//! Windows: Media Foundation's Media Engine in frame-server mode. The engine
//! decodes (on the GPU, through the D3D11 device it is given) and keeps picture
//! and sound in sync; each new picture is copied by the GPU into a texture the
//! renderer samples. With the D3D11 renderer that texture lives on the
//! renderer's own device: no copy through memory. Other renderers get the
//! picture read back into memory.

use super::windows_reader::{AudioTrack, ReaderPlayer, audio_codec};
use super::windows_shared::win;
use super::windows_stream::{RemoteStream, VIDEO_WINDOW, content_type, streamable};
use super::windows_subtitles::Subtitles;
use super::{VideoFrame, VideoLoad, media_error};
use crate::d3d11::VideoView;
use crate::media::failure;
use crate::media::remote::{Stream, is_remote};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use vello::peniko::{Blob, ImageAlphaType, ImageData, ImageFormat};
use windows::Win32::Foundation::{HMODULE, RECT, S_OK};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D::D3D11_SRV_DIMENSION_TEXTURE2D;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_CPU_ACCESS_READ,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_CREATE_DEVICE_VIDEO_SUPPORT, D3D11_MAP_READ,
    D3D11_MAPPED_SUBRESOURCE, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
    D3D11_USAGE_STAGING, D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Multithread,
    ID3D11ShaderResourceView, ID3D11Texture2D,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11_SHADER_RESOURCE_VIEW_DESC, D3D11_SHADER_RESOURCE_VIEW_DESC_0, D3D11_TEX2D_SRV,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_NV12, DXGI_FORMAT_R8_UNORM,
    DXGI_FORMAT_R8G8_UNORM, DXGI_SAMPLE_DESC,
};
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
};
use windows::core::{BSTR, HSTRING, Interface, implement};
mod player;
mod tracks;
#[allow(unused_imports)]
pub(crate) use player::*;
use tracks::engine_tracks;

/// While playing, how often the engine is asked for a new picture. Well under
/// a 120 Hz display's frame, so a picture is shown on the vsync it is due.
const PLAYING_POLL: Duration = Duration::from_millis(4);
/// Off screen: how often a playing engine is stepped (no picture is copied).
const HIDDEN_POLL: Duration = Duration::from_millis(33);
/// After a load or a seek, a paused video still gets its first picture.
const SETTLE_POLL: Duration = Duration::from_millis(16);
const SETTLE_FOR: Duration = Duration::from_secs(2);
/// A seek still under way this long while playing reports `waiting` (the reader's threshold).
const SEEK_WAITING_AFTER: Duration = Duration::from_millis(150);

/// What the engine's callback thread hands the event loop.
struct Shared {
    events: Mutex<Vec<u32>>,
    wake: Arc<dyn Fn() + Send + Sync>,
    /// A remote src opened through the app's download, off the event loop.
    stream: Mutex<Option<Result<Arc<Stream>, String>>>,
}

/// A remote src whose download is opening: what was asked of it meanwhile.
struct Opening {
    play: bool,
    seek: Option<f64>,
}

#[implement(IMFMediaEngineNotify)]
struct Notify {
    shared: Arc<Shared>,
}

impl IMFMediaEngineNotify_Impl for Notify_Impl {
    fn EventNotify(&self, event: u32, _param1: usize, _param2: u32) -> windows::core::Result<()> {
        if let Ok(mut events) = self.shared.events.lock() {
            events.push(event);
        }
        (self.shared.wake)();
        Ok(())
    }
}

/// The D3D11 device the engines decode with, behind one DXGI device manager.
struct Gpu {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    manager: IMFDXGIDeviceManager,
    token: u32,
    /// The renderer's own device: pictures are drawn from the texture, never read back.
    renderer: bool,
}

struct Surface {
    texture: ID3D11Texture2D,
    /// What the renderer samples (none when the picture is read back instead).
    view: Option<VideoView>,
    format: DXGI_FORMAT,
    staging: Option<ID3D11Texture2D>,
    width: u32,
    height: u32,
}

struct Player {
    engine: IMFMediaEngine,
    shared: Arc<Shared>,
    src: String,
    surface: Option<Surface>,
    generation: u64,
    size: (u32, u32),
    playing: bool,
    /// Poll for a picture until then, even paused (after a load or a seek).
    settle_until: Option<Instant>,
    /// Device pixels the picture covers on screen: pictures read back into memory
    /// are scaled to it by the GPU (never above the video's own size).
    display: Option<(u32, u32)>,
    /// The display size changed: copy the current picture again, even paused.
    redraw: bool,
    /// The last UI frame did not draw it: no picture is copied (nor read back)
    /// until it is on screen again.
    hidden: bool,
    /// Pictures stay in the decoder's NV12 for the renderer (converted while drawn);
    /// off when this GPU's video processor cannot write NV12 (then BGRA).
    nv12: bool,
    /// Paused by its own end: the engine's `pause` for it is not reported again.
    ended_pause: bool,
    /// Took over from a reader that already reported `loadedmetadata`.
    quiet_metadata: bool,
    /// The remote download is opening; the engine has no source yet.
    opening: Option<Opening>,
    /// The app's own download behind a remote source (`filename`).
    stream: Option<Arc<Stream>>,
    /// `waiting` was reported; playing again ends it with `canplay`.
    waiting: bool,
    /// When a seek was asked and its `seeked` has not come (`waiting` while playing past
    /// it), and its target: `currentTime` until then.
    seek_started: Option<(Instant, f64)>,
    /// The file's audio streams once known (`audioTracks`); ids are the engine's stream numbers.
    tracks: Vec<AudioTrack>,
    /// An audio track to play once the engine has opened the file.
    pending_track: Option<u32>,
}

/// A load that waits until the renderer is known (it picks the decoding path).
struct PendingLoad {
    src: String,
    looped: bool,
    muted: bool,
    volume: f32,
    mixer: Option<rodio::mixer::Mixer>,
    play: bool,
    seek: Option<f64>,
}

pub(crate) struct Videos {
    wake: Arc<dyn Fn() + Send + Sync>,
    /// D3D11 renderer: decoder textures drawn directly (Source Reader).
    readers: HashMap<String, ReaderPlayer>,
    /// Loads made before the renderer was known.
    pending_loads: HashMap<String, PendingLoad>,
    /// `playbackRate` of each video not at 1, applied to the player it gets.
    rates: HashMap<String, f64>,
    /// Each video's embedded text subtitles, read by a thread of their own.
    subtitles: HashMap<String, Subtitles>,
    renderer_known: bool,
    factory: Option<IMFMediaEngineClassFactory>,
    gpu: Option<Gpu>,
    /// The renderer's D3D11 device, when it has one.
    renderer_device: Option<ID3D11Device>,
    players: HashMap<String, Player>,
    changed: Vec<(String, Option<VideoFrame>)>,
    /// Events raised outside `tick` (a failed device switch), sent with the next one.
    pending: Vec<Value>,
    /// Videos whose new picture must go through a UI paint (a parked video's copy:
    /// the last frame's commands still hold the decoder's texture).
    repaint: Vec<String>,
}

fn finite(value: f64) -> Option<f64> {
    value.is_finite().then_some(value)
}

/// A local path as the URL Media Foundation's source resolver expects.
fn source_url(src: &str) -> String {
    if src.contains("://") {
        return src.to_string();
    }
    let path = std::path::absolute(src).unwrap_or_else(|_| src.into());
    let path = path.to_string_lossy().replace('\\', "/");
    let encoded: String = path
        .chars()
        .map(|c| match c {
            ' ' => "%20".to_string(),
            '#' => "%23".to_string(),
            '%' => "%25".to_string(),
            '?' => "%3F".to_string(),
            c => c.to_string(),
        })
        .collect();
    format!("file:///{}", encoded.trim_start_matches('/'))
}

fn create_device() -> Result<(ID3D11Device, ID3D11DeviceContext), String> {
    let mut device = None;
    let mut context = None;
    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )
    }
    .map_err(win)?;
    Ok((
        device.ok_or("D3D11 device was not created")?,
        context.ok_or("D3D11 context was not created")?,
    ))
}

/// Media Foundation decodes on its own threads with the device the app also uses.
fn protect(device: &ID3D11Device) {
    if let Ok(multithread) = device.cast::<ID3D11Multithread>() {
        unsafe {
            let _ = multithread.SetMultithreadProtected(true);
        }
    }
}

fn same(a: &ID3D11Device, b: &ID3D11Device) -> bool {
    a.as_raw() == b.as_raw()
}

impl Videos {
    pub(crate) fn new(wake: impl Fn() + Send + Sync + 'static) -> Self {
        Self {
            wake: Arc::new(wake),
            factory: None,
            gpu: None,
            renderer_device: None,
            players: HashMap::new(),
            changed: Vec::new(),
            pending: Vec::new(),
            repaint: Vec::new(),
            readers: HashMap::new(),
            pending_loads: HashMap::new(),
            rates: HashMap::new(),
            subtitles: HashMap::new(),
            renderer_known: false,
        }
    }

    pub(crate) fn handles(&self, id: &str) -> bool {
        self.players.contains_key(id)
            || self.readers.contains_key(id)
            || self.pending_loads.contains_key(id)
    }

    /// The renderer's D3D11 device (`None` for the CPU and wgpu renderers). Engines
    /// move to it, or off it, the next time they decode.
    pub(crate) fn attach_renderer(&mut self, device: Option<ID3D11Device>) {
        let unchanged = match (&self.renderer_device, &device) {
            (Some(a), Some(b)) => same(a, b),
            (None, None) => true,
            _ => false,
        };
        let first = !self.renderer_known;
        self.renderer_known = true;
        if unchanged {
            if first {
                self.start_pending();
            }
            return;
        }
        self.renderer_device = device;
        // Readers decode onto the renderer's device: a new device (or none) loads them again where they were.
        let readers: Vec<(String, ReaderPlayer)> = self.readers.drain().collect();
        for (id, reader) in readers {
            self.changed.push((id.clone(), None));
            self.pending_loads.insert(
                id,
                PendingLoad {
                    src: reader.src.clone(),
                    looped: reader.looped(),
                    muted: reader.muted(),
                    volume: reader.volume(),
                    mixer: Some(reader.mixer()),
                    play: reader.playing,
                    seek: Some(reader.time()),
                },
            );
        }
        if self.gpu.is_some()
            && let Err(message) = self.switch_device()
        {
            for (id, player) in self.players.drain() {
                self.changed.push((id.clone(), None));
                self.pending
                    .push(media_error(&id, failure(&player.src, &message)));
            }
        }
        self.start_pending();
    }

    /// Loads that waited for the renderer: now it is known, each takes its path.
    fn start_pending(&mut self) {
        let pending: Vec<(String, PendingLoad)> = self.pending_loads.drain().collect();
        for (id, load) in pending {
            let events = self.create(&id, &load);
            self.pending.extend(events);
            if let Some(time) = load.seek {
                let events = self.command(&id, "seek", Some(time), None, None, None);
                self.pending.extend(events);
            }
            if load.play {
                let events = self.command(&id, "play", None, None, None, None);
                self.pending.extend(events);
            }
        }
    }

    /// Points the device manager (and so every engine) at the device pictures should land on.
    fn switch_device(&mut self) -> Result<(), String> {
        let Some(gpu) = self.gpu.as_mut() else {
            return Ok(());
        };
        let (device, context, renderer) = match &self.renderer_device {
            Some(device) => {
                let context = unsafe { device.GetImmediateContext() }.map_err(win)?;
                (device.clone(), context, true)
            }
            None => {
                let (device, context) = create_device()?;
                (device, context, false)
            }
        };
        protect(&device);
        unsafe { gpu.manager.ResetDevice(&device, gpu.token) }.map_err(win)?;
        gpu.device = device;
        gpu.context = context;
        gpu.renderer = renderer;
        for player in self.players.values_mut() {
            player.surface = None;
            player.settle_until = Some(Instant::now() + SETTLE_FOR);
        }
        Ok(())
    }

    /// The Media Engine (CPU and wgpu renderers only): the Source Reader path never loads it.
    fn ensure_engine_factory(&mut self) -> Result<(), String> {
        self.ensure_gpu()?;
        if self.factory.is_none() {
            self.factory = Some(
                unsafe {
                    CoCreateInstance(&CLSID_MFMediaEngineClassFactory, None, CLSCTX_INPROC_SERVER)
                }
                .map_err(win)?,
            );
        }
        Ok(())
    }

    /// Media Foundation and the device manager decoders share.
    fn ensure_gpu(&mut self) -> Result<(), String> {
        if self.gpu.is_none() {
            unsafe {
                // The event loop's thread; already initialized by the window in practice.
                let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
                MFStartup(MF_VERSION, MFSTARTUP_FULL).map_err(win)?;
            }
            let (device, context, renderer) = match &self.renderer_device {
                Some(device) => (
                    device.clone(),
                    unsafe { device.GetImmediateContext() }.map_err(win)?,
                    true,
                ),
                None => {
                    let (device, context) = create_device()?;
                    (device, context, false)
                }
            };
            protect(&device);
            let mut token = 0_u32;
            let mut manager = None;
            unsafe { MFCreateDXGIDeviceManager(&mut token, &mut manager) }.map_err(win)?;
            let manager = manager.ok_or("DXGI device manager was not created")?;
            unsafe { manager.ResetDevice(&device, token) }.map_err(win)?;
            self.gpu = Some(Gpu {
                device,
                context,
                manager,
                token,
                renderer,
            });
        }
        Ok(())
    }

    fn create_player(&mut self, load: &VideoLoad<'_>) -> Result<Player, String> {
        self.ensure_engine_factory()?;
        let shared = Arc::new(Shared {
            events: Mutex::new(Vec::new()),
            wake: self.wake.clone(),
            stream: Mutex::new(None),
        });
        let notify: IMFMediaEngineNotify = Notify {
            shared: shared.clone(),
        }
        .into();
        let gpu = self.gpu.as_ref().unwrap();
        let engine = unsafe {
            let mut attributes = None;
            MFCreateAttributes(&mut attributes, 3).map_err(win)?;
            let attributes = attributes.ok_or("media attributes were not created")?;
            attributes
                .SetUnknown(&MF_MEDIA_ENGINE_CALLBACK, &notify)
                .map_err(win)?;
            attributes
                .SetUnknown(&MF_MEDIA_ENGINE_DXGI_MANAGER, &gpu.manager)
                .map_err(win)?;
            attributes
                .SetUINT32(
                    &MF_MEDIA_ENGINE_VIDEO_OUTPUT_FORMAT,
                    DXGI_FORMAT_B8G8R8A8_UNORM.0 as u32,
                )
                .map_err(win)?;
            self.factory
                .as_ref()
                .unwrap()
                .CreateInstance(0, &attributes)
                .map_err(win)?
        };
        unsafe {
            engine.SetLoop(load.looped).map_err(win)?;
            engine.SetMuted(load.muted).map_err(win)?;
            engine
                .SetVolume(f64::from(load.volume.clamp(0.0, 1.0)))
                .map_err(win)?;
            engine
                .SetPreload(MF_MEDIA_ENGINE_PRELOAD_AUTOMATIC)
                .map_err(win)?;
        }
        // A remote file goes through the app's own download (as on the reader
        // path): a refused or unknown host fails at once, the moov box at the end
        // is one range request, and a short file stays whole for loops and seeks.
        let opening = if is_remote(load.src) && streamable(load.src) {
            let (url, shared) = (load.src.to_string(), shared.clone());
            std::thread::Builder::new()
                .name("tarve-video-open".into())
                .spawn(move || {
                    let opened = Stream::open_windowed(&url, VIDEO_WINDOW);
                    *shared.stream.lock().unwrap_or_else(|p| p.into_inner()) = Some(opened);
                    (shared.wake)();
                })
                .map_err(|error| error.to_string())?;
            Some(Opening {
                play: false,
                seek: None,
            })
        } else {
            unsafe { engine.SetSource(&BSTR::from(source_url(load.src))) }.map_err(win)?;
            None
        };
        Ok(Player {
            engine,
            shared,
            src: load.src.to_string(),
            surface: None,
            generation: 0,
            size: (0, 0),
            playing: false,
            settle_until: Some(Instant::now() + SETTLE_FOR),
            display: None,
            redraw: false,
            hidden: false,
            nv12: true,
            ended_pause: false,
            quiet_metadata: false,
            opening,
            stream: None,
            waiting: false,
            seek_started: None,
            tracks: Vec::new(),
            pending_track: None,
        })
    }

    pub(crate) fn load(
        &mut self,
        id: &str,
        load: VideoLoad<'_>,
        mixer: Option<rodio::mixer::Mixer>,
    ) -> Vec<Value> {
        let removed = self.players.remove(id).is_some() | self.readers.remove(id).is_some();
        self.pending_loads.remove(id);
        self.subtitles.insert(
            id.to_string(),
            Subtitles::spawn(load.src, self.wake.clone()),
        );
        // A new source starts at the normal rate, as HTMLMediaElement.load() does.
        self.rates.remove(id);
        if removed {
            self.changed.push((id.to_string(), None));
        }
        let load = PendingLoad {
            src: load.src.to_string(),
            looped: load.looped,
            muted: load.muted,
            volume: load.volume,
            mixer,
            play: false,
            seek: None,
        };
        if !self.renderer_known {
            self.pending_loads.insert(id.to_string(), load);
            return Vec::new();
        }
        self.create(id, &load)
    }

    /// The D3D11 renderer reads decoder textures directly; the others take the
    /// Media Engine's pictures (read back into memory).
    fn create(&mut self, id: &str, load: &PendingLoad) -> Vec<Value> {
        let result = match (self.renderer_device.clone(), &load.mixer) {
            (Some(device), Some(mixer)) => self.ensure_gpu().and_then(|()| {
                let gpu = self.gpu.as_ref().ok_or("no video device")?;
                ReaderPlayer::new(
                    source_url(&load.src),
                    &load.src,
                    &gpu.manager,
                    device,
                    mixer.clone(),
                    load.looped,
                    load.muted,
                    load.volume,
                    self.wake.clone(),
                )
                .map(|reader| {
                    self.readers.insert(id.to_string(), reader);
                })
            }),
            _ => self
                .create_player(&VideoLoad {
                    src: &load.src,
                    looped: load.looped,
                    muted: load.muted,
                    volume: load.volume,
                })
                .map(|player| {
                    self.players.insert(id.to_string(), player);
                }),
        };
        match result {
            Ok(()) => self.apply_rate(id),
            Err(message) => vec![media_error(id, failure(&load.src, message))],
        }
    }

    /// `textTracks[index].mode = "showing"` (`None`: no subtitles): cues of that embedded
    /// track come as `cuechange` events.
    pub(crate) fn set_text_track(&mut self, id: &str, index: Option<u32>) -> Vec<Value> {
        let Some(subtitles) = self.subtitles.get_mut(id) else {
            return vec![media_error(id, "media not loaded")];
        };
        match subtitles.select(index) {
            Ok(()) => Vec::new(),
            Err(message) => vec![media_error(id, message)],
        }
    }

    /// `audioTracks[index].enabled = true`: that stream plays alone, on either path.
    pub(crate) fn set_audio_track(&mut self, id: &str, index: u32) -> Vec<Value> {
        if let Some(reader) = self.readers.get_mut(id) {
            return match reader.set_audio_track(index) {
                Ok(()) => {
                    let mut event = reader_event(id, reader, "audiotracks");
                    event["audioTracks"] = AudioTrack::json(&reader.audio_tracks());
                    vec![event]
                }
                Err(message) => vec![media_error(id, message)],
            };
        }
        let Some(player) = self.players.get_mut(id) else {
            return vec![media_error(id, "media not loaded")];
        };
        if player.tracks.is_empty() {
            player.pending_track = Some(index);
            return Vec::new();
        }
        match player.select_audio(index) {
            Ok(()) => vec![player.tracks_event(id)],
            Err(message) => vec![media_error(id, message)],
        }
    }

    /// `playbackRate`: the sound keeps its pitch; pictures follow.
    pub(crate) fn set_rate(&mut self, id: &str, rate: f64) -> Vec<Value> {
        let rate = rate.clamp(0.0625, 16.0);
        if (rate - 1.0).abs() < 1e-9 {
            self.rates.remove(id);
        } else {
            self.rates.insert(id.to_string(), rate);
        }
        if let Some(reader) = self.readers.get_mut(id) {
            reader.set_rate(rate);
            return Vec::new();
        }
        if self.players.contains_key(id) {
            return self.apply_rate(id);
        }
        Vec::new()
    }

    /// Gives the player of `id` its rate (the Media Engine keeps the default across a source set later).
    fn apply_rate(&mut self, id: &str) -> Vec<Value> {
        let rate = self.rates.get(id).copied().unwrap_or(1.0);
        if let Some(reader) = self.readers.get_mut(id) {
            reader.set_rate(rate);
        }
        let Some(player) = self.players.get(id) else {
            return Vec::new();
        };
        let result = unsafe {
            player
                .engine
                .SetDefaultPlaybackRate(rate)
                .and_then(|()| player.engine.SetPlaybackRate(rate))
        };
        match result {
            Ok(()) => Vec::new(),
            Err(error) => vec![media_error(id, failure(&player.src, win(error)))],
        }
    }

    /// A video the Source Reader cannot hand over as NV12 textures (VP8): the
    /// Media Engine plays it instead, from where the reader was.
    fn engine_instead(&mut self, id: &str, reader: &ReaderPlayer) -> Option<Value> {
        let load = VideoLoad {
            src: &reader.src,
            looped: reader.looped(),
            muted: reader.muted(),
            volume: reader.volume(),
        };
        let mut player = match self.create_player(&load) {
            Ok(player) => player,
            Err(message) => return Some(media_error(id, failure(&reader.src, message))),
        };
        player.quiet_metadata = reader.duration().is_some() || reader.size() != (0, 0);
        let time = reader.time();
        let started = unsafe {
            (if time > 0.05 {
                player.engine.SetCurrentTime(time)
            } else {
                Ok(())
            })
            .and_then(|()| {
                if reader.playing {
                    player.engine.Play()
                } else {
                    Ok(())
                }
            })
        };
        self.players.insert(id.to_string(), player);
        started
            .err()
            .map(|error| media_error(id, failure(&reader.src, win(error))))
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
            self.pending_loads.remove(id);
            self.rates.remove(id);
            self.subtitles.remove(id);
            if self.players.remove(id).is_some() | self.readers.remove(id).is_some() {
                self.changed.push((id.to_string(), None));
            }
            return Vec::new();
        }
        if let Some(load) = self.pending_loads.get_mut(id) {
            match action {
                "play" => load.play = true,
                "pause" => load.play = false,
                "seek" => load.seek = time,
                "set" => {
                    load.looped = looped.unwrap_or(load.looped);
                    load.muted = muted.unwrap_or(load.muted);
                    load.volume = volume.map_or(load.volume, |v| v as f32);
                }
                _ => {}
            }
            return Vec::new();
        }
        if let Some(reader) = self.readers.get_mut(id) {
            let event = match action {
                "play" => reader.play().then_some("play"),
                "pause" => reader.pause().then_some("pause"),
                "seek" => {
                    reader.seek_to(time.unwrap_or(0.0), true);
                    Some("seeking")
                }
                "set" => {
                    reader.set(looped, muted, volume);
                    None
                }
                _ => None,
            };
            return event
                .map(|name| vec![reader_event(id, reader, name)])
                .unwrap_or_default();
        }
        let Some(player) = self.players.get_mut(id) else {
            return vec![media_error(id, "media not loaded")];
        };
        if let Some(opening) = player.opening.as_mut() {
            match action {
                "play" => opening.play = true,
                "pause" => opening.play = false,
                "seek" => opening.seek = time,
                _ => {}
            }
            if action != "set" {
                return Vec::new();
            }
        }
        let engine = &player.engine;
        let result = unsafe {
            match action {
                "play" => engine.Play(),
                "pause" => engine.Pause(),
                "seek" => player.seek(time.unwrap_or(0.0)),
                "set" => (|| {
                    if let Some(looped) = looped {
                        engine.SetLoop(looped)?;
                    }
                    if let Some(muted) = muted {
                        engine.SetMuted(muted)?;
                    }
                    if let Some(volume) = volume {
                        engine.SetVolume(volume.clamp(0.0, 1.0))?;
                    }
                    Ok(())
                })(),
                _ => Ok(()),
            }
        };
        match result {
            // `seeking` at once, as HTMLMediaElement fires it when the seek starts.
            Ok(()) if action == "seek" => vec![player.event(id, "seeking")],
            Ok(()) => Vec::new(),
            Err(error) => vec![media_error(id, failure(&player.src, win(error)))],
        }
    }

    /// Engine events become media events; due pictures are drawn.
    pub(crate) fn tick(&mut self, now: Instant) -> Vec<Value> {
        let mut out = std::mem::take(&mut self.pending);
        if self.players.is_empty() && self.readers.is_empty() {
            return out;
        }
        for (id, player) in &mut self.players {
            let opened = player.opening.as_ref().and_then(|_| {
                player
                    .shared
                    .stream
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .take()
            });
            if let Some(opened) = opened
                && let Err(message) = opened.and_then(|stream| player.open_stream(stream))
            {
                out.push(media_error(id, failure(&player.src, message)));
            }
            let events = std::mem::take(
                &mut *player
                    .shared
                    .events
                    .lock()
                    .unwrap_or_else(|p| p.into_inner()),
            );
            for event in events {
                let event = MF_MEDIA_ENGINE_EVENT(event as i32);
                let name = match event {
                    MF_MEDIA_ENGINE_EVENT_LOADEDMETADATA | MF_MEDIA_ENGINE_EVENT_FORMATCHANGE => {
                        player.size = player.size();
                        if event == MF_MEDIA_ENGINE_EVENT_LOADEDMETADATA {
                            player.tracks = engine_tracks(&player.engine);
                            if let Some(index) = player.pending_track.take()
                                && let Err(message) = player.select_audio(index)
                            {
                                out.push(media_error(id, message));
                            }
                            if !player.tracks.is_empty() {
                                out.push(player.tracks_event(id));
                            }
                        }
                        player.settle_until = Some(now + SETTLE_FOR);
                        (event == MF_MEDIA_ENGINE_EVENT_LOADEDMETADATA
                            && !std::mem::take(&mut player.quiet_metadata))
                        .then_some("loadedmetadata")
                    }
                    MF_MEDIA_ENGINE_EVENT_PLAY => {
                        player.playing = true;
                        Some("play")
                    }
                    MF_MEDIA_ENGINE_EVENT_PAUSE => {
                        player.playing = false;
                        (!std::mem::take(&mut player.ended_pause)).then_some("pause")
                    }
                    MF_MEDIA_ENGINE_EVENT_SEEKED => {
                        player.settle_until = Some(now + SETTLE_FOR);
                        player.seek_started = None;
                        out.push(player.event(id, "seeked"));
                        // A seek that waited for data: playing again.
                        std::mem::take(&mut player.waiting).then_some("canplay")
                    }
                    MF_MEDIA_ENGINE_EVENT_TIMEUPDATE => Some("timeupdate"),
                    MF_MEDIA_ENGINE_EVENT_ENDED => {
                        player.playing = false;
                        // The Media Engine stays unpaused at the end, so a later play()
                        // fired no `play` and its clock ran past the duration. Paused, as
                        // a browser's element is: play() starts over and ends again.
                        if !unsafe { player.engine.IsPaused() }.as_bool() {
                            player.ended_pause = unsafe { player.engine.Pause() }.is_ok();
                        }
                        Some("ended")
                    }
                    MF_MEDIA_ENGINE_EVENT_FIRSTFRAMEREADY => {
                        player.settle_until = Some(now + SETTLE_FOR);
                        None
                    }
                    MF_MEDIA_ENGINE_EVENT_CANPLAY => {
                        player.settle_until = Some(now + SETTLE_FOR);
                        Some("canplay")
                    }
                    // Not while it first opens: `loadedmetadata` and `canplay` tell that.
                    MF_MEDIA_ENGINE_EVENT_WAITING if player.size != (0, 0) && !player.waiting => {
                        player.waiting = true;
                        Some("waiting")
                    }
                    // Playing again after `waiting`: browsers fire `playing`; `canplay` ends the wait here.
                    MF_MEDIA_ENGINE_EVENT_PLAYING => {
                        std::mem::take(&mut player.waiting).then_some("canplay")
                    }
                    MF_MEDIA_ENGINE_EVENT_PROGRESS => Some("progress"),
                    MF_MEDIA_ENGINE_EVENT_ERROR => {
                        out.push(media_error(id, player.error_message()));
                        None
                    }
                    _ => None,
                };
                if let Some(name) = name {
                    out.push(player.event(id, name));
                }
            }
            // The engine reports no `waiting` while a seek downloads its target: as a
            // browser, a seek still under way while playing is a wait.
            if player.playing
                && !player.waiting
                && player
                    .seek_started
                    .is_some_and(|(started, _)| now.duration_since(started) >= SEEK_WAITING_AFTER)
            {
                player.waiting = true;
                out.push(player.event(id, "waiting"));
            }
        }
        // Embedded subtitles: the track list once known, then the cue under the current time.
        for (id, subtitles) in &mut self.subtitles {
            let base = if let Some(reader) = self.readers.get(id) {
                Some((reader.time(), reader_event(id, reader, "texttracks")))
            } else {
                self.players
                    .get(id)
                    .map(|player| (player.current_time(), player.event(id, "texttracks")))
            };
            let Some((time, base)) = base else { continue };
            for (name, field, value) in subtitles.tick(time) {
                let mut event = base.clone();
                event["event"] = json!(name);
                event[field] = value;
                out.push(event);
            }
        }
        let mut failed = Vec::new();
        for (id, reader) in &mut self.readers {
            match reader.tick(now) {
                Ok((events, changed)) => {
                    for name in events {
                        out.push(reader_event(id, reader, name));
                        if name == "loadedmetadata" {
                            let tracks = reader.audio_tracks();
                            if !tracks.is_empty() {
                                let mut event = reader_event(id, reader, "audiotracks");
                                event["audioTracks"] = AudioTrack::json(&tracks);
                                out.push(event);
                            }
                        }
                    }
                    if changed {
                        if reader.parked() {
                            self.repaint.push(id.clone());
                        }
                        let (width, height) = reader.size();
                        self.changed.push((
                            id.clone(),
                            Some(VideoFrame {
                                width,
                                height,
                                generation: reader.generation,
                                pixels: None,
                            }),
                        ));
                    }
                }
                Err(message) => failed.push((id.clone(), failure(&reader.src, message))),
            }
        }
        for (id, message) in failed {
            let reader = self.readers.remove(&id);
            self.changed.push((id.clone(), None));
            match reader.filter(ReaderPlayer::unsupported) {
                Some(reader) => {
                    out.extend(self.engine_instead(&id, &reader));
                    out.extend(self.apply_rate(&id));
                }
                None => out.push(media_error(&id, message)),
            }
        }
        let Some(gpu) = self.gpu.as_ref() else {
            return out;
        };
        for (id, player) in &mut self.players {
            let settling = player.settle_until.is_some_and(|until| until > now);
            // Again only once there is a picture to copy.
            let again = std::mem::take(&mut player.redraw) && player.generation > 0;
            if !player.playing && !settling && !again {
                player.settle_until = None;
                continue;
            }
            match player.transfer(gpu, again) {
                Ok(Some(frame)) => {
                    if !player.playing {
                        // The paused picture arrived: stop polling for it.
                        player.settle_until = None;
                    }
                    self.changed.push((id.clone(), Some(frame)));
                }
                Ok(None) => {}
                Err(message) => out.push(media_error(id, failure(&player.src, message))),
            }
        }
        out
    }

    /// Device pixels each video covered in the last paint: pictures are copied at
    /// that size; a paused one is copied again when it changes.
    pub(crate) fn set_display_sizes(&mut self, sizes: impl Fn(&str) -> Option<(u32, u32)>) {
        for (id, player) in &mut self.players {
            let size = sizes(id);
            if size != player.display {
                player.display = size;
                player.redraw = !player.playing;
            }
        }
    }

    /// Which videos the last UI frame drew: the ones off screen stop decoding
    /// pictures after a while (see `ReaderPlayer::set_visible`).
    pub(crate) fn set_visible(&mut self, visible: impl Fn(&str) -> bool) {
        let now = Instant::now();
        for (id, reader) in &mut self.readers {
            reader.set_visible(visible(id), now);
        }
        for (id, player) in &mut self.players {
            let shown = visible(id);
            if player.hidden && shown {
                // Back on screen: the current picture at once, even paused.
                player.redraw = true;
            }
            player.hidden = !shown;
        }
    }

    /// Videos whose last picture must be painted, not just presented (see `repaint`).
    pub(crate) fn take_repaint(&mut self) -> Vec<String> {
        std::mem::take(&mut self.repaint)
    }

    /// Pictures that changed (`None`: the video went away) since the last call.
    pub(crate) fn take_frames(&mut self) -> Vec<(String, Option<VideoFrame>)> {
        std::mem::take(&mut self.changed)
    }

    /// The current picture of video `id` (a reader's decoder texture).
    pub(crate) fn view(&self, id: &str) -> Option<VideoView> {
        self.readers.get(id).and_then(|reader| reader.view_now())
    }

    /// Texture views of the current pictures, for the D3D11 renderer to sample.
    pub(crate) fn views(&self) -> Vec<(String, VideoView)> {
        self.players
            .iter()
            .filter_map(|(id, player)| {
                let view = player.surface.as_ref()?.view.clone()?;
                Some((id.clone(), view))
            })
            .chain(
                self.readers
                    .iter()
                    .filter_map(|(id, reader)| Some((id.clone(), reader.view_now()?))),
            )
            .collect()
    }

    pub(crate) fn deadline(&self) -> Option<Instant> {
        let now = Instant::now();
        // Readers wake at their next picture's time, not on a fixed poll.
        let reading = self
            .readers
            .values()
            .filter_map(|reader| reader.due(now))
            .min();
        self.players
            .values()
            .filter_map(|player| {
                if player.playing && player.hidden && player.generation > 0 {
                    // Off screen: the engine only needs stepping through its pictures.
                    Some(now + HIDDEN_POLL)
                } else if player.playing {
                    Some(now + PLAYING_POLL)
                } else {
                    player
                        .settle_until
                        .filter(|until| *until > now)
                        .map(|_| now + SETTLE_POLL)
                }
            })
            .chain(reading)
            .min()
    }
}

fn reader_event(id: &str, reader: &ReaderPlayer, name: &str) -> Value {
    let (width, height) = reader.size();
    let mut event = json!({
        "type": "media",
        "id": id,
        "event": name,
        "time": reader.time(),
        "duration": reader.duration(),
        "paused": reader.paused(),
        "videoWidth": width,
        "videoHeight": height,
    });
    if let Some(buffered) = reader.buffered() {
        event["buffered"] = json!(buffered);
    }
    if name == "loadedmetadata" {
        event["filename"] = json!(reader.filename());
    }
    event
}
