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

/// The work area of `hwnd`'s monitor once `settled` holds for it: Explorer applies some changes a
/// moment after answering (the last one read when it never does).
fn work_area_when(hwnd: HWND, settled: impl Fn(RECT) -> bool) -> RECT {
    for _ in 0..40 {
        let work = monitor(hwnd).rcWork;
        if settled(work) {
            return work;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    monitor(hwnd).rcWork
}

fn same_rect(a: RECT, b: RECT) -> bool {
    (a.left, a.top, a.right, a.bottom) == (b.left, b.top, b.right, b.bottom)
}

#[test]
fn app_bar_without_a_shell_fails_and_registers_nothing() {
    let window = TestWindow::new();
    let error = set_app_bar(window.0, AppBarEdge::Top, 40, 0, no_shell).unwrap_err();
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
    let error = set_app_bar(window.0, AppBarEdge::Top, 40, 0, drops_query).unwrap_err();
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
    let error = set_app_bar(window.0, AppBarEdge::Bottom, 40, 0, drops_reservation).unwrap_err();
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
    let _shell = system_shell_lock();
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
    let result = set_app_bar(window.0, AppBarEdge::Top, 37, 0, system_shell);
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
    let work = work_area_when(window.0, |work| work.top >= rect.bottom);
    assert!(
        work.top >= rect.bottom,
        "work area top {} overlaps the bar ending at {}",
        work.top,
        rect.bottom
    );
    release_app_bar(window.0 as usize);
    assert!(!window.registered());
    assert!(work_area_when(window.0, |work| work.top < rect.bottom).top < rect.bottom);
}

/// Tests that reach the system shell or put a `Shell_TrayWnd` of this process in front of it run
/// one at a time.
fn system_shell_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn explorer_running() -> bool {
    let tray: Vec<u16> = "Shell_TrayWnd\0".encode_utf16().collect();
    !unsafe { FindWindowW(tray.as_ptr(), std::ptr::null()) }.is_null()
}

fn per_monitor_dpi() {
    unsafe {
        windows_sys::Win32::UI::HiDpi::SetThreadDpiAwarenessContext(
            windows_sys::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
        )
    };
}

/// What the own tray got: the `WM_COPYDATA` payloads (`dwData`, bytes) and the rectangle the shell
/// found in shared memory.
/// A `WM_COPYDATA` payload: `dwData`, the bytes, the rectangle answered in shared memory.
type Copied = (usize, Vec<u8>, Option<RECT>);
static OWN_TRAY: Mutex<Vec<Copied>> = Mutex::new(Vec::new());

/// A `Shell_TrayWnd` of this process in front of Explorer's, as a taskbar replacement hosts: it
/// takes every AppBar message and answers rectangles with `left` 100.
struct OwnTray(HWND);

impl OwnTray {
    fn new() -> Self {
        use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
        use windows_sys::Win32::UI::Shell::{SHLockShared, SHUnlockShared};
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            DefWindowProcW, RegisterClassW, WM_COPYDATA, WNDCLASSW, WS_EX_TOPMOST,
        };
        unsafe extern "system" fn proc(hwnd: HWND, message: u32, w: WPARAM, l: LPARAM) -> LRESULT {
            if message != WM_COPYDATA {
                return unsafe { DefWindowProcW(hwnd, message, w, l) };
            }
            let copy = unsafe { &*(l as *const CopyData) };
            // Other programs on the machine reach it too: tray icons (`dwData` 1), 32-bit callers.
            if copy.kind != 0 || copy.size as usize != size_of::<AppBarCommand>() {
                return 0;
            }
            let bytes =
                unsafe { std::slice::from_raw_parts(copy.data.cast::<u8>(), copy.size as usize) }
                    .to_vec();
            let command = unsafe { &*copy.data.cast::<AppBarCommand>() };
            let mut answered = None;
            if command.output != 0 {
                // The memory was handed to this (the tray's) process, as to Explorer.
                let shared = unsafe { SHLockShared(command.output as _, std::process::id()) }
                    .cast::<AppBarData3264>();
                if shared.is_null() {
                    return 0;
                }
                unsafe {
                    (*shared).rc.left = 100;
                    answered = Some((*shared).rc);
                    SHUnlockShared(shared.cast());
                }
            }
            OWN_TRAY.lock().unwrap().push((copy.kind, bytes, answered));
            1
        }
        let class: Vec<u16> = "Shell_TrayWnd\0".encode_utf16().collect();
        let window_class = WNDCLASSW {
            style: 0,
            lpfnWndProc: Some(proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: std::ptr::null_mut(),
            hIcon: std::ptr::null_mut(),
            hCursor: std::ptr::null_mut(),
            hbrBackground: std::ptr::null_mut(),
            lpszMenuName: std::ptr::null(),
            lpszClassName: class.as_ptr(),
        };
        // A second test registers it again: the class is already there.
        unsafe { RegisterClassW(&window_class) };
        let hwnd = unsafe {
            CreateWindowExW(
                WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
                class.as_ptr(),
                std::ptr::null(),
                WS_POPUP,
                0,
                0,
                1,
                1,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        };
        assert!(!hwnd.is_null());
        OWN_TRAY.lock().unwrap().clear();
        Self(hwnd)
    }
    fn take(&self) -> Vec<Copied> {
        std::mem::take(&mut *OWN_TRAY.lock().unwrap())
    }
    /// The messages about `window`: every other AppBar client on the machine (another dock, a
    /// window asking where the taskbar is) reaches this window too while it is first.
    fn took_for(&self, window: &TestWindow) -> Vec<Copied> {
        self.take()
            .into_iter()
            .filter(|(_, bytes, _)| bytes[4..8] == (window.0 as usize as u32).to_le_bytes())
            .collect()
    }
}

impl Drop for OwnTray {
    fn drop(&mut self) {
        unsafe { DestroyWindow(self.0) };
    }
}

/// The message built by hand is the one `SHAppBarMessage` sends (all but the shared-memory
/// handle), and the rectangle the shell answers comes back the same way.
#[test]
fn hand_built_message_matches_sh_app_bar_message() {
    let _shell = system_shell_lock();
    let tray = OwnTray::new();
    let tray_class: Vec<u16> = "Shell_TrayWnd\0".encode_utf16().collect();
    assert_eq!(
        unsafe { FindWindowW(tray_class.as_ptr(), std::ptr::null()) },
        tray.0,
        "SHAppBarMessage reaches this process's Shell_TrayWnd first"
    );
    let window = TestWindow::new();
    let fresh = || {
        let mut data: APPBARDATA = unsafe { std::mem::zeroed() };
        data.cbSize = size_of::<APPBARDATA>() as u32;
        data.hWnd = window.0;
        data.uCallbackMessage = 0x1234;
        data.uEdge = 3;
        data.rc = RECT {
            left: 1,
            top: 2,
            right: 3,
            bottom: 4,
        };
        data.lParam = 0x55;
        data
    };
    for message in [ABM_NEW, ABM_QUERYPOS, ABM_SETPOS, ABM_REMOVE] {
        let (mut system, mut by_hand) = (fresh(), fresh());
        assert_eq!(unsafe { SHAppBarMessage(message, &mut system) }, 1);
        let expected = tray.took_for(&window);
        assert_eq!(unsafe { send_to_tray(tray.0, message, &mut by_hand) }, 1);
        let got = tray.took_for(&window);
        assert_eq!((expected.len(), got.len()), (1, 1), "message {message}");
        let ((kind, mut expected, expected_rect), (got_kind, mut got, got_rect)) =
            (expected[0].clone(), got[0].clone());
        assert_eq!((kind, got_kind), (0, 0));
        assert_eq!(expected.len(), 64);
        // The shared-memory handles differ: one each.
        assert_eq!(
            expected[48..56] == [0; 8],
            got[48..56] == [0; 8],
            "message {message}"
        );
        expected[48..56].fill(0);
        got[48..56].fill(0);
        assert_eq!(expected, got, "message {message}");
        assert_eq!(expected_rect.is_some(), got_rect.is_some());
        assert!(same_rect(system.rc, by_hand.rc), "message {message}");
        if expected_rect.is_some() {
            assert_eq!(by_hand.rc.left, 100);
        }
    }
}

/// A `Shell_TrayWnd` of this process (a taskbar replacement) does not stop the bar from reaching
/// Explorer's: the strip is reserved, and the window reaches `overlap` px past it.
#[test]
fn app_bar_reaches_the_system_shell_past_an_own_shell_tray_window() {
    let _shell = system_shell_lock();
    if !explorer_running() {
        return;
    }
    per_monitor_dpi();
    let tray = OwnTray::new();
    let window = TestWindow::new();
    set_app_bar(window.0, AppBarEdge::Top, 31, 9, system_shell).unwrap();
    assert!(
        tray.took_for(&window).is_empty(),
        "the own Shell_TrayWnd got the bar's messages"
    );
    let info = monitor(window.0);
    let rect = window.rect();
    assert_eq!(rect.top, info.rcMonitor.top);
    assert_eq!(rect.bottom - rect.top, 31 + 9);
    assert_eq!(
        work_area_when(window.0, |work| work.top == rect.top + 31).top,
        rect.top + 31,
        "the work area starts after the reserved strip, under the overlap"
    );
    // setBounds: a thicker bar over half the edge, still reserved through the shell.
    let width = (info.rcMonitor.right - info.rcMonitor.left) / 2;
    move_app_bar(
        window.0,
        [
            Some(info.rcMonitor.left + 10),
            None,
            Some(width),
            Some(50 + 9),
        ],
    )
    .unwrap();
    let moved = window.rect();
    assert_eq!(
        (
            moved.left,
            moved.top,
            moved.right - moved.left,
            moved.bottom - moved.top
        ),
        (info.rcMonitor.left + 10, info.rcMonitor.top, width, 59)
    );
    let top = info.rcMonitor.top + 50;
    assert_eq!(work_area_when(window.0, |work| work.top == top).top, top);
    release_app_bar(window.0 as usize);
    assert!(work_area_when(window.0, |work| work.top < rect.top + 31).top < rect.top + 31);
    assert!(tray.took_for(&window).is_empty());
}

/// Takes every message and leaves the proposed rectangle as it is.
unsafe extern "system" fn takes_all(message: u32, data: *mut APPBARDATA) -> usize {
    record(message, data);
    1
}

/// `setBounds` on a bar asks the shell again (QUERYPOS, SETPOS) instead of moving the window off
/// its reservation: the new height (less the overlap) is the reserved thickness, `x`/`width` the
/// stretch of the edge the window covers.
#[test]
fn set_bounds_on_an_app_bar_re_docks_through_the_shell() {
    let window = TestWindow::new();
    set_app_bar(window.0, AppBarEdge::Bottom, 40, 6, takes_all).unwrap();
    let info = monitor(window.0);
    let docked = window.rect();
    assert_eq!(
        (
            docked.left,
            docked.right,
            docked.bottom,
            docked.bottom - docked.top
        ),
        (
            info.rcMonitor.left,
            info.rcMonitor.right,
            info.rcMonitor.bottom,
            46
        )
    );
    SENT.lock().unwrap().clear();
    let left = info.rcMonitor.left + 20;
    move_app_bar(window.0, [Some(left), Some(0), Some(300), Some(70)]).unwrap();
    assert_eq!(window.messages(), [ABM_QUERYPOS, ABM_SETPOS]);
    let moved = window.rect();
    assert_eq!(
        (
            moved.left,
            moved.right,
            moved.bottom,
            moved.bottom - moved.top
        ),
        (left, left + 300, info.rcMonitor.bottom, 70)
    );
    let bar = app_bars()
        .iter()
        .copied()
        .find(|bar| bar.hwnd == window.0 as usize)
        .unwrap();
    assert_eq!(
        (bar.thickness, bar.overlap, bar.span),
        (64, 6, Some((left, left + 300)))
    );
    // A plain move of the window stays on the reservation.
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::SetWindowPos(
            window.0,
            std::ptr::null_mut(),
            5,
            5,
            10,
            10,
            windows_sys::Win32::UI::WindowsAndMessaging::SWP_NOZORDER,
        )
    };
    assert!(same_rect(window.rect(), moved));
}

#[test]
fn bar_window_reaches_past_the_strip_and_keeps_its_span_inside_it() {
    let bar = |edge, overlap, span| AppBar {
        hwnd: 0,
        edge,
        thickness: 40,
        overlap,
        span,
        monitor: 0,
        rect: [0; 4],
        shell: takes_all,
    };
    let strip = |left, top, right, bottom| RECT {
        left,
        top,
        right,
        bottom,
    };
    let window = |rc: RECT| (rc.left, rc.top, rc.right, rc.bottom);
    let top = strip(0, 0, 1000, 40);
    assert_eq!(
        window(bar_window(top, &bar(AppBarEdge::Top, 8, None))),
        (0, 0, 1000, 48)
    );
    let bottom = strip(0, 760, 1000, 800);
    assert_eq!(
        window(bar_window(bottom, &bar(AppBarEdge::Bottom, 8, None))),
        (0, 752, 1000, 800)
    );
    let left = strip(0, 0, 40, 800);
    assert_eq!(
        window(bar_window(left, &bar(AppBarEdge::Left, 5, None))),
        (0, 0, 45, 800)
    );
    let right = strip(960, 30, 1000, 800);
    assert_eq!(
        window(bar_window(
            right,
            &bar(AppBarEdge::Right, 0, Some((100, 300)))
        )),
        (960, 100, 1000, 300)
    );
    // A span past the strip slides back into it, one longer than it is cut to it.
    assert_eq!(
        window(bar_window(
            right,
            &bar(AppBarEdge::Right, 0, Some((0, 200)))
        )),
        (960, 30, 1000, 230)
    );
    assert_eq!(
        window(bar_window(top, &bar(AppBarEdge::Top, 0, Some((900, 1200))))),
        (700, 0, 1000, 40)
    );
    assert_eq!(
        window(bar_window(top, &bar(AppBarEdge::Top, 0, Some((-50, 2000))))),
        (0, 0, 1000, 40)
    );
}
