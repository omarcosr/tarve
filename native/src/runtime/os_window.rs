//! The OS side of a winit window: showing it without activating it, its DPI and where the OS
//! has the cursor relative to it.
use winit::window::Window;

/// Shows the hidden window without activating it. Showing and activating a never-shown
/// window in one `ShowWindow(SW_SHOW)` holds the UI thread ~15 ms (DWM brings up the window
/// and its activation together); shown first, the activation that follows takes under 1 ms.
#[cfg(target_os = "windows")]
pub(super) fn show_without_activation(window: &Window) {
    use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
    if std::env::var_os("TARVE_SHOW_ACTIVATE").is_some() {
        return;
    }
    if let Ok(handle) = window.window_handle()
        && let RawWindowHandle::Win32(handle) = handle.as_raw()
    {
        // SAFETY: the window handle is live for the window's lifetime.
        unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::ShowWindow(
                handle.hwnd.get() as _,
                windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNA,
            );
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub(super) fn show_without_activation(_: &Window) {}

/// `ShowWindow(SW_SHOWNA)`: shows the window where it is in the z-order, never activating it.
#[cfg(target_os = "windows")]
pub(super) fn show_inactive(window: &Window) {
    if let Some(hwnd) = activation_hwnd(window) {
        // SAFETY: the window handle is live for the window's lifetime.
        unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::ShowWindow(
                hwnd,
                windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNA,
            );
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub(super) fn show_inactive(_: &Window) {}

#[cfg(target_os = "windows")]
pub(super) fn activation_hwnd(window: &Window) -> Option<windows_sys::Win32::Foundation::HWND> {
    use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
    match window.window_handle().ok()?.as_raw() {
        RawWindowHandle::Win32(handle) => Some(handle.hwnd.get() as _),
        _ => None,
    }
}

/// The DPI scale the window is really at; winit's cached factor lags behind
/// while Windows moves a window between monitors.
#[cfg(target_os = "windows")]
pub(super) fn window_dpi_scale(window: &Window) -> f64 {
    use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
    if let Ok(handle) = window.window_handle()
        && let RawWindowHandle::Win32(handle) = handle.as_raw()
    {
        let dpi = unsafe {
            windows_sys::Win32::UI::HiDpi::GetDpiForWindow(
                handle.hwnd.get() as windows_sys::Win32::Foundation::HWND
            )
        };
        if dpi > 0 {
            return dpi as f64 / 96.0;
        }
    }
    window.scale_factor()
}

#[cfg(not(target_os = "windows"))]
pub(super) fn window_dpi_scale(window: &Window) -> f64 {
    window.scale_factor()
}

/// The cursor in physical client coordinates, read from the OS.
#[cfg(target_os = "windows")]
pub(super) fn os_cursor_in_client(window: &Window) -> Option<(f64, f64)> {
    use windows_sys::Win32::{
        Foundation::POINT, Graphics::Gdi::ScreenToClient, UI::WindowsAndMessaging::GetCursorPos,
    };
    use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let handle = window.window_handle().ok()?;
    let RawWindowHandle::Win32(handle) = handle.as_raw() else {
        return None;
    };
    let mut point = POINT { x: 0, y: 0 };
    unsafe {
        if GetCursorPos(&mut point) == 0 || ScreenToClient(handle.hwnd.get() as _, &mut point) == 0
        {
            return None;
        }
    }
    Some((point.x as f64, point.y as f64))
}

/// Whether the OS still has the cursor over this window (nothing of another window above it).
/// Windows posts a pointer leave when an app's other window activates, or capture changes, with
/// the cursor still over this one: such a leave is not one.
#[cfg(target_os = "windows")]
pub(super) fn os_cursor_over_window(window: &Window) -> bool {
    use windows_sys::Win32::{
        Foundation::POINT,
        UI::WindowsAndMessaging::{GA_ROOT, GetAncestor, GetCursorPos, WindowFromPoint},
    };
    use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let Ok(handle) = window.window_handle() else {
        return false;
    };
    let RawWindowHandle::Win32(handle) = handle.as_raw() else {
        return false;
    };
    let mut point = POINT { x: 0, y: 0 };
    unsafe {
        if GetCursorPos(&mut point) == 0 {
            return false;
        }
        let under = WindowFromPoint(point);
        !under.is_null() && GetAncestor(under, GA_ROOT) == handle.hwnd.get() as _
    }
}

#[cfg(not(target_os = "windows"))]
pub(super) fn os_cursor_over_window(_: &Window) -> bool {
    false
}

#[cfg(target_os = "linux")]
pub(super) fn os_cursor_in_client(window: &Window) -> Option<(f64, f64)> {
    crate::x11_state::pointer_in_window(window)
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
pub(super) fn os_cursor_in_client(_: &Window) -> Option<(f64, f64)> {
    None
}
