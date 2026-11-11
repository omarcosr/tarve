//! C ABI entry points that need no app state.
use super::*;

/// Lets process `pid` take the foreground (Windows `AllowSetForegroundWindow`): a
/// second launch hands its arguments to the first instance, which then brings its
/// window forward. A no-op elsewhere.
#[unsafe(no_mangle)]
pub extern "C" fn tarve_allow_foreground(pid: u32) -> i32 {
    #[cfg(target_os = "windows")]
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow(pid);
    }
    #[cfg(not(target_os = "windows"))]
    let _ = pid;
    0
}

/// Starts what the first frame waits on (the GPU device) before the document is ready:
/// 0 auto, 1 gpu, 2 cpu, as the document's renderer. Optional; tarve_start does it too.
#[unsafe(no_mangle)]
pub extern "C" fn tarve_prewarm(renderer: u32) -> i32 {
    crate::stats::mark_started();
    let preference = match renderer {
        1 => protocol::RendererPreference::Gpu,
        2 => protocol::RendererPreference::Cpu,
        _ => protocol::RendererPreference::Auto,
    };
    crate::renderer::prewarm(preference);
    crate::text::prewarm();
    0
}

/// The `len` bytes at `ptr`, borrowed for one call (an empty input may be a null pointer).
unsafe fn input<'a>(ptr: *const u8, len: u32) -> Result<&'a [u8], String> {
    if len == 0 {
        return Ok(&[]);
    }
    if ptr.is_null() {
        return Err("Invalid input buffer".into());
    }
    // SAFETY: the C caller promises a readable buffer of len bytes for this call only.
    Ok(unsafe { std::slice::from_raw_parts(ptr, len as usize) })
}

/// Copies `bytes` into the caller's buffer: their length, or, when they do not fit, minus the
/// capacity they need (below -1, so never read as an error; nothing is written).
unsafe fn output(bytes: &[u8], ptr: *mut u8, capacity: u32) -> Result<i32, String> {
    let length = i32::try_from(bytes.len()).map_err(|_| "Output is larger than 2 GiB")?;
    if bytes.len() > capacity as usize {
        return Ok(-length.max(2));
    }
    if !bytes.is_empty() {
        if ptr.is_null() {
            return Err("Invalid output buffer".into());
        }
        // SAFETY: the caller owns a writable buffer of capacity bytes; length checked above.
        unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len()) };
    }
    Ok(length)
}

/// node:zlib's `deflateSync` where the runtime lacks it (txiki.js, packages/core/txiki/shims/zlib.ts):
/// the zlib stream of the input at `level` (0–9) into `out`. Returns its length, below -1 the
/// capacity it needs (call again with a buffer that large), or -1 with tarve_last_error set.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tarve_zlib_deflate(
    level: u32,
    ptr: *const u8,
    len: u32,
    out: *mut u8,
    capacity: u32,
) -> i32 {
    guard(|| {
        let data = unsafe { input(ptr, len)? };
        let level = u8::try_from(level.min(10)).unwrap_or(crate::zlib::DEFAULT_LEVEL);
        unsafe { output(&crate::zlib::deflate(data, level), out, capacity) }
    })
}

/// node:zlib's `inflateSync` where the runtime lacks it: the bytes of a zlib stream into `out`.
/// Returns as tarve_zlib_deflate does; data that is not a zlib stream is an error (-1).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tarve_zlib_inflate(
    ptr: *const u8,
    len: u32,
    out: *mut u8,
    capacity: u32,
) -> i32 {
    guard(|| {
        let data = unsafe { input(ptr, len)? };
        unsafe { output(&crate::zlib::inflate(data)?, out, capacity) }
    })
}

/// node:zlib's `gzipSync` where the runtime lacks it: a gzip member of the input at `level`
/// (0–9), with the header Node.js writes. Returns as tarve_zlib_deflate does.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tarve_zlib_gzip(
    level: u32,
    ptr: *const u8,
    len: u32,
    out: *mut u8,
    capacity: u32,
) -> i32 {
    guard(|| {
        let data = unsafe { input(ptr, len)? };
        let level = u8::try_from(level.min(10)).unwrap_or(crate::zlib::DEFAULT_LEVEL);
        unsafe { output(&crate::zlib::gzip(data, level), out, capacity) }
    })
}

/// node:zlib's `gunzipSync` where the runtime lacks it: the bytes of a gzip stream (its members
/// joined) into `out`. Returns as tarve_zlib_deflate does; damaged data is an error (-1).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tarve_zlib_gunzip(
    ptr: *const u8,
    len: u32,
    out: *mut u8,
    capacity: u32,
) -> i32 {
    guard(|| {
        let data = unsafe { input(ptr, len)? };
        unsafe { output(&crate::zlib::gunzip(data)?, out, capacity) }
    })
}

/// A plugin's native library reports to its JavaScript (`ctx.events(channel)`) from any thread:
/// `channel` is NUL-terminated UTF-8 (1-128 bytes), the `len` bytes at `data` are copied and
/// arrive as a Uint8Array. Events sent before the app started (from a plugin's setup) are held and
/// delivered once it starts. Returns 0, or -1 (tarve_last_error) when an argument is invalid. The library gets this function's address from `ctx.emitAddress()`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tarve_plugin_emit(
    channel: *const std::ffi::c_char,
    data: *const u8,
    len: usize,
) -> i32 {
    use base64::Engine;
    guard(|| {
        if channel.is_null() {
            return Err("tarve_plugin_emit: null channel".into());
        }
        // SAFETY: the caller passes a NUL-terminated string for this call.
        let channel = unsafe { std::ffi::CStr::from_ptr(channel) }
            .to_str()
            .map_err(|_| "tarve_plugin_emit: the channel is not UTF-8")?;
        if channel.is_empty() || channel.len() > 128 {
            return Err("tarve_plugin_emit: the channel must be 1-128 bytes".into());
        }
        let len = u32::try_from(len).map_err(|_| "tarve_plugin_emit: more than 4 GiB")?;
        let bytes = unsafe { input(data, len)? };
        let event = serde_json::json!({
            "type": "pluginEvent",
            "channel": channel,
            "data": base64::engine::general_purpose::STANDARD.encode(bytes),
        });
        let state = host().lock().unwrap_or_else(|p| p.into_inner());
        match state.as_ref() {
            Some(host) => host.events.push(event),
            // Before tarve_start (a plugin's setup runs first): held until the app starts.
            None => {
                let mut pending = PENDING_PLUGIN_EVENTS
                    .lock()
                    .unwrap_or_else(|p| p.into_inner());
                if pending.len() >= MAX_PENDING_PLUGIN_EVENTS {
                    return Err(
                        "tarve_plugin_emit: more than 4096 events before the app started".into(),
                    );
                }
                pending.push(event);
            }
        }
        Ok(0)
    })
}

/// Plugin events sent before the app started, queued by tarve_start in order.
static PENDING_PLUGIN_EVENTS: std::sync::Mutex<Vec<serde_json::Value>> =
    std::sync::Mutex::new(Vec::new());
const MAX_PENDING_PLUGIN_EVENTS: usize = 4096;

/// The plugin events sent before tarve_start, for the app's queue.
pub(super) fn take_pending_plugin_events() -> Vec<serde_json::Value> {
    std::mem::take(
        &mut *PENDING_PLUGIN_EVENTS
            .lock()
            .unwrap_or_else(|p| p.into_inner()),
    )
}

/// The address of `tarve_plugin_emit`, which JavaScript hands to a plugin's library
/// (`ctx.emitAddress()`): the library calls it without linking against this one.
#[unsafe(no_mangle)]
pub extern "C" fn tarve_plugin_emit_address() -> u64 {
    tarve_plugin_emit as *const () as usize as u64
}

/// Queues an event for the app from outside the event loop (an Android activity's result).
#[cfg(target_os = "android")]
pub(crate) fn emit(event: serde_json::Value) {
    if let Some(host) = host().lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
        host.events.push(event);
    }
}
