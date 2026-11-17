//! The screens (monitors, work areas, scale) with the pointer position, and `screensChange`.
use serde_json::{Value, json};
use winit::event_loop::ActiveEventLoop;
use winit::window::Window;

/// Every monitor (physical px, work area, scale, primary), the pointer's screen position and
/// `windowScreen`, the window's monitor (an index into `screens`; `null` without a window or
/// where unknown). Not `window`: that key routes an event to one of the app's windows.
pub(crate) fn screens(event_loop: &ActiveEventLoop, window: Option<&Window>) -> Value {
    let monitors: Vec<_> = event_loop.available_monitors().collect();
    let current = window
        .and_then(Window::current_monitor)
        .and_then(|current| monitors.iter().position(|monitor| *monitor == current));
    json!({
        "screens": screen_list(event_loop, &monitors),
        "cursor": cursor_position(),
        "windowScreen": current,
    })
}

fn screen_list(event_loop: &ActiveEventLoop, monitors: &[winit::monitor::MonitorHandle]) -> Value {
    let primary = event_loop.primary_monitor();
    monitors
        .iter()
        .map(|monitor| {
            let (position, size) = (monitor.position(), monitor.size());
            let (wx, wy, ww, wh) = work_area(monitor).unwrap_or((
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
                "primary": primary.as_ref() == Some(monitor),
            })
        })
        .collect()
}

/// Set by the window procedure when monitors or work areas may have changed (Windows:
/// `WM_SETTINGCHANGE` with `SPI_SETWORKAREA`, `WM_DISPLAYCHANGE`, `WM_DPICHANGED`).
static SCREENS_DIRTY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// The screens the last `screensChange` reported.
static LAST_SCREENS: std::sync::Mutex<Option<Value>> = std::sync::Mutex::new(None);

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn screens_maybe_changed() {
    SCREENS_DIRTY.store(true, std::sync::atomic::Ordering::Relaxed);
}

/// A `screensChange` event when the screens differ from the last one reported, once for every
/// message that arrived since the last call (a burst of them reads the screens once).
pub(crate) fn screens_change(event_loop: &ActiveEventLoop) -> Option<Value> {
    use std::sync::atomic::Ordering::Relaxed;
    if !SCREENS_DIRTY.load(Relaxed) {
        return None;
    }
    SCREENS_DIRTY.store(false, Relaxed);
    let monitors: Vec<_> = event_loop.available_monitors().collect();
    let screens = screen_list(event_loop, &monitors);
    let mut last = LAST_SCREENS
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    if last.as_ref() == Some(&screens) {
        return None;
    }
    *last = Some(screens.clone());
    Some(json!({"type": "screensChange", "screens": screens}))
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
