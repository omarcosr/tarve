use std::io::{self, Read};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock, Weak};
use std::time::Duration;

/// Download granularity: a seek waits for at most one chunk.
pub(super) const CHUNK: usize = 256 * 1024;
/// Chunks one range request asks for (4 MB: a whole song in one or two).
const RUN: usize = 16;
/// How far ahead of the download (in chunks, 8 MB) a seek starts a new pass there.
const JUMP: usize = 2 * RUN;
/// Windowed streams (video) keep a file up to this size whole (32 MB).
const KEEP_WHOLE: usize = 32 * 1024 * 1024;
/// Windowed streams (video) keep this many chunks behind the reader (4 MB);
/// older ones go and are fetched again if it seeks back.
const BEHIND: usize = 16;
/// A read gives up after the network has delivered nothing for this long.
const STALL: Duration = Duration::from_secs(30);
/// Consecutive failed requests before the stream reports an error: with the
/// backoff below, about 15 s of retrying.
const ATTEMPTS: u32 = 5;

use super::failure;

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 3 <= bytes.len()
            && let Ok(byte) = std::str::from_utf8(&bytes[i + 1..i + 3])
                .map_err(|_| ())
                .and_then(|hex| u8::from_str_radix(hex, 16).map_err(|_| ()))
        {
            out.push(byte);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub(crate) fn is_remote(src: &str) -> bool {
    src.starts_with("http://") || src.starts_with("https://")
}

#[cfg(feature = "net")]
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
    /// The chunk the decoder is reading or waiting for.
    want: usize,
    error: Option<String>,
    /// Seeks so far: a run requested before the last one is dropped as soon as
    /// the decoder reads outside it, instead of downloading the rest of it first.
    seeks: u64,
    /// A newer seek waits (`interrupt`): a read that would wait on the network gives
    /// up at once, until the decoder takes the seek (`resume`).
    interrupted: bool,
    /// A read gave up for it: the demuxer that saw it fail is opened again.
    cut: bool,
    /// Readers made before the last cut fail every read: their demuxer is gone.
    epoch: u64,
}

impl State {
    fn new(chunks: Vec<Option<Arc<[u8]>>>) -> Self {
        Self {
            chunks,
            want: 0,
            error: None,
            seeks: 0,
            interrupted: false,
            cut: false,
            epoch: 0,
        }
    }
}

/// One remote file, downloaded into memory chunk by chunk as it plays.
pub(crate) struct Stream {
    url: String,
    /// Where the request ended up after redirects, for `filename`.
    final_url: String,
    /// Where the newest reader reads (the decoder's position), for `would_block`.
    read_at: std::sync::atomic::AtomicU64,
    pub(crate) len: u64,
    pub(crate) mime: Option<String>,
    state: Mutex<State>,
    ready: Condvar,
    /// Whether the server serves ranges (else one sequential download).
    ranged: bool,
    /// With ranges: download at most this many chunks ahead of the reader and
    /// drop the ones far behind it (a video), instead of the whole file (a song).
    window: Option<usize>,
}

#[cfg(feature = "net")]
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
        Self::open_with(url, None)
    }

    /// Like [`Stream::open`], keeping only `window` chunks ahead of the reader
    /// (and `BEHIND` behind it) in memory when the server serves ranges.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub(crate) fn open_windowed(url: &str, window: usize) -> Result<Arc<Self>, String> {
        Self::open_with(url, Some(window.max(1)))
    }

    /// Built without the native "net" feature: remote media reports an error.
    #[cfg(not(feature = "net"))]
    fn open_with(url: &str, window: Option<usize>) -> Result<Arc<Self>, String> {
        let _ = window;
        Err(failure(
            url,
            "remote media needs the native \"net\" feature",
        ))
    }

    #[cfg(feature = "net")]
    fn open_with(url: &str, window: Option<usize>) -> Result<Arc<Self>, String> {
        let mut attempt = 0;
        let response = loop {
            match agent()
                .get(url)
                .header("Range", format!("bytes=0-{}", CHUNK - 1))
                // As browsers fetch media: compressed replies drop the length and the ranges.
                .header("Accept-Encoding", "identity")
                .call()
            {
                Ok(response) => break response,
                Err(error) => {
                    attempt += 1;
                    // Fewer tries than mid-song: a refused start is often an expired URL.
                    if attempt >= ATTEMPTS - 1 || !transient(&error) || unreachable(&error) {
                        return Err(failure(url, error));
                    }
                    std::thread::sleep(backoff(attempt));
                }
            }
        };
        let final_url = {
            use ureq::ResponseExt;
            response.get_uri().to_string()
        };
        let total = header(&response, "content-range")
            .and_then(|range| range.rsplit('/').next()?.parse::<u64>().ok());
        let ranged = response.status().as_u16() == 206 && total.is_some();
        let mime = header(&response, "content-type")
            .and_then(|value| value.split(';').next().map(str::trim).map(str::to_string))
            .filter(|mime| !mime.is_empty() && mime != "application/octet-stream");
        let len = match total.filter(|_| ranged) {
            Some(total) => total,
            None => match header(&response, "content-length")
                .and_then(|length| length.parse::<u64>().ok())
            {
                Some(len) => len,
                // No length (a chunked or compressed reply): the whole file, then from memory.
                None => {
                    return Self::whole(url, mime, response.into_body().into_reader(), window).map(
                        |stream| {
                            // `whole` keeps the asked URL; the reply came from `final_url`.
                            let mut stream = Arc::into_inner(stream).expect("just made");
                            stream.final_url = final_url;
                            Arc::new(stream)
                        },
                    );
                }
            },
        };
        if len == 0 {
            return Err(failure(url, "empty response"));
        }
        let count = usize::try_from(len.div_ceil(CHUNK as u64)).map_err(|_| "media too large")?;
        let stream = Arc::new(Self {
            url: url.to_string(),
            final_url,
            read_at: Default::default(),
            len,
            mime,
            state: Mutex::new(State::new(vec![None; count])),
            ready: Condvar::new(),
            ranged,
            window,
        });
        let mut body = response.into_body().into_reader();
        if ranged {
            stream
                .fill(&mut body, 0, 1, None)
                .map_err(|error| failure(url, error))?;
            if count > 1 {
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
                    if let Err(error) = downloader.fill(&mut body, 0, count, None) {
                        downloader.fail(error.to_string());
                    }
                })
                .map_err(|error| error.to_string())?;
        }
        Ok(stream)
    }

    /// A stream over a body of unknown length, read to its end first.
    fn whole(
        url: &str,
        mime: Option<String>,
        mut body: impl Read,
        window: Option<usize>,
    ) -> Result<Arc<Self>, String> {
        let mut data = Vec::new();
        body.read_to_end(&mut data)
            .map_err(|error| failure(url, error))?;
        if data.is_empty() {
            return Err(failure(url, "empty response"));
        }
        let chunks = data
            .chunks(CHUNK)
            .map(|chunk| Some(Arc::<[u8]>::from(chunk)))
            .collect();
        Ok(Arc::new(Self {
            url: url.to_string(),
            final_url: url.to_string(),
            read_at: Default::default(),
            len: data.len() as u64,
            mime,
            state: Mutex::new(State::new(chunks)),
            ready: Condvar::new(),
            ranged: false,
            window,
        }))
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

    /// A seek: the run being downloaded is dropped once the decoder reads outside it.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub(crate) fn seeking(&self) {
        self.lock().seeks += 1;
    }

    /// A seek while the decoder may wait on the network for an older target: that
    /// read, and any read that would wait until [`Stream::resume`], fails at once.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub(crate) fn interrupt(&self) {
        let mut state = self.lock();
        state.seeks += 1;
        state.interrupted = true;
        drop(state);
        self.ready.notify_all();
    }

    /// The decoder took the seek: reads wait again. True when a read was cut: the
    /// demuxer that saw it fail is to be opened again (the readers made so far retire).
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub(crate) fn resume(&self) -> bool {
        let mut state = self.lock();
        state.interrupted = false;
        // The seek the decoder makes now moves the reads: a run for the old target goes.
        state.seeks += 1;
        let cut = std::mem::take(&mut state.cut);
        state.epoch += u64::from(cut);
        cut
    }

    /// A read gave up for a newer seek since the last [`Stream::resume`].
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub(crate) fn cut(&self) -> bool {
        self.lock().cut
    }

    /// A seek since the run began (`since`) and the decoder waits outside what is left
    /// of it (`run`): the rest of the run is not worth waiting for.
    fn superseded(&self, since: u64, run: std::ops::Range<usize>) -> bool {
        let state = self.lock();
        state.seeks != since
            && !run.contains(&state.want)
            && state.chunks.get(state.want).is_some_and(Option::is_none)
    }

    pub(crate) fn error(&self) -> Option<String> {
        self.lock().error.clone()
    }

    /// The file's name as the server finally served it (after redirects), as mpv's
    /// `filename`: the last path segment, percent-decoded, without the query.
    pub(crate) fn filename(&self) -> String {
        let path = self.final_url.split(['?', '#']).next().unwrap_or_default();
        let path = path.split_once("://").map_or(path, |(_, rest)| rest);
        let name = path.rsplit('/').next().unwrap_or_default();
        percent_decode(name)
    }

    /// The next `margin` bytes from where the decoder reads have not all arrived: a
    /// read there would wait on the network (on the audio thread, stalling every
    /// sound). False once the stream failed: the read then reports the error.
    pub(crate) fn would_block(&self, margin: u64) -> bool {
        let at = self.read_at.load(std::sync::atomic::Ordering::Relaxed);
        if at >= self.len {
            return false;
        }
        let end = (at + margin).min(self.len - 1);
        let state = self.lock();
        state.error.is_none()
            && (at as usize / CHUNK..=end as usize / CHUNK)
                .any(|index| state.chunks.get(index).is_some_and(Option::is_none))
    }

    /// How far the download reaches without a gap from `fraction` of the file
    /// (where playback is), as a fraction of the file: what `buffered` reports.
    pub(crate) fn buffered_from(&self, fraction: f64) -> f64 {
        let state = self.lock();
        let count = state.chunks.len();
        if count == 0 {
            return 1.0;
        }
        let mut index = ((fraction.clamp(0.0, 1.0) * count as f64) as usize).min(count - 1);
        if state.chunks[index].is_none() {
            return fraction.clamp(0.0, 1.0);
        }
        while index < count && state.chunks[index].is_some() {
            index += 1;
        }
        ((index * CHUNK) as f64 / self.len as f64).min(1.0)
    }

    /// Reads chunks `from..to` off `body` in order. A run of the download started at
    /// `since` seeks stops early once a later seek moved the decoder elsewhere.
    fn fill(
        &self,
        body: &mut impl Read,
        from: usize,
        to: usize,
        since: Option<u64>,
    ) -> io::Result<()> {
        for index in from..to {
            let mut chunk = vec![0; self.chunk_len(index)];
            let mut filled = 0;
            while filled < chunk.len() {
                if since.is_some_and(|since| self.superseded(since, index..to)) {
                    // Dropping the body closes the connection: the next run starts where it reads.
                    return Ok(());
                }
                match body.read(&mut chunk[filled..]) {
                    Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
                    Ok(count) => filled += count,
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                    Err(error) => return Err(error),
                }
            }
            let mut state = self.lock();
            state.chunks[index] = Some(chunk.into());
            if let Some(window) = self.window.filter(|_| self.ranged) {
                // At most the window ahead plus a little behind stays in memory:
                // past that budget the chunks farthest from the reader go first (a
                // jump to the index at the end and back keeps the start it read).
                // A short file (up to `KEEP_WHOLE`) stays whole: a loop or a seek
                // back replays it without downloading it again.
                let budget = (window + 2 * BEHIND + RUN).max(KEEP_WHOLE / CHUNK);
                let want = state.want;
                let mut held = state.chunks.iter().filter(|chunk| chunk.is_some()).count();
                while held > budget {
                    let farthest = state
                        .chunks
                        .iter()
                        .enumerate()
                        .filter(|(other, chunk)| {
                            chunk.is_some()
                                && *other != index
                                && !(want..=want + window).contains(other)
                        })
                        .max_by_key(|(other, _)| other.abs_diff(want))
                        .map(|(other, _)| other);
                    let Some(farthest) = farthest else { break };
                    state.chunks[farthest] = None;
                    held -= 1;
                }
            }
            drop(state);
            self.ready.notify_all();
        }
        Ok(())
    }

    /// A stream of `count` chunks with the first one downloaded and the
    /// decoder waiting at `want`, for testing which run comes next.
    #[cfg(test)]
    pub(super) fn next_run_for(count: usize, want: usize) -> Option<(usize, usize)> {
        let stream = Self {
            url: String::new(),
            final_url: String::new(),
            read_at: Default::default(),
            len: (count * CHUNK) as u64,
            mime: None,
            state: Mutex::new(State {
                want,
                ..State::new(
                    (0..count)
                        .map(|index| (index == 0).then(|| Arc::from(vec![0u8; CHUNK])))
                        .collect(),
                )
            }),
            ready: Condvar::new(),
            ranged: true,
            window: None,
        };
        stream.next_run()
    }

    /// The next run to fetch: from the first missing chunk, in file order; or
    /// from where playback waits, when a seek lands far beyond the download
    /// (a long podcast), and the gap after that. Files the size of a song are
    /// read in one forward pass, which every range-capable server handles.
    fn next_run(&self) -> Option<(usize, usize)> {
        let state = self.lock();
        let count = state.chunks.len();
        if let Some(window) = self.window {
            // From the reader on, within the window; `None` while it is full.
            let want = state.want.min(count - 1);
            let limit = count.min(want + window + 1);
            let start = (want..limit).find(|&index| state.chunks[index].is_none())?;
            let mut end = start + 1;
            while end < limit.min(start + RUN) && state.chunks[end].is_none() {
                end += 1;
            }
            return Some((start, end));
        }
        let first = (0..count).find(|&index| state.chunks[index].is_none())?;
        let want = state.want.min(count - 1);
        let start = if state.chunks[want].is_none() && want > first + JUMP {
            want
        } else {
            first
        };
        let mut end = start + 1;
        while end < count.min(start + RUN) && state.chunks[end].is_none() {
            end += 1;
        }
        Some((start, end))
    }

    /// The download, one connection, start to end. Some media CDNs
    /// refuse a second request to a file while one is in flight, or a range
    /// behind what they already served, with 403; one forward pass is what every
    /// server handles, and it is fast (a song in well under a second). A seek ahead
    /// waits for the pass to get there. It holds the stream weakly, so it stops
    /// once every reader (and the track) is gone.
    #[cfg(feature = "net")]
    fn download(stream: &Weak<Self>) {
        let mut failures = 0;
        while let Some(stream) = stream.upgrade() {
            let since = stream.lock().seeks;
            let Some((start, end)) = stream.next_run() else {
                if stream.window.is_none() {
                    return;
                }
                // A window full (or the rest downloaded): wait for the reader to move.
                let state = stream.lock();
                drop(stream.ready.wait_timeout(state, Duration::from_millis(500)));
                continue;
            };
            let last = ((end * CHUNK) as u64).min(stream.len) - 1;
            let mut lasting = false;
            let result = agent()
                .get(&stream.url)
                .header("Range", format!("bytes={}-{last}", start * CHUNK))
                .header("Accept-Encoding", "identity")
                .call()
                .map_err(|error| {
                    lasting = !transient(&error);
                    error.to_string()
                })
                .and_then(|response| {
                    if response.status().as_u16() != 206 {
                        return Err(format!("range request answered {}", response.status()));
                    }
                    let mut body = response.into_body().into_reader();
                    stream
                        .fill(&mut body, start, end, Some(since))
                        .map_err(|error| error.to_string())
                });
            match result {
                Ok(()) => failures = 0,
                Err(error) => {
                    // A run cut short keeps the chunks it delivered; the next
                    // request continues after them.
                    failures += 1;
                    if failures >= ATTEMPTS || lasting {
                        stream.fail(failure(&stream.url, error));
                        return;
                    }
                    std::thread::sleep(backoff(failures));
                }
            }
        }
    }
}

/// Worth retrying: the network, a busy or throttling server (a CDN's
/// rate-limit 403 often lifts after a second or two). A 404 or 410 will not change.
#[cfg(feature = "net")]
fn transient(error: &ureq::Error) -> bool {
    match error {
        ureq::Error::StatusCode(code) => matches!(code, 403 | 408 | 429) || *code >= 500,
        _ => true,
    }
}

/// No server at that name or port: a browser reports it at once (retrying a
/// refused connection cost ~12 s on Windows, where each refusal takes ~2 s).
#[cfg(feature = "net")]
fn unreachable(error: &ureq::Error) -> bool {
    match error {
        ureq::Error::HostNotFound => true,
        ureq::Error::Io(error) => error.kind() == std::io::ErrorKind::ConnectionRefused,
        _ => false,
    }
}

/// 0.5 s, 1 s, 2 s, 4 s…: enough for a throttling server to let go.
#[cfg(feature = "net")]
fn backoff(attempt: u32) -> Duration {
    Duration::from_millis(250 << attempt.min(6))
}

mod reader;
pub(crate) use reader::Reader;
#[cfg(all(test, feature = "net"))]
mod tests;
