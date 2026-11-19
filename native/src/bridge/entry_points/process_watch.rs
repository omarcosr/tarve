//! tarve_watch_process: a thread waits on a process handle and reports its exit code through a
//! named pipe (txiki.js's `spawn` shim on Windows).
use std::{
    ptr,
    sync::atomic::{AtomicU64, Ordering},
};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, DUPLICATE_SAME_ACCESS, DuplicateHandle, ERROR_PIPE_CONNECTED, GetLastError,
        HANDLE, INVALID_HANDLE_VALUE,
    },
    Storage::FileSystem::{FlushFileBuffers, PIPE_ACCESS_OUTBOUND, WriteFile},
    System::{
        Pipes::{
            ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_TYPE_BYTE, PIPE_WAIT,
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
