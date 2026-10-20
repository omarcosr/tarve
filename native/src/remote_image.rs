//! `<Image src="https://…">`: fetched and decoded on worker threads once the
//! image is painted, then handed back to the UI thread as a `Command`.
use crate::protocol::Command;
use std::collections::VecDeque;
use std::io::Read;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;

/// Concurrent downloads, as many as a browser opens per host.
const WORKERS: usize = 6;
const MAX_BYTES: u64 = 64 * 1024 * 1024;

#[cfg(feature = "net")]
fn agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::Agent::config_builder()
            .timeout_connect(Some(Duration::from_secs(15)))
            .timeout_global(Some(Duration::from_secs(60)))
            .build()
            .into()
    })
}

/// Seconds a response may be reused, from `Cache-Control: max-age`; none for
/// `no-store`, `no-cache` or `private` responses.
fn max_age(cache_control: &str) -> Option<u64> {
    let mut age = None;
    for directive in cache_control.split(',').map(str::trim) {
        let lower = directive.to_ascii_lowercase();
        if lower == "no-store" || lower == "no-cache" || lower == "private" {
            return None;
        }
        if let Some(value) = lower.strip_prefix("max-age=") {
            age = value.trim_matches('"').parse::<u64>().ok();
        }
    }
    age.filter(|age| *age > 0)
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

/// Disk cache for responses that allow it, so covers survive a restart.
mod disk {
    use std::hash::{Hash, Hasher};
    use std::path::PathBuf;

    const MAX_BYTES: u64 = 256 * 1024 * 1024;

    fn dir() -> Option<PathBuf> {
        let base = std::env::var_os("LOCALAPPDATA")
            .or_else(|| std::env::var_os("XDG_CACHE_HOME"))
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache")))?;
        Some(base.join("tarve").join("images"))
    }

    fn path(url: &str) -> Option<PathBuf> {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        url.hash(&mut hasher);
        Some(dir()?.join(format!("{:016x}", hasher.finish())))
    }

    /// File layout: `<expiry unix seconds>\n<url>\n<body>`.
    pub(super) fn read(url: &str, now: u64) -> Option<Vec<u8>> {
        let file = std::fs::read(path(url)?).ok()?;
        let first = file.iter().position(|byte| *byte == b'\n')?;
        let expiry: u64 = std::str::from_utf8(&file[..first]).ok()?.parse().ok()?;
        let rest = &file[first + 1..];
        let second = rest.iter().position(|byte| *byte == b'\n')?;
        (expiry > now && &rest[..second] == url.as_bytes()).then(|| rest[second + 1..].to_vec())
    }

    pub(super) fn write(url: &str, expiry: u64, body: &[u8]) {
        let (Some(dir), Some(path)) = (dir(), path(url)) else {
            return;
        };
        if std::fs::create_dir_all(&dir).is_err() {
            return;
        }
        let mut file = format!("{expiry}\n{url}\n").into_bytes();
        file.extend_from_slice(body);
        let temp = path.with_extension("tmp");
        if std::fs::write(&temp, file).is_ok() && std::fs::rename(&temp, &path).is_err() {
            let _ = std::fs::remove_file(&temp);
        }
        // Listing the directory costs per file; trim once per batch of writes.
        static WRITES: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        if WRITES
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            .is_multiple_of(64)
        {
            trim(&dir);
        }
    }

    /// Deletes the oldest files once the cache passes `MAX_BYTES`.
    fn trim(dir: &std::path::Path) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut files: Vec<_> = entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let meta = entry.metadata().ok()?;
                Some((meta.modified().ok()?, meta.len(), entry.path()))
            })
            .collect();
        let mut total: u64 = files.iter().map(|file| file.1).sum();
        if total <= MAX_BYTES {
            return;
        }
        files.sort_by_key(|file| file.0);
        for (_, len, path) in files {
            if total <= MAX_BYTES * 3 / 4 {
                break;
            }
            if std::fs::remove_file(path).is_ok() {
                total -= len;
            }
        }
    }
}

/// Built without the native "net" feature: remote images report an error.
#[cfg(not(feature = "net"))]
fn fetch(url: &str) -> Result<Vec<u8>, String> {
    disk::read(url, now()).ok_or_else(|| "remote images need the native \"net\" feature".to_string())
}

#[cfg(feature = "net")]
fn fetch(url: &str) -> Result<Vec<u8>, String> {
    if let Some(bytes) = disk::read(url, now()) {
        return Ok(bytes);
    }
    let response = agent().get(url).call().map_err(|error| error.to_string())?;
    let age = response
        .headers()
        .get("cache-control")
        .and_then(|value| value.to_str().ok())
        .and_then(max_age);
    let mut bytes = Vec::new();
    response
        .into_body()
        .into_reader()
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(format!("remote image exceeds the {MAX_BYTES} byte limit"));
    }
    if let Some(age) = age {
        disk::write(url, now().saturating_add(age), &bytes);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    #[test]
    fn cache_control_allows_disk_reuse_only_with_a_public_max_age() {
        assert_eq!(super::max_age("public, max-age=86400"), Some(86400));
        assert_eq!(super::max_age("max-age=0"), None);
        assert_eq!(super::max_age("private, max-age=60"), None);
        assert_eq!(super::max_age("no-store"), None);
        assert_eq!(super::max_age(""), None);
    }
}

#[derive(Default)]
struct Queue {
    urls: VecDeque<String>,
    closed: bool,
}

type Shared = Arc<(Mutex<Queue>, Condvar)>;

pub(crate) struct RemoteImages {
    queue: Shared,
    workers: usize,
    proxy: crate::runtime::CommandProxy,
}

impl RemoteImages {
    pub(crate) fn new(proxy: crate::runtime::CommandProxy) -> Self {
        Self {
            queue: Arc::default(),
            workers: 0,
            proxy,
        }
    }

    /// Queues URLs; worker threads start on demand, up to `WORKERS`.
    pub(crate) fn request(&mut self, urls: Vec<String>) {
        if urls.is_empty() {
            return;
        }
        let pending = {
            let mut queue = self.queue.0.lock().unwrap();
            queue.urls.extend(urls);
            queue.urls.len()
        };
        self.queue.1.notify_all();
        while self.workers < WORKERS.min(pending) {
            let queue = self.queue.clone();
            let proxy = self.proxy.clone();
            let spawned = std::thread::Builder::new()
                .name("tarve-image".into())
                .spawn(move || worker(&queue, &proxy));
            if spawned.is_err() {
                break;
            }
            self.workers += 1;
        }
    }
}

impl Drop for RemoteImages {
    fn drop(&mut self) {
        self.queue.0.lock().unwrap().closed = true;
        self.queue.1.notify_all();
    }
}

fn worker(queue: &Shared, proxy: &crate::runtime::CommandProxy) {
    loop {
        let url = {
            let mut state = queue.0.lock().unwrap();
            loop {
                if state.closed {
                    return;
                }
                // Newest first: what was painted last is most likely still on screen.
                if let Some(url) = state.urls.pop_back() {
                    break url;
                }
                state = queue.1.wait(state).unwrap();
            }
        };
        // A panic in a decoder must not take the worker, and the URL with it, down.
        let result = std::panic::catch_unwind(|| {
            fetch(&url).and_then(|bytes| crate::tree::decode_remote_image(&bytes))
        })
        .unwrap_or_else(|_| Err("the image decoder panicked".into()));
        if !proxy.send(Command::RemoteImage { url, result }) {
            return;
        }
    }
}
