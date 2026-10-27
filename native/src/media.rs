//! `<audio>` (and the sound of `<video>`): files and HTTP(S) streams decoded by
//! Symphonia and played through the default output device (WASAPI on Windows,
//! ALSA on Linux). Commands follow HTMLMediaElement: load, play, pause, seek,
//! volume, muted and loop; events mirror its loadedmetadata, play, pause,
//! timeupdate, ended and error.
//!
//! A remote `src` streams like a browser's: playback starts once the first
//! chunk arrives, the rest downloads behind it with HTTP range requests, and a
//! seek fetches the chunk it lands in first.

use crate::stretch::Stretcher;
use rodio::mixer::{Mixer, MixerSource};
use rodio::{Decoder, DeviceSinkBuilder, MixerDeviceSink, Player, Source};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, Read, Seek};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

/// HTMLMediaElement fires timeupdate every 15–250 ms; Tarve uses 250 ms.
const TIME_UPDATE: Duration = Duration::from_millis(250);
/// How often a pending remote load is checked while it connects.
const LOAD_POLL: Duration = Duration::from_millis(50);

#[cfg_attr(not(feature = "net"), allow(dead_code))]
pub(crate) mod remote;

type Sound = Box<dyn Source + Send>;

/// `playbackRate` over a sound: at 1 it passes the samples through; otherwise a
/// time stretch plays it that much faster at its own pitch (until a seek).
struct Stretched {
    inner: Sound,
    rate: Arc<AtomicU64>,
    gate: Option<Gate>,
    /// Silent samples still to play while the gate waits for the network.
    silence: usize,
    /// Samples since the gate was last looked at.
    since_check: usize,
    stretch: Option<(Stretcher, rodio::ChannelCount, rodio::SampleRate)>,
    /// Samples passed through in the current frame: a stretch starts on a frame boundary.
    phase: usize,
    done: bool,
}

/// A remote sound's guard against the network: when the bytes the decoder reads next
/// have not arrived it plays silence instead of blocking the audio thread (which
/// stalls every sound in the mix), and the silence is kept out of the media clock.
#[derive(Clone)]
struct Gate {
    stream: Arc<remote::Stream>,
    shared: Arc<GateState>,
}

#[derive(Default)]
struct GateState {
    /// Seconds of silence played for the network (f64 bits), in the player's time.
    silence: AtomicU64,
    /// Waiting for the network now.
    starved: AtomicBool,
}

impl GateState {
    fn silence(&self) -> f64 {
        f64::from_bits(self.silence.load(Ordering::Relaxed))
    }
}

/// Bytes ahead of the decoder's last read that must have arrived before it reads on: its
/// largest read (symphonia's source buffer), so the read that would block never starts.
const GATE_MARGIN: u64 = 64 * 1024;
/// Samples between looks at the network, and the silence played per look while it waits.
const GATE_STEP: usize = 1024;

impl Stretched {
    /// Whether to play silence now (at a frame boundary), checking the network every
    /// `GATE_STEP` samples.
    fn gated(&mut self) -> bool {
        let Some(gate) = &self.gate else {
            return false;
        };
        if self.silence == 0 && self.since_check < GATE_STEP {
            self.since_check += 1;
            return false;
        }
        self.since_check = 0;
        if self.silence == 0 {
            let blocked = gate.stream.would_block(GATE_MARGIN);
            gate.shared.starved.store(blocked, Ordering::Relaxed);
            if !blocked {
                return false;
            }
            let channels = usize::from(self.channels().get());
            self.silence = GATE_STEP.div_ceil(channels) * channels;
            // Look again as soon as this silence is played.
            self.since_check = GATE_STEP;
        }
        true
    }

    fn silent_sample(&mut self) -> rodio::Sample {
        self.silence -= 1;
        if let Some(gate) = &self.gate {
            let per =
                1.0 / (f64::from(self.sample_rate().get()) * f64::from(self.channels().get()));
            let total = gate.shared.silence() + per;
            gate.shared
                .silence
                .store(total.to_bits(), Ordering::Relaxed);
        }
        0.0
    }
}

fn stretched(inner: Sound, rate: &Arc<AtomicU64>, gate: Option<Gate>) -> Sound {
    Box::new(Stretched {
        inner,
        rate: rate.clone(),
        gate,
        silence: 0,
        since_check: 0,
        stretch: None,
        phase: 0,
        done: false,
    })
}

impl Iterator for Stretched {
    type Item = rodio::Sample;
    fn next(&mut self) -> Option<Self::Item> {
        let rate = f64::from_bits(self.rate.load(Ordering::Relaxed));
        if self.silence > 0 {
            return Some(self.silent_sample());
        }
        if self.stretch.is_none() && ((rate - 1.0).abs() < 1e-6 || self.phase != 0) {
            if self.phase == 0 && self.gated() {
                return Some(self.silent_sample());
            }
            let sample = self.inner.next()?;
            self.phase = (self.phase + 1) % usize::from(self.inner.channels().get());
            return Some(sample);
        }
        let (channels, sample_rate) = (self.inner.channels(), self.inner.sample_rate());
        if self.stretch.is_none() {
            self.stretch = Some((
                Stretcher::new(channels.get(), sample_rate.get()),
                channels,
                sample_rate,
            ));
        }
        loop {
            if let Some((stretch, ..)) = self.stretch.as_mut()
                && let Some(sample) = stretch.pull(rate)
            {
                return Some(sample);
            }
            if self.done {
                return None;
            }
            // Between stretch blocks: a frame boundary.
            self.since_check = GATE_STEP;
            if self.gated() {
                return Some(self.silent_sample());
            }
            let mut chunk = Vec::with_capacity(2048);
            while chunk.len() < 2048 {
                match self.inner.next() {
                    Some(sample) => chunk.push(sample),
                    None => {
                        self.done = true;
                        break;
                    }
                }
            }
            if let Some((stretch, ..)) = self.stretch.as_mut() {
                stretch.push(&chunk);
                if self.done {
                    stretch.finish();
                }
            }
        }
    }
}

impl Source for Stretched {
    fn current_span_len(&self) -> Option<usize> {
        match self.stretch {
            Some(_) => None,
            None => self.inner.current_span_len(),
        }
    }
    fn channels(&self) -> rodio::ChannelCount {
        self.stretch
            .as_ref()
            .map_or_else(|| self.inner.channels(), |(_, channels, _)| *channels)
    }
    fn sample_rate(&self) -> rodio::SampleRate {
        self.stretch
            .as_ref()
            .map_or_else(|| self.inner.sample_rate(), |(_, _, rate)| *rate)
    }
    fn total_duration(&self) -> Option<Duration> {
        self.inner.total_duration()
    }
    fn try_seek(&mut self, position: Duration) -> Result<(), rodio::source::SeekError> {
        self.inner.try_seek(position)?;
        self.stretch = None;
        self.silence = 0;
        self.phase = 0;
        self.done = false;
        Ok(())
    }
}
/// What a remote load hands back: the sound, its duration and the stream behind it.
type Loaded = Result<(Sound, Option<f64>, Arc<remote::Stream>), String>;

/// Where a track's bytes come from, kept so loop and replay reopen it cheaply.
enum Origin {
    File,
    Remote(Arc<remote::Stream>),
}

/// A seekable decoder being built for a remote track, and where to seek once it is.
struct Rebuild {
    sound: mpsc::Receiver<Result<Sound, String>>,
    target: f64,
}

/// A seek the audio thread has yet to perform, and the one asked for meanwhile.
struct PendingSeek {
    done: mpsc::Receiver<Result<(), String>>,
    target: f64,
    next: Option<f64>,
}

struct Track {
    /// Shared with the thread waiting for a seek: rodio performs a seek on the
    /// audio thread and `try_seek` blocks until it has, so it never runs on the
    /// event loop (a stalled or lost device would freeze the window).
    player: Arc<Player>,
    seeking: Option<PendingSeek>,
    src: String,
    origin: Origin,
    /// Remote MP4s start unseekable: a seekable one first reads every fragment
    /// header across the file. The first seek builds that one in the background.
    seekable: bool,
    rebuild: Option<Rebuild>,
    duration: Option<f64>,
    looped: bool,
    volume: f32,
    muted: bool,
    ended: bool,
    /// `playbackRate` (f64 bits), read by the sound's time stretch.
    rate: Arc<AtomicU64>,
    /// The player's position and the media time it stood for when the rate last changed
    /// (or the sound restarted): media time runs `rate` times the player's from there.
    clock: (f64, f64),
    /// `waiting` was reported (the download stalled); `canplay` ends it.
    waiting: bool,
    /// The network guard's state, shared with the sound (remote tracks).
    gate: Arc<GateState>,
}

impl Track {
    fn rate(&self) -> f64 {
        f64::from_bits(self.rate.load(Ordering::Relaxed))
    }

    /// The media time now: the player counts played samples, `rate` media seconds each second.
    fn time(&self) -> f64 {
        (self.clock.1 + (self.played() - self.clock.0) * self.rate()).max(0.0)
    }

    /// The player's position without the silence played while the network stalled.
    fn played(&self) -> f64 {
        self.player.get_pos().as_secs_f64() - self.gate.silence()
    }

    /// The sound for this track's player: the rate, and the network guard when remote.
    fn sound(&self, sound: Sound) -> Sound {
        let gate = match &self.origin {
            Origin::Remote(stream) => Some(Gate {
                stream: stream.clone(),
                shared: self.gate.clone(),
            }),
            Origin::File => None,
        };
        stretched(sound, &self.rate, gate)
    }
}

/// A remote track still connecting, and what the page asked of it meanwhile.
struct Pending {
    src: String,
    loaded: mpsc::Receiver<Loaded>,
    play: bool,
    seek: Option<f64>,
    looped: bool,
    volume: f32,
    muted: bool,
}

/// The mix format without a device; with one, the mix takes the first device's
/// own format, so samples are converted once (later devices convert from it).
const MIX_RATE: u32 = 48_000;
const MIX_CHANNELS: u16 = 2;

/// The app's own mix of every track. It outlives output streams: when the
/// device changes, a new stream plays this same source on from where the old
/// one stopped, so no track is reopened, reloaded or moved.
#[derive(Clone)]
struct Mix {
    source: Arc<Mutex<MixerSource>>,
    channels: rodio::ChannelCount,
    rate: rodio::SampleRate,
}

impl Mix {
    fn new(channels: rodio::ChannelCount, rate: rodio::SampleRate) -> (Mixer, Self) {
        let (mixer, source) = rodio::mixer::mixer(channels, rate);
        (
            mixer,
            Self {
                source: Arc::new(Mutex::new(source)),
                channels,
                rate,
            },
        )
    }
}

impl Iterator for Mix {
    type Item = rodio::Sample;
    fn next(&mut self) -> Option<Self::Item> {
        // Never ends: rodio's mixer source ends once its last track is gone
        // (between two songs), and a device sink drops a source that ended,
        // which left every later track playing to nothing at 0:00.
        Some(
            self.source
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .next()
                .unwrap_or(0.0),
        )
    }
}

impl Source for Mix {
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

/// Where the mix goes: the default device, or (no device, or TARVE_AUDIO=silent)
/// a clock that consumes samples in real time, as a browser plays muted media
/// when no output exists, so playback, time and ended still behave.
enum Output {
    Device(#[allow(dead_code)] MixerDeviceSink),
    Silent(Arc<AtomicBool>),
}

impl Output {
    fn silent(mut mix: Mix) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let _ = std::thread::Builder::new()
            .name("tarve-silent-audio".into())
            .spawn(move || {
                let started = Instant::now();
                let mut consumed: u64 = 0;
                while !stopped.load(Ordering::Relaxed) {
                    let due = (started.elapsed().as_secs_f64()
                        * f64::from(mix.rate.get())
                        * f64::from(mix.channels.get())) as u64;
                    while consumed < due {
                        let _ = mix.next();
                        consumed += 1;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
            });
        Self::Silent(stop)
    }
}

impl Drop for Output {
    fn drop(&mut self) {
        if let Self::Silent(stop) = self {
            stop.store(true, Ordering::Relaxed);
        }
    }
}

/** How often the default output device is compared with the one in use while playing. */
const DEVICE_CHECK: Duration = Duration::from_secs(2);

/// The default output device's id, to follow it when the user switches outputs.
fn default_output_id() -> Option<String> {
    use rodio::cpal::traits::{DeviceTrait, HostTrait};
    rodio::cpal::default_host()
        .default_output_device()?
        .id()
        .ok()
        .map(|id| id.to_string())
}

#[derive(Default)]
pub struct Media {
    mix: Option<(Mixer, Mix)>,
    sink: Option<Output>,
    /// Set by the output stream's error callback: the device went away (unplugged,
    /// sleep, a driver restart) and nothing plays until a new stream is opened.
    output_lost: Arc<AtomicBool>,
    /// The device the open stream plays to, and when to compare it with the default again.
    device_id: Option<String>,
    next_device_check: Option<Instant>,
    /// Never open a device (tests): reopening the output gives a silent one again.
    #[cfg(test)]
    silent: bool,
    /// Nothing consumes the mix (tests): what a stalled or lost device looks like.
    #[cfg(test)]
    unconsumed: bool,
    tracks: HashMap<String, Track>,
    /// `playbackRate` of each element not at 1 (also for one still loading).
    rates: HashMap<String, f64>,
    pending: HashMap<String, Pending>,
    next_update: Option<Instant>,
}

fn event(id: &str, name: &str, track: Option<&Track>) -> Value {
    let mut event = json!({
        "type": "media",
        "id": id,
        "event": name,
        "time": track.map_or(0.0, Track::time),
        "duration": track.and_then(|track| track.duration),
        "paused": track.is_none_or(|track| track.player.is_paused()),
    });
    if let Some(track) = track {
        if let Some(duration) = track.duration.filter(|duration| *duration > 0.0) {
            event["buffered"] = json!(match &track.origin {
                Origin::Remote(stream) => duration * stream.buffered_from(track.time() / duration),
                Origin::File => duration,
            });
        }
        if name == "loadedmetadata" {
            event["filename"] = json!(match &track.origin {
                Origin::Remote(stream) => stream.filename(),
                Origin::File => track
                    .src
                    .rsplit(['/', '\\'])
                    .next()
                    .unwrap_or_default()
                    .to_string(),
            });
        }
    }
    event
}

/// "<reason> (<source>)": the reason first, so a cut-off message still says it,
/// and a URL as its host only, as a browser's media error names no query string.
pub(crate) fn failure(src: &str, reason: impl std::fmt::Display) -> String {
    let source = src.split_once("://").map_or(src, |(_, rest)| {
        rest.split(['/', '?', '#']).next().unwrap_or(rest)
    });
    let reason = reason.to_string();
    // Already named (a download error passed up through the video reader).
    if reason.ends_with(&format!(" ({source})")) {
        return reason;
    }
    format!("{reason} ({source})")
}

/// rodio's Display of an I/O error drops its reason ("An IO error occurred …"); keep it.
fn decoder_failure(src: &str, error: rodio::decoder::DecoderError) -> String {
    match error {
        rodio::decoder::DecoderError::IoError(reason) => failure(src, reason),
        other => failure(src, other),
    }
}

fn error(id: &str, message: impl Into<String>) -> Value {
    crate::video::media_error(id, message)
}

fn decode<R: Read + Seek + Send + Sync + 'static>(
    data: R,
    len: Option<u64>,
    mime: Option<&str>,
    src: &str,
    seekable: bool,
) -> Result<(Sound, Option<f64>), String> {
    let mut builder = Decoder::builder().with_data(data);
    if let Some(len) = len {
        builder = builder.with_byte_len(len);
    }
    builder = builder.with_seekable(seekable);
    if let Some(mime) = mime {
        builder = builder.with_mime_type(mime);
    }
    let decoder = builder
        .build()
        .map_err(|error| decoder_failure(src, error))?;
    let duration = decoder
        .total_duration()
        .map(|duration| duration.as_secs_f64());
    Ok((Box::new(decoder), duration))
}

/// A decoder over a remote stream; an unseekable one starts after the first chunk.
fn decode_remote(
    stream: &Arc<remote::Stream>,
    src: &str,
    seekable: bool,
) -> Result<(Sound, Option<f64>), String> {
    decode(
        remote::Reader::new(stream.clone()),
        Some(stream.len),
        stream.mime.as_deref(),
        src,
        seekable,
    )
    // A failed download is the cause; the decoder only saw a read that failed.
    .map_err(|error| stream.error().unwrap_or(error))
}

fn open_file(src: &str) -> Result<(Sound, Option<f64>), String> {
    let file = File::open(src).map_err(|error| failure(src, error))?;
    let length = file.metadata().map(|meta| meta.len()).ok();
    decode(BufReader::new(file), length, None, src, true)
}

fn open_remote(src: &str) -> Loaded {
    let stream = remote::Stream::open(src)?;
    let (sound, duration) = decode_remote(&stream, src, false)?;
    Ok((sound, duration, stream))
}

/// Gives the track a new player with `sound`, paused, at its volume. The old
/// player is dropped, which stops its sound; `Player::clear` would instead
/// block until the audio thread acknowledges, freezing the event loop while
/// the output is stalled.
fn replace_player(track: &mut Track, mixer: &Mixer, sound: Sound) {
    let player = Arc::new(Player::connect_new(mixer));
    player.pause();
    track.gate = Arc::default();
    player.append(track.sound(sound));
    track.player = player;
    track.seeking = None;
    track.clock = (0.0, 0.0);
    Media::apply_volume(track);
}

/// Asks the audio thread to seek, from a helper thread that waits for it; a
/// seek asked for while one is in flight runs after it (the last one wins).
fn begin_seek(track: &mut Track, target: f64) -> Result<(), String> {
    if let Some(seek) = &mut track.seeking {
        seek.next = Some(target);
        return Ok(());
    }
    let (sender, done) = mpsc::channel();
    let player = track.player.clone();
    std::thread::Builder::new()
        .name("tarve-media-seek".into())
        .spawn(move || {
            let result = player
                .try_seek(Duration::from_secs_f64(target))
                .map_err(|error| format!("seek: {error}"));
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    track.seeking = Some(PendingSeek {
        done,
        target,
        next: None,
    });
    Ok(())
}

/// The track's sound from the start again, for loop and replay after ended.
fn reopen(track: &mut Track) -> Result<Sound, String> {
    match &track.origin {
        Origin::File => open_file(&track.src).map(|(sound, _)| sound),
        Origin::Remote(stream) => {
            let sound = decode_remote(stream, &track.src, false).map(|(sound, _)| sound);
            track.seekable = false;
            sound
        }
    }
}

impl Media {
    /// The app's mixer, with an output stream playing it.
    fn mixer(&mut self) -> Result<Mixer, String> {
        if self.sink.is_none() {
            #[cfg(test)]
            let forced = self.silent;
            #[cfg(not(test))]
            let forced = false;
            let silent =
                forced || std::env::var_os("TARVE_AUDIO").is_some_and(|value| value == "silent");
            self.output_lost.store(false, Ordering::Relaxed);
            let lost = self.output_lost.clone();
            let device = if silent {
                None
            } else {
                DeviceSinkBuilder::from_default_device()
                    .ok()
                    .and_then(|builder| {
                        builder
                            .with_error_callback(move |error| {
                                // Glitches are not a lost device; anything else needs a new stream.
                                if !matches!(error, rodio::cpal::StreamError::BufferUnderrun) {
                                    lost.store(true, Ordering::Relaxed);
                                }
                            })
                            .open_sink_or_fallback()
                            .ok()
                    })
            };
            self.device_id = if device.is_some() {
                default_output_id()
            } else {
                None
            };
            let (channels, rate) = device.as_ref().map_or(
                (
                    std::num::NonZero::new(MIX_CHANNELS).unwrap(),
                    std::num::NonZero::new(MIX_RATE).unwrap(),
                ),
                |sink| (sink.config().channel_count(), sink.config().sample_rate()),
            );
            let mix = self
                .mix
                .get_or_insert_with(|| Mix::new(channels, rate))
                .1
                .clone();
            let output = match device {
                Some(mut sink) => {
                    sink.log_on_drop(false);
                    sink.mixer().add(mix);
                    Output::Device(sink)
                }
                #[cfg(test)]
                None if self.unconsumed => Output::Silent(Arc::new(AtomicBool::new(true))),
                None => Output::silent(mix),
            };
            self.sink = Some(output);
        }
        Ok(self.mix.as_ref().unwrap().0.clone())
    }

    /// The app's audio mix, for `<video>` sound to play through the same output.
    #[cfg(target_os = "windows")]
    pub(crate) fn output_mixer(&mut self) -> Result<Mixer, String> {
        self.mixer()
    }

    fn apply_volume(track: &Track) {
        track
            .player
            .set_volume(if track.muted { 0.0 } else { track.volume });
    }

    #[allow(clippy::too_many_arguments)]
    fn install(
        &mut self,
        id: &str,
        src: &str,
        loaded: (Sound, Option<f64>, Origin),
        looped: bool,
        volume: f32,
        muted: bool,
    ) -> Result<(), String> {
        let mixer = self.mixer()?;
        let (sound, duration, origin) = loaded;
        let rate = Arc::new(AtomicU64::new(
            self.rates.get(id).copied().unwrap_or(1.0).to_bits(),
        ));
        let player = Arc::new(Player::connect_new(&mixer));
        player.pause();
        let seekable = matches!(origin, Origin::File);
        let track = Track {
            player: player.clone(),
            src: src.to_string(),
            origin,
            seekable,
            rebuild: None,
            seeking: None,
            duration,
            looped,
            volume,
            muted,
            ended: false,
            rate,
            clock: (0.0, 0.0),
            waiting: false,
            gate: Arc::default(),
        };
        player.append(track.sound(sound));
        Self::apply_volume(&track);
        self.tracks.insert(id.to_string(), track);
        Ok(())
    }

    /// `playbackRate`: the sound plays this much faster at its own pitch.
    pub fn set_rate(&mut self, id: &str, rate: f64) -> Vec<Value> {
        let rate = rate.clamp(0.0625, 16.0);
        if (rate - 1.0).abs() < 1e-9 {
            self.rates.remove(id);
        } else {
            self.rates.insert(id.to_string(), rate);
        }
        if let Some(track) = self.tracks.get_mut(id) {
            track.clock = (track.played(), track.time());
            track.rate.store(rate.to_bits(), Ordering::Relaxed);
        }
        vec![]
    }

    /// One HTMLMediaElement operation; returns the events it fires.
    #[allow(clippy::too_many_arguments)]
    pub fn command(
        &mut self,
        id: &str,
        action: &str,
        src: Option<&str>,
        time: Option<f64>,
        volume: Option<f64>,
        muted: Option<bool>,
        looped: Option<bool>,
    ) -> Vec<Value> {
        let volume = volume.map(|volume| volume.clamp(0.0, 1.0) as f32);
        match action {
            "load" => {
                let Some(src) = src else {
                    return vec![];
                };
                if self.tracks.get(id).is_some_and(|track| track.src == src)
                    || self
                        .pending
                        .get(id)
                        .is_some_and(|pending| pending.src == src)
                {
                    return vec![];
                }
                self.tracks.remove(id);
                self.pending.remove(id);
                // A new source starts at the normal rate, as HTMLMediaElement.load() does.
                self.rates.remove(id);
                let (looped, volume, muted) = (
                    looped.unwrap_or(false),
                    volume.unwrap_or(1.0),
                    muted.unwrap_or(false),
                );
                if remote::is_remote(src) {
                    // Connecting takes a network round trip: do it off the event loop.
                    let (sender, receiver) = mpsc::channel();
                    let url = src.to_string();
                    let spawned = std::thread::Builder::new()
                        .name("tarve-media-load".into())
                        .spawn(move || {
                            let _ = sender.send(open_remote(&url));
                        });
                    if let Err(message) = spawned {
                        return vec![error(id, message.to_string())];
                    }
                    self.pending.insert(
                        id.to_string(),
                        Pending {
                            src: src.to_string(),
                            loaded: receiver,
                            play: false,
                            seek: None,
                            looped,
                            volume,
                            muted,
                        },
                    );
                    return vec![];
                }
                let installed = open_file(src).and_then(|(sound, duration)| {
                    self.install(
                        id,
                        src,
                        (sound, duration, Origin::File),
                        looped,
                        volume,
                        muted,
                    )
                });
                match installed {
                    Ok(()) => vec![
                        event(id, "loadedmetadata", self.tracks.get(id)),
                        event(id, "canplay", self.tracks.get(id)),
                    ],
                    Err(message) => vec![error(id, message)],
                }
            }
            "unload" => {
                self.tracks.remove(id);
                self.pending.remove(id);
                vec![]
            }
            _ => {
                if let Some(pending) = self.pending.get_mut(id) {
                    // Remembered and applied once the stream is ready, as a browser does.
                    match action {
                        "play" => pending.play = true,
                        "pause" => pending.play = false,
                        "seek" => pending.seek = time,
                        _ => {}
                    }
                    pending.looped = looped.unwrap_or(pending.looped);
                    pending.volume = volume.unwrap_or(pending.volume);
                    pending.muted = muted.unwrap_or(pending.muted);
                    return vec![];
                }
                let mixer = self.mix.as_ref().map(|(mixer, _)| mixer.clone());
                let Some(track) = self.tracks.get_mut(id) else {
                    return vec![];
                };
                if let Some(looped) = looped {
                    track.looped = looped;
                }
                if let Some(volume) = volume {
                    track.volume = volume;
                }
                if let Some(muted) = muted {
                    track.muted = muted;
                }
                Self::apply_volume(track);
                match action {
                    "play" if track.player.is_paused() || track.ended => {
                        if track.ended {
                            match reopen(track) {
                                Ok(sound) => {
                                    if let Some(mixer) = &mixer {
                                        replace_player(track, mixer, sound);
                                    }
                                    track.ended = false;
                                }
                                Err(message) => return vec![error(id, message)],
                            }
                        }
                        track.player.play();
                        self.next_update
                            .get_or_insert_with(|| Instant::now() + TIME_UPDATE);
                        vec![event(id, "play", self.tracks.get(id))]
                    }
                    "pause" if !track.player.is_paused() => {
                        track.player.pause();
                        vec![event(id, "pause", self.tracks.get(id))]
                    }
                    "seek" if !track.seekable => {
                        let target = time.unwrap_or(0.0).max(0.0);
                        if let Some(rebuild) = &mut track.rebuild {
                            rebuild.target = target;
                            return vec![];
                        }
                        let Origin::Remote(stream) = &track.origin else {
                            return vec![];
                        };
                        let (sender, receiver) = mpsc::channel();
                        let (stream, src) = (stream.clone(), track.src.clone());
                        let spawned = std::thread::Builder::new()
                            .name("tarve-media-seekable".into())
                            .spawn(move || {
                                let _ = sender.send(
                                    decode_remote(&stream, &src, true).map(|(sound, _)| sound),
                                );
                            });
                        match spawned {
                            Ok(_) => {
                                track.rebuild = Some(Rebuild {
                                    sound: receiver,
                                    target,
                                });
                                vec![]
                            }
                            Err(message) => vec![error(id, message.to_string())],
                        }
                    }
                    "seek" => {
                        track.ended = false;
                        match begin_seek(track, time.unwrap_or(0.0).max(0.0)) {
                            Ok(()) => vec![],
                            Err(message) => vec![error(id, message)],
                        }
                    }
                    _ => vec![],
                }
            }
        }
    }

    /// When the next timeupdate is due, if any track is playing, or the next
    /// check on a remote load still connecting.
    pub fn deadline(&self) -> Option<Instant> {
        if self.pending.is_empty()
            && self
                .tracks
                .values()
                .all(|track| track.rebuild.is_none() && track.seeking.is_none())
        {
            return self.next_update;
        }
        let poll = Instant::now() + LOAD_POLL;
        Some(self.next_update.map_or(poll, |due| due.min(poll)))
    }

    /// Installs remote tracks whose first chunk arrived, replaying what the
    /// page asked of them while they connected.
    fn finish_loads(&mut self) -> Vec<Value> {
        let mut events = vec![];
        let ids: Vec<String> = self.pending.keys().cloned().collect();
        for id in ids {
            let result = match self.pending[&id].loaded.try_recv() {
                Ok(result) => result,
                Err(mpsc::TryRecvError::Empty) => continue,
                Err(mpsc::TryRecvError::Disconnected) => {
                    Err("media: the loader stopped".to_string())
                }
            };
            let pending = self.pending.remove(&id).unwrap();
            let installed = result.and_then(|(sound, duration, stream)| {
                self.install(
                    &id,
                    &pending.src,
                    (sound, duration, Origin::Remote(stream)),
                    pending.looped,
                    pending.volume,
                    pending.muted,
                )
            });
            if let Err(message) = installed {
                events.push(error(&id, message));
                continue;
            }
            events.push(event(&id, "loadedmetadata", self.tracks.get(&id)));
            events.push(event(&id, "canplay", self.tracks.get(&id)));
            if let Some(time) = pending.seek {
                events.extend(self.command(&id, "seek", None, Some(time), None, None, None));
            }
            if pending.play {
                events.extend(self.command(&id, "play", None, None, None, None, None));
            }
        }
        events
    }

    /// Swaps in seekable decoders that finished building and performs the seek
    /// that asked for them, keeping play or pause as it was.
    fn finish_rebuilds(&mut self) -> Vec<Value> {
        let mut events = vec![];
        let mixer = self.mix.as_ref().map(|(mixer, _)| mixer.clone());
        for (id, track) in &mut self.tracks {
            let Some(rebuild) = &track.rebuild else {
                continue;
            };
            let result = match rebuild.sound.try_recv() {
                Ok(result) => result,
                Err(mpsc::TryRecvError::Empty) => continue,
                Err(mpsc::TryRecvError::Disconnected) => Err("media: the seek stopped".to_string()),
            };
            let target = rebuild.target;
            track.rebuild = None;
            let sound = match result {
                Ok(sound) => sound,
                Err(message) => {
                    events.push(error(id, message));
                    continue;
                }
            };
            let playing = !track.player.is_paused() && !track.ended;
            let Some(mixer) = &mixer else {
                continue;
            };
            replace_player(track, mixer, sound);
            track.seekable = true;
            track.ended = false;
            if let Err(message) = begin_seek(track, target) {
                events.push(error(id, message));
            }
            if playing {
                track.player.play();
            }
        }
        events
    }

    /// Reports seeks the audio thread performed, starting the one asked for meanwhile.
    fn finish_seeks(&mut self) -> Vec<Value> {
        let mut events = vec![];
        for (id, track) in &mut self.tracks {
            let Some(seek) = &track.seeking else {
                continue;
            };
            let result = match seek.done.try_recv() {
                Ok(result) => result,
                Err(mpsc::TryRecvError::Empty) => continue,
                Err(mpsc::TryRecvError::Disconnected) => Err("seek: stopped".to_string()),
            };
            let (next, target) = track
                .seeking
                .take()
                .map_or((None, 0.0), |seek| (seek.next, seek.target));
            if let Some(target) = next {
                if let Err(message) = begin_seek(track, target) {
                    events.push(error(id, message));
                }
                continue;
            }
            match result {
                Ok(()) => {
                    // The player's position is the target now: media time starts from it.
                    track.clock = (track.played(), target);
                    events.push(event(id, "seeked", Some(track)));
                }
                Err(message) => events.push(error(id, message)),
            }
        }
        events
    }

    pub(crate) fn playing(&self) -> Vec<String> {
        let on = |(i, t): (&String, &Track)| (!t.player.is_paused() && !t.ended).then(|| i.clone());
        Vec::from_iter(self.tracks.iter().filter_map(on))
    }

    /// Whether the output must be reopened: its device failed or the default output changed.
    fn output_stale(&mut self, now: Instant) -> bool {
        if self.sink.is_none() {
            return false;
        }
        if self.output_lost.load(Ordering::Relaxed) {
            return true;
        }
        let playing = !self.playing().is_empty();
        if !playing || self.device_id.is_none() || self.next_device_check.is_some_and(|at| at > now)
        {
            return false;
        }
        self.next_device_check = Some(now + DEVICE_CHECK);
        default_output_id().is_some_and(|id| Some(&id) != self.device_id.as_ref())
    }

    /// Opens a new output stream on the current default device. The old one is
    /// closed first, so the mix has one listener and every track goes on from
    /// the sample it was at.
    fn reopen_output(&mut self) -> Vec<Value> {
        self.sink = None;
        match self.mixer() {
            Ok(_) => vec![],
            Err(message) => vec![error("", message)],
        }
    }

    /// timeupdate for playing tracks, and ended (or a restart, with loop).
    pub fn tick(&mut self, now: Instant) -> Vec<Value> {
        let mut events = vec![];
        if self.output_stale(now) {
            events.extend(self.reopen_output());
        }
        events.extend(self.finish_loads());
        events.extend(self.finish_seeks());
        events.extend(self.finish_rebuilds());
        if self.next_update.is_none_or(|due| due > now) {
            return events;
        }
        let ids: Vec<String> = self.tracks.keys().cloned().collect();
        for id in ids {
            let track = self.tracks.get_mut(&id).unwrap();
            if track.player.is_paused() || track.ended {
                continue;
            }
            // The download stalled under the decoder: `waiting`, then `canplay` once it moves.
            let starved = track.gate.starved.load(Ordering::Relaxed);
            if starved != track.waiting {
                track.waiting = starved;
                events.push(event(
                    &id,
                    if starved { "waiting" } else { "canplay" },
                    Some(track),
                ));
            }
            if track.player.empty() {
                // A stream that failed mid-way ends early: that is an error, not the end.
                if let Origin::Remote(stream) = &track.origin
                    && let Some(message) = stream.error()
                {
                    track.ended = true;
                    track.player.pause();
                    events.push(error(&id, message));
                    continue;
                }
                if track.looped
                    && let Ok(sound) = reopen(track)
                {
                    // The loop's sound follows the first in the same player.
                    track.clock = (track.played(), 0.0);
                    track.player.append(track.sound(sound));
                    events.push(event(&id, "timeupdate", Some(track)));
                    continue;
                }
                track.ended = true;
                track.player.pause();
                let mut ended = event(&id, "ended", Some(track));
                if let Some(duration) = track.duration {
                    ended["time"] = json!(duration);
                }
                events.push(ended);
                continue;
            }
            events.push(event(&id, "timeupdate", Some(track)));
        }
        let playing = !self.playing().is_empty();
        self.next_update = playing.then(|| now + TIME_UPDATE);
        events
    }
}

#[cfg(test)]
mod tests {
    use super::remote::{CHUNK, Reader, Stream};
    use super::{Media, decode, open_remote};
    use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
    use std::net::TcpListener;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    /// A WAV of `seconds` of 8 kHz mono PCM: big enough to span several chunks.
    fn wav(seconds: u32) -> Vec<u8> {
        let samples = 8_000 * seconds;
        let mut out = Vec::with_capacity(44 + samples as usize * 2);
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + samples * 2).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&8_000u32.to_le_bytes());
        out.extend_from_slice(&16_000u32.to_le_bytes());
        out.extend_from_slice(&2u16.to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&(samples * 2).to_le_bytes());
        for i in 0..samples {
            out.extend_from_slice(&(((i * 37) % 2000) as i16 - 1000).to_le_bytes());
        }
        out
    }

    /// Like `serve`, but answers 403 to a request while another one is in flight,
    /// as some media CDNs do. Returns the URL and how many requests were refused.
    fn serve_one_at_a_time(body: Vec<u8>) -> (String, Arc<std::sync::atomic::AtomicUsize>) {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let body = Arc::new(body);
        let busy = Arc::new(AtomicUsize::new(0));
        let refused = Arc::new(AtomicUsize::new(0));
        let refused_out = refused.clone();
        std::thread::spawn(move || {
            for connection in listener.incoming() {
                let Ok(mut connection) = connection else {
                    continue;
                };
                let (body, busy, refused) = (body.clone(), busy.clone(), refused.clone());
                std::thread::spawn(move || {
                    let mut reader = BufReader::new(connection.try_clone().unwrap());
                    loop {
                        let mut range = None;
                        loop {
                            let mut line = String::new();
                            if reader.read_line(&mut line).unwrap_or(0) == 0 {
                                return;
                            }
                            if line == "\r\n" {
                                break;
                            }
                            if let Some(value) =
                                line.to_ascii_lowercase().strip_prefix("range: bytes=")
                            {
                                let (start, end) = value.trim().split_once('-').unwrap();
                                let start: usize = start.parse().unwrap();
                                let end = end
                                    .parse::<usize>()
                                    .map_or(body.len() - 1, |end| end.min(body.len() - 1));
                                range = Some((start, end));
                            }
                        }
                        if busy.fetch_add(1, Ordering::SeqCst) > 0 {
                            busy.fetch_sub(1, Ordering::SeqCst);
                            refused.fetch_add(1, Ordering::SeqCst);
                            let _ = connection
                                .write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
                            continue;
                        }
                        let (start, end) = range.unwrap_or((0, body.len() - 1));
                        let head = format!(
                            "HTTP/1.1 206 Partial Content\r\nContent-Type: audio/wav\r\nContent-Length: {}\r\nContent-Range: bytes {start}-{end}/{}\r\n\r\n",
                            end + 1 - start,
                            body.len()
                        );
                        let _ = connection.write_all(head.as_bytes());
                        // Slow enough that the other connections arrive meanwhile.
                        for piece in body[start..=end].chunks(64 * 1024) {
                            let _ = connection.write_all(piece);
                            std::thread::sleep(Duration::from_millis(2));
                        }
                        busy.fetch_sub(1, Ordering::SeqCst);
                    }
                });
            }
        });
        (format!("http://{address}/song.wav"), refused_out)
    }

    #[test]
    fn media_commands_never_wait_for_the_audio_thread() {
        // A stalled or lost device stops pulling the mix; rodio's seek and clear
        // wait for the audio thread, which froze the window. Nothing pulls here.
        let mut media = Media {
            silent: true,
            unconsumed: true,
            ..Default::default()
        };
        let url = serve(wav(40), true);
        media.command("a", "load", Some(&url), None, None, None, None);
        let started = Instant::now();
        while !media.tracks.contains_key("a") && started.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(10));
            media.tick(Instant::now());
        }
        assert!(media.tracks.contains_key("a"), "the track loaded");
        let started = Instant::now();
        media.command("a", "play", None, None, None, None, None);
        media.command("a", "seek", None, Some(10.0), None, None, None);
        media.command("a", "seek", None, Some(20.0), None, None, None);
        for _ in 0..20 {
            media.tick(Instant::now() + Duration::from_secs(1));
        }
        // Replay after ended swaps in a new player instead of clearing the old one.
        media.tracks.get_mut("a").unwrap().ended = true;
        media.command("a", "play", None, None, None, None, None);
        media.command("a", "unload", None, None, None, None, None);
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "took {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn the_mix_never_ends_between_tracks() {
        // A device sink drops a source that ends; between two songs the mix has
        // no track, and that must not end it.
        let (mixer, mut mix) = super::Mix::new(
            std::num::NonZero::new(2).unwrap(),
            std::num::NonZero::new(48_000).unwrap(),
        );
        for _ in 0..1000 {
            assert_eq!(mix.next(), Some(0.0), "silence with no track");
        }
        mixer.add(rodio::Source::take_duration(
            rodio::source::SineWave::new(440.0),
            Duration::from_millis(10),
        ));
        let heard = (0..48_000)
            .filter_map(|_| mix.next())
            .filter(|sample| *sample != 0.0)
            .count();
        assert!(heard > 0, "a track added later is heard");
        assert!(
            (0..1000).all(|_| mix.next().is_some()),
            "and the mix goes on after it ended"
        );
    }

    #[test]
    fn the_download_goes_forward_and_jumps_only_for_a_far_seek() {
        // A song-sized seek waits for the forward pass…
        assert_eq!(Stream::next_run_for(100, 20), Some((1, 17)));
        // …a seek far beyond it (a long podcast) starts a pass where playback waits.
        assert_eq!(Stream::next_run_for(100, 60), Some((60, 76)));
        assert_eq!(Stream::next_run_for(100, 99), Some((99, 100)));
    }

    #[test]
    fn a_host_that_allows_one_connection_streams_the_whole_file() {
        let data = wav(80);
        assert!(data.len() > 4 * CHUNK);
        // A request racing the end of the previous response may still be refused
        // (403); the download retries it, and every byte arrives.
        let (url, _refused) = serve_one_at_a_time(data.clone());
        let stream = Stream::open(&url).unwrap();
        let mut all = vec![];
        Reader::new(stream.clone()).read_to_end(&mut all).unwrap();
        assert!(all == data, "every byte arrives over the one connection");
        assert!(stream.error().is_none(), "{:?}", stream.error());
    }

    /// Serves `body` over HTTP; with `ranges`, honours Range like a CDN.
    fn serve(body: Vec<u8>, ranges: bool) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let body = Arc::new(body);
        std::thread::spawn(move || {
            for connection in listener.incoming() {
                let Ok(mut connection) = connection else {
                    continue;
                };
                let body = body.clone();
                std::thread::spawn(move || {
                    let mut reader = BufReader::new(connection.try_clone().unwrap());
                    let mut range = None;
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                            break;
                        }
                        if let Some(value) = line.to_ascii_lowercase().strip_prefix("range: bytes=")
                        {
                            let (start, end) = value.trim().split_once('-').unwrap();
                            let start: usize = start.parse().unwrap();
                            let end = end
                                .parse::<usize>()
                                .map_or(body.len() - 1, |end| end.min(body.len() - 1));
                            range = Some((start, end));
                        }
                    }
                    let (status, slice, extra) = match range.filter(|_| ranges) {
                        Some((start, end)) => (
                            "206 Partial Content",
                            &body[start..=end],
                            format!("Content-Range: bytes {start}-{end}/{}\r\n", body.len()),
                        ),
                        None => ("200 OK", &body[..], String::new()),
                    };
                    let head = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: audio/wav\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n",
                        slice.len()
                    );
                    let _ = connection.write_all(head.as_bytes());
                    let _ = connection.write_all(slice);
                });
            }
        });
        format!("http://{address}/song.wav")
    }

    #[test]
    fn a_read_failure_names_its_reason_not_rodios_generic_text() {
        let error = super::decoder_failure(
            "https://cdn.example.com/audio?sig=x",
            rodio::decoder::DecoderError::IoError("range request answered 403 Forbidden".into()),
        );
        assert_eq!(
            error,
            "range request answered 403 Forbidden (cdn.example.com)"
        );
    }

    #[test]
    fn a_ranged_stream_reads_and_seeks_like_the_file() {
        let data = wav(40);
        assert!(data.len() > 2 * CHUNK);
        let stream = Stream::open(&serve(data.clone(), true)).unwrap();
        assert_eq!(stream.len, data.len() as u64);
        assert_eq!(stream.mime.as_deref(), Some("audio/wav"));
        let mut reader = Reader::new(stream.clone());
        let middle = CHUNK as u64 * 2 + 1234;
        reader.seek(SeekFrom::Start(middle)).unwrap();
        let mut part = vec![0; 5000];
        reader.read_exact(&mut part).unwrap();
        assert_eq!(part, data[middle as usize..middle as usize + 5000]);
        let mut all = vec![];
        Reader::new(stream).read_to_end(&mut all).unwrap();
        assert!(all == data, "the whole stream matches the file");
    }

    #[test]
    fn a_server_without_ranges_still_streams() {
        let data = wav(40);
        let stream = Stream::open(&serve(data.clone(), false)).unwrap();
        let mut all = vec![];
        Reader::new(stream).read_to_end(&mut all).unwrap();
        assert!(all == data);
    }

    #[test]
    fn a_remote_wav_decodes_with_its_duration() {
        let (_, duration, _) = open_remote(&serve(wav(40), true)).unwrap();
        assert!((duration.unwrap() - 40.0).abs() < 0.01, "{duration:?}");
        let stream = Stream::open(&serve(wav(3), true)).unwrap();
        let (sound, _) = decode(
            Reader::new(stream.clone()),
            Some(stream.len),
            None,
            "test",
            true,
        )
        .unwrap();
        assert_eq!(sound.count(), 8_000 * 3);
    }

    #[test]
    fn a_missing_file_is_an_error() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for mut connection in listener.incoming().flatten() {
                let mut buffer = [0; 1024];
                let _ = connection.read(&mut buffer);
                let _ = connection.write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                );
            }
        });
        let error = open_remote(&format!("http://{address}/missing.mp3"))
            .err()
            .unwrap();
        assert!(error.contains("404"), "{error}");
    }

    /// Drives a Media through load, play and a seek past what an unseekable
    /// stream can do, as the event loop would.
    #[test]
    fn a_lost_output_device_plays_on_from_the_same_sample_on_a_new_stream() {
        let mut media = Media {
            silent: true,
            ..Default::default()
        };
        let url = serve(wav(40), true);
        media.command("a", "load", Some(&url), None, None, None, None);
        media.command("a", "play", None, None, None, None, None);
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(10) {
            std::thread::sleep(Duration::from_millis(20));
            media.tick(Instant::now() + Duration::from_secs(1));
            if media
                .tracks
                .get("a")
                .is_some_and(|track| track.player.get_pos() > Duration::from_millis(400))
            {
                break;
            }
        }
        let before = media.tracks["a"].player.get_pos().as_secs_f64();
        assert!(before > 0.3, "it played on the first stream: {before}");
        // What the stream's error callback does when the device goes away.
        media
            .output_lost
            .store(true, std::sync::atomic::Ordering::Relaxed);
        let events = media.tick(Instant::now() + Duration::from_secs(1));
        assert!(
            events
                .iter()
                .all(|event| event["event"] != "error" && event["event"] != "seeked"),
            "the track is neither reloaded nor sought: {events:?}"
        );
        assert!(!media.output_lost.load(std::sync::atomic::Ordering::Relaxed));
        let after = media.tracks["a"].player.get_pos().as_secs_f64();
        assert!(
            after >= before,
            "it did not restart: {after} after {before}"
        );
        std::thread::sleep(Duration::from_millis(300));
        media.tick(Instant::now() + Duration::from_secs(1));
        assert!(!media.tracks["a"].player.is_paused(), "still playing");
        assert!(
            media.tracks["a"].player.get_pos().as_secs_f64() > after + 0.1,
            "and moving on the new stream"
        );
    }

    #[test]
    fn a_remote_track_plays_and_seeks() {
        let mut media = Media {
            silent: true,
            ..Default::default()
        };
        let url = serve(wav(40), true);
        assert!(
            media
                .command("a", "load", Some(&url), None, Some(0.5), None, None)
                .is_empty()
        );
        assert!(
            media
                .command("a", "play", None, None, None, None, None)
                .is_empty()
        );
        let mut events = vec![];
        let started = Instant::now();
        let mut seeked = false;
        while started.elapsed() < Duration::from_secs(10) {
            std::thread::sleep(Duration::from_millis(20));
            for event in media.tick(Instant::now() + Duration::from_secs(1)) {
                let name = event["event"].as_str().unwrap().to_string();
                if name == "play" && !seeked {
                    seeked = true;
                    media.command("a", "seek", None, Some(30.0), None, None, None);
                }
                events.push((name, event["time"].as_f64().unwrap()));
            }
            if events.iter().any(|(name, _)| name == "seeked") {
                break;
            }
        }
        let names: Vec<&str> = events.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(
            &names[..3],
            ["loadedmetadata", "canplay", "play"],
            "{events:?}"
        );
        let (_, time) = events
            .iter()
            .find(|(name, _)| name == "seeked")
            .expect("seeked");
        assert!((*time - 30.0).abs() < 0.5, "{events:?}");
        assert!(
            !media.tracks["a"].player.is_paused(),
            "still playing after the seek"
        );
    }
}
