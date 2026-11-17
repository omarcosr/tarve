//! AppBar messages to the shell when `SHAppBarMessage` would reach the wrong `Shell_TrayWnd`:
//! an app that replaces the taskbar hosts one of its own.

/// `SHAppBarMessage`, unless the `Shell_TrayWnd` it would reach (the first in z-order) is not the
/// shell's: an app that replaces the taskbar hosts one, which would get the message and drop it.
/// Then the message goes straight to the `Shell_TrayWnd` of the shell process (Explorer), the one
/// that owns the desktop window (`GetShellWindow`).
pub(super) unsafe extern "system" fn system_shell(
    message: u32,
    data: *mut windows_sys::Win32::UI::Shell::APPBARDATA,
) -> usize {
    match shell_tray() {
        Some(tray) => unsafe { send_to_tray(tray, message, data) },
        None => unsafe { windows_sys::Win32::UI::Shell::SHAppBarMessage(message, data) },
    }
}

/// The shell process's `Shell_TrayWnd` when another one comes first in z-order (the one
/// `SHAppBarMessage` would find); `None` when the first is the shell's, or without a shell.
fn shell_tray() -> Option<windows_sys::Win32::Foundation::HWND> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        FindWindowExW, GetShellWindow, GetWindowThreadProcessId,
    };
    let owner = |hwnd| {
        let mut process = 0;
        unsafe { GetWindowThreadProcessId(hwnd, &mut process) };
        process
    };
    let desktop = unsafe { GetShellWindow() };
    if desktop.is_null() {
        return None;
    }
    let shell = owner(desktop);
    let class: Vec<u16> = "Shell_TrayWnd\0".encode_utf16().collect();
    let mut tray = std::ptr::null_mut();
    let mut first = true;
    loop {
        tray =
            unsafe { FindWindowExW(std::ptr::null_mut(), tray, class.as_ptr(), std::ptr::null()) };
        if tray.is_null() {
            return None;
        }
        if owner(tray) == shell {
            return (!first).then_some(tray);
        }
        first = false;
    }
}

/// `APPBARDATA` as `SHAppBarMessage` hands it to the shell: the same layout for 32- and 64-bit
/// callers (a 32-bit window handle, a 64-bit `lParam`).
#[repr(C)]
#[derive(Clone, Copy)]
pub(super) struct AppBarData3264 {
    pub(super) size: u32,
    pub(super) hwnd: u32,
    pub(super) callback_message: u32,
    pub(super) edge: u32,
    pub(super) rc: windows_sys::Win32::Foundation::RECT,
    pub(super) lparam: i64,
}
/// The `WM_COPYDATA` payload (`dwData` 0) `SHAppBarMessage` sends `Shell_TrayWnd`: the data, the
/// message, the sender's `process` and the memory shared with the shell's process
/// (`SHAllocShared`) the shell writes the answered rectangle to.
#[repr(C)]
pub(super) struct AppBarCommand {
    pub(super) data: AppBarData3264,
    pub(super) message: u32,
    pub(super) padding: u32,
    pub(super) output: u64,
    pub(super) process: u32,
    pub(super) padding_end: u32,
}
const _: () = assert!(size_of::<AppBarData3264>() == 40 && size_of::<AppBarCommand>() == 64);
/// `COPYDATASTRUCT`.
#[repr(C)]
pub(super) struct CopyData {
    pub(super) kind: usize,
    pub(super) size: u32,
    pub(super) data: *const core::ffi::c_void,
}

/// What `SHAppBarMessage` does after finding `Shell_TrayWnd`, sent to `tray`: the same bytes, the
/// rectangle answered back into `data`, the shell's answer returned.
pub(super) unsafe fn send_to_tray(
    tray: windows_sys::Win32::Foundation::HWND,
    message: u32,
    data: *mut windows_sys::Win32::UI::Shell::APPBARDATA,
) -> usize {
    use windows_sys::Win32::UI::Shell::{
        ABM_GETTASKBARPOS, ABM_QUERYPOS, ABM_SETPOS, SHAllocShared, SHFreeShared, SHLockShared,
        SHUnlockShared,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SMTO_ABORTIFHUNG, SendMessageTimeoutW, WM_COPYDATA,
    };
    let data = unsafe { &mut *data };
    let process = std::process::id();
    // The answer's memory belongs to the shell's process, as `SHAppBarMessage` hands it over.
    let mut shell = 0;
    unsafe { GetWindowThreadProcessId(tray, &mut shell) };
    let bar = AppBarData3264 {
        size: size_of::<AppBarData3264>() as u32,
        hwnd: data.hWnd as usize as u32,
        callback_message: data.uCallbackMessage,
        edge: data.uEdge,
        rc: data.rc,
        lparam: data.lParam as i64,
    };
    // The messages that answer a rectangle get it through memory shared with the shell.
    let output = if matches!(message, ABM_QUERYPOS | ABM_SETPOS | ABM_GETTASKBARPOS) {
        let shared = unsafe {
            SHAllocShared(
                (&raw const bar).cast(),
                size_of::<AppBarData3264>() as u32,
                shell,
            )
        };
        if shared.is_null() {
            return 0;
        }
        shared
    } else {
        std::ptr::null_mut()
    };
    let command = AppBarCommand {
        data: bar,
        message,
        padding: 0,
        output: output as u64,
        process,
        padding_end: 0,
    };
    let copy = CopyData {
        kind: 0,
        size: size_of::<AppBarCommand>() as u32,
        data: (&raw const command).cast(),
    };
    let mut answer = 0;
    if unsafe {
        SendMessageTimeoutW(
            tray,
            WM_COPYDATA,
            data.hWnd as usize,
            (&raw const copy) as isize,
            SMTO_ABORTIFHUNG,
            10_000,
            &mut answer,
        )
    } == 0
    {
        answer = 0;
    }
    if !output.is_null() {
        if answer != 0 {
            let shared = unsafe { SHLockShared(output, shell) } as *const AppBarData3264;
            if !shared.is_null() {
                data.rc = unsafe { (*shared).rc };
                unsafe { SHUnlockShared(shared.cast()) };
            }
        }
        unsafe { SHFreeShared(output, shell) };
    }
    answer
}
