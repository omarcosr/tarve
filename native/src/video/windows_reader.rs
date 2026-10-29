//! The D3D11 renderer's video path. Media Foundation's Source Reader decodes on
//! the GPU into NV12 textures the frame samples directly (converted to RGB in the
//! pixel shader): no conversion pass, no copy, as browsers do. The sound goes
//! through the app's audio mix, and pictures follow its clock.

use super::windows_shared::{SendCom, plane_array_view, win};
use super::windows_stream::{RemoteStream, VIDEO_WINDOW, content_type, streamable};
use crate::d3d11::VideoView;
use crate::media::remote::{Stream, is_remote};
use crate::stretch::Stretcher;
use rodio::mixer::Mixer;
use rodio::{Player, Source};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_DECODER, D3D11_BIND_SHADER_RESOURCE, ID3D11Device, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_R8_UNORM, DXGI_FORMAT_R8G8_UNORM};
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx};
use windows::Win32::System::Variant::VT_I8;
use windows::core::{GUID, HSTRING, Interface};
mod decode;
mod tracks;
#[allow(unused_imports)]
pub(crate) use decode::*;
pub(crate) use tracks::*;

/// Decoded pictures kept ahead of the clock. Decoders own a small pool of
/// surfaces; holding more would stall them.
const VIDEO_AHEAD: usize = 4;
/// Seconds of decoded sound kept ahead of the output.
const AUDIO_AHEAD: f64 = 0.5;
/// How long the reader sleeps with both queues full when no picture is taken
/// (the sound drains on the audio thread, which does not signal): well inside `AUDIO_AHEAD`.
const REFILL_WAIT: Duration = Duration::from_millis(100);
/// Samples the audio thread takes per lock (about 3 ms of stereo 48 kHz).
const FEED_CHUNK: usize = 256;
/// Out of data this long while playing before `waiting` is reported (a gap between
/// chunks is not a stall).
const WAITING_AFTER: Duration = Duration::from_millis(150);
/// `timeupdate` interval, as browsers fire it.
const TIMEUPDATE: Duration = Duration::from_millis(250);
/// Waiting on the reader (opening, a seek, the end): how often to look.
const SETTLE_POLL: Duration = Duration::from_millis(16);
/// Off screen this long before a silent video stops decoding pictures.
const SUSPEND_AFTER: Duration = Duration::from_secs(3);
/// Paused this long, a video lets go of its decoder (keeping a copy of its
/// picture), as browsers suspend idle media; play or seek opens it again.
const PARK_AFTER: Duration = Duration::from_secs(15);
/// Never wake sooner than this for a picture: the audio clock moves in device-buffer steps.
const MIN_WAKE: Duration = Duration::from_millis(1);

const VIDEO_STREAM: u32 = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
const AUDIO_STREAM: u32 = MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32;
const ANY_STREAM: u32 = MF_SOURCE_READER_ANY_STREAM.0 as u32;
const MEDIA_SOURCE: u32 = MF_SOURCE_READER_MEDIASOURCE.0 as u32;

/// What the file holds, known once the reader opened it.
#[derive(Clone, Copy)]
pub(super) struct Info {
    /// The picture's display size (the decoder's texture may be taller: 1080 in 1088).
    pub width: u32,
    pub height: u32,
    pub duration: Option<f64>,
    /// Channels and rate of the sound, if any.
    audio: Option<(u16, u32)>,
}

/// Decoded sound waiting for the output, and how much of it the output took.
struct Sound {
    samples: Mutex<VecDeque<f32>>,
    /// Samples played since the last seek: the clock.
    consumed: AtomicU64,
    stop: AtomicBool,
    /// Bumped by a seek: the feed drops the chunk it holds from before it.
    epoch: AtomicU64,
    /// `playbackRate` (f64 bits): the feed plays the sound this much faster, at its pitch.
    rate: AtomicU64,
}

/// rodio source over the decoded sound. Silence while it waits for more (a
/// stalled network): the clock only counts real samples, so pictures wait too.
struct Feed {
    sound: Arc<Sound>,
    channels: rodio::ChannelCount,
    rate: rodio::SampleRate,
    /// Samples taken from the queue in one lock, played from `at` on.
    chunk: Vec<f32>,
    at: usize,
    epoch: u64,
    /// Off the normal rate: the sound goes through a time stretch (kept until a seek).
    stretch: Option<Stretcher>,
    /// Media samples played but not yet counted in `consumed` (a fraction at other rates).
    credit: f64,
}

impl Feed {
    /// The next sample at `rate`: the stretch takes the sound `rate` times faster and the
    /// clock (`consumed`) counts the media samples it moved past.
    fn stretched(&mut self, rate: f64) -> f32 {
        let (channels, sample_rate) = (self.channels.get(), self.rate.get());
        let stretch = self
            .stretch
            .get_or_insert_with(|| Stretcher::new(channels, sample_rate));
        loop {
            if let Some(sample) = stretch.pull(rate) {
                self.credit += rate;
                let whole = self.credit as u64;
                if whole > 0 {
                    self.credit -= whole as f64;
                    self.sound.consumed.fetch_add(whole, Ordering::Relaxed);
                }
                return sample;
            }
            if self.at == self.chunk.len() {
                self.chunk.clear();
                self.at = 0;
                let mut samples = self.sound.samples.lock().unwrap_or_else(|p| p.into_inner());
                let take = samples.len().min(FEED_CHUNK);
                self.chunk.extend(samples.drain(..take));
                if self.chunk.is_empty() {
                    return 0.0;
                }
            }
            stretch.push(&self.chunk[self.at..]);
            self.at = self.chunk.len();
        }
    }
}

impl Iterator for Feed {
    type Item = rodio::Sample;
    fn next(&mut self) -> Option<Self::Item> {
        if self.sound.stop.load(Ordering::Relaxed) {
            return None;
        }
        let epoch = self.sound.epoch.load(Ordering::Acquire);
        if epoch != self.epoch {
            self.epoch = epoch;
            self.chunk.clear();
            self.at = 0;
            self.stretch = None;
            self.credit = 0.0;
        }
        let rate = f64::from_bits(self.sound.rate.load(Ordering::Relaxed));
        if self.stretch.is_some() || (rate - 1.0).abs() > 1e-6 {
            return Some(self.stretched(rate));
        }
        if self.at == self.chunk.len() {
            self.chunk.clear();
            self.at = 0;
            let mut samples = self.sound.samples.lock().unwrap_or_else(|p| p.into_inner());
            let take = samples.len().min(FEED_CHUNK);
            self.chunk.extend(samples.drain(..take));
            drop(samples);
            if self.chunk.is_empty() {
                return Some(0.0);
            }
        }
        let sample = self.chunk[self.at];
        self.at += 1;
        self.sound.consumed.fetch_add(1, Ordering::Relaxed);
        Some(sample)
    }
}

impl Source for Feed {
    fn current_span_len(&self) -> Option<usize> {
        None
    }
    fn channels(&self) -> rodio::ChannelCount {
        self.channels
    }
    fn sample_rate(&self) -> rodio::SampleRate {
        self.rate
    }
    fn total_duration(&self) -> Option<Duration> {
        None
    }
}

enum Request {
    Seek(f64),
    /// Decode pictures (true) or only the sound (false): a video off screen.
    Video(bool),
    /// Decode the sound (true) or not (false): a muted video.
    Audio(bool),
    /// Decode audio stream `index` instead (`audioTracks`); a seek follows it.
    AudioTrack(u32),
}

/// Shared between the event loop and the reader thread.
struct State {
    info: Option<Info>,
    /// Decoded pictures in order: presentation time (seconds) and the sample.
    video: VecDeque<(f64, SendCom<IMFSample>)>,
    video_done: bool,
    audio_done: bool,
    error: Option<String>,
    /// The decoder cannot hand out NV12 textures: the Media Engine plays it instead.
    unsupported: bool,
    requests: VecDeque<Request>,
    stop: bool,
    /// The app's own download behind a remote file: `buffered` and `filename`.
    remote: Option<Arc<Stream>>,
    /// The file's audio streams (`audioTracks`).
    tracks: Vec<AudioTrack>,
}

struct Shared {
    state: Mutex<State>,
    changed: Condvar,
    sound: Arc<Sound>,
    wake: Arc<dyn Fn() + Send + Sync>,
}

impl Shared {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// The picture on screen: its sample stays alive (the decoder must not reuse
/// the surface) while the renderer samples it.
struct Shown {
    /// `None` for a parked video's own copy of its picture.
    _sample: Option<SendCom<IMFSample>>,
    view: VideoView,
}

pub(super) struct ReaderPlayer {
    shared: Arc<Shared>,
    pub src: String,
    device: ID3D11Device,
    info: Option<Info>,
    output: Option<Arc<Player>>,
    mixer: Mixer,
    shown: Option<Shown>,
    views: HashMap<(usize, u32), VideoView>,
    /// The decoder's surfaces cannot be sampled here: each picture is copied.
    copying: bool,
    copy: Option<(ID3D11Texture2D, VideoView)>,
    pub generation: u64,
    pub playing: bool,
    looped: bool,
    muted: bool,
    volume: f32,
    /// Media time at the last seek (or start), and the wall clock while there is no sound.
    base: f64,
    wall: Option<Instant>,
    /// After a seek: show the picture at it, then report `seeked` (unless the seek
    /// was the player's own: the start, a loop).
    seeking: Option<(f64, bool)>,
    ended: bool,
    last_update: Instant,
    /// Off screen since then (`None`: painted by the last frame).
    hidden_since: Option<Instant>,
    /// Pictures are not decoded (off screen for a while, silent): the sound or the
    /// wall keeps the time, and coming back on screen seeks to it.
    suspended: bool,
    /// Muted: the sound is not decoded nor mixed; the wall keeps the time.
    audio_off: bool,
    /// What a parked video needs to open again.
    url: String,
    manager: SendCom<IMFDXGIDeviceManager>,
    wake: Arc<dyn Fn() + Send + Sync>,
    /// Paused since then (`None` while playing).
    paused_since: Option<Instant>,
    /// The reader is closed (paused for `PARK_AFTER`): only a copy of the picture is kept.
    parked: bool,
    /// Opened again after parking, until the reader knows the file once more.
    reopening: bool,
    /// `playbackRate`: media seconds per second, for the sound and the wall clock alike.
    rate: f64,
    /// Playing but out of data since then (`None`: not starved).
    starved_since: Option<Instant>,
    /// The audio stream chosen with `set_audio_track` (`None`: the first).
    audio_track: Option<u32>,
    /// `waiting` was reported; `canplay` ends it.
    waiting: bool,
    /// `canplay` was reported for this source.
    can_play: bool,
    /// The last `buffered` reported with `progress`.
    last_buffered: f64,
}

impl ReaderPlayer {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn new(
        url: String,
        src: &str,
        manager: &IMFDXGIDeviceManager,
        device: ID3D11Device,
        mixer: Mixer,
        looped: bool,
        muted: bool,
        volume: f32,
        wake: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<Self, String> {
        let manager = SendCom(manager.clone());
        // Muted from the start: the sound is never decoded.
        let requests = if muted {
            VecDeque::from([Request::Audio(false)])
        } else {
            VecDeque::new()
        };
        let shared = spawn_reader(&url, &manager, &wake, requests)?;
        Ok(Self {
            shared,
            src: src.to_string(),
            device,
            info: None,
            output: None,
            mixer,
            shown: None,
            views: HashMap::new(),
            copying: false,
            copy: None,
            generation: 0,
            playing: false,
            looped,
            muted,
            volume,
            base: 0.0,
            wall: None,
            seeking: Some((0.0, false)),
            ended: false,
            last_update: Instant::now(),
            hidden_since: None,
            suspended: false,
            audio_off: muted,
            url,
            manager,
            wake,
            paused_since: Some(Instant::now()),
            parked: false,
            reopening: false,
            rate: 1.0,
            starved_since: None,
            audio_track: None,
            waiting: false,
            can_play: false,
            last_buffered: -1.0,
        })
    }

    /// The media time the download reaches from the current one without a gap (the
    /// whole duration for a local file), as `HTMLMediaElement.buffered`'s current range end.
    pub(super) fn buffered(&self) -> Option<f64> {
        let duration = self.duration()?;
        let remote = self.shared.lock().remote.clone();
        Some(match remote {
            Some(stream) => duration * stream.buffered_from(self.time() / duration),
            None => duration,
        })
    }

    /// The file's audio streams, the one playing enabled.
    pub(super) fn audio_tracks(&self) -> Vec<AudioTrack> {
        self.shared.lock().tracks.clone()
    }

    /// Plays audio stream `index` from where it is: the reader switches streams and
    /// seeks there; the sound's output is reattached if its format differs.
    pub(super) fn set_audio_track(&mut self, index: u32) -> Result<(), String> {
        {
            let mut state = self.shared.lock();
            if !state.tracks.iter().any(|track| track.index == index) {
                return Err(format!("no audio track {index}"));
            }
            for track in &mut state.tracks {
                track.enabled = track.index == index;
            }
        }
        self.audio_track = Some(index);
        if self.parked {
            return Ok(());
        }
        self.shared
            .lock()
            .requests
            .push_back(Request::AudioTrack(index));
        let time = self.time();
        let ended = self.ended;
        self.seek_to(time, false);
        self.ended = ended;
        Ok(())
    }

    /// The served file's name (after redirects) for a remote source, else the path's.
    pub(super) fn filename(&self) -> String {
        match self.shared.lock().remote.clone() {
            Some(stream) => stream.filename(),
            None => self
                .src
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or_default()
                .to_string(),
        }
    }

    /// Playing and out of decoded data: the sound's queue ran dry (the clock stops), or a
    /// silent video's pictures did, before the end; or a seek is still under way (its
    /// target not downloaded yet), as a browser reports `waiting` while it seeks.
    fn starved(&self) -> bool {
        if !self.playing || self.ended || self.parked {
            return false;
        }
        if self.seeking.is_some() {
            return true;
        }
        let state = self.shared.lock();
        match self.sound() {
            Some(_) => {
                !state.audio_done
                    && self
                        .shared
                        .sound
                        .samples
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .is_empty()
            }
            None => !self.suspended && !state.video_done && state.video.is_empty(),
        }
    }

    /// The sound's channels and rate while it is the clock (not muted away).
    fn sound(&self) -> Option<(u16, u32)> {
        if self.audio_off {
            None
        } else {
            self.info.and_then(|info| info.audio)
        }
    }

    /// The output that plays the decoded sound, in the app's mix.
    fn attach_output(&mut self) {
        let Some((channels, rate)) = self.sound() else {
            return;
        };
        if self.output.is_some() {
            return;
        }
        let player = Arc::new(Player::connect_new(&self.mixer));
        player.pause();
        player.append(Feed {
            sound: self.shared.sound.clone(),
            channels: std::num::NonZero::new(channels).unwrap_or(std::num::NonZero::<u16>::MIN),
            rate: std::num::NonZero::new(rate).unwrap_or(std::num::NonZero::<u32>::MIN),
            chunk: Vec::with_capacity(FEED_CHUNK),
            at: 0,
            epoch: self.shared.sound.epoch.load(Ordering::Acquire),
            stretch: None,
            credit: 0.0,
        });
        self.output = Some(player);
        self.apply_volume();
    }

    /// Mutes by not decoding the sound at all (the wall clock takes over), and
    /// unmutes by decoding it again from the current time.
    fn set_audio(&mut self, on: bool) {
        if self.info.is_some_and(|info| info.audio.is_none()) || on != self.audio_off {
            return;
        }
        let time = self.time();
        if on {
            self.audio_off = false;
            // Parked: the reader opens again with sound when it plays or seeks (an
            // output attached now would read the closed reader's sound and stop the clock).
            if self.parked {
                return;
            }
            self.shared.lock().requests.push_back(Request::Audio(true));
            if self.info.is_some() {
                self.attach_output();
                let ended = self.ended;
                self.seek_to(time, false);
                self.ended = ended;
                self.resume_clock();
            }
        } else {
            self.base = time;
            self.shared.sound.consumed.store(0, Ordering::Relaxed);
            self.audio_off = true;
            self.wall = self.playing.then(Instant::now);
            self.output = None;
            self.shared.lock().requests.push_back(Request::Audio(false));
            self.shared.changed.notify_one();
        }
    }

    /// Paused long enough: keep a copy of the picture, close the reader (and with
    /// it the decoder and its surfaces). True when it parked.
    fn park(&mut self, now: Instant) -> Result<bool, String> {
        let due = self
            .paused_since
            .is_some_and(|since| now.duration_since(since) >= PARK_AFTER);
        if self.parked
            || self.playing
            || self.reopening
            || self.seeking.is_some()
            || self.info.is_none()
            || !due
        {
            return Ok(false);
        }
        let Some(Shown {
            view:
                VideoView::Nv12 {
                    uv,
                    source: Some((texture, slice)),
                    ..
                },
            ..
        }) = &self.shown
        else {
            return Ok(false);
        };
        let (uv, texture, slice) = (*uv, texture.clone(), *slice);
        let mut desc = Default::default();
        unsafe { texture.GetDesc(&mut desc) };
        desc.ArraySize = 1;
        desc.MipLevels = 1;
        desc.BindFlags = D3D11_BIND_SHADER_RESOURCE.0 as u32;
        desc.MiscFlags = 0;
        desc.CPUAccessFlags = 0;
        desc.Usage = windows::Win32::Graphics::Direct3D11::D3D11_USAGE_DEFAULT;
        let mut copy = None;
        unsafe { self.device.CreateTexture2D(&desc, None, Some(&mut copy)) }.map_err(win)?;
        let copy = copy.ok_or("video picture copy was not created")?;
        unsafe {
            let context = self.device.GetImmediateContext().map_err(win)?;
            context.CopySubresourceRegion(&copy, 0, 0, 0, 0, &texture, slice, None);
        }
        let view = VideoView::Nv12 {
            luma: plane_array_view(&self.device, &copy, DXGI_FORMAT_R8_UNORM, 0)?,
            chroma: plane_array_view(&self.device, &copy, DXGI_FORMAT_R8G8_UNORM, 0)?,
            uv,
            source: Some((copy, 0)),
        };
        // Nothing may hold the decoder's textures any more.
        self.shown = Some(Shown {
            _sample: None,
            view,
        });
        self.views.clear();
        self.copy = None;
        self.output = None;
        self.stop_reader();
        self.parked = true;
        self.generation += 1;
        Ok(true)
    }

    /// Opens a parked video again where it was; its picture stays until the new one.
    fn unpark(&mut self) -> Result<(), String> {
        if !self.parked {
            return Ok(());
        }
        let mut requests = VecDeque::new();
        if self.audio_off {
            requests.push_back(Request::Audio(false));
        }
        if let Some(track) = self.audio_track {
            requests.push_back(Request::AudioTrack(track));
        }
        self.shared = spawn_reader(&self.url, &self.manager, &self.wake, requests)?;
        self.shared
            .sound
            .rate
            .store(self.rate.to_bits(), Ordering::Relaxed);
        self.parked = false;
        self.reopening = true;
        let ended = self.ended;
        self.seek_to(self.base, false);
        self.ended = ended;
        Ok(())
    }

    fn stop_reader(&self) {
        self.shared.sound.stop.store(true, Ordering::Relaxed);
        self.shared.lock().stop = true;
        self.shared.changed.notify_all();
    }

    /// Failed because the decoder hands out no NV12 textures (the Media Engine can play it).
    pub(super) fn unsupported(&self) -> bool {
        self.shared.lock().unsupported
    }

    pub(super) fn size(&self) -> (u32, u32) {
        self.info.map_or((0, 0), |info| (info.width, info.height))
    }

    pub(super) fn duration(&self) -> Option<f64> {
        self.info.and_then(|info| info.duration)
    }

    /// The media time now: the sound's clock, or the wall clock without sound.
    pub(super) fn time(&self) -> f64 {
        let sound = self.sound();
        let state_done = self.shared.lock().audio_done;
        let pending = self
            .shared
            .sound
            .samples
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .len();
        match sound {
            // While there is sound to play, it is the clock (a sound that ended earlier hands over to the wall).
            Some((channels, rate)) if !(state_done && pending == 0 && self.wall.is_some()) => {
                self.base
                    + self.shared.sound.consumed.load(Ordering::Relaxed) as f64
                        / (f64::from(rate) * f64::from(channels))
            }
            _ => {
                self.base
                    + self
                        .wall
                        .map_or(0.0, |since| since.elapsed().as_secs_f64() * self.rate)
            }
        }
    }

    /// The sound track ended and every decoded sample was taken: the wall clock
    /// carries the rest of a video that runs longer than its sound.
    fn audio_drained(&self) -> bool {
        self.sound().is_some()
            && self.shared.lock().audio_done
            && self
                .shared
                .sound
                .samples
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .is_empty()
    }

    /// Hands the clock from the sound to the wall once the sound is drained.
    fn hand_over_clock(&mut self) {
        if self.playing && self.wall.is_none() && self.audio_drained() {
            self.base = self.time();
            self.shared.sound.consumed.store(0, Ordering::Relaxed);
            self.wall = Some(Instant::now());
        }
    }

    fn apply_volume(&self) {
        if let Some(output) = &self.output {
            output.set_volume(if self.muted { 0.0 } else { self.volume });
        }
    }

    pub(super) fn set(&mut self, looped: Option<bool>, muted: Option<bool>, volume: Option<f64>) {
        if let Some(looped) = looped {
            self.looped = looped;
        }
        if let Some(muted) = muted {
            self.muted = muted;
            self.set_audio(!muted);
        }
        if let Some(volume) = volume {
            self.volume = volume.clamp(0.0, 1.0) as f32;
        }
        self.apply_volume();
    }

    /// `playbackRate`: the sound plays this much faster at its own pitch, pictures follow.
    pub(super) fn set_rate(&mut self, rate: f64) {
        let rate = rate.clamp(0.0625, 16.0);
        if self.wall.is_some() {
            self.base = self.time();
            self.wall = Some(Instant::now());
        }
        self.rate = rate;
        self.shared
            .sound
            .rate
            .store(rate.to_bits(), Ordering::Relaxed);
    }

    pub(super) fn play(&mut self) -> bool {
        if self.playing {
            return false;
        }
        if let Err(error) = self.unpark() {
            self.shared.lock().error = Some(error);
            return false;
        }
        self.paused_since = None;
        if self.ended {
            self.ended = false;
            self.seek_to(0.0, false);
        }
        self.playing = true;
        self.resume_clock();
        true
    }

    pub(super) fn pause(&mut self) -> bool {
        if !self.playing {
            return false;
        }
        self.base = self.time();
        self.shared.sound.consumed.store(0, Ordering::Relaxed);
        self.wall = None;
        if let Some(output) = &self.output {
            output.pause();
        }
        self.playing = false;
        self.paused_since = Some(Instant::now());
        true
    }

    fn resume_clock(&mut self) {
        if !self.playing {
            return;
        }
        match self.sound() {
            Some(_) => {
                if let Some(output) = &self.output {
                    output.play();
                }
                self.hand_over_clock();
            }
            None => self.wall = Some(Instant::now()),
        }
    }

    pub(super) fn seek_to(&mut self, time: f64, report: bool) {
        if let Err(error) = self.unpark() {
            self.shared.lock().error = Some(error);
            return;
        }
        if !self.playing {
            self.paused_since = Some(Instant::now());
        }
        let time = match self.duration() {
            Some(duration) => time.clamp(0.0, duration),
            None => time.max(0.0),
        };
        self.base = time;
        self.shared.sound.consumed.store(0, Ordering::Relaxed);
        self.shared.sound.epoch.fetch_add(1, Ordering::Release);
        if self.sound().is_some() {
            // The sound plays again from the target: it is the clock until it drains.
            self.wall = None;
        } else if self.wall.is_some() {
            self.wall = Some(Instant::now());
        }
        self.seeking = Some((time, report));
        self.ended = false;
        let mut state = self.shared.lock();
        state.requests.push_back(Request::Seek(time));
        drop(state);
        self.shared.changed.notify_all();
    }

    /// The decoder texture slice as shader views (cached per surface).
    fn view(&mut self, sample: &IMFSample) -> Result<VideoView, String> {
        let (texture, slice) = unsafe {
            let buffer = sample.GetBufferByIndex(0).map_err(win)?;
            let dxgi: IMFDXGIBuffer = buffer.cast().map_err(win)?;
            let mut raw = std::ptr::null_mut();
            dxgi.GetResource(&ID3D11Texture2D::IID, &mut raw)
                .map_err(win)?;
            let texture = ID3D11Texture2D::from_raw(raw);
            (texture, dxgi.GetSubresourceIndex().map_err(win)?)
        };
        let key = (texture.as_raw() as usize, slice);
        if !self.copying
            && let Some(view) = self.views.get(&key)
        {
            return Ok(view.clone());
        }
        let (width, height) = self.size();
        let mut desc = Default::default();
        unsafe { texture.GetDesc(&mut desc) };
        let uv = [
            width as f32 / desc.Width.max(1) as f32,
            height as f32 / desc.Height.max(1) as f32,
        ];
        if !self.copying {
            let direct = plane_array_view(&self.device, &texture, DXGI_FORMAT_R8_UNORM, slice)
                .and_then(|luma| {
                    Ok(VideoView::Nv12 {
                        luma,
                        chroma: plane_array_view(
                            &self.device,
                            &texture,
                            DXGI_FORMAT_R8G8_UNORM,
                            slice,
                        )?,
                        uv,
                        source: Some((texture.clone(), slice)),
                    })
                });
            match direct {
                Ok(view) => {
                    self.views.insert(key, view.clone());
                    return Ok(view);
                }
                // This decoder's surfaces cannot be sampled: copy each picture instead.
                Err(_) => self.copying = true,
            }
        }
        // One GPU copy of the slice into a texture the shader can read (no conversion).
        let reuse = self.copy.as_ref().is_some_and(|(copy, _)| {
            let mut existing = Default::default();
            unsafe { copy.GetDesc(&mut existing) };
            existing.Width == desc.Width && existing.Height == desc.Height
        });
        if !reuse {
            let mut copy_desc = desc;
            copy_desc.ArraySize = 1;
            copy_desc.MipLevels = 1;
            copy_desc.BindFlags = D3D11_BIND_SHADER_RESOURCE.0 as u32;
            copy_desc.MiscFlags = 0;
            copy_desc.CPUAccessFlags = 0;
            copy_desc.Usage = windows::Win32::Graphics::Direct3D11::D3D11_USAGE_DEFAULT;
            let mut copy = None;
            unsafe {
                self.device
                    .CreateTexture2D(&copy_desc, None, Some(&mut copy))
            }
            .map_err(win)?;
            let copy = copy.ok_or("video copy texture was not created")?;
            let view = VideoView::Nv12 {
                luma: plane_array_view(&self.device, &copy, DXGI_FORMAT_R8_UNORM, 0)?,
                chroma: plane_array_view(&self.device, &copy, DXGI_FORMAT_R8G8_UNORM, 0)?,
                uv,
                source: Some((copy.clone(), 0)),
            };
            self.copy = Some((copy, view));
        }
        let (copy, view) = self.copy.as_ref().unwrap();
        unsafe {
            let context = self.device.GetImmediateContext().map_err(win)?;
            context.CopySubresourceRegion(copy, 0, 0, 0, 0, &texture, slice, None);
        }
        Ok(view.clone())
    }

    pub(super) fn view_now(&self) -> Option<VideoView> {
        self.shown.as_ref().map(|shown| shown.view.clone())
    }

    /// Events (by name) and whether a new picture is on screen.
    pub(super) fn tick(&mut self, now: Instant) -> Result<(Vec<&'static str>, bool), String> {
        let mut events = Vec::new();
        let (info, error) = {
            let state = self.shared.lock();
            (state.info, state.error.clone())
        };
        if let Some(error) = error {
            return Err(error);
        }
        if self.info.is_none()
            && let Some(info) = info
        {
            self.info = Some(info);
            self.attach_output();
            events.push("loadedmetadata");
            self.resume_clock();
        }
        // Another audio track with another format: the output plays it as it is now.
        if let (Some(known), Some(info)) = (self.info.as_mut(), info)
            && known.audio != info.audio
        {
            known.audio = info.audio;
            self.output = None;
            self.attach_output();
            self.resume_clock();
        }
        if self.reopening && info.is_some() {
            // Opened again after parking: same file, no new `loadedmetadata`.
            self.reopening = false;
            self.attach_output();
            self.resume_clock();
        }
        if self.info.is_none() || self.reopening {
            return Ok((events, false));
        }
        if self.park(now)? {
            return Ok((events, true));
        }
        if self.parked {
            return Ok((events, false));
        }
        // A seek the reader has not carried out yet: the pictures queued are from before it.
        let pending = !self.shared.lock().requests.is_empty();
        let mut changed = false;
        if !pending {
            self.hand_over_clock();
            // Before the lock: the clock reads the shared state too.
            let clock = self.time();
            let mut state = self.shared.lock();
            let mut next = None;
            if let Some((target, _)) = self.seeking {
                // The picture showing at the target: the reader starts at the key
                // frame before it, so the ones in between are skipped.
                while state.video.len() > 1 && state.video[1].0 <= target + 0.0005 {
                    state.video.pop_front();
                }
                let settled = self.suspended
                    || state.video.len() > 1
                    || state.video_done
                    || state
                        .video
                        .front()
                        .is_some_and(|(time, _)| *time + 0.0005 >= target);
                if settled {
                    next = state.video.pop_front();
                }
                if next.is_none() && settled {
                    // Nothing to show (past the end): the seek is still done.
                    if let Some((_, true)) = self.seeking.take() {
                        events.push("seeked");
                    }
                }
            } else if self.playing {
                while state.video.front().is_some_and(|(time, _)| *time <= clock) {
                    next = state.video.pop_front();
                }
            }
            // Without pictures the clock tells the end.
            let pictures_done = if self.suspended {
                self.duration().is_some_and(|duration| clock >= duration)
            } else {
                state.video_done && state.video.is_empty()
            };
            let ended = self.playing
                && pictures_done
                && (state.audio_done || self.sound().is_none())
                && self
                    .shared
                    .sound
                    .samples
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .is_empty();
            drop(state);
            if next.is_some() {
                // A slot freed in the picture queue: the reader may decode the next one.
                self.shared.changed.notify_one();
            }
            if let Some((_, sample)) = next {
                let view = self.view(&sample.0)?;
                self.shown = Some(Shown {
                    _sample: Some(sample),
                    view,
                });
                self.generation += 1;
                changed = true;
                if let Some((_, true)) = self.seeking.take() {
                    events.push("seeked");
                }
            }
            if ended {
                if self.looped {
                    self.seek_to(0.0, false);
                } else {
                    self.base = self.duration().unwrap_or_else(|| self.time());
                    self.shared.sound.consumed.store(0, Ordering::Relaxed);
                    self.wall = None;
                    if let Some(output) = &self.output {
                        output.pause();
                    }
                    self.playing = false;
                    self.ended = true;
                    self.paused_since = Some(now);
                    events.push("ended");
                }
            }
        }
        if !self.can_play && changed {
            self.can_play = true;
            events.push("canplay");
        }
        // Out of data for a moment (a stalled network): `waiting`, then `canplay` when it plays again.
        if self.starved() {
            let since = *self.starved_since.get_or_insert(now);
            if !self.waiting && now.duration_since(since) >= WAITING_AFTER {
                self.waiting = true;
                events.push("waiting");
            }
        } else {
            self.starved_since = None;
            if std::mem::take(&mut self.waiting) {
                events.push("canplay");
            }
        }
        if self.playing && now.duration_since(self.last_update) >= TIMEUPDATE {
            self.last_update = now;
            events.push("timeupdate");
            if let Some(buffered) = self.buffered()
                && (buffered - self.last_buffered).abs() >= 0.25
            {
                self.last_buffered = buffered;
                events.push("progress");
            }
        }
        Ok((events, changed))
    }

    /// When the event loop should look again: when the next queued picture is due
    /// on the media clock (not on a fixed poll), the next `timeupdate`, or soon while
    /// the reader settles. An empty queue waits for the reader's wake.
    pub(super) fn due(&self, now: Instant) -> Option<Instant> {
        if !self.playing {
            if self.settling() {
                return Some(now + SETTLE_POLL);
            }
            // Wake once to park it when it has been paused long enough.
            return (!self.parked && self.shown.is_some())
                .then_some(self.paused_since?)
                .map(|since| (since + PARK_AFTER).max(now + MIN_WAKE));
        }
        let timeupdate = (self.last_update + TIMEUPDATE).max(now + MIN_WAKE);
        if self.settling() {
            return Some((now + SETTLE_POLL).min(timeupdate));
        }
        if self.wall.is_none() && self.audio_drained() {
            // The sound ran out before the pictures: hand the clock to the wall now.
            return Some(now + MIN_WAKE);
        }
        let clock = self.time();
        if self.suspended {
            // No pictures: only the end, or the next `timeupdate`.
            let end = self.duration().map_or(timeupdate, |duration| {
                now + Duration::from_secs_f64(
                    (duration - clock).clamp(0.0, TIMEUPDATE.as_secs_f64()),
                )
            });
            return Some(end.max(now + MIN_WAKE).min(timeupdate));
        }
        let state = self.shared.lock();
        let at = if !state.requests.is_empty() {
            now + SETTLE_POLL
        } else {
            match state.video.front() {
                Some((time, _)) => {
                    now + Duration::from_secs_f64(
                        (time - clock).clamp(0.0, TIMEUPDATE.as_secs_f64()),
                    )
                }
                None if state.video_done => now + SETTLE_POLL,
                None => timeupdate,
            }
        };
        Some(at.max(now + MIN_WAKE).min(timeupdate))
    }

    /// Whether the last UI frame drew this video. Off screen for `SUSPEND_AFTER`
    /// while playing silently (muted, or no sound): stop decoding pictures, as
    /// browsers drop the video track of hidden media. Back on screen: decode again
    /// from the current time. Pictures nobody sees cost nothing; the time, events
    /// and sound go on.
    pub(super) fn set_visible(&mut self, visible: bool, now: Instant) {
        if visible {
            self.hidden_since = None;
            if self.suspended {
                self.suspended = false;
                self.shared.lock().requests.push_back(Request::Video(true));
                // Decode again from the current time (the last picture of a video
                // that ended meanwhile); an ended video stays ended, so play() restarts it.
                let ended = self.ended;
                let time = self.time();
                self.seek_to(time, false);
                self.ended = ended;
            }
            return;
        }
        let since = *self.hidden_since.get_or_insert(now);
        let silent = self.muted || self.info.is_some_and(|info| info.audio.is_none());
        if !self.suspended
            && self.playing
            && silent
            && self.seeking.is_none()
            && self.duration().is_some()
            && now.duration_since(since) >= SUSPEND_AFTER
        {
            self.suspended = true;
            self.shared.lock().requests.push_back(Request::Video(false));
            self.shared.changed.notify_one();
        }
    }

    /// The reader is closed; a copy of the picture shows.
    pub(super) fn parked(&self) -> bool {
        self.parked
    }

    pub(super) fn paused(&self) -> bool {
        !self.playing
    }

    /// Waiting on the reader (opening, or the picture at a seek target): poll it.
    pub(super) fn settling(&self) -> bool {
        self.info.is_none() || self.reopening || self.seeking.is_some()
    }

    pub(super) fn looped(&self) -> bool {
        self.looped
    }

    pub(super) fn muted(&self) -> bool {
        self.muted
    }

    pub(super) fn volume(&self) -> f32 {
        self.volume
    }

    pub(super) fn mixer(&self) -> Mixer {
        self.mixer.clone()
    }
}

impl Drop for ReaderPlayer {
    fn drop(&mut self) {
        self.stop_reader();
    }
}

/// Starts a reader thread on `url` with `requests` queued before it reads.
fn spawn_reader(
    url: &str,
    manager: &SendCom<IMFDXGIDeviceManager>,
    wake: &Arc<dyn Fn() + Send + Sync>,
    requests: VecDeque<Request>,
) -> Result<Arc<Shared>, String> {
    let shared = Arc::new(Shared {
        state: Mutex::new(State {
            info: None,
            video: VecDeque::new(),
            video_done: false,
            audio_done: false,
            error: None,
            unsupported: false,
            requests,
            stop: false,
            remote: None,
            tracks: Vec::new(),
        }),
        changed: Condvar::new(),
        sound: Arc::new(Sound {
            samples: Mutex::new(VecDeque::new()),
            consumed: AtomicU64::new(0),
            stop: AtomicBool::new(false),
            epoch: AtomicU64::new(0),
            rate: AtomicU64::new(1.0f64.to_bits()),
        }),
        wake: wake.clone(),
    });
    let thread_shared = shared.clone();
    let url = url.to_string();
    let manager = SendCom(manager.0.clone());
    std::thread::Builder::new()
        .name("tarve-video-reader".into())
        .spawn(move || reader_thread(thread_shared, url, manager))
        .map_err(|error| error.to_string())?;
    Ok(shared)
}
