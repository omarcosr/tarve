//! Extended window manager hints (EWMH) winit does not expose: skip the
//! taskbar and pager, stay on every workspace. Set on the window's
//! `_NET_WM_STATE` before it is first mapped, which is when window managers
//! read it (later changes go through client messages instead).

use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
use winit::window::Window;
use x11rb::protocol::xproto::{AtomEnum, ConnectionExt, PropMode};
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;

/// Appends `states` (`_NET_WM_STATE_*` atom names) to an unmapped X11 window.
/// Does nothing on Wayland, where these hints do not exist.
pub(crate) fn add_window_states(window: &Window, states: &[&str]) -> Result<(), String> {
    if states.is_empty() {
        return Ok(());
    }
    let handle = window.window_handle().map_err(|error| error.to_string())?;
    let id = match handle.as_raw() {
        RawWindowHandle::Xlib(handle) => handle.window as u32,
        RawWindowHandle::Xcb(handle) => handle.window.get(),
        _ => return Ok(()),
    };
    let (connection, _) = RustConnection::connect(None).map_err(|error| error.to_string())?;
    let intern = |name: &str| -> Result<u32, String> {
        Ok(connection
            .intern_atom(false, name.as_bytes())
            .map_err(|error| error.to_string())?
            .reply()
            .map_err(|error| error.to_string())?
            .atom)
    };
    let property = intern("_NET_WM_STATE")?;
    let atoms = states.iter().map(|state| intern(state)).collect::<Result<Vec<_>, _>>()?;
    connection
        .change_property32(PropMode::APPEND, id, property, AtomEnum::ATOM, &atoms)
        .map_err(|error| error.to_string())?
        // Wait for the server to apply it: the connection closes right after.
        .check()
        .map_err(|error| error.to_string())
}

/// The `_NET_WM_STATE` atoms for these window options.
pub(crate) fn states_for(options: &crate::protocol::WindowOptions) -> Vec<&'static str> {
    use crate::protocol::WindowLevel;
    let mut states = Vec::new();
    match options.level {
        WindowLevel::AlwaysOnBottom => states.push("_NET_WM_STATE_BELOW"),
        WindowLevel::AlwaysOnTop => states.push("_NET_WM_STATE_ABOVE"),
        WindowLevel::Normal => {}
    }
    if options.skip_taskbar {
        states.extend(["_NET_WM_STATE_SKIP_TASKBAR", "_NET_WM_STATE_SKIP_PAGER"]);
    }
    if options.desktop_widget.is_some() {
        // A widget belongs to the desktop, not to one workspace.
        states.push("_NET_WM_STATE_STICKY");
    }
    states
}
