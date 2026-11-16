//! AppBar docking against real Win32 windows: the system shell (`Shell_TrayWnd`) and stand-in
//! shells that take or drop each message, as a foreign `Shell_TrayWnd` would.
use super::*;
use std::sync::Mutex;
use windows_sys::Win32::Foundation::{HWND, RECT};
use windows_sys::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow,
};
use windows_sys::Win32::UI::Shell::{
    ABM_NEW, ABM_QUERYPOS, ABM_REMOVE, ABM_SETPOS, APPBARDATA, SHAppBarMessage,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, FindWindowW, GetWindowRect, WS_EX_TOOLWINDOW, WS_POPUP,
};

/// A hidden top-level window, unregistered and destroyed when dropped.
struct TestWindow(HWND);

impl TestWindow {
    fn new() -> Self {
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        let hwnd = unsafe {
            CreateWindowExW(
                WS_EX_TOOLWINDOW,
                class.as_ptr(),
                std::ptr::null(),
                WS_POPUP,
                0,
                0,
                100,
                100,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        };
        assert!(
            !hwnd.is_null(),
            "CreateWindowExW: {}",
            std::io::Error::last_os_error()
        );
        Self(hwnd)
    }
    fn rect(&self) -> RECT {
        let mut rect: RECT = unsafe { std::mem::zeroed() };
        assert_ne!(unsafe { GetWindowRect(self.0, &mut rect) }, 0);
        rect
    }
    fn registered(&self) -> bool {
        app_bars().iter().any(|bar| bar.hwnd == self.0 as usize)
    }
    /// The messages the stand-in shells got for this window, in order.
    fn messages(&self) -> Vec<u32> {
        SENT.lock()
            .unwrap()
            .iter()
            .filter(|(hwnd, _)| *hwnd == self.0 as usize)
            .map(|(_, message)| *message)
            .collect()
    }
}

impl Drop for TestWindow {
    fn drop(&mut self) {
        release_app_bar(self.0 as usize);
        unsafe { DestroyWindow(self.0) };
    }
}

static SENT: Mutex<Vec<(usize, u32)>> = Mutex::new(Vec::new());

fn record(message: u32, data: *mut APPBARDATA) {
    SENT.lock()
        .unwrap()
        .push((unsafe { (*data).hWnd } as usize, message));
}

/// No shell window takes any message (no `Shell_TrayWnd`).
unsafe extern "system" fn no_shell(message: u32, data: *mut APPBARDATA) -> usize {
    record(message, data);
    0
}

/// Takes the registration but drops the position query, as a `Shell_TrayWnd` that is not the
/// system's would.
unsafe extern "system" fn drops_query(message: u32, data: *mut APPBARDATA) -> usize {
    record(message, data);
    usize::from(message == ABM_NEW || message == ABM_REMOVE)
}

/// Answers everything but the reservation itself.
unsafe extern "system" fn drops_reservation(message: u32, data: *mut APPBARDATA) -> usize {
    record(message, data);
    usize::from(message != ABM_SETPOS)
}

fn monitor(hwnd: HWND) -> MONITORINFO {
    let mut info: MONITORINFO = unsafe { std::mem::zeroed() };
    info.cbSize = size_of::<MONITORINFO>() as u32;
    let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    assert_ne!(unsafe { GetMonitorInfoW(monitor, &mut info) }, 0);
    info
}

fn same_rect(a: RECT, b: RECT) -> bool {
    (a.left, a.top, a.right, a.bottom) == (b.left, b.top, b.right, b.bottom)
}

#[test]
fn app_bar_without_a_shell_fails_and_registers_nothing() {
    let window = TestWindow::new();
    let error = set_app_bar(window.0, AppBarEdge::Top, 40, no_shell).unwrap_err();
    assert!(
        error.contains("ABM_NEW") && error.contains("Shell_TrayWnd"),
        "{error}"
    );
    assert!(!window.registered());
    assert_eq!(window.messages(), [ABM_NEW]);
}

#[test]
fn app_bar_whose_position_query_goes_unanswered_fails_and_lets_the_bar_go() {
    let window = TestWindow::new();
    let before = window.rect();
    let error = set_app_bar(window.0, AppBarEdge::Top, 40, drops_query).unwrap_err();
    assert!(
        error.contains("ABM_QUERYPOS") && error.contains("not reserved"),
        "{error}"
    );
    assert!(!window.registered());
    assert_eq!(window.messages(), [ABM_NEW, ABM_QUERYPOS, ABM_REMOVE]);
    // Not moved to the edge as if docked.
    assert!(same_rect(window.rect(), before));
}

#[test]
fn app_bar_whose_reservation_goes_unanswered_fails_and_lets_the_bar_go() {
    let window = TestWindow::new();
    let before = window.rect();
    let error = set_app_bar(window.0, AppBarEdge::Bottom, 40, drops_reservation).unwrap_err();
    assert!(
        error.contains("ABM_SETPOS") && error.contains("not reserved"),
        "{error}"
    );
    assert!(!window.registered());
    assert_eq!(
        window.messages(),
        [ABM_NEW, ABM_QUERYPOS, ABM_SETPOS, ABM_REMOVE]
    );
    assert!(same_rect(window.rect(), before));
}

/// The system shell: docks the window on the top edge and reserves the strip out of the work area.
/// Without a `Shell_TrayWnd` (a session with no Explorer) the call has to say so instead.
#[test]
fn app_bar_with_the_system_shell_docks_and_reserves_the_edge() {
    let tray: Vec<u16> = "Shell_TrayWnd\0".encode_utf16().collect();
    let shell_running = !unsafe { FindWindowW(tray.as_ptr(), std::ptr::null()) }.is_null();
    // Physical pixels, as the runtime's windows: the shell reserves the rectangle as given, so a
    // DPI-virtualized thread would see a scaled-down strip.
    unsafe {
        windows_sys::Win32::UI::HiDpi::SetThreadDpiAwarenessContext(
            windows_sys::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
        )
    };
    let window = TestWindow::new();
    let result = set_app_bar(window.0, AppBarEdge::Top, 37, SHAppBarMessage);
    if !shell_running {
        let error = result.unwrap_err();
        assert!(error.contains("ABM_NEW"), "{error}");
        assert!(!window.registered());
        return;
    }
    result.unwrap();
    assert!(window.registered());
    let info = monitor(window.0);
    let rect = window.rect();
    assert_eq!(rect.bottom - rect.top, 37);
    assert_eq!(rect.left, info.rcMonitor.left);
    assert_eq!(rect.right, info.rcMonitor.right);
    assert!(
        info.rcWork.top >= rect.bottom,
        "work area top {} overlaps the bar ending at {}",
        info.rcWork.top,
        rect.bottom
    );
    release_app_bar(window.0 as usize);
    assert!(!window.registered());
    assert!(monitor(window.0).rcWork.top < rect.bottom);
}
