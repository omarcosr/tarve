//! C ABI: caller-owned UTF-8 buffers, no borrowed pointers retained across calls.
use crate::{
    protocol::{self, Command, Document},
    runtime,
};
use std::{
    collections::VecDeque,
    panic::{AssertUnwindSafe, catch_unwind},
    sync::{Arc, Condvar, Mutex, OnceLock, mpsc},
    thread::JoinHandle,
};
use winit::event_loop::EventLoopProxy;

#[cfg(target_os = "windows")]
mod wake_pipe {
    use std::{
        ptr,
        sync::atomic::{AtomicU64, Ordering},
    };
    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, ERROR_BROKEN_PIPE, ERROR_NO_DATA, ERROR_PIPE_CONNECTED,
            ERROR_PIPE_LISTENING, GetLastError, INVALID_HANDLE_VALUE,
        },
        Storage::FileSystem::{PIPE_ACCESS_DUPLEX, WriteFile},
        System::Pipes::{
            ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_NOWAIT,
            PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
        },
    };

    static NEXT_PIPE_ID: AtomicU64 = AtomicU64::new(1);

    pub struct WakePipe {
        handle: usize,
        name: String,
        connected: bool,
    }

    impl WakePipe {
        pub fn new() -> Result<Self, String> {
            let id = NEXT_PIPE_ID.fetch_add(1, Ordering::Relaxed);
            let name = format!(r"\\.\pipe\tarve-events-{}-{id}", std::process::id());
            let wide: Vec<u16> = name.encode_utf16().chain([0]).collect();
            let handle = unsafe {
                CreateNamedPipeW(
                    wide.as_ptr(),
                    PIPE_ACCESS_DUPLEX,
                    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS,
                    1,
                    64,
                    64,
                    0,
                    ptr::null(),
                )
            };
            if handle == INVALID_HANDLE_VALUE {
                return Err(format!(
                    "Could not create native event wake pipe: {}",
                    unsafe { GetLastError() }
                ));
            }
            Ok(Self {
                handle: handle as usize,
                name,
                connected: false,
            })
        }

        pub fn name(&self) -> &str {
            &self.name
        }

        fn handle(&self) -> windows_sys::Win32::Foundation::HANDLE {
            self.handle as windows_sys::Win32::Foundation::HANDLE
        }

        fn ensure_connected(&mut self) -> bool {
            if self.connected || self.handle == 0 {
                return self.connected;
            }
            let connected = unsafe { ConnectNamedPipe(self.handle(), ptr::null_mut()) } != 0;
            if connected {
                self.connected = true;
                return true;
            }
            match unsafe { GetLastError() } {
                ERROR_PIPE_CONNECTED => {
                    self.connected = true;
                    true
                }
                ERROR_PIPE_LISTENING => false,
                ERROR_NO_DATA | ERROR_BROKEN_PIPE => {
                    unsafe { DisconnectNamedPipe(self.handle()) };
                    false
                }
                _ => {
                    self.close();
                    false
                }
            }
        }

        pub fn signal(&mut self) {
            if !self.ensure_connected() {
                return;
            }
            let byte = [1u8];
            let mut written = 0u32;
            let ok = unsafe {
                WriteFile(
                    self.handle(),
                    byte.as_ptr(),
                    byte.len() as u32,
                    &mut written,
                    ptr::null_mut(),
                )
            } != 0;
            if !ok {
                let error = unsafe { GetLastError() };
                if error == ERROR_NO_DATA || error == ERROR_BROKEN_PIPE {
                    unsafe { DisconnectNamedPipe(self.handle()) };
                    self.connected = false;
                } else {
                    self.close();
                }
            } else if written != 1 {
                // PIPE_NOWAIT + byte mode may report success with a short write when the pipe
                // buffer is full. This byte is only a wake hint: a full buffer already contains
                // an unread wake, so dropping this redundant signal is correct and keeps the
                // transport alive until the Bun client drains it.
            }
        }

        pub fn close(&mut self) {
            if self.handle == 0 {
                return;
            }
            if self.connected {
                unsafe { DisconnectNamedPipe(self.handle()) };
            }
            unsafe { CloseHandle(self.handle()) };
            self.handle = 0;
            self.connected = false;
        }
    }

    impl Drop for WakePipe {
        fn drop(&mut self) {
            self.close();
        }
    }
}

#[cfg(unix)]
mod wake_pipe {
    use std::{
        fs,
        io::{self, Write},
        os::unix::{
            fs::PermissionsExt,
            net::{UnixListener, UnixStream},
        },
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    static NEXT_SOCKET_ID: AtomicU64 = AtomicU64::new(1);

    pub struct WakePipe {
        listener: Option<UnixListener>,
        stream: Option<UnixStream>,
        path: PathBuf,
        name: String,
    }

    impl WakePipe {
        pub fn new() -> Result<Self, String> {
            let directory = std::env::temp_dir();
            for _ in 0..64 {
                let id = NEXT_SOCKET_ID.fetch_add(1, Ordering::Relaxed);
                let path = directory.join(format!("tarve-events-{}-{id}.sock", std::process::id()));
                match UnixListener::bind(&path) {
                    Ok(listener) => {
                        listener
                            .set_nonblocking(true)
                            .map_err(|error| error.to_string())?;
                        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
                            .map_err(|error| error.to_string())?;
                        let name = path
                            .to_str()
                            .ok_or("Native event socket path is not valid UTF-8")?
                            .to_owned();
                        return Ok(Self {
                            listener: Some(listener),
                            stream: None,
                            path,
                            name,
                        });
                    }
                    Err(error) if error.kind() == io::ErrorKind::AddrInUse => continue,
                    Err(error) => {
                        return Err(format!("Could not create native event socket: {error}"));
                    }
                }
            }
            Err("Could not allocate a unique native event socket path".into())
        }

        pub fn name(&self) -> &str {
            &self.name
        }

        fn ensure_connected(&mut self) -> bool {
            if self.stream.is_some() {
                return true;
            }
            let Some(listener) = self.listener.as_ref() else {
                return false;
            };
            loop {
                match listener.accept() {
                    Ok((stream, _)) => {
                        if stream.set_nonblocking(true).is_err() {
                            return false;
                        }
                        self.stream = Some(stream);
                        return true;
                    }
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => return false,
                    Err(_) => return false,
                }
            }
        }

        pub fn signal(&mut self) {
            if !self.ensure_connected() {
                return;
            }
            let result = self.stream.as_mut().expect("connected stream").write(&[1]);
            match result {
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    // The socket already contains an unread wake hint.
                }
                Err(_) => {
                    self.stream = None;
                }
            }
        }

        pub fn close(&mut self) {
            self.stream = None;
            self.listener = None;
            let _ = fs::remove_file(&self.path);
        }
    }

    impl Drop for WakePipe {
        fn drop(&mut self) {
            self.close();
        }
    }
}

#[cfg(all(not(target_os = "windows"), not(unix)))]
mod wake_pipe {
    pub struct WakePipe;
    impl WakePipe {
        pub fn new() -> Result<Self, String> {
            Err("Native event wake transport is not supported on this platform".into())
        }
        pub fn name(&self) -> &str {
            ""
        }
        pub fn signal(&mut self) {}
        pub fn close(&mut self) {}
    }
}

use wake_pipe::WakePipe;

pub struct Events {
    queue: Mutex<VecDeque<Vec<u8>>>,
    wake: Condvar,
    wake_pipe: Mutex<WakePipe>,
}
impl Events {
    fn new() -> Result<Self, String> {
        Ok(Self {
            queue: Mutex::new(VecDeque::new()),
            wake: Condvar::new(),
            wake_pipe: Mutex::new(WakePipe::new()?),
        })
    }

    pub fn push(&self, event: serde_json::Value) {
        let should_wake = {
            let mut queue = self.queue.lock().unwrap_or_else(|p| p.into_inner());
            let was_empty = queue.is_empty();
            queue.push_back(event.to_string().into_bytes());
            was_empty
        };
        self.wake.notify_one();
        if should_wake {
            self.wake_pipe
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .signal();
        }
    }

    fn wake_pipe_name(&self) -> String {
        self.wake_pipe
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .name()
            .to_owned()
    }

    fn close_wake_pipe(&self) {
        self.wake_pipe
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .close();
    }
}
struct Host {
    proxy: EventLoopProxy<Command>,
    events: Arc<Events>,
    thread: Option<JoinHandle<()>>,
}
static HOST: OnceLock<Mutex<Option<Host>>> = OnceLock::new();
static LAST_ERROR: Mutex<String> = Mutex::new(String::new());
pub const ABI_VERSION: u32 = 5;
fn host() -> &'static Mutex<Option<Host>> {
    HOST.get_or_init(|| Mutex::new(None))
}
fn guard(f: impl FnOnce() -> Result<i32, String>) -> i32 {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(Ok(code)) => code,
        result => {
            let msg = match result {
                Ok(Err(msg)) => msg,
                _ => "Rust panic at FFI boundary".into(),
            };
            *LAST_ERROR.lock().unwrap_or_else(|p| p.into_inner()) = msg;
            -1
        }
    }
}
const MAX_JSON_INPUT_BYTES: u32 = 128 * 1024 * 1024;

unsafe fn read_json<T: serde::de::DeserializeOwned>(ptr: *const u8, len: u32) -> Result<T, String> {
    if ptr.is_null() || len == 0 || len > MAX_JSON_INPUT_BYTES {
        return Err("Invalid input buffer".into());
    }
    // SAFETY: C caller promises a readable buffer of len bytes for this call only.
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len as usize) };
    serde_json::from_slice(bytes).map_err(|e| e.to_string())
}

#[cfg(test)]
mod json_input_tests {
    use super::{MAX_JSON_INPUT_BYTES, read_json};

    #[test]
    fn input_limit_can_transport_one_maximum_dynamic_image() {
        const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;
        let base64_bytes = MAX_IMAGE_BYTES.div_ceil(3) * 4;
        assert!(
            u64::from(MAX_JSON_INPUT_BYTES) > base64_bytes + 1024,
            "JSON input cap must fit a maximum image after base64 expansion"
        );
    }

    #[test]
    fn read_json_rejects_oversized_input_before_dereferencing_the_buffer() {
        let byte = b'0';
        let result = unsafe {
            read_json::<serde_json::Value>(std::ptr::from_ref(&byte), MAX_JSON_INPUT_BYTES + 1)
        };
        assert_eq!(result.unwrap_err(), "Invalid input buffer");
    }
}
#[unsafe(no_mangle)]
pub extern "C" fn tarve_abi_version() -> u32 {
    ABI_VERSION
}

pub(crate) fn validate_protocol_version(version: u32) -> Result<(), String> {
    if version == protocol::VERSION {
        Ok(())
    } else {
        Err("Protocol version mismatch".into())
    }
}

pub(crate) fn validate_external_target(target: &str) -> Result<(), String> {
    let target = target.trim();
    if target.is_empty() || target.len() > 32_768 || target.contains('\0') {
        return Err("External target must be a non-empty URI up to 32768 bytes".into());
    }
    let Some(colon) = target.find(':') else {
        return Err("External target must be an absolute URI with a scheme".into());
    };
    let scheme = &target[..colon];
    if scheme.is_empty()
        || !scheme.as_bytes()[0].is_ascii_alphabetic()
        || !scheme
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.'))
    {
        return Err("External target has an invalid URI scheme".into());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn open_external(target: &str) -> Result<(), String> {
    use std::ptr;
    use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};

    validate_external_target(target)?;
    let operation: Vec<u16> = "open".encode_utf16().chain([0]).collect();
    let target: Vec<u16> = target.trim().encode_utf16().chain([0]).collect();
    let result = unsafe {
        ShellExecuteW(
            ptr::null_mut(),
            operation.as_ptr(),
            target.as_ptr(),
            ptr::null(),
            ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if result as isize <= 32 {
        return Err(format!(
            "Could not open external URI (ShellExecuteW code {})",
            result as isize
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn open_external(target: &str) -> Result<(), String> {
    validate_external_target(target)?;
    #[cfg(target_os = "linux")]
    {
        let target = target.trim();
        match std::process::Command::new("xdg-open").arg(target).spawn() {
            Ok(_) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "Could not open external URI with xdg-open: {error}"
                ));
            }
        }
        std::process::Command::new("gio")
            .args(["open", target])
            .spawn()
            .map_err(|error| format!("Could not open external URI with gio: {error}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    Err("Opening external URIs is not supported on this platform".into())
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn tarve_open_external(ptr: *const u8, len: u32) -> i32 {
    guard(|| {
        if ptr.is_null() || len == 0 || len > 32_768 {
            return Err("Invalid external URI buffer".into());
        }
        let bytes = unsafe { std::slice::from_raw_parts(ptr, len as usize) };
        let target = std::str::from_utf8(bytes).map_err(|_| "External URI must be UTF-8")?;
        open_external(target)?;
        Ok(0)
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn tarve_start(ptr: *const u8, len: u32) -> i32 {
    guard(|| {
        let document: Document = unsafe { read_json(ptr, len)? };
        validate_protocol_version(document.version)?;
        protocol::validate(&document.root)?;
        let w = &document.window;
        if ![w.width, w.height, w.min_width, w.min_height]
            .iter()
            .all(|n| n.is_finite() && *n > 0.0 && *n < 32_768.0)
        {
            return Err("Invalid window dimensions".into());
        }
        if let Some(protocol::WindowPosition::Coordinates { x, y }) = &w.position
            && (!x.is_finite()
                || !y.is_finite()
                || *x < i32::MIN as f64
                || *x > i32::MAX as f64
                || *y < i32::MIN as f64
                || *y > i32::MAX as f64)
        {
            return Err("Invalid window position".into());
        }
        let mut state = host().lock().map_err(|e| e.to_string())?;
        if state.is_some() {
            return Err("Only one native app can be started per process".into());
        }
        crate::renderer::prewarm(document.renderer);
        let events = Arc::new(Events::new()?);
        let out = events.clone();
        let (tx, rx) = mpsc::sync_channel(1);
        let thread = std::thread::Builder::new()
            .name("tarve-window".into())
            .spawn(move || {
                let result =
                    catch_unwind(AssertUnwindSafe(|| runtime::run(document, out.clone(), tx)));
                match result {
                    Ok(Err(e)) => out.push(protocol::error(e)),
                    Err(_) => out.push(protocol::error("Native window thread panicked")),
                    _ => {}
                }
                out.push(serde_json::json!({"type":"closed"}));
            })
            .map_err(|e| e.to_string())?;
        let proxy = rx
            .recv()
            .map_err(|_| "Could not initialize native event loop".to_string())??;
        *state = Some(Host {
            proxy,
            events,
            thread: Some(thread),
        });
        Ok(0)
    })
}

/// Returns the UTF-8 local IPC path used only to wake the Bun event loop.
/// Windows uses a named pipe; Unix platforms use a Unix domain socket.
/// Events themselves remain in the native FIFO and are consumed by tarve_poll_event().
/// A negative value is the required capacity and leaves the name unchanged for retry.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tarve_event_pipe_name(ptr: *mut u8, capacity: u32) -> i32 {
    guard(|| {
        if ptr.is_null() || capacity == 0 {
            return Err("Invalid output buffer".into());
        }
        let name = host()
            .lock()
            .map_err(|e| e.to_string())?
            .as_ref()
            .ok_or("App not started")?
            .events
            .wake_pipe_name();
        let bytes = name.as_bytes();
        if bytes.len() > capacity as usize {
            return Ok(-(bytes.len() as i32));
        }
        unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len()) };
        Ok(bytes.len() as i32)
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn tarve_send(ptr: *const u8, len: u32) -> i32 {
    guard(|| {
        let command: Command = unsafe { read_json(ptr, len)? };
        if let Command::Update { root } = &command {
            protocol::validate(root)?;
        }
        if let Command::Patch { nodes } = &command {
            protocol::validate_patch(nodes)?;
        }
        if let Command::Mutate { mutations } = &command {
            protocol::validate_mutations(mutations)?;
        }
        if let Command::FileDialog { mode, options, .. } = &command {
            protocol::validate_file_dialog(mode, options)?;
        }
        host()
            .lock()
            .map_err(|e| e.to_string())?
            .as_ref()
            .ok_or("App not started")?
            .proxy
            .send_event(command)
            .map_err(|e| e.to_string())?;
        Ok(0)
    })
}

/// Legacy blocking dequeue retained for ABI consumers outside the current Bun bridge.
/// Negative return is the required capacity; the event remains queued for retry.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tarve_wait_event(ptr: *mut u8, capacity: u32) -> i32 {
    guard(|| {
        if ptr.is_null() || capacity == 0 {
            return Err("Invalid output buffer".into());
        }
        let events = host()
            .lock()
            .map_err(|e| e.to_string())?
            .as_ref()
            .ok_or("App not started")?
            .events
            .clone();
        let mut queue = events.queue.lock().map_err(|e| e.to_string())?;
        while queue.is_empty() {
            queue = events.wake.wait(queue).map_err(|e| e.to_string())?;
        }
        let data = queue.front().unwrap();
        if data.len() > capacity as usize {
            return Ok(-(data.len() as i32));
        }
        let data = queue.pop_front().unwrap();
        // SAFETY: caller owns a writable buffer of capacity bytes; length checked above.
        unsafe {
            std::ptr::copy_nonoverlapping(data.as_ptr(), ptr, data.len());
        }
        Ok(data.len() as i32)
    })
}

/// Non-blocking event dequeue for the Bun main runtime.
/// Positive = bytes copied; < -1 = required capacity (event retained); 0 = no queued event.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tarve_poll_event(ptr: *mut u8, capacity: u32) -> i32 {
    guard(|| {
        if ptr.is_null() || capacity == 0 {
            return Err("Invalid output buffer".into());
        }
        let events = host()
            .lock()
            .map_err(|e| e.to_string())?
            .as_ref()
            .ok_or("App not started")?
            .events
            .clone();
        let mut queue = events.queue.lock().map_err(|e| e.to_string())?;
        let Some(data) = queue.front() else {
            return Ok(0);
        };
        if data.len() > capacity as usize {
            return Ok(-(data.len() as i32));
        }
        let data = queue.pop_front().unwrap();
        // SAFETY: caller owns a writable buffer of capacity bytes; length checked above.
        unsafe {
            std::ptr::copy_nonoverlapping(data.as_ptr(), ptr, data.len());
        }
        Ok(data.len() as i32)
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn tarve_last_error(ptr: *mut u8, capacity: u32) -> i32 {
    let error = LAST_ERROR.lock().unwrap_or_else(|p| p.into_inner());
    if ptr.is_null() || capacity == 0 {
        return 0;
    }
    let size = error.len().min(capacity as usize);
    unsafe {
        std::ptr::copy_nonoverlapping(error.as_ptr(), ptr, size);
    }
    size as i32
}
#[unsafe(no_mangle)]
pub extern "C" fn tarve_join() -> i32 {
    guard(|| {
        let (thread, events) = {
            let mut state = host().lock().map_err(|e| e.to_string())?;
            let host = state.as_mut().ok_or("App not started")?;
            (host.thread.take(), host.events.clone())
        };
        if let Some(thread) = thread {
            thread
                .join()
                .map_err(|_| "Window thread failed".to_string())?;
        }
        events.close_wake_pipe();
        Ok(0)
    })
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::Events;
    use std::{
        fs::OpenOptions,
        io::Read,
        os::windows::io::AsRawHandle,
        sync::Arc,
        time::{Duration, Instant},
    };
    use windows_sys::Win32::System::Pipes::PeekNamedPipe;

    fn available_bytes(file: &std::fs::File) -> u32 {
        let mut available = 0u32;
        let ok = unsafe {
            PeekNamedPipe(
                file.as_raw_handle() as _,
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                &mut available,
                std::ptr::null_mut(),
            )
        };
        assert_ne!(ok, 0);
        available
    }

    #[test]
    fn named_pipe_wakes_once_per_empty_to_nonempty_queue_transition() {
        let events = Events::new().expect("wake pipe");
        let name = events.wake_pipe_name();
        let mut client = OpenOptions::new()
            .read(true)
            .write(true)
            .open(name)
            .expect("connect wake pipe client");

        events.push(serde_json::json!({"type":"first"}));
        let mut byte = [0u8; 1];
        client.read_exact(&mut byte).expect("read first wake");
        assert_eq!(byte, [1]);

        events.push(serde_json::json!({"type":"second"}));
        assert_eq!(
            available_bytes(&client),
            0,
            "queued bursts must coalesce wake signals"
        );

        events
            .queue
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
        events.push(serde_json::json!({"type":"third"}));
        client.read_exact(&mut byte).expect("read rearmed wake");
        assert_eq!(byte, [1]);
    }

    #[test]
    fn named_pipe_survives_wake_backpressure() {
        let events = Events::new().expect("wake pipe");
        let name = events.wake_pipe_name();
        let client = OpenOptions::new()
            .read(true)
            .write(true)
            .open(name)
            .expect("connect wake pipe client");

        // The pipe is only a wake hint. Simulate a consumer that drains the FIFO faster than it
        // reads the wake bytes, causing many empty->nonempty transitions to accumulate in the
        // tiny pipe buffer. Backpressure must not destroy the transport.
        for index in 0..512 {
            events.push(serde_json::json!({"type":"burst", "index": index}));
            events
                .queue
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clear();
        }

        assert!(
            available_bytes(&client) > 0,
            "at least one wake must remain readable"
        );
        events.push(serde_json::json!({"type":"after-backpressure"}));
        assert!(
            available_bytes(&client) > 0,
            "wake pipe must remain connected after backpressure"
        );
    }

    #[test]
    fn named_pipe_large_fifo_has_no_lost_wake() {
        const TOTAL: usize = 50_000;
        let events = Arc::new(Events::new().expect("wake pipe"));
        let name = events.wake_pipe_name();
        let mut client = OpenOptions::new()
            .read(true)
            .write(true)
            .open(name)
            .expect("connect wake pipe client");
        let producer_events = events.clone();
        let producer = std::thread::spawn(move || {
            for index in 0..TOTAL {
                producer_events.push(serde_json::json!({"type":"stress", "index":index}));
            }
        });

        let deadline = Instant::now() + Duration::from_secs(10);
        let mut drained = 0usize;
        let mut byte = [0u8; 1];
        while drained < TOTAL && Instant::now() < deadline {
            if available_bytes(&client) == 0 {
                std::thread::yield_now();
                continue;
            }
            client.read_exact(&mut byte).expect("read wake");
            assert_eq!(byte, [1]);
            let mut queue = events.queue.lock().unwrap_or_else(|p| p.into_inner());
            drained += queue.len();
            queue.clear();
        }
        producer.join().expect("producer");
        if drained < TOTAL {
            let mut queue = events.queue.lock().unwrap_or_else(|p| p.into_inner());
            drained += queue.len();
            queue.clear();
        }
        assert_eq!(drained, TOTAL, "every queued event must remain drainable");
    }
}

#[cfg(all(test, unix))]
mod unix_tests {
    use super::Events;
    use std::{
        io::{ErrorKind, Read},
        os::unix::net::UnixStream,
        path::Path,
    };

    #[test]
    fn unix_socket_wakes_once_per_empty_to_nonempty_queue_transition() {
        let events = Events::new().expect("wake socket");
        let name = events.wake_pipe_name();
        let mut client = UnixStream::connect(&name).expect("connect wake socket client");
        client
            .set_nonblocking(true)
            .expect("nonblocking wake socket client");

        events.push(serde_json::json!({"type":"first"}));
        let mut byte = [0u8; 1];
        client.read_exact(&mut byte).expect("read first wake");
        assert_eq!(byte, [1]);

        events.push(serde_json::json!({"type":"second"}));
        let error = client
            .read(&mut byte)
            .expect_err("queued bursts must coalesce wake signals");
        assert_eq!(error.kind(), ErrorKind::WouldBlock);

        events
            .queue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
        events.push(serde_json::json!({"type":"third"}));
        client.read_exact(&mut byte).expect("read rearmed wake");
        assert_eq!(byte, [1]);

        drop(client);
        drop(events);
        assert!(
            !Path::new(&name).exists(),
            "wake socket must be removed on drop"
        );
    }
}
