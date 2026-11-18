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

/// Waits for a process where the runtime cannot (txiki.js's `spawn` shim on Windows, which starts
/// hidden children with CreateProcessW): writes into `out` the name of a named pipe that, once a
/// client connected and `process` (a handle the caller keeps owning) ended, carries its exit code
/// (u32, little endian) and closes. Returns as tarve_zlib_deflate does; -1 elsewhere than Windows.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tarve_watch_process(process: u64, out: *mut u8, capacity: u32) -> i32 {
    guard(|| {
        #[cfg(target_os = "windows")]
        {
            process_watch::watch(process, out, capacity)
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = (process, out, capacity);
            Err("tarve_watch_process is only available on Windows".to_string())
        }
    })
}

/// The name of a fresh wake pipe for threadsafe callbacks (native/src/threadsafe.rs) into `out`;
/// the previous one closes. A byte arrives on it when calls were queued. Returns as
/// tarve_zlib_deflate does.
#[cfg(not(target_arch = "wasm32"))]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tarve_threadsafe_pipe_name(out: *mut u8, capacity: u32) -> i32 {
    guard(|| {
        let name = crate::threadsafe::pipe_name()?;
        unsafe { output(name.as_bytes(), out, capacity) }
    })
}

/// Opens a threadsafe callback for JavaScript callback `id`: the address of a C function any
/// thread may call with up to 6 integer or pointer arguments; each call is queued and returns
/// `returns` at once. With `copy_arg` below 6, each call also copies `copy_len` bytes from the
/// address that argument holds. 0 when it cannot open one (tarve_last_error says why).
#[cfg(not(target_arch = "wasm32"))]
#[unsafe(no_mangle)]
pub extern "C" fn tarve_threadsafe_callback(
    id: u32,
    returns: u64,
    copy_arg: u32,
    copy_len: u32,
) -> u64 {
    match crate::threadsafe::create(id, returns, copy_arg, copy_len) {
        Ok(address) => address,
        Err(message) => {
            *LAST_ERROR.lock().unwrap_or_else(|p| p.into_inner()) = message;
            0
        }
    }
}

/// Closes the threadsafe callback at `address`: 1, or 0 when none is open there.
#[cfg(not(target_arch = "wasm32"))]
#[unsafe(no_mangle)]
pub extern "C" fn tarve_threadsafe_close(address: u64) -> i32 {
    i32::from(crate::threadsafe::close(address))
}

/// Takes the queued calls into `out`: whole records (id u32, copied length u32, 6 arguments u64,
/// the copied bytes), in call order. Their length (0 when none), or, when not even the first
/// fits, minus the capacity it needs.
#[cfg(not(target_arch = "wasm32"))]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tarve_threadsafe_poll(out: *mut u8, capacity: u32) -> i32 {
    guard(|| {
        if out.is_null() || capacity == 0 {
            return Err("Invalid output buffer".into());
        }
        // SAFETY: the caller owns a writable buffer of `capacity` bytes for this call.
        let buffer = unsafe { std::slice::from_raw_parts_mut(out, capacity as usize) };
        match crate::threadsafe::poll(buffer) {
            Ok(written) => Ok(written as i32),
            Err(needed) => Ok(-(needed as i32).max(2)),
        }
    })
}

/// Calls dropped since the last ask because JavaScript left too many queued.
#[cfg(not(target_arch = "wasm32"))]
#[unsafe(no_mangle)]
pub extern "C" fn tarve_threadsafe_dropped() -> u64 {
    crate::threadsafe::take_dropped()
}

/// A COM object whose IUnknown runs natively: `iids` (`count` GUIDs of 16 bytes) are the
/// interfaces it answers to besides IUnknown and IAgileObject, `methods` (`methods_count` u64
/// addresses) its vtable after IUnknown. Its address, holding one reference
/// (tarve_com_release); 0 on error.
#[cfg(not(target_arch = "wasm32"))]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tarve_com_object(
    iids: *const u8,
    count: u32,
    methods: *const u8,
    methods_count: u32,
) -> u64 {
    let built = (|| {
        let iid_bytes = unsafe { input(iids, count.checked_mul(16).ok_or("Too many IIDs")?)? };
        let method_bytes = unsafe {
            input(
                methods,
                methods_count.checked_mul(8).ok_or("Too many methods")?,
            )?
        };
        let iids = iid_bytes.as_chunks::<16>().0.to_vec();
        let methods: Vec<u64> = method_bytes
            .as_chunks::<8>()
            .0
            .iter()
            .map(|chunk| u64::from_le_bytes(*chunk))
            .collect();
        crate::threadsafe::com_object(iids, &methods)
    })();
    match built {
        Ok(object) => object,
        Err(message) => {
            *LAST_ERROR.lock().unwrap_or_else(|p| p.into_inner()) = message;
            0
        }
    }
}

/// Releases one reference to an object tarve_com_object made: the references left, or -1.
#[cfg(not(target_arch = "wasm32"))]
#[unsafe(no_mangle)]
pub extern "C" fn tarve_com_release(object: u64) -> i32 {
    guard(|| crate::threadsafe::com_release(object).map(|left| left as i32))
}

#[cfg(not(target_os = "windows"))]
const MESSAGE_WINDOW_UNSUPPORTED: &str = "messageWindow is only available on Windows";

pub(crate) fn set_last_error(message: String) {
    *LAST_ERROR.lock().unwrap_or_else(|p| p.into_inner()) = message;
}

/// Opens a message window (native/src/message_window.rs): a hidden window on its own thread,
/// described by the JSON options at `ptr`, whose messages, WinEvents, shell hook notifications and
/// registry/folder changes go to the threadsafe callback at `callback`. Its id, or 0
/// (tarve_last_error) on error and off Windows.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tarve_message_window_open(ptr: *const u8, len: u32, callback: u64) -> u64 {
    #[cfg(target_os = "windows")]
    let opened = unsafe { read_json::<crate::message_window::Options>(ptr, len) }
        .and_then(|options| crate::message_window::open(options, callback));
    #[cfg(not(target_os = "windows"))]
    let opened: Result<u64, String> = {
        let _ = (ptr, len, callback);
        Err(MESSAGE_WINDOW_UNSUPPORTED.into())
    };
    opened.unwrap_or_else(|message| {
        set_last_error(message);
        0
    })
}

/// The message window's description as JSON (hwnd, threadId, registered message ids, shellHook)
/// into `out`. Returns as tarve_zlib_deflate does.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tarve_message_window_info(id: u64, out: *mut u8, capacity: u32) -> i32 {
    guard(|| {
        #[cfg(target_os = "windows")]
        {
            let info = crate::message_window::info(id)?;
            unsafe { output(info.as_bytes(), out, capacity) }
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = (id, out, capacity);
            Err(MESSAGE_WINDOW_UNSUPPORTED.into())
        }
    })
}

/// JavaScript's LRESULT for the sent message `sequence` the window waits on: 1, or 0 when that
/// message no longer waits (answered, timed out, closed).
#[unsafe(no_mangle)]
pub extern "C" fn tarve_message_window_reply(id: u64, sequence: u64, value: i64) -> i32 {
    #[cfg(target_os = "windows")]
    return i32::from(crate::message_window::reply(id, sequence, value));
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (id, sequence, value);
        0
    }
}

/// Sets (`set` 1) or clears the LRESULT of `message` to `hwnd`, keyed by `kind`/`key`: 1 or 0.
#[unsafe(no_mangle)]
pub extern "C" fn tarve_message_window_set_reply(
    id: u64,
    hwnd: u64,
    message: u32,
    kind: u32,
    key: u64,
    set: u32,
    value: i64,
) -> i32 {
    #[cfg(target_os = "windows")]
    return crate::message_window::set_reply(id, hwnd, message, kind, key, set, value).into();
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (id, hwnd, message, kind, key, set, value);
        0
    }
}

/// Stops the message window's thread and waits for it (hooks, window and class released): 1, or
/// 0 for no such window.
#[unsafe(no_mangle)]
pub extern "C" fn tarve_message_window_close(id: u64) -> i32 {
    #[cfg(target_os = "windows")]
    return i32::from(crate::message_window::close(id));
    #[cfg(not(target_os = "windows"))]
    {
        let _ = id;
        0
    }
}

#[cfg(target_os = "windows")]
mod process_watch {
    use std::{
        ptr,
        sync::atomic::{AtomicU64, Ordering},
    };
    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, DUPLICATE_SAME_ACCESS, DuplicateHandle, ERROR_PIPE_CONNECTED,
            GetLastError, HANDLE, INVALID_HANDLE_VALUE,
        },
        Storage::FileSystem::{FlushFileBuffers, PIPE_ACCESS_OUTBOUND, WriteFile},
        System::{
            Pipes::{
                ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe,
                PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
            },
            Threading::{GetCurrentProcess, GetExitCodeProcess, INFINITE, WaitForSingleObject},
        },
    };

    static NEXT_WATCH: AtomicU64 = AtomicU64::new(1);

    pub(super) fn watch(process: u64, out: *mut u8, capacity: u32) -> Result<i32, String> {
        let id = NEXT_WATCH.fetch_add(1, Ordering::Relaxed);
        let name = format!(r"\\.\pipe\tarve-exit-{}-{id}", std::process::id());
        if name.len() > capacity as usize {
            // Asks for room before creating anything (see `output`).
            return unsafe { super::output(name.as_bytes(), out, capacity) };
        }
        let mut own: HANDLE = ptr::null_mut();
        // SAFETY: duplicates the caller's handle within this process; checked below.
        let duplicated = unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                process as usize as HANDLE,
                GetCurrentProcess(),
                &mut own,
                0,
                0,
                DUPLICATE_SAME_ACCESS,
            )
        };
        if duplicated == 0 {
            return Err(format!(
                "Invalid process handle (Windows error {})",
                unsafe { GetLastError() }
            ));
        }
        let wide: Vec<u16> = name.encode_utf16().chain([0]).collect();
        // SAFETY: a NUL-terminated name; the handle is checked below.
        let pipe = unsafe {
            CreateNamedPipeW(
                wide.as_ptr(),
                PIPE_ACCESS_OUTBOUND,
                PIPE_TYPE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                8,
                8,
                0,
                ptr::null(),
            )
        };
        if pipe == INVALID_HANDLE_VALUE {
            let error = unsafe { GetLastError() };
            unsafe { CloseHandle(own) };
            return Err(format!(
                "Could not create the exit pipe (Windows error {error})"
            ));
        }
        let (own, pipe) = (own as usize, pipe as usize);
        let spawned = std::thread::Builder::new()
            .name("tarve-process-watch".into())
            .stack_size(64 * 1024)
            .spawn(move || {
                let (own, pipe) = (own as HANDLE, pipe as HANDLE);
                // SAFETY: both handles belong to this thread, which closes them.
                unsafe {
                    let connected = ConnectNamedPipe(pipe, ptr::null_mut()) != 0
                        || GetLastError() == ERROR_PIPE_CONNECTED;
                    if connected {
                        WaitForSingleObject(own, INFINITE);
                        let mut code = 1u32;
                        GetExitCodeProcess(own, &mut code);
                        let bytes = code.to_le_bytes();
                        let mut written = 0u32;
                        WriteFile(pipe, bytes.as_ptr(), 4, &mut written, ptr::null_mut());
                        FlushFileBuffers(pipe);
                        DisconnectNamedPipe(pipe);
                    }
                    CloseHandle(pipe);
                    CloseHandle(own);
                }
            });
        if let Err(error) = spawned {
            unsafe {
                CloseHandle(pipe as HANDLE);
                CloseHandle(own as HANDLE);
            }
            return Err(format!("Could not start the process watch: {error}"));
        }
        unsafe { super::output(name.as_bytes(), out, capacity) }
    }
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

/// Follows other apps' media sessions (Windows): `tarve_media_sessions` then answers from a list
/// kept up to date, and `callback` (a C function taking a u64, a threadsafe callback) is called
/// with the list's version whenever it changes. Watching already: only the callback changes.
/// 0, or -1 (tarve_last_error) when Windows has no session manager or off Windows.
#[cfg(not(target_arch = "wasm32"))]
#[unsafe(no_mangle)]
pub extern "C" fn tarve_media_sessions_watch(callback: u64) -> i32 {
    guard(|| {
        if callback == 0 {
            return Err("tarve_media_sessions_watch needs a callback".into());
        }
        crate::media_sessions::watch(callback).map(|()| 0)
    })
}

/// Stops tarve_media_sessions_watch: its subscriptions, its thread and the kept list. 0.
#[cfg(not(target_arch = "wasm32"))]
#[unsafe(no_mangle)]
pub extern "C" fn tarve_media_sessions_unwatch() -> i32 {
    crate::media_sessions::unwatch();
    0
}

/// The sessions `tarve_media_sessions` read that did not fit the caller's buffer, handed to the
/// next call (made with the capacity asked for) instead of listing them again.
static PENDING_MEDIA_SESSIONS: std::sync::Mutex<Option<Vec<u8>>> = std::sync::Mutex::new(None);

/// Other apps' media sessions (Windows GlobalSystemMediaTransportControlsSessionManager) as a
/// JSON array of `ExternalMediaSession` into `out`; `[]` elsewhere. Returns its length, below -1
/// the capacity it needs (the list is kept for the next call, which should pass that much), or
/// -1 with tarve_last_error set.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tarve_media_sessions(out: *mut u8, capacity: u32) -> i32 {
    guard(|| {
        let mut pending = PENDING_MEDIA_SESSIONS
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let json = match pending.take() {
            Some(json) => json,
            None => crate::media_sessions::sessions_json()?,
        };
        let written = unsafe { output(&json, out, capacity)? };
        if written < -1 {
            *pending = Some(json);
        }
        Ok(written)
    })
}

/// Asks the first media session of the app whose AppUserModelID is the UTF-8 at `ptr` to play
/// (`action` 0), pause (1), toggle (2), skip to the next (3) or previous (4) track. Returns 1
/// when the app accepted, 0 when it refused or no session has that id (always 0 off Windows),
/// or -1 with tarve_last_error set.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tarve_media_session_control(action: u32, ptr: *const u8, len: u32) -> i32 {
    guard(|| {
        let action = crate::media_sessions::MediaAction::from_code(action)
            .ok_or_else(|| format!("tarve_media_session_control: unknown action {action}"))?;
        let app_id = std::str::from_utf8(unsafe { input(ptr, len)? })
            .map_err(|_| "tarve_media_session_control: the app id is not UTF-8")?;
        Ok(i32::from(crate::media_sessions::control(app_id, action)?))
    })
}

/// The address of `tarve_plugin_emit`, which JavaScript hands to a plugin's library
/// (`ctx.emitAddress()`): the library calls it without linking against this one.
#[unsafe(no_mangle)]
pub extern "C" fn tarve_plugin_emit_address() -> u64 {
    tarve_plugin_emit as *const () as usize as u64
}

/// `tarve_ffi_call` statuses (packages/core/src/plugins/pointer.ts reads them).
#[cfg(not(target_arch = "wasm32"))]
mod ffi_status {
    pub(super) const OK: i32 = 0;
    /// The frame is malformed: a null frame, an unknown kind, a void argument, a buffer return,
    /// a buffer argument naming no buffer.
    pub(super) const INVALID: i32 = -1;
    /// A C signature this platform cannot call by signature (crate::foreign_call's limits).
    pub(super) const UNSUPPORTED: i32 = -2;
    /// The function address is null.
    pub(super) const NULL_FUNCTION: i32 = -3;
}

/// Bytes before a frame's argument slots.
#[cfg(not(target_arch = "wasm32"))]
const FFI_HEADER: usize = 24;

/// The function address and signature a `tarve_ffi_call` frame holds, or the status to return.
#[cfg(not(target_arch = "wasm32"))]
unsafe fn ffi_frame(frame: *const u8) -> Result<(usize, crate::foreign_call::Signature), i32> {
    use crate::foreign_call::{Kind, Signature, SignatureError};
    if frame.is_null() {
        return Err(ffi_status::INVALID);
    }
    // SAFETY: the caller passes a frame of FFI_HEADER + 9n bytes, n being its byte 17.
    let header = unsafe { std::slice::from_raw_parts(frame, FFI_HEADER) };
    let count = header[17] as usize;
    // SAFETY: as above; the kinds follow the n argument slots.
    let codes = unsafe { std::slice::from_raw_parts(frame.add(FFI_HEADER + 8 * count), count) };
    let returns = Kind::from_code(header[16]).ok_or(ffi_status::INVALID)?;
    let args = codes
        .iter()
        .map(|&code| Kind::from_code(code))
        .collect::<Option<Vec<_>>>()
        .ok_or(ffi_status::INVALID)?;
    let signature = Signature::new(args, returns).map_err(|error| match error {
        SignatureError::Invalid(_) => ffi_status::INVALID,
        SignatureError::Unsupported(_) => ffi_status::UNSUPPORTED,
    })?;
    // SAFETY: the header's first 8 bytes; read unaligned since the caller owns the alignment.
    let address = unsafe { frame.cast::<u64>().read_unaligned() };
    let address = usize::try_from(address).map_err(|_| ffi_status::INVALID)?;
    Ok((address, signature))
}

/// Whether `tarve_ffi_call` can call the signature in `frame` on this platform (its address is
/// not looked at): 0, -1 for a malformed signature, -2 for one this platform's calling convention
/// cannot take by signature (stack arguments on AAPCS64/System V, more than 16 on Windows x64).
/// `pointerFunction` asks once, when it binds an address.
#[cfg(not(target_arch = "wasm32"))]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tarve_ffi_check(frame: *const u8) -> i32 {
    match unsafe { ffi_frame(frame) } {
        Ok(_) => ffi_status::OK,
        Err(status) => status,
    }
}

/// Calls a C function by its address with a signature known only at run time
/// (`pointerFunction`, packages/core/src/plugins/pointer.ts): COM and vtable methods, functions
/// exported by ordinal, callbacks a library hands out. Uses crate::foreign_call, a prototype
/// fixed at compile time: no libffi, no executable memory, no generated code. The frame:
///
/// - bytes 0..8: the function's address (u64);
/// - bytes 8..16: written on success, the return value: an f64 for bool, i8–u32, f32 and f64,
///   the i64/u64 bits for i64, u64 and ptr, 0 for void;
/// - byte 16: the return kind, byte 17: the argument count n, bytes 18..24: zero;
/// - bytes 24..24+8n: the arguments, an f64 for f32/f64, the i64/u64 bits for integers, bool and
///   ptr, and for a buffer the index (0–3) of the `buffers` argument it is, or u64::MAX for null;
/// - bytes 24+8n..24+9n: the argument kinds (crate::foreign_call::Kind::from_code).
///
/// Returns 0, or a negative status as tarve_ffi_check does, -3 for a null address.
///
/// # Safety
/// The address must be a function of the frame's signature, alive for the call, and every
/// pointer and buffer valid for what it does with them, as with any FFI call.
#[cfg(not(target_arch = "wasm32"))]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tarve_ffi_call(
    frame: *mut u8,
    buffer0: *mut u8,
    buffer1: *mut u8,
    buffer2: *mut u8,
    buffer3: *mut u8,
) -> i32 {
    use crate::foreign_call::{self, Kind, Returned};
    let (address, signature) = match unsafe { ffi_frame(frame) } {
        Ok(found) => found,
        Err(status) => return status,
    };
    if address == 0 {
        return ffi_status::NULL_FUNCTION;
    }
    let buffers = [buffer0, buffer1, buffer2, buffer3];
    let mut raw = Vec::with_capacity(signature.args.len());
    for (index, &kind) in signature.args.iter().enumerate() {
        // SAFETY: slot `index` of the frame's n argument slots.
        let bits = unsafe {
            frame
                .add(FFI_HEADER + 8 * index)
                .cast::<u64>()
                .read_unaligned()
        };
        raw.push(match kind {
            Kind::Buffer if bits == u64::MAX => 0,
            Kind::Buffer => match usize::try_from(bits)
                .ok()
                .and_then(|slot| buffers.get(slot))
            {
                Some(buffer) => *buffer as u64,
                None => return ffi_status::INVALID,
            },
            kind if kind.is_float() => foreign_call::float(kind, f64::from_bits(bits)),
            kind => foreign_call::integer(kind, bits as i64),
        });
    }
    // SAFETY: the caller vouches for the address, its signature and the pointers it is handed.
    let result = unsafe { foreign_call::call(address, &signature, &raw) };
    let out = match foreign_call::returned(signature.returns, result) {
        Returned::Void => 0,
        Returned::Bool(value) => f64::from(u8::from(value)).to_bits(),
        Returned::Number(value) => value.to_bits(),
        Returned::Signed(value) => value as u64,
        Returned::Unsigned(value) => value,
    };
    // SAFETY: bytes 8..16 of the frame.
    unsafe { frame.add(8).cast::<u64>().write_unaligned(out) };
    ffi_status::OK
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod ffi_tests {
    use super::*;

    extern "C" fn scale(bytes: *mut u8, length: u32, factor: f32, offset: i16) -> f64 {
        // SAFETY: the test passes `length` writable bytes.
        let bytes = unsafe { std::slice::from_raw_parts_mut(bytes, length as usize) };
        for byte in bytes.iter_mut() {
            *byte = (*byte as f32 * factor) as u8;
        }
        bytes.iter().map(|&byte| byte as f64).sum::<f64>() + offset as f64
    }
    extern "C" fn negative() -> i64 {
        -5
    }
    extern "C" fn is_null(pointer: *const u8) -> bool {
        pointer.is_null()
    }

    /// A frame as packages/core/src/plugins/pointer.ts writes it.
    fn frame(address: usize, returns: u8, args: &[(u8, u64)]) -> Vec<u8> {
        let mut frame = vec![0_u8; FFI_HEADER + 9 * args.len()];
        frame[..8].copy_from_slice(&(address as u64).to_ne_bytes());
        frame[16] = returns;
        frame[17] = args.len() as u8;
        for (index, &(kind, bits)) in args.iter().enumerate() {
            frame[FFI_HEADER + 8 * index..][..8].copy_from_slice(&bits.to_ne_bytes());
            frame[FFI_HEADER + 8 * args.len() + index] = kind;
        }
        frame
    }

    fn result(frame: &[u8]) -> u64 {
        u64::from_ne_bytes(frame[8..16].try_into().unwrap())
    }

    const BOOL: u8 = 1;
    const I16: u8 = 4;
    const U32: u8 = 7;
    const I64: u8 = 8;
    const F32: u8 = 10;
    const F64: u8 = 11;
    const PTR: u8 = 12;
    const BUFFER: u8 = 13;

    #[test]
    fn a_frame_calls_its_function_with_buffers_and_reads_back_the_result() {
        let mut bytes = [1_u8, 2, 3];
        let mut frame = frame(
            scale as *const () as usize,
            F64,
            &[
                (BUFFER, 1),
                (U32, 3),
                (F32, 2.0_f64.to_bits()),
                (I16, (-1_i64) as u64),
            ],
        );
        let null = std::ptr::null_mut();
        let mut unused = [0_u8; 1];
        assert_eq!(unsafe { tarve_ffi_check(frame.as_ptr()) }, ffi_status::OK);
        let status = unsafe {
            tarve_ffi_call(
                frame.as_mut_ptr(),
                unused.as_mut_ptr(),
                bytes.as_mut_ptr(),
                null,
                null,
            )
        };
        assert_eq!(status, ffi_status::OK);
        assert_eq!(bytes, [2, 4, 6]);
        assert_eq!(f64::from_bits(result(&frame)), 11.0);

        let mut frame = frame_for(negative as *const () as usize, I64, &[]);
        assert_eq!(
            unsafe {
                tarve_ffi_call(
                    frame.as_mut_ptr(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            },
            0
        );
        assert_eq!(result(&frame) as i64, -5);

        let mut frame = frame_for(is_null as *const () as usize, BOOL, &[(BUFFER, u64::MAX)]);
        assert_eq!(
            unsafe {
                tarve_ffi_call(
                    frame.as_mut_ptr(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            },
            0
        );
        assert_eq!(f64::from_bits(result(&frame)), 1.0);
    }

    fn frame_for(address: usize, returns: u8, args: &[(u8, u64)]) -> Vec<u8> {
        frame(address, returns, args)
    }

    #[test]
    fn malformed_and_unsupported_frames_are_refused_before_any_call() {
        let null = std::ptr::null_mut();
        assert_eq!(
            unsafe { tarve_ffi_check(std::ptr::null()) },
            ffi_status::INVALID
        );
        let mut unknown = frame(negative as *const () as usize, 14, &[]);
        assert_eq!(
            unsafe { tarve_ffi_call(unknown.as_mut_ptr(), null, null, null, null) },
            ffi_status::INVALID
        );
        let buffer_return = frame(negative as *const () as usize, BUFFER, &[]);
        assert_eq!(
            unsafe { tarve_ffi_check(buffer_return.as_ptr()) },
            ffi_status::INVALID
        );
        let void_argument = frame(negative as *const () as usize, I64, &[(0, 0)]);
        assert_eq!(
            unsafe { tarve_ffi_check(void_argument.as_ptr()) },
            ffi_status::INVALID
        );
        let mut fifth_buffer = frame(is_null as *const () as usize, BOOL, &[(BUFFER, 4)]);
        assert_eq!(
            unsafe { tarve_ffi_call(fifth_buffer.as_mut_ptr(), null, null, null, null) },
            ffi_status::INVALID
        );
        let mut no_function = frame(0, I64, &[]);
        assert_eq!(
            unsafe { tarve_ffi_check(no_function.as_ptr()) },
            ffi_status::OK
        );
        assert_eq!(
            unsafe { tarve_ffi_call(no_function.as_mut_ptr(), null, null, null, null) },
            ffi_status::NULL_FUNCTION
        );
        let too_many = frame(0, I64, &[(PTR, 0); 17]);
        assert_eq!(
            unsafe { tarve_ffi_check(too_many.as_ptr()) },
            ffi_status::UNSUPPORTED
        );
    }
}

/// Queues an event for the app from outside the event loop (an Android activity's result).
#[cfg(target_os = "android")]
pub(crate) fn emit(event: serde_json::Value) {
    if let Some(host) = host().lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
        host.events.push(event);
    }
}
