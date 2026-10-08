//! `<audio>` (and the sound of `<video>`): files and HTTP(S) streams decoded by
//! Symphonia and played through the default output device (WASAPI on Windows,
//! ALSA on Linux). Commands follow HTMLMediaElement: load, play, pause, seek,
//! volume, muted and loop; events mirror its loadedmetadata, play, pause,
//! timeupdate, ended and error.
//!
//! A remote `src` streams like a browser's: playback starts once the first
//! chunk arrives, the rest downloads behind it with HTTP range requests, and a
//! seek fetches the chunk it lands in first.

use rodio::mixer::Mixer;
use rodio::{Decoder, DeviceSinkBuilder, MixerDeviceSink, Player, Source};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, Read, Seek};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

/// HTMLMediaElement fires timeupdate every 15–250 ms; Tarve uses 250 ms.
const TIME_UPDATE: Duration = Duration::from_millis(250);
/// How often a pending remote load is checked while it connects.
const LOAD_POLL: Duration = Duration::from_millis(50);

mod remote {
    use std::io::{self, Read, Seek, SeekFrom};
    use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock, Weak};
    use std::time::Duration;

    /// Download granularity: a seek waits for at most one chunk.
    pub(super) const CHUNK: usize = 256 * 1024;
    /// Chunks one range request asks for.
    const RUN: usize = 4;
    /// Parallel range requests. Hosts pace each connection (YouTube's CDN to
    /// ~1.5 MB/s), and an MP4 opens only after its fragment index is read from
    /// across the file, so several connections bring the first sound sooner.
    const CONNECTIONS: usize = 4;
    /// A read gives up after the network has delivered nothing for this long.
    const STALL: Duration = Duration::from_secs(30);
    /// Consecutive failed requests before the stream reports an error.
    const ATTEMPTS: u32 = 4;

    pub(super) fn is_remote(src: &str) -> bool {
        src.starts_with("http://") || src.starts_with("https://")
    }

    fn agent() -> &'static ureq::Agent {
        static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
        AGENT.get_or_init(|| {
            ureq::Agent::config_builder()
                .timeout_connect(Some(Duration::from_secs(15)))
                .timeout_recv_response(Some(Duration::from_secs(20)))
                .timeout_recv_body(Some(STALL))
                .build()
                .into()
        })
    }

    struct State {
        chunks: Vec<Option<Arc<[u8]>>>,
        /// Chunks a connection is already fetching.
        claimed: Vec<bool>,
        /// The chunk the decoder is reading or waiting for.
        want: usize,
        error: Option<String>,
    }

    /// One remote file, downloaded into memory chunk by chunk as it plays.
    pub(super) struct Stream {
        url: String,
        pub(super) len: u64,
        pub(super) mime: Option<String>,
        state: Mutex<State>,
        ready: Condvar,
    }

    fn header(response: &ureq::http::Response<ureq::Body>, name: &str) -> Option<String> {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.trim().to_string())
    }

    impl Stream {
        /// Requests the first chunk, which also tells the size and whether the
        /// server serves ranges, then downloads the rest in the background.
        pub(super) fn open(url: &str) -> Result<Arc<Self>, String> {
            let response = agent()
                .get(url)
                .header("Range", format!("bytes=0-{}", CHUNK - 1))
                .call()
                .map_err(|error| format!("media {url}: {error}"))?;
            let total = header(&response, "content-range")
                .and_then(|range| range.rsplit('/').next()?.parse::<u64>().ok());
            let ranged = response.status().as_u16() == 206 && total.is_some();
            let len = match total.filter(|_| ranged) {
                Some(total) => total,
                None => header(&response, "content-length")
                    .and_then(|length| length.parse::<u64>().ok())
                    .ok_or_else(|| format!("media {url}: the server sends no length"))?,
            };
            if len == 0 {
                return Err(format!("media {url}: empty response"));
            }
            let mime = header(&response, "content-type")
                .and_then(|value| value.split(';').next().map(str::trim).map(str::to_string))
                .filter(|mime| !mime.is_empty() && mime != "application/octet-stream");
            let count =
                usize::try_from(len.div_ceil(CHUNK as u64)).map_err(|_| "media too large")?;
            let stream = Arc::new(Self {
                url: url.to_string(),
                len,
                mime,
                state: Mutex::new(State {
                    chunks: vec![None; count],
                    claimed: vec![false; count],
                    want: 0,
                    error: None,
                }),
                ready: Condvar::new(),
            });
            let mut body = response.into_body().into_reader();
            if ranged {
                stream
                    .fill(&mut body, 0, 1)
                    .map_err(|error| format!("media {url}: {error}"))?;
                for _ in 0..CONNECTIONS.min(count - 1) {
                    let downloader = Arc::downgrade(&stream);
                    std::thread::Builder::new()
                        .name("tarve-media-download".into())
                        .spawn(move || Self::download(&downloader))
                        .map_err(|error| error.to_string())?;
                }
            } else {
                // No ranges: one sequential download; a seek ahead waits for it.
                let downloader = stream.clone();
                std::thread::Builder::new()
                    .name("tarve-media-download".into())
                    .spawn(move || {
                        if let Err(error) = downloader.fill(&mut body, 0, count) {
                            downloader.fail(error.to_string());
                        }
                    })
                    .map_err(|error| error.to_string())?;
            }
            Ok(stream)
        }

        fn lock(&self) -> MutexGuard<'_, State> {
            self.state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
        }

        fn chunk_len(&self, index: usize) -> usize {
            let start = (index * CHUNK) as u64;
            (self.len - start).min(CHUNK as u64) as usize
        }

        fn fail(&self, error: String) {
            self.lock().error = Some(error);
            self.ready.notify_all();
        }

        pub(super) fn error(&self) -> Option<String> {
            self.lock().error.clone()
        }

        /// Reads chunks `from..to` off `body` in order. Stops early when the
        /// decoder waits for a chunk no connection is fetching (a seek), so it is served next.
        fn fill(&self, body: &mut impl Read, from: usize, to: usize) -> io::Result<()> {
            for index in from..to {
                let mut chunk = vec![0; self.chunk_len(index)];
                body.read_exact(&mut chunk)?;
                let mut state = self.lock();
                state.chunks[index] = Some(chunk.into());
                let want = state.want;
                // Nobody is fetching what the decoder waits for: drop this run for it.
                let elsewhere = state.chunks[want].is_none() && !state.claimed[want];
                drop(state);
                self.ready.notify_all();
                if elsewhere {
                    break;
                }
            }
            Ok(())
        }

        /// Claims the next run to fetch: unclaimed missing chunks from the one
        /// being read, then any.
        fn claim_run(&self) -> Option<(usize, usize)> {
            let mut state = self.lock();
            let count = state.chunks.len();
            let open = |state: &State, index: usize| {
                state.chunks[index].is_none() && !state.claimed[index]
            };
            let start = (state.want..count)
                .find(|&index| open(&state, index))
                .or_else(|| (0..state.want).find(|&index| open(&state, index)))?;
            let mut end = start + 1;
            while end < count.min(start + RUN) && open(&state, end) {
                end += 1;
            }
            state.claimed[start..end].fill(true);
            Some((start, end))
        }

        fn release(&self, start: usize, end: usize) {
            self.lock().claimed[start..end].fill(false);
        }

        /// One connection's loop. It holds the stream weakly, so it stops once
        /// every reader (and the track) is gone.
        fn download(stream: &Weak<Self>) {
            let mut failures = 0;
            while let Some(stream) = stream.upgrade() {
                let Some((start, end)) = stream.claim_run() else {
                    return;
                };
                let last = ((end * CHUNK) as u64).min(stream.len) - 1;
                let result = agent()
                    .get(&stream.url)
                    .header("Range", format!("bytes={}-{last}", start * CHUNK))
                    .call()
                    .map_err(|error| error.to_string())
                    .and_then(|response| {
                        if response.status().as_u16() != 206 {
                            return Err(format!("range request answered {}", response.status()));
                        }
                        let mut body = response.into_body().into_reader();
                        stream
                            .fill(&mut body, start, end)
                            .map_err(|error| error.to_string())
                    });
                stream.release(start, end);
                match result {
                    Ok(()) => failures = 0,
                    Err(error) => {
                        failures += 1;
                        if failures >= ATTEMPTS {
                            stream.fail(format!("media {}: {error}", stream.url));
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(250 << failures));
                    }
                }
            }
        }
    }

    /// A seekable reader over a [`Stream`]; reads block until their chunk arrives.
    pub(super) struct Reader {
        stream: Arc<Stream>,
        position: u64,
    }

    impl Reader {
        pub(super) fn new(stream: Arc<Stream>) -> Self {
            Self {
                stream,
                position: 0,
            }
        }
    }

    impl Read for Reader {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            if buf.is_empty() || self.position >= self.stream.len {
                return Ok(0);
            }
            let index = (self.position / CHUNK as u64) as usize;
            let offset = (self.position % CHUNK as u64) as usize;
            let mut state = self.stream.lock();
            state.want = index;
            loop {
                if let Some(chunk) = &state.chunks[index] {
                    let count = buf.len().min(chunk.len() - offset);
                    buf[..count].copy_from_slice(&chunk[offset..offset + count]);
                    self.position += count as u64;
                    return Ok(count);
                }
                if let Some(error) = &state.error {
                    return Err(io::Error::other(error.clone()));
                }
                let (next, wait) = self
                    .stream
                    .ready
                    .wait_timeout(state, STALL)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                state = next;
                if wait.timed_out() && state.chunks[index].is_none() {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "media stream stalled",
                    ));
                }
            }
        }
    }

    impl Seek for Reader {
        fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
            let target = match to {
                SeekFrom::Start(offset) => Some(offset),
                SeekFrom::End(delta) => self.stream.len.checked_add_signed(delta),
                SeekFrom::Current(delta) => self.position.checked_add_signed(delta),
            };
            self.position = target
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "seek before start"))?;
            Ok(self.position)
        }
    }
}

type Sound = Box<dyn Source + Send>;
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

struct Track {
    player: Player,
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

/// Where sound goes: the default device, or (no device, or TARVE_AUDIO=silent)
/// a clock that consumes samples in real time, as a browser plays muted media
/// when no output exists, so playback, time and ended still behave.
enum Output {
    Device(MixerDeviceSink),
    Silent(Mixer, Arc<AtomicBool>),
}

impl Output {
    fn mixer(&self) -> &Mixer {
        match self {
            Self::Device(sink) => sink.mixer(),
            Self::Silent(mixer, _) => mixer,
        }
    }

    fn silent() -> Self {
        const RATE: u32 = 48_000;
        const CHANNELS: u16 = 2;
        let (mixer, mut source) = rodio::mixer::mixer(
            std::num::NonZero::new(CHANNELS).unwrap(),
            std::num::NonZero::new(RATE).unwrap(),
        );
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let _ = std::thread::Builder::new()
            .name("tarve-silent-audio".into())
            .spawn(move || {
                let started = Instant::now();
                let mut consumed: u64 = 0;
                while !stopped.load(Ordering::Relaxed) {
                    let due = (started.elapsed().as_secs_f64()
                        * f64::from(RATE)
                        * f64::from(CHANNELS)) as u64;
                    while consumed < due {
                        let _ = source.next();
                        consumed += 1;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
            });
        Self::Silent(mixer, stop)
    }
}

impl Drop for Output {
    fn drop(&mut self) {
        if let Self::Silent(_, stop) = self {
            stop.store(true, Ordering::Relaxed);
        }
    }
}

#[derive(Default)]
pub struct Media {
    sink: Option<Output>,
    tracks: HashMap<String, Track>,
    pending: HashMap<String, Pending>,
    next_update: Option<Instant>,
}

fn event(id: &str, name: &str, track: Option<&Track>) -> Value {
    json!({
        "type": "media",
        "id": id,
        "event": name,
        "time": track.map_or(0.0, |track| track.player.get_pos().as_secs_f64()),
        "duration": track.and_then(|track| track.duration),
        "paused": track.is_none_or(|track| track.player.is_paused()),
    })
}

fn error(id: &str, message: impl Into<String>) -> Value {
    json!({"type":"media", "id":id, "event":"error", "message":message.into()})
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
        .map_err(|error| format!("media {src}: {error}"))?;
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
}

fn open_file(src: &str) -> Result<(Sound, Option<f64>), String> {
    let file = File::open(src).map_err(|error| format!("media {src}: {error}"))?;
    let length = file.metadata().map(|meta| meta.len()).ok();
    decode(BufReader::new(file), length, None, src, true)
}

fn open_remote(src: &str) -> Loaded {
    let stream = remote::Stream::open(src)?;
    let (sound, duration) = decode_remote(&stream, src, false)?;
    Ok((sound, duration, stream))
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
    fn mixer(&mut self) -> Result<&Output, String> {
        if self.sink.is_none() {
            let silent = std::env::var_os("TARVE_AUDIO").is_some_and(|value| value == "silent");
            let device = if silent {
                None
            } else {
                DeviceSinkBuilder::open_default_sink().ok()
            };
            let output = match device {
                Some(mut sink) => {
                    sink.log_on_drop(false);
                    Output::Device(sink)
                }
                None => Output::silent(),
            };
            self.sink = Some(output);
        }
        Ok(self.sink.as_ref().unwrap())
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
        let mixer = self.mixer()?.mixer().clone();
        let (sound, duration, origin) = loaded;
        let player = Player::connect_new(&mixer);
        player.pause();
        player.append(sound);
        let seekable = matches!(origin, Origin::File);
        let track = Track {
            player,
            src: src.to_string(),
            origin,
            seekable,
            rebuild: None,
            duration,
            looped,
            volume,
            muted,
            ended: false,
        };
        Self::apply_volume(&track);
        self.tracks.insert(id.to_string(), track);
        Ok(())
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
                    Ok(()) => vec![event(id, "loadedmetadata", self.tracks.get(id))],
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
                                    track.player.clear();
                                    track.player.append(sound);
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
                        let target = Duration::from_secs_f64(time.unwrap_or(0.0).max(0.0));
                        match track.player.try_seek(target) {
                            Ok(()) => {
                                track.ended = false;
                                vec![event(id, "seeked", self.tracks.get(id))]
                            }
                            Err(message) => vec![error(id, format!("seek: {message}"))],
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
        if self.pending.is_empty() && self.tracks.values().all(|track| track.rebuild.is_none()) {
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
            track.player.clear();
            track.player.append(sound);
            track.seekable = true;
            track.ended = false;
            match track.player.try_seek(Duration::from_secs_f64(target)) {
                Ok(()) => events.push(event(id, "seeked", Some(track))),
                Err(message) => events.push(error(id, format!("seek: {message}"))),
            }
            if playing {
                track.player.play();
            }
        }
        events
    }

    /// timeupdate for playing tracks, and ended (or a restart, with loop).
    pub fn tick(&mut self, now: Instant) -> Vec<Value> {
        let mut events = self.finish_loads();
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
                    track.player.append(sound);
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
        let playing = self
            .tracks
            .values()
            .any(|track| !track.player.is_paused() && !track.ended);
        self.next_update = playing.then(|| now + TIME_UPDATE);
        events
    }
}

#[cfg(test)]
mod tests {
    use super::remote::{CHUNK, Reader, Stream};
    use super::{Media, Output, decode, open_remote};
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
    fn a_remote_track_plays_and_seeks() {
        let mut media = Media {
            sink: Some(Output::silent()),
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
        assert_eq!(&names[..2], ["loadedmetadata", "play"], "{events:?}");
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
