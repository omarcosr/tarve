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

const TIME_UPDATE: Duration = Duration::from_millis(250);

const STATE_NULL: c_int = 1;
const STATE_PAUSED: c_int = 3;
const STATE_PLAYING: c_int = 4;
const FORMAT_TIME: c_int = 3;
const SEEK_FLUSH: c_int = 1;
const SEEK_ACCURATE: c_int = 2;
const MESSAGE_EOS: c_uint = 1 << 0;
const MESSAGE_ERROR: c_uint = 1 << 1;
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
    gst_element_get_bus: fn(Ptr) -> Ptr;
    gst_bus_pop: fn(Ptr) -> Ptr;
    gst_bus_set_sync_handler: fn(Ptr, Option<unsafe extern "C" fn(Ptr, Ptr, Ptr) -> c_int>, Ptr, Option<unsafe extern "C" fn(Ptr)>);
    gst_message_parse_error: fn(Ptr, *mut *mut GError, *mut *mut c_char);
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
    next_update: Option<Instant>,
}

impl Player {
    fn new(
        gst: &'static Gst,
        load: &VideoLoad<'_>,
        wake: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<Self, String> {
        let uri = if load.src.contains("://") {
            load.src.to_string()
        } else {
            let path = std::path::absolute(load.src).unwrap_or_else(|_| load.src.into());
            let mut error = std::ptr::null_mut();
            let uri = unsafe {
                (gst.gst_filename_to_uri)(c(&path.to_string_lossy()).as_ptr(), &mut error)
            };
            if uri.is_null() {
                return Err(take_error(gst, error, "invalid video path"));
            }
            let text = unsafe { CStr::from_ptr(uri) }
                .to_string_lossy()
                .into_owned();
            unsafe { (gst.g_free)(uri.cast()) };
            text
        };
        let make = |factory: &str| {
            let element =
                unsafe { (gst.gst_element_factory_make)(c(factory).as_ptr(), std::ptr::null()) };
            if element.is_null() {
                Err(format!(
                    "the GStreamer element {factory} is missing (install gstreamer1.0-plugins-base)"
                ))
            } else {
                Ok(element)
            }
        };
        let pipeline = make("playbin")?;
        unsafe { (gst.gst_object_ref_sink)(pipeline) };
        let mut player = Self {
            gst,
            pipeline,
            sink: std::ptr::null_mut(),
            bus: std::ptr::null_mut(),
            signal: Box::new(Signal {
                picture: AtomicBool::new(false),
                preroll: AtomicBool::new(false),
                message: AtomicBool::new(false),
                wake,
            }),
            src: load.src.to_string(),
            size: (0, 0),
            generation: 0,
            looped: load.looped,
            playing: false,
            ended: false,
            metadata: false,
            seeking: false,
            next_update: None,
        };
        let sink = make("appsink")?;
        player.sink = sink;
        let caps = unsafe {
            (gst.gst_caps_from_string)(c"video/x-raw,format=RGBA,pixel-aspect-ratio=1/1".as_ptr())
        };
        unsafe {
            (gst.g_object_set)(sink, c"caps".as_ptr(), caps, std::ptr::null::<c_char>());
            (gst.gst_mini_object_unref)(caps);
            // Only the newest picture matters: a late one is dropped, never queued.
            (gst.g_object_set)(
                sink,
                c"max-buffers".as_ptr(),
                1 as c_uint,
                std::ptr::null::<c_char>(),
            );
            (gst.g_object_set)(
                sink,
                c"drop".as_ptr(),
                1 as c_int,
                std::ptr::null::<c_char>(),
            );
            let callbacks = AppSinkCallbacks {
                eos: None,
                new_preroll: Some(on_preroll),
                new_sample: Some(on_sample),
                rest: [std::ptr::null_mut(); 8],
            };
            let data = &*player.signal as *const Signal as Ptr;
            (gst.gst_app_sink_set_callbacks)(sink, &callbacks, data, None);
            (gst.g_object_set)(
                pipeline,
                c"video-sink".as_ptr(),
                sink,
                std::ptr::null::<c_char>(),
            );
            (gst.g_object_set)(
                pipeline,
                c"uri".as_ptr(),
                c(&uri).as_ptr(),
                std::ptr::null::<c_char>(),
            );
            if std::env::var_os("TARVE_AUDIO").is_some_and(|value| value == "silent") {
                let quiet = make("fakesink")?;
                (gst.g_object_set)(
                    quiet,
                    c"sync".as_ptr(),
                    1 as c_int,
                    std::ptr::null::<c_char>(),
                );
                (gst.g_object_set)(
                    pipeline,
                    c"audio-sink".as_ptr(),
                    quiet,
                    std::ptr::null::<c_char>(),
                );
            }
            player.bus = (gst.gst_element_get_bus)(pipeline);
            (gst.gst_bus_set_sync_handler)(player.bus, Some(on_message), data, None);
        }
        player.set(None, Some(load.muted), Some(f64::from(load.volume)));
        // Paused: the first picture and the metadata arrive without playing.
        unsafe { (gst.gst_element_set_state)(pipeline, STATE_PAUSED) };
        Ok(player)
    }

    fn set(&mut self, looped: Option<bool>, muted: Option<bool>, volume: Option<f64>) {
        if let Some(looped) = looped {
            self.looped = looped;
        }
        unsafe {
            if let Some(muted) = muted {
                (self.gst.g_object_set)(
                    self.pipeline,
                    c"mute".as_ptr(),
                    c_int::from(muted),
                    std::ptr::null::<c_char>(),
                );
            }
            if let Some(volume) = volume {
                (self.gst.g_object_set)(
                    self.pipeline,
                    c"volume".as_ptr(),
                    volume.clamp(0.0, 1.0),
                    std::ptr::null::<c_char>(),
                );
            }
        }
    }

    fn query(&self, duration: bool) -> Option<f64> {
        let mut value = 0_i64;
        let found = unsafe {
            if duration {
                (self.gst.gst_element_query_duration)(self.pipeline, FORMAT_TIME, &mut value)
            } else {
                (self.gst.gst_element_query_position)(self.pipeline, FORMAT_TIME, &mut value)
            }
        };
        (found != 0 && value >= 0).then(|| value as f64 / 1e9)
    }

    fn seek(&mut self, time: f64) {
        let nanos = (time.max(0.0) * 1e9) as i64;
        if unsafe {
            (self.gst.gst_element_seek_simple)(
                self.pipeline,
                FORMAT_TIME,
                SEEK_FLUSH | SEEK_ACCURATE,
                nanos,
            )
        } != 0
        {
            self.seeking = true;
            self.ended = false;
        }
    }

    fn play(&mut self) -> bool {
        if self.playing {
            return false;
        }
        if self.ended {
            // Like a browser: play() after the end starts over.
            self.seek(0.0);
        }
        self.playing = true;
        self.next_update = Some(Instant::now() + TIME_UPDATE);
        unsafe { (self.gst.gst_element_set_state)(self.pipeline, STATE_PLAYING) };
        true
    }

    fn pause(&mut self) -> bool {
        if !self.playing {
            return false;
        }
        self.playing = false;
        self.next_update = None;
        unsafe { (self.gst.gst_element_set_state)(self.pipeline, STATE_PAUSED) };
        true
    }

    fn event(&self, id: &str, name: &str) -> Value {
        json!({
            "type": "media",
            "id": id,
            "event": name,
            "time": self.query(false).unwrap_or(0.0),
            "duration": self.query(true),
            "paused": !self.playing,
            "videoWidth": self.size.0,
            "videoHeight": self.size.1,
        })
    }

    /// Bus messages since the last call, as media events.
    fn messages(&mut self, id: &str, out: &mut Vec<Value>) -> Result<(), String> {
        if !self.signal.message.swap(false, Ordering::AcqRel) {
            return Ok(());
        }
        loop {
            let message = unsafe { (self.gst.gst_bus_pop)(self.bus) };
            if message.is_null() {
                return Ok(());
            }
            let kind = unsafe {
                *(message
                    .cast::<u8>()
                    .add(MESSAGE_TYPE_OFFSET)
                    .cast::<c_uint>())
            };
            let mut failed = None;
            match kind {
                MESSAGE_ERROR => {
                    let mut error = std::ptr::null_mut();
                    let mut debug = std::ptr::null_mut();
                    unsafe { (self.gst.gst_message_parse_error)(message, &mut error, &mut debug) };
                    if !debug.is_null() {
                        unsafe { (self.gst.g_free)(debug.cast()) };
                    }
                    failed = Some(take_error(self.gst, error, "the video could not be played"));
                }
                MESSAGE_EOS if self.looped => self.seek(0.0),
                MESSAGE_EOS => {
                    self.playing = false;
                    self.ended = true;
                    self.next_update = None;
                    unsafe { (self.gst.gst_element_set_state)(self.pipeline, STATE_PAUSED) };
                    out.push(self.event(id, "pause"));
                    out.push(self.event(id, "ended"));
                }
                MESSAGE_ASYNC_DONE if self.seeking => {
                    self.seeking = false;
                    out.push(self.event(id, "seeked"));
                }
                MESSAGE_DURATION_CHANGED if self.metadata => {
                    out.push(self.event(id, "durationchange"))
                }
                _ => {}
            }
            unsafe { (self.gst.gst_mini_object_unref)(message) };
            if let Some(message) = failed {
                return Err(message);
            }
        }
    }

    /// The newest picture, if one arrived since the last call.
    fn picture(&mut self) -> Option<VideoFrame> {
        let sample = if self.signal.picture.swap(false, Ordering::AcqRel) {
            unsafe { (self.gst.gst_app_sink_try_pull_sample)(self.sink, 0) }
        } else {
            std::ptr::null_mut()
        };
        let sample = if sample.is_null() && self.signal.preroll.swap(false, Ordering::AcqRel) {
            unsafe { (self.gst.gst_app_sink_try_pull_preroll)(self.sink, 0) }
        } else {
            sample
        };
        if sample.is_null() {
            return None;
        }
        let frame = self.copy(sample);
        unsafe { (self.gst.gst_mini_object_unref)(sample) };
        frame
    }

    fn copy(&mut self, sample: Ptr) -> Option<VideoFrame> {
        let gst = self.gst;
        let caps = unsafe { (gst.gst_sample_get_caps)(sample) };
        let buffer = unsafe { (gst.gst_sample_get_buffer)(sample) };
        if caps.is_null() || buffer.is_null() {
            return None;
        }
        let structure = unsafe { (gst.gst_caps_get_structure)(caps, 0) };
        let (mut width, mut height) = (0, 0);
        unsafe {
            (gst.gst_structure_get_int)(structure, c"width".as_ptr(), &mut width);
            (gst.gst_structure_get_int)(structure, c"height".as_ptr(), &mut height);
        }
        if width <= 0 || height <= 0 {
            return None;
        }
        let (width, height) = (width as usize, height as usize);
        let mut map = MapInfo {
            memory: std::ptr::null_mut(),
            flags: 0,
            data: std::ptr::null_mut(),
            size: 0,
            maxsize: 0,
            user_data: [std::ptr::null_mut(); 4],
            reserved: [std::ptr::null_mut(); 4],
        };
        if unsafe { (gst.gst_buffer_map)(buffer, &mut map, MAP_READ) } == 0 {
            return None;
        }
        // RGBA rows are 4-byte aligned already: the stride is width × 4.
        let bytes = width * height * 4;
        let pixels = (map.size >= bytes)
            .then(|| unsafe { std::slice::from_raw_parts(map.data, bytes) }.to_vec());
        unsafe { (gst.gst_buffer_unmap)(buffer, &mut map) };
        let pixels = pixels?;
        self.size = (width as u32, height as u32);
        self.generation += 1;
        Some(VideoFrame {
            width: self.size.0,
            height: self.size.1,
            generation: self.generation,
            pixels: Some(ImageData {
                width: self.size.0,
                height: self.size.1,
                format: ImageFormat::Rgba8,
                alpha_type: ImageAlphaType::Alpha,
                data: Blob::new(Arc::new(pixels)),
            }),
        })
    }
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
