//! Linux: GStreamer's \`playbin\` decodes (VA-API or software, whichever the
//! system has) and plays the sound through the desktop's audio sink, keeping
//! picture and sound in sync on its clock. Pictures reach an \`appsink\` as RGBA
//! (converted by GStreamer) and are handed to the renderer in memory.
//!
//! GStreamer is loaded at run time (\`dlopen\`), not linked: the binary needs no
//! system library to start, and without GStreamer a \`<video>\` reports an
//! \`error\` event, the way it does on other unsupported systems.
//!
//! The decoder wakes the event loop itself (a new picture, a bus message), so a
//! playing video costs no polling; only \`timeupdate\` runs on a 250 ms timer.

use super::{VideoFrame, VideoLoad, media_error};
use crate::media::failure;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::ffi::{CStr, CString, c_char, c_int, c_uint, c_void};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use vello::peniko::{Blob, ImageAlphaType, ImageData, ImageFormat};
mod player;
#[allow(unused_imports)]
pub(crate) use player::*;

const TIME_UPDATE: Duration = Duration::from_millis(250);

const STATE_NULL: c_int = 1;
const STATE_PAUSED: c_int = 3;
const STATE_PLAYING: c_int = 4;
const FORMAT_TIME: c_int = 3;
const SEEK_FLUSH: c_int = 1;
const SEEK_ACCURATE: c_int = 2;
const SEEK_TYPE_NONE: c_int = 0;
/// playbin's `flags`: render subtitles.
const PLAY_FLAG_TEXT: c_int = 1 << 2;
const SEEK_TYPE_SET: c_int = 1;
const MESSAGE_EOS: c_uint = 1 << 0;
const MESSAGE_ERROR: c_uint = 1 << 1;
const MESSAGE_BUFFERING: c_uint = 1 << 5;
const FORMAT_PERCENT: c_int = 2;
/// `GST_FORMAT_PERCENT_MAX`: 100 % in a buffering range.
const PERCENT_MAX: f64 = 1_000_000.0;
const MESSAGE_DURATION_CHANGED: c_uint = 1 << 18;
const MESSAGE_ASYNC_DONE: c_uint = 1 << 21;
const MAP_READ: c_int = 1;
const BUS_PASS: c_int = 1;
/// \`GstMessage.type\` follows the 64-byte \`GstMiniObject\` header (64-bit ABI).
const MESSAGE_TYPE_OFFSET: usize = 64;

type Ptr = *mut c_void;

#[repr(C)]
struct GError {
    domain: u32,
    code: c_int,
    message: *mut c_char,
}

#[repr(C)]
struct MapInfo {
    memory: Ptr,
    flags: c_int,
    data: *mut u8,
    size: usize,
    maxsize: usize,
    user_data: [Ptr; 4],
    reserved: [Ptr; 4],
}

type SampleCallback = unsafe extern "C" fn(Ptr, Ptr) -> c_int;

/// \`GstAppSinkCallbacks\`, with room for fields newer releases add.
#[repr(C)]
struct AppSinkCallbacks {
    eos: Option<unsafe extern "C" fn(Ptr, Ptr)>,
    new_preroll: Option<SampleCallback>,
    new_sample: Option<SampleCallback>,
    rest: [Ptr; 8],
}

unsafe extern "C" {
    fn dlopen(file: *const c_char, mode: c_int) -> Ptr;
    fn dlsym(handle: Ptr, name: *const c_char) -> Ptr;
}

macro_rules! gst_api {
    ($($name:ident: fn($($arg:ty),*) $(-> $ret:ty)?;)*) => {
        #[allow(non_snake_case)]
        struct Gst {
            $($name: unsafe extern "C" fn($($arg),*) $(-> $ret)?,)*
            g_object_set: unsafe extern "C" fn(Ptr, *const c_char, ...),
            g_object_get: unsafe extern "C" fn(Ptr, *const c_char, ...),
            g_signal_emit_by_name: unsafe extern "C" fn(Ptr, *const c_char, ...),
        }
        impl Gst {
            fn load() -> Result<Self, String> {
                const RTLD_NOW_GLOBAL: c_int = 2 | 0x100;
                let mut handles = Vec::new();
                for library in ["libgobject-2.0.so.0", "libglib-2.0.so.0", "libgstreamer-1.0.so.0", "libgstapp-1.0.so.0"] {
                    let name = CString::new(library).unwrap();
                    let handle = unsafe { dlopen(name.as_ptr(), RTLD_NOW_GLOBAL) };
                    if handle.is_null() {
                        return Err(format!("GStreamer is not installed ({library} not found); install gstreamer1.0-plugins-base, -good and -libav to play video"));
                    }
                    handles.push(handle);
                }
                let find = |symbol: &str| -> Result<Ptr, String> {
                    let name = CString::new(symbol).unwrap();
                    handles
                        .iter()
                        .map(|handle| unsafe { dlsym(*handle, name.as_ptr()) })
                        .find(|pointer| !pointer.is_null())
                        .ok_or_else(|| format!("GStreamer is too old: {symbol} is missing"))
                };
                // SAFETY: each symbol has the C signature declared for it.
                unsafe {
                    Ok(Self {
                        $($name: std::mem::transmute::<Ptr, unsafe extern "C" fn($($arg),*) $(-> $ret)?>(find(stringify!($name))?),)*
                        g_object_set: std::mem::transmute::<Ptr, unsafe extern "C" fn(Ptr, *const c_char, ...)>(find("g_object_set")?),
                        g_object_get: std::mem::transmute::<Ptr, unsafe extern "C" fn(Ptr, *const c_char, ...)>(find("g_object_get")?),
                        g_signal_emit_by_name: std::mem::transmute::<Ptr, unsafe extern "C" fn(Ptr, *const c_char, ...)>(find("g_signal_emit_by_name")?),
                    })
                }
            }
        }
    };
}

gst_api! {
    gst_init_check: fn(*mut c_int, *mut c_void, *mut *mut GError) -> c_int;
    gst_element_factory_make: fn(*const c_char, *const c_char) -> Ptr;
    gst_object_ref_sink: fn(Ptr) -> Ptr;
    gst_object_unref: fn(Ptr);
    gst_mini_object_unref: fn(Ptr);
    gst_caps_from_string: fn(*const c_char) -> Ptr;
    gst_element_set_state: fn(Ptr, c_int) -> c_int;
    gst_element_query_position: fn(Ptr, c_int, *mut i64) -> c_int;
    gst_element_query_duration: fn(Ptr, c_int, *mut i64) -> c_int;
    gst_element_seek_simple: fn(Ptr, c_int, c_int, i64) -> c_int;
    gst_element_seek: fn(Ptr, f64, c_int, c_int, c_int, i64, c_int, i64) -> c_int;
    gst_element_get_bus: fn(Ptr) -> Ptr;
    gst_bus_pop: fn(Ptr) -> Ptr;
    gst_bus_set_sync_handler: fn(Ptr, Option<unsafe extern "C" fn(Ptr, Ptr, Ptr) -> c_int>, Ptr, Option<unsafe extern "C" fn(Ptr)>);
    gst_message_parse_error: fn(Ptr, *mut *mut GError, *mut *mut c_char);
    gst_message_parse_buffering: fn(Ptr, *mut c_int);
    gst_query_new_buffering: fn(c_int) -> Ptr;
    gst_element_query: fn(Ptr, Ptr) -> c_int;
    gst_query_parse_buffering_range: fn(Ptr, *mut c_int, *mut i64, *mut i64, *mut i64);
    gst_tag_list_get_string: fn(Ptr, *const c_char, *mut *mut c_char) -> c_int;
    gst_filename_to_uri: fn(*const c_char, *mut *mut GError) -> *mut c_char;
    gst_app_sink_set_callbacks: fn(Ptr, *const AppSinkCallbacks, Ptr, Option<unsafe extern "C" fn(Ptr)>);
    gst_app_sink_try_pull_sample: fn(Ptr, u64) -> Ptr;
    gst_app_sink_try_pull_preroll: fn(Ptr, u64) -> Ptr;
    gst_sample_get_buffer: fn(Ptr) -> Ptr;
    gst_sample_get_caps: fn(Ptr) -> Ptr;
    gst_caps_get_structure: fn(Ptr, c_uint) -> Ptr;
    gst_structure_get_int: fn(Ptr, *const c_char, *mut c_int) -> c_int;
    gst_buffer_map: fn(Ptr, *mut MapInfo, c_int) -> c_int;
    gst_buffer_unmap: fn(Ptr, *mut MapInfo);
    g_error_free: fn(*mut GError);
    g_free: fn(Ptr);
}

fn gst() -> Result<&'static Gst, String> {
    static GST: OnceLock<Result<Gst, String>> = OnceLock::new();
    GST.get_or_init(|| {
        let gst = Gst::load()?;
        let mut error = std::ptr::null_mut();
        if unsafe { (gst.gst_init_check)(std::ptr::null_mut(), std::ptr::null_mut(), &mut error) }
            == 0
        {
            return Err(take_error(&gst, error, "GStreamer could not start"));
        }
        Ok(gst)
    })
    .as_ref()
    .map_err(Clone::clone)
}

fn take_error(gst: &Gst, error: *mut GError, fallback: &str) -> String {
    if error.is_null() {
        return fallback.to_string();
    }
    let message = unsafe { (*error).message };
    let text = if message.is_null() {
        fallback.to_string()
    } else {
        unsafe { CStr::from_ptr(message) }
            .to_string_lossy()
            .into_owned()
    };
    unsafe { (gst.g_error_free)(error) };
    text
}

fn c(text: &str) -> CString {
    CString::new(text.replace('\0', "")).unwrap_or_default()
}

/// What the decoder's threads tell the event loop.
struct Signal {
    picture: AtomicBool,
    preroll: AtomicBool,
    message: AtomicBool,
    wake: Arc<dyn Fn() + Send + Sync>,
}

unsafe extern "C" fn on_sample(_sink: Ptr, data: Ptr) -> c_int {
    let signal = unsafe { &*(data as *const Signal) };
    signal.picture.store(true, Ordering::Release);
    (signal.wake)();
    0
}

unsafe extern "C" fn on_preroll(_sink: Ptr, data: Ptr) -> c_int {
    let signal = unsafe { &*(data as *const Signal) };
    signal.preroll.store(true, Ordering::Release);
    (signal.wake)();
    0
}

unsafe extern "C" fn on_message(_bus: Ptr, _message: Ptr, data: Ptr) -> c_int {
    let signal = unsafe { &*(data as *const Signal) };
    signal.message.store(true, Ordering::Release);
    (signal.wake)();
    BUS_PASS
}

struct Player {
    gst: &'static Gst,
    pipeline: Ptr,
    sink: Ptr,
    bus: Ptr,
    /// Read by GStreamer's threads until the pipeline stops (see \`Drop\`).
    signal: Box<Signal>,
    src: String,
    size: (u32, u32),
    generation: u64,
    looped: bool,
    playing: bool,
    ended: bool,
    metadata: bool,
    seeking: bool,
    /// `playbackRate`: every seek carries it (playsink keeps the pitch with scaletempo).
    rate: f64,
    next_update: Option<Instant>,
    /// Paused by a buffering message (a stream ran short): `waiting` until it refills.
    buffering: bool,
}

impl Drop for Player {
    fn drop(&mut self) {
        unsafe {
            // Stopping joins GStreamer's threads: nothing reads \`signal\` after this.
            (self.gst.gst_element_set_state)(self.pipeline, STATE_NULL);
            (self.gst.gst_bus_set_sync_handler)(self.bus, None, std::ptr::null_mut(), None);
            (self.gst.gst_object_unref)(self.bus);
            (self.gst.gst_object_unref)(self.pipeline);
        }
    }
}

pub(crate) struct Videos {
    wake: Arc<dyn Fn() + Send + Sync>,
    players: HashMap<String, Player>,
    changed: Vec<(String, Option<VideoFrame>)>,
}

impl Videos {
    pub(crate) fn new(wake: impl Fn() + Send + Sync + 'static) -> Self {
        Self {
            wake: Arc::new(wake),
            players: HashMap::new(),
            changed: Vec::new(),
        }
    }

    pub(crate) fn handles(&self, id: &str) -> bool {
        self.players.contains_key(id)
    }

    /// GStreamer plays the sound itself (its clock keeps it in sync): no mixer.
    pub(crate) fn load<Mixer>(
        &mut self,
        id: &str,
        load: VideoLoad<'_>,
        _mixer: Option<Mixer>,
    ) -> Vec<Value> {
        if self.players.remove(id).is_some() {
            self.changed.push((id.to_string(), None));
        }
        match gst().and_then(|gst| Player::new(gst, &load, self.wake.clone())) {
            Ok(player) => {
                self.players.insert(id.to_string(), player);
                Vec::new()
            }
            Err(message) => vec![media_error(id, failure(load.src, message))],
        }
    }

    pub(crate) fn set_text_track(&mut self, id: &str, index: Option<u32>) -> Vec<Value> {
        let Some(player) = self.players.get_mut(id) else {
            return vec![media_error(id, "media not loaded")];
        };
        player.select_text(index);
        let mut event = player.event(id, "texttracks");
        event["textTracks"] = player.text_tracks();
        vec![event]
    }

    pub(crate) fn set_audio_track(&mut self, id: &str, index: u32) -> Vec<Value> {
        let Some(player) = self.players.get_mut(id) else {
            return vec![media_error(id, "media not loaded")];
        };
        player.select_audio(index);
        let mut event = player.event(id, "audiotracks");
        event["audioTracks"] = player.audio_tracks();
        vec![event]
    }

    pub(crate) fn set_rate(&mut self, id: &str, rate: f64) -> Vec<Value> {
        match self.players.get_mut(id) {
            Some(player) => {
                player.set_rate(rate);
                Vec::new()
            }
            None => vec![media_error(id, "media not loaded")],
        }
    }

    pub(crate) fn command(
        &mut self,
        id: &str,
        action: &str,
        time: Option<f64>,
        volume: Option<f64>,
        muted: Option<bool>,
        looped: Option<bool>,
    ) -> Vec<Value> {
        if action == "unload" {
            if self.players.remove(id).is_some() {
                self.changed.push((id.to_string(), None));
            }
            return Vec::new();
        }
        let Some(player) = self.players.get_mut(id) else {
            return vec![media_error(id, "media not loaded")];
        };
        let event = match action {
            "play" => player.play().then_some("play"),
            "pause" => player.pause().then_some("pause"),
            "seek" => {
                player.seek(time.unwrap_or(0.0));
                None
            }
            "set" => {
                player.set(looped, muted, volume);
                None
            }
            _ => None,
        };
        event
            .map(|name| vec![player.event(id, name)])
            .unwrap_or_default()
    }

    pub(crate) fn tick(&mut self, now: Instant) -> Vec<Value> {
        let mut out = Vec::new();
        let mut failed = Vec::new();
        for (id, player) in &mut self.players {
            if let Err(message) = player.messages(id, &mut out) {
                failed.push((id.clone(), failure(&player.src, message)));
                continue;
            }
            if let Some(frame) = player.picture() {
                self.changed.push((id.clone(), Some(frame)));
                if !player.metadata {
                    player.metadata = true;
                    out.push(player.event(id, "loadedmetadata"));
                    out.push(player.event(id, "canplay"));
                    let tracks = player.audio_tracks();
                    if tracks.as_array().is_some_and(|tracks| !tracks.is_empty()) {
                        let mut event = player.event(id, "audiotracks");
                        event["audioTracks"] = tracks;
                        out.push(event);
                    }
                    let texts = player.text_tracks();
                    if texts.as_array().is_some_and(|tracks| !tracks.is_empty()) {
                        let mut event = player.event(id, "texttracks");
                        event["textTracks"] = texts;
                        out.push(event);
                    }
                }
            }
            if player.playing && player.next_update.is_some_and(|at| at <= now) {
                player.next_update = Some(now + TIME_UPDATE);
                out.push(player.event(id, "timeupdate"));
            }
        }
        for (id, message) in failed {
            self.players.remove(&id);
            self.changed.push((id.clone(), None));
            out.push(media_error(&id, message));
        }
        out
    }

    pub(crate) fn take_frames(&mut self) -> Vec<(String, Option<VideoFrame>)> {
        std::mem::take(&mut self.changed)
    }

    /// Pictures arrive at the video's own size; the renderer scales them.
    pub(crate) fn set_display_sizes(&mut self, _sizes: impl Fn(&str) -> Option<(u32, u32)>) {}

    /// No video lets go of its decoder here: nothing to repaint for it.
    pub(crate) fn take_repaint(&mut self) -> Vec<String> {
        Vec::new()
    }

    /// GStreamer keeps decoding off screen videos; the tree skips painting them.
    pub(crate) fn set_visible(&mut self, _visible: impl Fn(&str) -> bool) {}

    /// Only \`timeupdate\` needs a timer; pictures and bus messages wake the loop.
    pub(crate) fn deadline(&self) -> Option<Instant> {
        self.players
            .values()
            .filter_map(|player| player.next_update)
            .min()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// With or without GStreamer, a source that cannot play ends in one `error`
    /// event (never a crash or a silent empty box).
    #[test]
    fn a_missing_file_reports_an_error() {
        let mut videos = Videos::new(|| {});
        let load = VideoLoad {
            src: "/nonexistent/tarve-missing.mp4",
            looped: false,
            muted: true,
            volume: 1.0,
        };
        let mut events = videos.load::<()>("clip", load, None);
        let end = Instant::now() + Duration::from_secs(5);
        while events.is_empty() && Instant::now() < end {
            std::thread::sleep(Duration::from_millis(20));
            events = videos.tick(Instant::now());
        }
        assert_eq!(events.len(), 1, "{events:?}");
        assert_eq!(events[0]["event"], "error");
        assert!(!videos.handles("clip"));
        assert!(matches!(videos.take_frames().as_slice(), [] | [(_, None)]));
        if gst().is_err() {
            assert!(
                events[0]["message"].as_str().unwrap().contains("GStreamer"),
                "{events:?}"
            );
        }
    }
}
