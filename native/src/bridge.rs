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

#[derive(Default)]
pub struct Events {
    queue: Mutex<VecDeque<Vec<u8>>>,
    wake: Condvar,
}
impl Events {
    pub fn push(&self, event: serde_json::Value) {
        self.queue
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push_back(event.to_string().into_bytes());
        self.wake.notify_one();
    }
}
struct Host {
    proxy: EventLoopProxy<Command>,
    events: Arc<Events>,
    thread: Option<JoinHandle<()>>,
}
static HOST: OnceLock<Mutex<Option<Host>>> = OnceLock::new();
static LAST_ERROR: Mutex<String> = Mutex::new(String::new());
pub const ABI_VERSION: u32 = 1;
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
unsafe fn read_json<T: serde::de::DeserializeOwned>(ptr: *const u8, len: u32) -> Result<T, String> {
    if ptr.is_null() || len == 0 || len > 16 * 1024 * 1024 {
        return Err("Invalid input buffer".into());
    }
    // SAFETY: C caller promises a readable buffer of len bytes for this call only.
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len as usize) };
    serde_json::from_slice(bytes).map_err(|e| e.to_string())
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
        let events = Arc::new(Events::default());
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
            .map_err(|_| "Could not initialize native event loop".to_string())?;
        *state = Some(Host {
            proxy,
            events,
            thread: Some(thread),
        });
        Ok(0)
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

/// Blocks on a condition variable. Call ONLY from the dedicated Bun Worker.
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
        let thread = host()
            .lock()
            .map_err(|e| e.to_string())?
            .as_mut()
            .and_then(|h| h.thread.take());
        if let Some(thread) = thread {
            thread
                .join()
                .map_err(|_| "Window thread failed".to_string())?;
        }
        Ok(0)
    })
}
