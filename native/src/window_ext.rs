//! Window operations past winit's: the native handle, whole-window opacity, AppBar docking
//! (Windows) and the screens with the pointer position.
use serde_json::{Value, json};
use winit::event_loop::ActiveEventLoop;
use winit::window::Window;

use crate::protocol::AppBarEdge;

/// The native window as a decimal string: HWND (Windows), XID (X11), `wl_surface*` (Wayland),
/// `NSView*` (macOS), `ANativeWindow*` (Android).
pub(crate) fn native_handle(window: &Window) -> Option<String> {
    use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let handle = window.window_handle().ok()?;
    Some(match handle.as_raw() {
        RawWindowHandle::Win32(handle) => handle.hwnd.get().to_string(),
        RawWindowHandle::Xlib(handle) => handle.window.to_string(),
        RawWindowHandle::Xcb(handle) => handle.window.get().to_string(),
        RawWindowHandle::Wayland(handle) => (handle.surface.as_ptr() as usize).to_string(),
        RawWindowHandle::AppKit(handle) => (handle.ns_view.as_ptr() as usize).to_string(),
        RawWindowHandle::AndroidNdk(handle) => {
            (handle.a_native_window.as_ptr() as usize).to_string()
        }
        _ => return None,
    })
}

#[cfg(target_os = "windows")]
fn hwnd(window: &Window) -> Option<windows_sys::Win32::Foundation::HWND> {
    use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let handle = window.window_handle().ok()?;
    let RawWindowHandle::Win32(handle) = handle.as_raw() else {
        return None;
    };
    Some(handle.hwnd.get() as windows_sys::Win32::Foundation::HWND)
}

/// The whole window at `opacity` (0–1): a layered window on Windows. 1 drops the layered style.
#[cfg(target_os = "windows")]
pub(crate) fn set_opacity(window: &Window, opacity: f64) -> Result<(), String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GWL_EXSTYLE, GetWindowLongPtrW, LWA_ALPHA, SetLayeredWindowAttributes, SetWindowLongPtrW,
        WS_EX_LAYERED,
    };
    if !opacity.is_finite() {
        return Err("opacity must be a number from 0 to 1".into());
    }
    let hwnd = hwnd(window).ok_or("no Win32 window handle")?;
    let alpha = (opacity.clamp(0.0, 1.0) * 255.0).round() as u8;
    let layered = WS_EX_LAYERED as isize;
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        if alpha == 255 {
            if style & layered != 0 {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style & !layered);
            }
            return Ok(());
        }
        if style & layered == 0 {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | layered);
        }
        if SetLayeredWindowAttributes(hwnd, 0, alpha, LWA_ALPHA) == 0 {
            return Err(format!(
                "SetLayeredWindowAttributes failed: {}",
                std::io::Error::last_os_error()
            ));
        }
    }
    Ok(())
}

/// Puts the layered style (and so `opacity`) back when something rewrote the window styles.
#[cfg(target_os = "windows")]
pub(crate) fn keep_opacity(window: &Window, opacity: f64) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GWL_EXSTYLE, GetWindowLongPtrW, WS_EX_LAYERED,
    };
    let Some(hwnd) = hwnd(window) else {
        return;
    };
    if unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } & WS_EX_LAYERED as isize == 0 {
        let _ = set_opacity(window, opacity);
    }
}

/// The opacity property outlives style changes elsewhere.
#[cfg(not(target_os = "windows"))]
pub(crate) fn keep_opacity(_: &Window, _: f64) {}

#[cfg(target_os = "linux")]
pub(crate) fn set_opacity(window: &Window, opacity: f64) -> Result<(), String> {
    if !opacity.is_finite() {
        return Err("opacity must be a number from 0 to 1".into());
    }
    crate::x11_state::set_opacity(window, opacity.clamp(0.0, 1.0))
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
pub(crate) fn set_opacity(_: &Window, opacity: f64) -> Result<(), String> {
    if (opacity - 1.0).abs() < f64::EPSILON {
        return Ok(());
    }
    Err("window opacity is not supported on this platform".into())
}

/// A window docked as an AppBar: its edge, thickness (px) and the rectangle the shell gave it.
#[cfg(target_os = "windows")]
#[derive(Clone, Copy)]
struct AppBar {
    hwnd: usize,
    edge: AppBarEdge,
    thickness: i32,
    rect: [i32; 4],
    shell: Shell,
}
/// Sends an AppBar message to the shell: `SHAppBarMessage` (tests pass a stand-in shell).
#[cfg(target_os = "windows")]
type Shell =
    unsafe extern "system" fn(u32, *mut windows_sys::Win32::UI::Shell::APPBARDATA) -> usize;

/// The shell answers every AppBar message it handles with nonzero; zero means no shell window
/// (`Shell_TrayWnd`) took it, so the space was not reserved.
#[cfg(target_os = "windows")]
fn shell_refused(message: &str) -> String {
    format!(
        "SHAppBarMessage({message}) got no answer from the shell (Shell_TrayWnd): the screen space was not reserved"
    )
}
/// Windows registered as AppBars, so they stay docked and are released when they close.
#[cfg(target_os = "windows")]
static APP_BARS: std::sync::Mutex<Vec<AppBar>> = std::sync::Mutex::new(Vec::new());
/// The AppBar notification message (ABN_*), handled by the subclass below.
#[cfg(target_os = "windows")]
const APP_BAR_MESSAGE: u32 = windows_sys::Win32::UI::WindowsAndMessaging::WM_APP + 0x0a5b;
#[cfg(target_os = "windows")]
const APP_BAR_SUBCLASS: usize = 0x7a1e;

#[cfg(target_os = "windows")]
fn app_bars() -> std::sync::MutexGuard<'static, Vec<AppBar>> {
    APP_BARS.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// Docks the window as an AppBar on `edge`, `size` logical px thick (Windows), reserving the
/// space; `None` releases it.
#[cfg(target_os = "windows")]
pub(crate) fn app_bar(window: &Window, edge: Option<AppBarEdge>, size: f64) -> Result<(), String> {
    let hwnd = hwnd(window).ok_or("no Win32 window handle")?;
    let Some(edge) = edge else {
        release_app_bar(hwnd as usize);
        return Ok(());
    };
    if !size.is_finite() || size <= 0.0 {
        return Err("appBar size must be a positive number".into());
    }
    let thickness = (size * window.scale_factor()).round().max(1.0) as i32;
    set_app_bar(
        hwnd,
        edge,
        thickness,
        windows_sys::Win32::UI::Shell::SHAppBarMessage,
    )
}

/// Registers `hwnd` with `shell` (first time) and docks it on `edge`, `thickness` px thick.
/// A new bar the shell does not dock is unregistered again, so a failed call leaves nothing behind.
#[cfg(target_os = "windows")]
fn set_app_bar(
    hwnd: windows_sys::Win32::Foundation::HWND,
    edge: AppBarEdge,
    thickness: i32,
    shell: Shell,
) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::{ABM_NEW, APPBARDATA, SetWindowSubclass};
    let registered = app_bars().iter().any(|bar| bar.hwnd == hwnd as usize);
    if !registered {
        let mut data: APPBARDATA = unsafe { std::mem::zeroed() };
        data.cbSize = size_of::<APPBARDATA>() as u32;
        data.hWnd = hwnd;
        data.uCallbackMessage = APP_BAR_MESSAGE;
        if unsafe { shell(ABM_NEW, &mut data) } == 0 {
            return Err(shell_refused("ABM_NEW"));
        }
        app_bars().push(AppBar {
            hwnd: hwnd as usize,
            edge,
            thickness,
            rect: [0; 4],
            shell,
        });
        unsafe { SetWindowSubclass(hwnd, Some(app_bar_proc), APP_BAR_SUBCLASS, 0) };
    }
    if let Some(bar) = app_bars().iter_mut().find(|bar| bar.hwnd == hwnd as usize) {
        bar.edge = edge;
        bar.thickness = thickness;
    }
    let docked = dock(hwnd);
    if docked.is_err() && !registered {
        release_app_bar(hwnd as usize);
    }
    docked
}

/// Asks the shell for the bar's rectangle on its monitor, reserves it and moves the window there.
#[cfg(target_os = "windows")]
fn dock(hwnd: windows_sys::Win32::Foundation::HWND) -> Result<(), String> {
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow,
    };
    use windows_sys::Win32::UI::Shell::{
        ABE_BOTTOM, ABE_LEFT, ABE_RIGHT, ABE_TOP, ABM_QUERYPOS, ABM_SETPOS, APPBARDATA,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{SWP_NOACTIVATE, SWP_NOZORDER, SetWindowPos};
    let Some(bar) = app_bars()
        .iter()
        .copied()
        .find(|bar| bar.hwnd == hwnd as usize)
    else {
        return Ok(());
    };
    let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    let mut info: MONITORINFO = unsafe { std::mem::zeroed() };
    info.cbSize = size_of::<MONITORINFO>() as u32;
    if monitor.is_null() || unsafe { GetMonitorInfoW(monitor, &mut info) } == 0 {
        return Err("GetMonitorInfoW failed".into());
    }
    let mut data: APPBARDATA = unsafe { std::mem::zeroed() };
    data.cbSize = size_of::<APPBARDATA>() as u32;
    data.hWnd = hwnd;
    data.uEdge = match bar.edge {
        AppBarEdge::Top => ABE_TOP,
        AppBarEdge::Bottom => ABE_BOTTOM,
        AppBarEdge::Left => ABE_LEFT,
        AppBarEdge::Right => ABE_RIGHT,
    };
    data.rc = info.rcMonitor;
    fit_app_bar(&mut data.rc, bar.edge, bar.thickness);
    if unsafe { (bar.shell)(ABM_QUERYPOS, &mut data) } == 0 {
        return Err(shell_refused("ABM_QUERYPOS"));
    }
    // The shell moved the proposed edge out of other AppBars and the taskbar: keep the thickness.
    fit_app_bar(&mut data.rc, bar.edge, bar.thickness);
    if unsafe { (bar.shell)(ABM_SETPOS, &mut data) } == 0 {
        return Err(shell_refused("ABM_SETPOS"));
    }
    let rc = data.rc;
    if let Some(stored) = app_bars()
        .iter_mut()
        .find(|stored| stored.hwnd == hwnd as usize)
    {
        stored.rect = [rc.left, rc.top, rc.right, rc.bottom];
    }
    if unsafe {
        SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            rc.left,
            rc.top,
            rc.right - rc.left,
            rc.bottom - rc.top,
            SWP_NOZORDER | SWP_NOACTIVATE,
        )
    } == 0
    {
        return Err(format!(
            "SetWindowPos failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

/// Keeps a docked AppBar where the shell put it: the work-area change that reserving the space
/// starts moves windows around (this one too), and the shell asks bars to re-dock (ABN_POSCHANGED)
/// when the taskbar or another bar moves.
#[cfg(target_os = "windows")]
unsafe extern "system" fn app_bar_proc(
    hwnd: windows_sys::Win32::Foundation::HWND,
    message: u32,
    wparam: windows_sys::Win32::Foundation::WPARAM,
    lparam: windows_sys::Win32::Foundation::LPARAM,
    _: usize,
    _: usize,
) -> windows_sys::Win32::Foundation::LRESULT {
    use windows_sys::Win32::UI::Shell::{ABN_POSCHANGED, DefSubclassProc};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        IsIconic, SWP_NOMOVE, SWP_NOSIZE, WINDOWPOS, WM_WINDOWPOSCHANGING,
    };
    match message {
        APP_BAR_MESSAGE if wparam as u32 == ABN_POSCHANGED => {
            let _ = dock(hwnd);
            return 0;
        }
        WM_WINDOWPOSCHANGING if unsafe { IsIconic(hwnd) } == 0 => {
            let rect = app_bars()
                .iter()
                .find(|bar| bar.hwnd == hwnd as usize && bar.rect != [0; 4])
                .map(|bar| bar.rect);
            if let Some([left, top, right, bottom]) = rect {
                let position = lparam as *mut WINDOWPOS;
                unsafe {
                    if (*position).flags & SWP_NOMOVE == 0 {
                        (*position).x = left;
                        (*position).y = top;
                    }
                    if (*position).flags & SWP_NOSIZE == 0 {
                        (*position).cx = right - left;
                        (*position).cy = bottom - top;
                    }
                }
            }
        }
        _ => {}
    }
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}

#[cfg(target_os = "windows")]
fn fit_app_bar(rc: &mut windows_sys::Win32::Foundation::RECT, edge: AppBarEdge, thickness: i32) {
    match edge {
        AppBarEdge::Top => rc.bottom = rc.top + thickness,
        AppBarEdge::Bottom => rc.top = rc.bottom - thickness,
        AppBarEdge::Left => rc.right = rc.left + thickness,
        AppBarEdge::Right => rc.left = rc.right - thickness,
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn app_bar(_: &Window, edge: Option<AppBarEdge>, _: f64) -> Result<(), String> {
    match edge {
        None => Ok(()),
        Some(_) => Err("appBar is supported on Windows only".into()),
    }
}

/// Gives the reserved screen space of this AppBar back (no-op for other windows).
#[cfg(target_os = "windows")]
fn release_app_bar(hwnd: usize) {
    use windows_sys::Win32::UI::Shell::{ABM_REMOVE, APPBARDATA, RemoveWindowSubclass};
    let shell = {
        let mut bars = app_bars();
        let Some(index) = bars.iter().position(|bar| bar.hwnd == hwnd) else {
            return;
        };
        bars.remove(index).shell
    };
    let hwnd = hwnd as windows_sys::Win32::Foundation::HWND;
    unsafe { RemoveWindowSubclass(hwnd, Some(app_bar_proc), APP_BAR_SUBCLASS) };
    let mut data: APPBARDATA = unsafe { std::mem::zeroed() };
    data.cbSize = size_of::<APPBARDATA>() as u32;
    data.hWnd = hwnd;
    unsafe { shell(ABM_REMOVE, &mut data) };
}

#[cfg(all(test, target_os = "windows"))]
mod app_bar_tests;

/// Releases the window's AppBar, if it is one; call before the window goes away.
pub(crate) fn release_window(window: &Window) {
    #[cfg(target_os = "windows")]
    if let Some(hwnd) = hwnd(window) {
        release_app_bar(hwnd as usize);
    }
    #[cfg(not(target_os = "windows"))]
    let _ = window;
}

/// Every monitor (physical px, work area, scale, primary) and the pointer's screen position.
pub(crate) fn screens(event_loop: &ActiveEventLoop) -> Value {
    let primary = event_loop.primary_monitor();
    let screens: Vec<Value> = event_loop
        .available_monitors()
        .map(|monitor| {
            let (position, size) = (monitor.position(), monitor.size());
            let (wx, wy, ww, wh) = work_area(&monitor).unwrap_or((
                position.x,
                position.y,
                size.width as i32,
                size.height as i32,
            ));
            json!({
                "name": monitor.name(),
                "x": position.x, "y": position.y, "width": size.width, "height": size.height,
                "workArea": {"x": wx, "y": wy, "width": ww, "height": wh},
                "scale": monitor.scale_factor(),
                "primary": primary.as_ref() == Some(&monitor),
            })
        })
        .collect();
    json!({"screens": screens, "cursor": cursor_position()})
}

#[cfg(target_os = "windows")]
fn work_area(monitor: &winit::monitor::MonitorHandle) -> Option<(i32, i32, i32, i32)> {
    use windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, HMONITOR, MONITORINFO};
    use winit::platform::windows::MonitorHandleExtWindows;
    let mut info: MONITORINFO = unsafe { std::mem::zeroed() };
    info.cbSize = size_of::<MONITORINFO>() as u32;
    if unsafe { GetMonitorInfoW(monitor.hmonitor() as HMONITOR, &mut info) } == 0 {
        return None;
    }
    let rc = info.rcWork;
    Some((rc.left, rc.top, rc.right - rc.left, rc.bottom - rc.top))
}

#[cfg(not(target_os = "windows"))]
fn work_area(_: &winit::monitor::MonitorHandle) -> Option<(i32, i32, i32, i32)> {
    None
}

#[cfg(target_os = "windows")]
fn cursor_position() -> Value {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut point = POINT { x: 0, y: 0 };
    if unsafe { GetCursorPos(&mut point) } == 0 {
        return Value::Null;
    }
    json!({"x": point.x, "y": point.y})
}

#[cfg(target_os = "linux")]
fn cursor_position() -> Value {
    crate::x11_state::cursor_position()
        .map(|(x, y)| json!({"x": x, "y": y}))
        .unwrap_or(Value::Null)
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
fn cursor_position() -> Value {
    Value::Null
}
