use crate::{
    bridge::Events,
    protocol::{
        Command, Document, FileDialogOptions, Node, WindowPosition, WindowPositionPreset, error,
    },
    renderer::{
        CaptureError, Graphics, GraphicsFaultKind, PresentResult, RenderError, RendererBackend,
    },
    tree::{Tree, color},
};

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "android"))]
use crate::accessibility::AccessibilityBridge;
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "android"))]
use accesskit::ActionRequest;
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "android"))]
use accesskit_winit::WindowEvent as AccessKitWindowEvent;

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn run_file_dialog(
    window: Option<&Arc<Window>>,
    mode: &str,
    options: FileDialogOptions,
) -> Result<Vec<String>, String> {
    let mut dialog = rfd::FileDialog::new();
    if let Some(window) = window {
        dialog = dialog.set_parent(window.as_ref());
    }
    if let Some(title) = options.title.filter(|value| !value.is_empty()) {
        dialog = dialog.set_title(title);
    }
    if let Some(directory) = options.directory.filter(|value| !value.is_empty()) {
        dialog = dialog.set_directory(directory);
    }
    if let Some(file_name) = options.file_name.filter(|value| !value.is_empty()) {
        dialog = dialog.set_file_name(file_name);
    }
    for filter in options.filters {
        if filter.name.is_empty() || filter.extensions.is_empty() {
            continue;
        }
        let extensions: Vec<String> = filter
            .extensions
            .into_iter()
            .map(|extension| extension.trim().trim_start_matches('.').to_string())
            .filter(|extension| !extension.is_empty())
            .collect();
        if !extensions.is_empty() {
            dialog = dialog.add_filter(filter.name, &extensions);
        }
    }
    let paths = match mode {
        "openFile" => dialog.pick_file().into_iter().collect(),
        "openFiles" => dialog.pick_files().unwrap_or_default(),
        "openFolder" => dialog.pick_folder().into_iter().collect(),
        "saveFile" => dialog.save_file().into_iter().collect(),
        _ => return Err(format!("Unsupported file dialog mode: {mode}")),
    };
    Ok(paths
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect())
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
fn run_file_dialog(
    _window: Option<&Arc<Window>>,
    _mode: &str,
    _options: FileDialogOptions,
) -> Result<Vec<String>, String> {
    Err("Native file dialogs are not supported on this platform".into())
}

fn shortcut_key_name(key: &Key) -> Option<String> {
    match key {
        Key::Character(value) => {
            let value = value.as_str();
            if value.chars().count() == 1 {
                Some(value.to_uppercase())
            } else {
                None
            }
        }
        Key::Named(named) => Some(
            match named {
                NamedKey::Escape => "Escape",
                NamedKey::Enter => "Enter",
                NamedKey::Space => "Space",
                NamedKey::Backspace => "Backspace",
                NamedKey::Delete => "Delete",
                NamedKey::Tab => "Tab",
                NamedKey::Home => "Home",
                NamedKey::End => "End",
                NamedKey::PageUp => "PageUp",
                NamedKey::PageDown => "PageDown",
                NamedKey::Insert => "Insert",
                NamedKey::ArrowUp => "ArrowUp",
                NamedKey::ArrowDown => "ArrowDown",
                NamedKey::ArrowLeft => "ArrowLeft",
                NamedKey::ArrowRight => "ArrowRight",
                NamedKey::F1 => "F1",
                NamedKey::F2 => "F2",
                NamedKey::F3 => "F3",
                NamedKey::F4 => "F4",
                NamedKey::F5 => "F5",
                NamedKey::F6 => "F6",
                NamedKey::F7 => "F7",
                NamedKey::F8 => "F8",
                NamedKey::F9 => "F9",
                NamedKey::F10 => "F10",
                NamedKey::F11 => "F11",
                NamedKey::F12 => "F12",
                NamedKey::F13 => "F13",
                NamedKey::F14 => "F14",
                NamedKey::F15 => "F15",
                NamedKey::F16 => "F16",
                NamedKey::F17 => "F17",
                NamedKey::F18 => "F18",
                NamedKey::F19 => "F19",
                NamedKey::F20 => "F20",
                NamedKey::F21 => "F21",
                NamedKey::F22 => "F22",
                NamedKey::F23 => "F23",
                NamedKey::F24 => "F24",
                _ => return None,
            }
            .to_string(),
        ),
        _ => None,
    }
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "android"))]
mod accessibility_actions;
mod clipboard;
mod cursor;
/// Word-wise caret motion: Ctrl on Windows/Linux, Option (Alt) on macOS.
/// `TARVE_BACKGROUND=1`: windows open off every monitor, under other windows
/// and without taking the foreground, so tests and
/// benchmarks run beside someone's work without touching their screen, mouse or
/// keyboard. Rendering and keyboard focus inside the app are unaffected.
mod graphics_startup;
mod system_requests;
mod viewport;
use viewport::{layout_viewport, request_frame, set_ime_allowed};
#[cfg(target_os = "android")]
mod android_input;
pub(crate) use graphics_startup::{
    graphics_fault_action, graphics_recoveries_after_stability, graphics_recovery_circuit_action,
    graphics_recovery_delay, graphics_recovery_failure_action,
};

pub(crate) fn background_windows() -> bool {
    static FLAG: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *FLAG.get_or_init(|| {
        std::env::var_os("TARVE_BACKGROUND").is_some_and(|v| v != "0" && !v.is_empty())
    })
}
/// Lines one wheel notch scrolls (Windows: the Mouse settings' value; 3 elsewhere).
fn wheel_lines_per_notch() -> f64 {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SPI_GETWHEELSCROLLLINES, SystemParametersInfoW,
        };
        let mut lines: u32 = 3;
        let ok = unsafe {
            SystemParametersInfoW(
                SPI_GETWHEELSCROLLLINES,
                0,
                (&mut lines as *mut u32).cast(),
                0,
            )
        };
        // WHEEL_PAGESCROLL (u32::MAX) asks for a page: a generous step stands in.
        if ok != 0 && lines > 0 {
            return f64::from(lines.min(30));
        }
    }
    3.0
}

/// A DOM `KeyboardEvent` for a winit key: `key` and `code` use the DOM names
/// (winit's named keys and key codes are spelled the same way).
pub(crate) fn dom_keyboard_event(
    event: &winit::event::KeyEvent,
    modifiers: ModifiersState,
    focused: Option<&str>,
) -> serde_json::Value {
    let key = match &event.logical_key {
        Key::Character(text) => text.to_string(),
        Key::Named(NamedKey::Space) => " ".to_string(),
        Key::Named(named) => format!("{named:?}"),
        // Text injected as Unicode (VK_PACKET: on-screen keyboards, password managers,
        // SendInput) has no key of its own: like a browser, the key is the character.
        _ => event
            .text
            .as_deref()
            .filter(|text| !text.is_empty() && !text.chars().any(char::is_control))
            .unwrap_or("Unidentified")
            .to_string(),
    };
    let code = match event.physical_key {
        winit::keyboard::PhysicalKey::Code(code) => format!("{code:?}"),
        _ => "Unidentified".to_string(),
    };
    json!({
        "type": "keyboard",
        "phase": if event.state == ElementState::Pressed { "down" } else { "up" },
        "id": focused,
        "key": key,
        "code": code,
        "repeat": event.repeat,
        "ctrlKey": modifiers.control_key(),
        "altKey": modifiers.alt_key(),
        "shiftKey": modifiers.shift_key(),
        "metaKey": modifiers.super_key(),
    })
}

impl App {
    /// A DOM-style `pointer` event at the pointer, on the deepest node under it.
    fn dom_pointer_event(&self, phase: &str, extra: serde_json::Value) -> serde_json::Value {
        let mut event = json!({
            "type": "pointer",
            "phase": phase,
            "id": self.tree.hover_path().last(),
            "x": self.tree.mouse.0,
            "y": self.tree.mouse.1,
            "ctrlKey": self.modifiers.control_key(),
            "altKey": self.modifiers.alt_key(),
            "shiftKey": self.modifiers.shift_key(),
            "metaKey": self.modifiers.super_key(),
        });
        if let (Some(event), serde_json::Value::Object(extra)) = (event.as_object_mut(), extra) {
            event.extend(extra);
        }
        event
    }
}

pub(crate) fn word_modifier(modifiers: ModifiersState) -> bool {
    if cfg!(target_os = "macos") {
        modifiers.alt_key()
    } else {
        modifiers.control_key()
    }
}

pub(crate) fn shortcut_name(key: &Key, modifiers: ModifiersState) -> Option<String> {
    let key = shortcut_key_name(key)?;
    let mut parts = Vec::with_capacity(5);
    if modifiers.control_key() {
        parts.push("Ctrl".to_string());
    }
    if modifiers.alt_key() {
        parts.push("Alt".to_string());
    }
    if modifiers.shift_key() {
        parts.push("Shift".to_string());
    }
    if modifiers.super_key() {
        parts.push("Meta".to_string());
    }
    parts.push(key);
    Some(parts.join("+"))
}
use serde_json::json;
use std::{
    sync::{Arc, mpsc::SyncSender},
    time::{Duration, Instant},
};
use winit::{
    application::ApplicationHandler,
    dpi::{LogicalPosition, LogicalSize, PhysicalPosition},
    event::{ElementState, Ime, MouseButton, MouseScrollDelta, WindowEvent},
    event_loop::{ActiveEventLoop, ControlFlow, EventLoop, EventLoopProxy},
    keyboard::{Key, ModifiersState, NamedKey},
    window::{CursorIcon, Fullscreen, ResizeDirection, Window, WindowId},
};

pub(crate) use cursor::{css_cursor, cursor_for_node};

pub(crate) fn ime_allowed_for_node(node: Option<&Node>) -> bool {
    node.is_some_and(|node| matches!(node.kind.as_str(), "input" | "textarea"))
}

/// Keys a focused text field uses for typing, editing and moving the caret.
/// Alone or with Shift they belong to the field, so they are not hotkeys:
/// typing a space in a search box must not also press "Space".
/// Editing chords a focused text field handles itself (clipboard, select all, undo,
/// word moves): no app shortcut or menu accelerator takes them from it.
pub(crate) fn editing_shortcut(key: &Key, modifiers: ModifiersState) -> bool {
    let command = modifiers.control_key() || modifiers.super_key();
    if !command || modifiers.alt_key() {
        return false;
    }
    match key {
        Key::Character(value) => matches!(
            value.to_ascii_lowercase().as_str(),
            "a" | "c" | "v" | "x" | "z" | "y"
        ),
        Key::Named(named) => matches!(
            named,
            NamedKey::Backspace
                | NamedKey::Delete
                | NamedKey::ArrowLeft
                | NamedKey::ArrowRight
                | NamedKey::ArrowUp
                | NamedKey::ArrowDown
                | NamedKey::Home
                | NamedKey::End
                | NamedKey::Insert
        ),
        _ => false,
    }
}

pub(crate) fn text_field_consumes(key: &Key, modifiers: ModifiersState) -> bool {
    if modifiers.control_key() || modifiers.alt_key() || modifiers.super_key() {
        return false;
    }
    match key {
        Key::Character(_) => true,
        Key::Named(named) => matches!(
            named,
            NamedKey::Space
                | NamedKey::Enter
                | NamedKey::Backspace
                | NamedKey::Delete
                | NamedKey::Tab
                | NamedKey::Home
                | NamedKey::End
                | NamedKey::PageUp
                | NamedKey::PageDown
                | NamedKey::ArrowUp
                | NamedKey::ArrowDown
                | NamedKey::ArrowLeft
                | NamedKey::ArrowRight
        ),
        _ => false,
    }
}

pub(crate) fn anchored_window_position(
    preset: &WindowPositionPreset,
    monitor_position: PhysicalPosition<i32>,
    monitor_size: winit::dpi::PhysicalSize<u32>,
    window_size: winit::dpi::PhysicalSize<u32>,
) -> PhysicalPosition<i32> {
    let remaining_x = monitor_size.width as i64 - window_size.width as i64;
    let remaining_y = monitor_size.height as i64 - window_size.height as i64;
    let x_offset = match preset {
        WindowPositionPreset::TopLeft
        | WindowPositionPreset::Left
        | WindowPositionPreset::BottomLeft => 0,
        WindowPositionPreset::Top | WindowPositionPreset::Center | WindowPositionPreset::Bottom => {
            remaining_x / 2
        }
        WindowPositionPreset::TopRight
        | WindowPositionPreset::Right
        | WindowPositionPreset::BottomRight => remaining_x,
    };
    let y_offset = match preset {
        WindowPositionPreset::TopLeft
        | WindowPositionPreset::Top
        | WindowPositionPreset::TopRight => 0,
        WindowPositionPreset::Left | WindowPositionPreset::Center | WindowPositionPreset::Right => {
            remaining_y / 2
        }
        WindowPositionPreset::BottomLeft
        | WindowPositionPreset::Bottom
        | WindowPositionPreset::BottomRight => remaining_y,
    };
    PhysicalPosition::new(
        (monitor_position.x as i64 + x_offset) as i32,
        (monitor_position.y as i64 + y_offset) as i32,
    )
}

#[cfg(target_os = "windows")]
fn window_work_area(
    window: &Window,
) -> Option<(PhysicalPosition<i32>, winit::dpi::PhysicalSize<u32>)> {
    use std::{ffi::c_void, mem::size_of};
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow,
    };
    use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};

    let handle = window.window_handle().ok()?;
    let RawWindowHandle::Win32(handle) = handle.as_raw() else {
        return None;
    };
    let hwnd = handle.hwnd.get() as *mut c_void;
    let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    if monitor.is_null() {
        return None;
    }
    let mut info = MONITORINFO {
        cbSize: size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if unsafe { GetMonitorInfoW(monitor, &mut info) } == 0 {
        return None;
    }
    let width = (info.rcWork.right - info.rcWork.left).max(0) as u32;
    let height = (info.rcWork.bottom - info.rcWork.top).max(0) as u32;
    Some((
        PhysicalPosition::new(info.rcWork.left, info.rcWork.top),
        winit::dpi::PhysicalSize::new(width, height),
    ))
}

#[cfg(not(target_os = "windows"))]
fn window_work_area(_: &Window) -> Option<(PhysicalPosition<i32>, winit::dpi::PhysicalSize<u32>)> {
    None
}

/// The window border as opaque 0xRRGGBB for DWM, which has no alpha: a
/// translucent `#rrggbbaa` (a hairline like `#ffffff14`) is blended over the
/// window background, as it looks when painted, instead of losing its alpha
/// and drawing a solid white frame around a dark window.
pub(crate) fn opaque_border_rgb(border: &str, background: &str) -> u32 {
    let parse = |value: &str| -> Option<[f32; 4]> {
        let hex = value.trim().strip_prefix('#')?;
        let channel = |i: usize| {
            u8::from_str_radix(hex.get(i..i + 2)?, 16)
                .ok()
                .map(f32::from)
        };
        match hex.len() {
            6 => Some([channel(0)?, channel(2)?, channel(4)?, 255.0]),
            8 => Some([channel(0)?, channel(2)?, channel(4)?, channel(6)?]),
            _ => None,
        }
    };
    let Some([r, g, b, a]) = parse(border) else {
        return 0x00e4e4e7;
    };
    let [br, bg, bb, _] = parse(background).unwrap_or([255.0; 4]);
    let t = a / 255.0;
    let mix = |fg: f32, bg: f32| (fg * t + bg * (1.0 - t)).round() as u32;
    (mix(r, br) << 16) | (mix(g, bg) << 8) | mix(b, bb)
}

#[cfg(target_os = "windows")]
fn configure_custom_window_chrome(
    window: &Window,
    border: u32,
    suppressed: bool,
) -> Result<(), String> {
    use std::{ffi::c_void, mem::size_of};
    use windows_sys::Win32::Graphics::Dwm::{
        DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND,
        DWMWCP_ROUND, DwmSetWindowAttribute,
    };
    use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};

    let handle = window.window_handle().map_err(|error| error.to_string())?;
    let RawWindowHandle::Win32(handle) = handle.as_raw() else {
        return Err("Expected a Win32 window handle".into());
    };
    let hwnd = handle.hwnd.get() as *mut c_void;
    let corner = if suppressed {
        DWMWCP_DONOTROUND
    } else {
        DWMWCP_ROUND
    };
    // COLORREF is 0x00BBGGRR.
    let rgb = border;
    let border_color = if suppressed {
        DWMWA_COLOR_NONE
    } else {
        ((rgb & 0xff) << 16) | (rgb & 0x00ff00) | ((rgb >> 16) & 0xff)
    };
    unsafe {
        let corner_result = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE as u32,
            (&corner as *const _) as *const c_void,
            size_of_val(&corner) as u32,
        );
        if corner_result < 0 {
            return Err(format!(
                "DwmSetWindowAttribute(corner) failed: 0x{:08x}",
                corner_result as u32
            ));
        }
        let border_result = DwmSetWindowAttribute(
            hwnd,
            DWMWA_BORDER_COLOR as u32,
            (&border_color as *const _) as *const c_void,
            size_of::<u32>() as u32,
        );
        if border_result < 0 {
            return Err(format!(
                "DwmSetWindowAttribute(border) failed: 0x{:08x}",
                border_result as u32
            ));
        }
    }
    Ok(())
}

/// What shows behind a blurred backdrop: `blur` the accent blur of the windows
/// behind (Windows 10 and 11, also while inactive); `mica`/`acrylic` the system
/// materials (Windows 11 22H2+; Mica's first attribute on 21H2), else the accent
/// blur. DWM draws them under the window's transparent pixels, and solid while the
/// user has transparency effects off (the materials also while inactive).
#[cfg(target_os = "windows")]
fn apply_window_backdrop(
    window: &Window,
    backdrop: crate::protocol::WindowBackdrop,
    decorations: bool,
) -> Result<(), String> {
    use std::ffi::c_void;
    use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};

    if !backdrop.blurred() {
        return Ok(());
    }
    let handle = window.window_handle().map_err(|error| error.to_string())?;
    let RawWindowHandle::Win32(handle) = handle.as_raw() else {
        return Err("Expected a Win32 window handle".into());
    };
    let hwnd = handle.hwnd.get() as *mut c_void;
    // With transparency effects off DWM draws the material solid until they are
    // switched on (`app.inspect().transparencyEffects`).
    // `blur` is the accent blur: it stays while the window is inactive, where
    // DWM draws Mica and Acrylic solid, as it does for the system's own windows.
    // DWM draws no material during the window-open animation (~250 ms of the
    // desktop showing through): skip it; `resumed` turns transitions back on once shown.
    set_dwm_transitions(hwnd, false);
    // Acrylic fades in from a lighter tint for ~230 ms once shown; keep the window
    // cloaked (composed but not on screen) until the fade is over.
    if backdrop == crate::protocol::WindowBackdrop::Acrylic {
        cloak_while_material_settles(hwnd);
    }
    if backdrop == crate::protocol::WindowBackdrop::Blur && accent_blur(hwnd).is_ok() {
        return Ok(());
    }
    apply_system_backdrop(hwnd, backdrop, decorations);
    Ok(())
}

/// Relative luminance (0–1) of `#rgb`/`#rrggbb`/`#rrggbbaa`, as the reconciler's `dark` test.
fn hex_luminance(color: &str) -> Option<f32> {
    let hex = color.trim().strip_prefix('#')?;
    let full: String = match hex.len() {
        3 | 4 => hex[..3].chars().flat_map(|c| [c, c]).collect(),
        6 | 8 => hex[..6].to_string(),
        _ => return None,
    };
    let channel = |i: usize| {
        u8::from_str_radix(&full[i..i + 2], 16)
            .ok()
            .map(|v| f32::from(v) / 255.0)
    };
    Some(0.2126 * channel(0)? + 0.7152 * channel(2)? + 0.0722 * channel(4)?)
}

#[cfg(test)]
mod backdrop_appearance_tests;

/// Logical client size of the window, owned by the event-loop thread: set from
/// resizes, frozen while the user moves the window so DPI changes on the way
/// can't feed back into it.
#[derive(Default)]
struct WindowLogicalSize {
    size: std::cell::Cell<Option<(f64, f64)>>,
    moving: std::cell::Cell<bool>,
}

thread_local! {
    /// By window (`u64::from(WindowId)`, the HWND on Windows): every window keeps its own.
    static WINDOW_LOGICAL_SIZE: std::cell::RefCell<std::collections::HashMap<u64, WindowLogicalSize>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
    /// `alwaysOnBottom`: Windows only places the window at the bottom once, and
    /// activating it (a click, a drag, being shown) raises it again, so every
    /// z-order change is redirected to the bottom while this is set.
    static KEEP_AT_BOTTOM: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// `skipTaskbar`: keep the tool-window style through winit's style rewrites.
    static SKIP_TASK_SWITCHER: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// Counts WM_SETTINGCHANGE messages (Windows): system settings may have changed.
    static SETTINGS_GENERATION: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

fn with_logical_size<T>(window: u64, read: impl FnOnce(&WindowLogicalSize) -> T) -> T {
    WINDOW_LOGICAL_SIZE.with(|sizes| read(sizes.borrow_mut().entry(window).or_default()))
}

fn keep_at_bottom(enabled: bool) {
    KEEP_AT_BOTTOM.with(|keep| keep.set(enabled));
}

fn winit_window_level(level: crate::protocol::WindowLevel) -> winit::window::WindowLevel {
    use crate::protocol::WindowLevel::*;
    match level {
        Normal => winit::window::WindowLevel::Normal,
        AlwaysOnTop => winit::window::WindowLevel::AlwaysOnTop,
        AlwaysOnBottom => winit::window::WindowLevel::AlwaysOnBottom,
    }
}

/// Tracks the user's move loop so DPI changes during a drag between monitors
/// keep the logical size frozen. Windows otherwise delivers resizes scaled for
/// the monitor being left; feeding them back made the window grow by the DPI
/// ratio on every crossing.
#[cfg(target_os = "windows")]
fn install_dpi_scaled_size(window: &Window, main: bool) {
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, SIZE, WPARAM};
    use windows_sys::Win32::UI::HiDpi::{AdjustWindowRectExForDpi, GetDpiForWindow};
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GWL_EXSTYLE, GWL_STYLE, GetClientRect, GetMenu, GetWindowLongPtrW, GetWindowRect,
        HWND_BOTTOM, STYLESTRUCT, SWP_NOZORDER, WINDOWPOS, WM_COMMAND, WM_EXITSIZEMOVE, WM_MOVING,
        WM_SETTINGCHANGE, WM_STYLECHANGING, WM_WINDOWPOSCHANGING,
    };

    const WM_GETDPISCALEDSIZE: u32 = 0x02E4;
    use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};

    unsafe extern "system" fn proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _: usize,
        main: usize,
    ) -> LRESULT {
        // The z-order, task switcher and logical-size state is the main window's.
        let main = main != 0;
        match message {
            WM_MOVING => with_logical_size(hwnd as u64, |state| state.moving.set(true)),
            WM_STYLECHANGING
                if main
                    && wparam as i32 == GWL_EXSTYLE
                    && SKIP_TASK_SWITCHER.with(|skip| skip.get()) =>
            {
                let styles = lparam as *mut STYLESTRUCT;
                unsafe { (*styles).styleNew = tool_window_style((*styles).styleNew) };
            }
            WM_WINDOWPOSCHANGING if main && KEEP_AT_BOTTOM.with(|keep| keep.get()) => {
                let position = lparam as *mut WINDOWPOS;
                unsafe {
                    (*position).hwndInsertAfter = HWND_BOTTOM;
                    (*position).flags &= !SWP_NOZORDER;
                }
            }
            WM_EXITSIZEMOVE => with_logical_size(hwnd as u64, |state| state.moving.set(false)),
            WM_SETTINGCHANGE => {
                SETTINGS_GENERATION.with(|generation| generation.set(generation.get() + 1))
            }
            // A menu bar selection: HIWORD 0 and no control handle.
            WM_COMMAND if (wparam >> 16) & 0xffff == 0 && lparam == 0 => {
                crate::menu_bar::selected(hwnd, wparam & 0xffff);
                return 0;
            }
            // Scale the client area exactly by the DPI ratio; Windows' default
            // scales the outer rect, which drifts with the frame and compounds.
            WM_GETDPISCALEDSIZE => {
                let new_dpi = wparam as u32;
                let old_dpi = unsafe { GetDpiForWindow(hwnd) };
                let mut client = RECT {
                    left: 0,
                    top: 0,
                    right: 0,
                    bottom: 0,
                };
                let mut outer = RECT {
                    left: 0,
                    top: 0,
                    right: 0,
                    bottom: 0,
                };
                if old_dpi != 0
                    && new_dpi != 0
                    && unsafe { GetClientRect(hwnd, &mut client) } != 0
                    && unsafe { GetWindowRect(hwnd, &mut outer) } != 0
                {
                    let scale = |value: i32| {
                        (value as f64 * new_dpi as f64 / old_dpi as f64).round() as i32
                    };
                    let mut rect = RECT {
                        left: 0,
                        top: 0,
                        right: scale(client.right),
                        bottom: scale(client.bottom),
                    };
                    // Frameless windows (custom TitleBar) have no non-client area.
                    let frameless = outer.right - outer.left == client.right
                        && outer.bottom - outer.top == client.bottom;
                    let style = unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) } as u32;
                    let ex_style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32;
                    let has_menu = !unsafe { GetMenu(hwnd) }.is_null();
                    if frameless
                        || unsafe {
                            AdjustWindowRectExForDpi(
                                &mut rect,
                                style,
                                has_menu as i32,
                                ex_style,
                                new_dpi,
                            )
                        } != 0
                    {
                        let size = lparam as *mut SIZE;
                        unsafe {
                            (*size).cx = rect.right - rect.left;
                            (*size).cy = rect.bottom - rect.top;
                        }
                        return 1;
                    }
                }
            }
            _ => {}
        }
        unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
    }

    let Ok(handle) = window.window_handle() else {
        return;
    };
    let RawWindowHandle::Win32(handle) = handle.as_raw() else {
        return;
    };
    unsafe {
        SetWindowSubclass(
            handle.hwnd.get() as HWND,
            Some(proc),
            0x7a1d,
            usize::from(main),
        )
    };
}

#[cfg(not(target_os = "windows"))]
fn install_dpi_scaled_size(_: &Window, _: bool) {}

/// The DPI scale the window is really at; winit's cached factor lags behind
/// while Windows moves a window between monitors.
#[cfg(target_os = "windows")]
fn window_dpi_scale(window: &Window) -> f64 {
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
fn window_dpi_scale(window: &Window) -> f64 {
    window.scale_factor()
}

/// The cursor in physical client coordinates, read from the OS.
#[cfg(target_os = "windows")]
fn os_cursor_in_client(window: &Window) -> Option<(f64, f64)> {
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

#[cfg(target_os = "linux")]
fn os_cursor_in_client(window: &Window) -> Option<(f64, f64)> {
    crate::x11_state::pointer_in_window(window)
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
fn os_cursor_in_client(_: &Window) -> Option<(f64, f64)> {
    None
}

#[cfg(not(target_os = "windows"))]
fn configure_custom_window_chrome(_: &Window, _: u32, _: bool) -> Result<(), String> {
    Ok(())
}

/// Logical size of a desktop widget before (or without) the icon grid: cells
/// of a typical desktop icon (80 × 100), less a 4 px margin on each side.
pub(crate) fn nominal_widget_size(widget: crate::protocol::DesktopWidget) -> (f64, f64) {
    (
        widget.columns as f64 * 80.0 - 8.0,
        widget.rows as f64 * 100.0 - 8.0,
    )
}

#[cfg(target_os = "linux")]
fn should_force_x11_on_wsl(kernel_release: &str, display: Option<&str>) -> bool {
    display.is_some_and(|value| !value.is_empty())
        && kernel_release.to_ascii_lowercase().contains("microsoft")
}

#[cfg(target_os = "linux")]
fn prefer_x11_on_wsl() -> bool {
    let kernel_release = std::fs::read_to_string("/proc/sys/kernel/osrelease").unwrap_or_default();
    let display = std::env::var("DISPLAY").ok();
    should_force_x11_on_wsl(&kernel_release, display.as_deref())
}

pub(crate) struct WindowIcons {
    /// Title bar icon (Windows); X11 takes the large one and scales it.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub(crate) small: winit::window::Icon,
    /// Windows taskbar and Alt+Tab icon.
    pub(crate) large: winit::window::Icon,
}

/// Decodes the app icon (PNG, ICO, JPEG or WebP) into a title-bar and a taskbar size.
pub(crate) fn window_icons(base64: &str) -> Result<WindowIcons, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64)
        .map_err(|error| format!("invalid base64: {error}"))?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("the icon file exceeds 16 MB".into());
    }
    let image = image::load_from_memory(&bytes)
        .map_err(|error| error.to_string())?
        .to_rgba8();
    let sized = |side: u32| -> Result<winit::window::Icon, String> {
        let (width, height) = image.dimensions();
        let scale = (side as f32 / width.max(height) as f32).min(1.0);
        let resized = if scale < 1.0 {
            image::imageops::resize(
                &image,
                ((width as f32 * scale).round() as u32).max(1),
                ((height as f32 * scale).round() as u32).max(1),
                image::imageops::FilterType::Lanczos3,
            )
        } else {
            image.clone()
        };
        let (width, height) = resized.dimensions();
        winit::window::Icon::from_rgba(resized.into_raw(), width, height)
            .map_err(|error| error.to_string())
    };
    // Windows scales the title-bar icon from this to 16–32 px by DPI; 64 keeps
    // the small sizes sharp without a 256 px icon in every window.
    Ok(WindowIcons {
        small: sized(64)?,
        large: sized(256)?,
    })
}

/// Where a window's events go: the app's queue, tagged with the window they come
/// from (`"window"`) unless it is the main one.
#[derive(Clone)]
pub(crate) struct EventSink {
    events: Arc<Events>,
    window: Option<Arc<str>>,
}

impl EventSink {
    pub(crate) fn push(&self, mut event: serde_json::Value) {
        if let (Some(window), Some(object)) = (&self.window, event.as_object_mut()) {
            object.insert("window".into(), serde_json::Value::from(window.as_ref()));
        }
        self.events.push(event);
    }
}

/// Wakes the event loop with a command for one window: worker threads (remote
/// images, video decoders) report to the window that asked them.
#[derive(Clone)]
pub(crate) struct CommandProxy {
    proxy: EventLoopProxy<Command>,
    window: Option<Arc<str>>,
}

impl CommandProxy {
    /// False once the event loop has closed.
    pub(crate) fn send(&self, command: Command) -> bool {
        let command = match &self.window {
            Some(window) => Command::ToWindow {
                window: window.to_string(),
                command: Box::new(command),
            },
            None => command,
        };
        self.proxy.send_event(command).is_ok()
    }
}

/// winit's Android loop drops wake-ups while the activity is in the background and drains the
/// app's commands only on a timeout, so a request sent then (`inspect`, `layout`, a notification)
/// waited for the user to come back and timed out. In the background the loop polls: often for a
/// few seconds after a command, then rarely (the system freezes cached apps anyway).
#[cfg(target_os = "android")]
pub(crate) mod background_poll {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, Instant};

    static LAST_COMMAND_MS: AtomicU64 = AtomicU64::new(0);
    const BUSY: Duration = Duration::from_millis(50);
    const IDLE: Duration = Duration::from_secs(1);
    const BUSY_FOR: Duration = Duration::from_secs(5);

    fn origin() -> Instant {
        static ORIGIN: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
        *ORIGIN.get_or_init(Instant::now)
    }

    pub(crate) fn command_sent() {
        let ms = origin().elapsed().as_millis() as u64;
        LAST_COMMAND_MS.store(ms.max(1), Ordering::Relaxed);
    }

    pub(crate) fn deadline(now: Instant) -> Option<Instant> {
        if crate::android::media::foreground() {
            return None;
        }
        let last = LAST_COMMAND_MS.load(Ordering::Relaxed);
        let recent = last != 0
            && now.saturating_duration_since(origin() + Duration::from_millis(last)) < BUSY_FOR;
        Some(now + if recent { BUSY } else { IDLE })
    }
}

/// Files dragged in from the system: winit reports each file once on entry
/// (`HoveredFile`) and on drop (`DroppedFile`), but not the pointer in between,
/// so the target under it is polled while the drag lasts.
#[derive(Default)]
struct FileDrag {
    hovered: Vec<String>,
    dropped: Vec<String>,
    /// The file drop target the pointer is over, as last reported.
    over: Option<String>,
    /// `fileDragEnter` is yet to be reported for `hovered`.
    entering: bool,
}

impl FileDrag {
    fn active(&self) -> bool {
        !self.hovered.is_empty() || !self.dropped.is_empty()
    }
}

/// How often the pointer is read while files are dragged over a window.
const FILE_DRAG_POLL: Duration = Duration::from_millis(50);
/// How often a GPU frame's pending buffer check is polled (renderer.rs).
const GPU_CHECK_POLL: Duration = Duration::from_millis(4);

/// The earlier of two wake-ups: what every window waits for together.
fn earlier_flow(a: ControlFlow, b: ControlFlow) -> ControlFlow {
    match (a, b) {
        (ControlFlow::Poll, _) | (_, ControlFlow::Poll) => ControlFlow::Poll,
        (ControlFlow::WaitUntil(x), ControlFlow::WaitUntil(y)) => ControlFlow::WaitUntil(x.min(y)),
        (ControlFlow::WaitUntil(x), ControlFlow::Wait)
        | (ControlFlow::Wait, ControlFlow::WaitUntil(x)) => ControlFlow::WaitUntil(x),
        (ControlFlow::Wait, ControlFlow::Wait) => ControlFlow::Wait,
    }
}

/// The app's windows on one event loop: the main one (process-wide state, tray,
/// media session) and those opened later with `openWindow`, each with its own
/// tree, renderer and events. Closing the main window quits the app; closing
/// another drops it and reports `closed` for it.
struct Host {
    main: App,
    others: Vec<(String, App)>,
}

impl Host {
    fn window_mut(&mut self, id: &str) -> Option<&mut App> {
        self.others
            .iter_mut()
            .find(|(key, _)| key == id)
            .map(|(_, app)| app)
    }
    fn open(&mut self, event_loop: &ActiveEventLoop, id: String, mut document: Document) {
        if id.is_empty() || self.others.iter().any(|(key, _)| *key == id) {
            // Reported to the window that asked, so its `ready` fails instead of waiting.
            let window = json!(id);
            let mut failure = error(format!("window '{id}' is already open"));
            failure["window"] = window.clone();
            self.main.events.events.push(failure);
            self.main
                .events
                .events
                .push(json!({"type": "closed", "window": window}));
            return;
        }
        // App fonts are process-wide: registered once, from the main document.
        document.fonts.clear();
        let events = EventSink {
            events: self.main.events.events.clone(),
            window: Some(Arc::from(id.as_str())),
        };
        let mut app = App::new(
            document,
            events,
            self.main.event_proxy.clone(),
            crate::stats::MemoryStages::default(),
            false,
        );
        app.resumed(event_loop);
        self.others.push((id, app));
    }
    /// After every callback: quit or drop closed windows, then wait for the
    /// earliest wake-up any window needs.
    fn settle(&mut self, event_loop: &ActiveEventLoop) {
        if self.main.exit_requested {
            event_loop.exit();
            return;
        }
        self.others.retain_mut(|(_, app)| {
            if !app.exit_requested {
                return true;
            }
            if let Some(message) = app.fatal.take() {
                app.events.push(error(message));
            }
            app.events.push(json!({"type": "closed"}));
            if let Some(window) = &app.window {
                let id = u64::from(window.id());
                WINDOW_LOGICAL_SIZE.with(|sizes| sizes.borrow_mut().remove(&id));
            }
            false
        });
        let flow = self
            .others
            .iter()
            .fold(self.main.wanted_flow.get(), |flow, (_, app)| {
                earlier_flow(flow, app.wanted_flow.get())
            });
        event_loop.set_control_flow(flow);
    }
}

impl ApplicationHandler<Command> for Host {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        self.main.resumed(event_loop);
        for (_, app) in &mut self.others {
            app.resumed(event_loop);
        }
        self.settle(event_loop);
    }
    fn suspended(&mut self, event_loop: &ActiveEventLoop) {
        self.main.suspended(event_loop);
        for (_, app) in &mut self.others {
            app.suspended(event_loop);
        }
        self.settle(event_loop);
    }
    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        self.main.about_to_wait(event_loop);
        for (_, app) in &mut self.others {
            app.about_to_wait(event_loop);
        }
        self.settle(event_loop);
    }
    fn window_event(&mut self, event_loop: &ActiveEventLoop, id: WindowId, event: WindowEvent) {
        if self.main.owns(id) {
            self.main.window_event(event_loop, id, event);
        } else if let Some((_, app)) = self.others.iter_mut().find(|(_, app)| app.owns(id)) {
            app.window_event(event_loop, id, event);
        }
        self.settle(event_loop);
    }
    fn user_event(&mut self, event_loop: &ActiveEventLoop, command: Command) {
        match command {
            Command::OpenWindow { window, document } => self.open(event_loop, window, *document),
            Command::ToWindow { window, command } => match *command {
                // The tray, notifications and the media session are the app's, not a window's.
                command @ (Command::Tray { .. }
                | Command::Notify { .. }
                | Command::SystemMedia { .. }) => self.main.user_event(event_loop, command),
                command => {
                    if let Some(app) = self.window_mut(&window) {
                        app.user_event(event_loop, command);
                    }
                }
            },
            #[cfg(any(target_os = "windows", target_os = "linux", target_os = "android"))]
            Command::Accessibility { event } => {
                let id = event.window_id;
                if self.main.owns(id) {
                    self.main
                        .user_event(event_loop, Command::Accessibility { event });
                } else if let Some((_, app)) = self.others.iter_mut().find(|(_, app)| app.owns(id))
                {
                    app.user_event(event_loop, Command::Accessibility { event });
                }
            }
            command => self.main.user_event(event_loop, command),
        }
        self.settle(event_loop);
    }
}

impl App {
    /// A window's state from its document; `resumed` then creates the window.
    fn new(
        mut document: Document,
        events: EventSink,
        event_proxy: EventLoopProxy<Command>,
        mut memory_stages: crate::stats::MemoryStages,
        is_main: bool,
    ) -> App {
        if let Some(widget) = document.window.desktop_widget.filter(|_| is_main) {
            let (width, height) = nominal_widget_size(widget);
            let window = &mut document.window;
            (
                window.width,
                window.height,
                window.min_width,
                window.min_height,
            ) = (width, height, width, height);
        }
        let command_proxy = CommandProxy {
            proxy: event_proxy.clone(),
            window: events.window.clone(),
        };
        let remote_images = crate::remote_image::RemoteImages::new(command_proxy.clone());
        // The tree owns the nodes from here on; move the children instead of
        // deep-cloning the whole document (~11 ms for 6,000 nodes).
        let tree = Tree::new(Node {
            children: std::mem::take(&mut document.root.children),
            ..document.root.clone()
        });
        memory_stages.record("tree");
        let videos = {
            // Engines report from their own threads: each report wakes the loop once.
            let proxy = std::sync::Mutex::new(command_proxy.clone());
            crate::video::Videos::new(move || {
                if let Ok(proxy) = proxy.lock() {
                    proxy.send(Command::VideoWake);
                }
            })
        };
        App {
            is_main,
            wanted_flow: std::cell::Cell::new(ControlFlow::Wait),
            exit_requested: false,
            settings_seen: 0,
            file_drag: FileDrag::default(),
            window_state: None,
            restored_bounds: None,
            #[cfg(target_os = "windows")]
            menu_bar: None,
            parked: false,
            iconic: false,
            presence: crate::power::Presence::new(),
            document,
            events,
            tree,
            graphics: GraphicsState::Suspended(GraphicsCheckpoint::default()),
            window: None,
            modifiers: ModifiersState::empty(),
            scene: vello::Scene::new(),
            glass: None,
            glass_seen: false,
            fatal: None,
            ready_emitted: false,
            presentation_retry_at: None,
            input_hold: None,
            memory_dirty: std::cell::Cell::new(false),
            trim_at: std::cell::Cell::new(None),
            startup_trim_pending: std::cell::Cell::new(true),
            last_memory_release: std::cell::Cell::new(Instant::now()),
            motion_epoch: Instant::now(),
            motion_test_clock: false,
            graphics_recovery_episodes: 0,
            graphics_stable_since: None,
            ime_target: None,
            ime_enabled: false,
            last_titlebar_click: None,
            close_request_pending: false,
            event_proxy,
            tray: None,
            media: Default::default(),
            videos,
            remote_images,
            present_times: Default::default(),
            backdrop_dark: None,
            transparency_effects: None,
            frame_stats: Default::default(),
            memory_stages,
            gpu_upgrade: false,
            gpu_check_pending: false,
            #[cfg(target_os = "windows")]
            system_media: None,
            #[cfg(any(target_os = "windows", target_os = "linux", target_os = "android"))]
            accessibility: None,
        }
    }
    fn owns(&self, id: WindowId) -> bool {
        self.window.as_ref().is_some_and(|window| window.id() == id)
    }
}

pub fn run(
    mut document: Document,
    events: Arc<Events>,
    ready: SyncSender<Result<EventLoopProxy<Command>, String>>,
) -> Result<(), String> {
    let mut memory_stages = crate::stats::MemoryStages::default();
    memory_stages.record("start");
    #[cfg(target_os = "windows")]
    if let Some(identity) = document.app_identity.as_ref()
        && let Err(message) = crate::smtc::register_app_identity(identity)
    {
        events.push(crate::protocol::error(format!("app identity: {message}")));
    }
    let mut builder = EventLoop::<Command>::with_user_event();
    #[cfg(target_os = "windows")]
    {
        use winit::platform::windows::EventLoopBuilderExtWindows;
        builder.with_any_thread(true);
    }
    #[cfg(target_os = "android")]
    {
        use winit::platform::android::EventLoopBuilderExtAndroid;
        builder.with_android_app(
            crate::android::app()
                .ok_or("Tarve on Android starts from android_main (NativeActivity)")?,
        );
    }
    #[cfg(target_os = "linux")]
    {
        use winit::platform::x11::EventLoopBuilderExtX11;
        builder.with_any_thread(true);
        // WSLg exposes both Wayland and X11, but its Wayland connection can
        // terminate winit's event loop with EPIPE for larger retained trees.
        // Prefer the stable X11 transport only on WSL; native Linux keeps
        // winit's normal backend auto-selection.
        // Below/skip-taskbar/sticky are X11 (EWMH) hints with no Wayland
        // equivalent for ordinary windows, so windows that ask for them run
        // through X11 (XWayland on a Wayland session) when it is there.
        let window = &document.window;
        let wants_x11_hints = window.desktop_widget.is_some()
            || window.skip_taskbar
            || window.level != crate::protocol::WindowLevel::Normal;
        if prefer_x11_on_wsl() || (wants_x11_hints && std::env::var_os("DISPLAY").is_some()) {
            builder.with_x11();
        }
    }
    crate::stats::trace("identity");
    let event_loop = match builder.build() {
        Ok(event_loop) => event_loop,
        Err(error) => {
            let message = format!("Could not initialize native event loop: {error}");
            let _ = ready.send(Err(message.clone()));
            return Err(message);
        }
    };
    event_loop.set_control_flow(ControlFlow::Wait);
    // A desktop widget starts at cells of a typical icon size (`App::new`). Windows
    // then fits it to the desktop icon grid; elsewhere there is no grid to read.
    crate::stats::trace("eventLoop");
    let event_proxy = event_loop.create_proxy();
    ready
        .send(Ok(event_proxy.clone()))
        .map_err(|e| e.to_string())?;
    for font in std::mem::take(&mut document.fonts) {
        use base64::Engine as _;
        match base64::engine::general_purpose::STANDARD.decode(font) {
            Ok(bytes) => crate::text::app_fonts::register(bytes),
            Err(error) => events.push(crate::protocol::error(format!(
                "font: invalid base64: {error}"
            ))),
        }
    }
    let main = App::new(
        document,
        EventSink {
            events,
            window: None,
        },
        event_proxy,
        memory_stages,
        true,
    );
    let mut host = Host {
        main,
        others: Vec::new(),
    };
    event_loop.run_app(&mut host).map_err(|e| e.to_string())?;
    let app = host.main;
    if let Some(error) = app.fatal {
        return Err(error);
    }
    Ok(())
}

struct App {
    /// The app's first window (`run`'s document); others come from `openWindow`.
    /// Process-wide window state (desktop widget, z-order, task switcher, tray)
    /// belongs to it.
    is_main: bool,
    /// The control flow this window needs; the host waits for the earliest of all.
    wanted_flow: std::cell::Cell<ControlFlow>,
    /// Closed (main: the app quits) or failed; the host drops the window.
    exit_requested: bool,
    /// `SETTINGS_GENERATION` this window last looked at.
    settings_seen: u64,
    /// Files dragged in from the system, while over the window.
    file_drag: FileDrag,
    /// The last `windowState` reported (`reportWindowState`), and the restored
    /// bounds a maximized window goes back to.
    window_state: Option<serde_json::Value>,
    restored_bounds: Option<(f64, f64, f64, f64)>,
    /// The window's native menu bar (`menuBar` command, Windows).
    #[cfg(target_os = "windows")]
    menu_bar: Option<crate::menu_bar::MenuBar>,
    /// Hidden by the app (`app.hide()`, close-to-tray): no GPU device, no
    /// frames, no motion ticks until it is shown again.
    parked: bool,
    /// Minimized: the GPU device, swap chain and textures are given back as when
    /// parked, but the window stays in the taskbar. Restored on the next resize.
    iconic: bool,
    /// Counts this window for process-wide EcoQoS (`crate::power`).
    presence: crate::power::Presence,
    /// Frames were painted since free memory was last released.
    memory_dirty: std::cell::Cell<bool>,
    trim_at: std::cell::Cell<Option<Instant>>,
    startup_trim_pending: std::cell::Cell<bool>,
    last_memory_release: std::cell::Cell<Instant>,
    document: Document,
    events: EventSink,
    tree: Tree,
    graphics: GraphicsState,
    window: Option<Arc<Window>>,
    modifiers: ModifiersState,
    scene: vello::Scene,
    /// The scene's glass and whether the last frame had any (glass/scene.rs).
    glass: Option<crate::glass::GlassFrame>,
    glass_seen: bool,
    fatal: Option<String>,
    ready_emitted: bool,
    presentation_retry_at: Option<Instant>,
    /// After a click or key reaches JS: the frame waits (until this deadline at most)
    /// for the patch its handler sends, so release and update show in one frame.
    input_hold: Option<Instant>,
    motion_epoch: Instant,
    motion_test_clock: bool,
    graphics_recovery_episodes: usize,
    graphics_stable_since: Option<Instant>,
    ime_target: Option<String>,
    ime_enabled: bool,
    last_titlebar_click: Option<(Instant, (f64, f64))>,
    close_request_pending: bool,
    event_proxy: EventLoopProxy<Command>,
    tray: Option<crate::tray::Tray>,
    media: crate::media::Media,
    /// `<video>` elements: the platform decoder and the pictures it hands the tree.
    videos: crate::video::Videos,
    remote_images: crate::remote_image::RemoteImages,
    /// When each of the last second's frames was presented, for `inspect().fps`.
    present_times: std::collections::VecDeque<Instant>,
    /// The dark/light appearance last given to the system material (`backdrop`).
    backdrop_dark: Option<bool>,
    /// Windows "Transparency effects" as last reported to JS.
    transparency_effects: Option<bool>,
    /// Phase timings of recent frames, for `app.stats()`.
    frame_stats: crate::stats::FrameStats,
    /// Process memory after each startup stage, for `app.stats()`.
    memory_stages: crate::stats::MemoryStages,
    /// The first frames are drawn on the CPU while the GPU device is still being created;
    /// set until the GPU renderer takes over.
    gpu_upgrade: bool,
    /// A GPU frame's check against Vello's buffer sizes is still on the GPU (renderer.rs).
    gpu_check_pending: bool,
    #[cfg(target_os = "windows")]
    system_media: Option<crate::smtc::SystemMedia>,
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "android"))]
    accessibility: Option<AccessibilityBridge>,
}

const MAX_GRAPHICS_RECOVERY_ATTEMPTS: u8 = 3;
const MAX_GRAPHICS_RECOVERY_EPISODES: usize = 3;
const GRAPHICS_RECOVERY_WINDOW: Duration = Duration::from_secs(30);
const PRESENT_RETRY_DELAY: Duration = Duration::from_millis(16);
/// Longest a frame waits for the JS patch answering a click or key (under a 60 Hz frame).
const INPUT_HOLD: Duration = Duration::from_millis(10);
const MEMORY_RELEASE_INTERVAL: Duration = Duration::from_millis(500);
const MAX_PASTE_IMAGE_BYTES: usize = 64 * 1024 * 1024;
const MAX_PASTE_IMAGE_DIMENSION: usize = 16_384;
const MAX_PASTE_FILES: usize = 4_096;

#[derive(Clone, Copy, Debug, Default)]
struct GraphicsCheckpoint {
    frames: u64,
    generation: u64,
    backend: Option<RendererBackend>,
}

impl GraphicsCheckpoint {
    fn from_graphics(graphics: &Graphics) -> Self {
        Self {
            frames: graphics.frames(),
            generation: graphics.generation(),
            backend: Some(graphics.backend()),
        }
    }
}

#[derive(Debug)]
struct GraphicsRecovery {
    checkpoint: GraphicsCheckpoint,
    attempts: u8,
    next_attempt: Instant,
    cause: String,
    last_error: Option<String>,
}

enum GraphicsState {
    Ready(Box<Graphics>),
    Recovering(GraphicsRecovery),
    Suspended(GraphicsCheckpoint),
    Fatal,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum GraphicsFaultAction {
    RecoverDevice,
    Fatal,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum GraphicsRecoveryFailureAction {
    RetryAfter(Duration),
    Fatal,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum GraphicsRecoveryCircuitAction {
    Allow,
    Fatal,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CloseRequestAction {
    Exit,
    Emit,
    Ignore,
}
pub(crate) fn close_request_action(intercept: bool, pending: &mut bool) -> CloseRequestAction {
    if !intercept {
        return CloseRequestAction::Exit;
    }
    if *pending {
        return CloseRequestAction::Ignore;
    }
    *pending = true;
    CloseRequestAction::Emit
}
impl App {
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "android"))]
    fn initialize_accessibility(&mut self, event_loop: &ActiveEventLoop, window: &Window) {
        self.accessibility = Some(AccessibilityBridge::new(
            event_loop,
            window,
            self.event_proxy.clone(),
        ));
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "android")))]
    fn initialize_accessibility(&mut self, _: &ActiveEventLoop, _: &Window) {}

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "android"))]
    fn sync_accessibility(&mut self) {
        if !self
            .accessibility
            .as_ref()
            .is_some_and(AccessibilityBridge::is_active)
        {
            return;
        }
        let Some(window) = self.window.as_ref() else {
            return;
        };
        let scale = window.scale_factor();
        let size = layout_viewport(window, &mut self.tree);
        if let Err(message) = self.tree.compute(size.width, size.height) {
            self.events.push(error(format!(
                "Accessibility layout update failed: {message}"
            )));
            return;
        }
        let layout_events = self.tree.take_layout_events();
        self.emit(layout_events);
        for message in self.tree.warnings.drain(..) {
            self.events.push(error(message));
        }
        if let Some(accessibility) = self.accessibility.as_mut() {
            accessibility.sync(&mut self.tree, &self.document.window.title, scale);
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "android")))]
    fn sync_accessibility(&mut self) {}

    fn request_close(&mut self, _event_loop: &ActiveEventLoop) {
        let intercept = self
            .tree
            .entries
            .get(&self.tree.root)
            .is_some_and(|entry| entry.node.close_intercept);
        match close_request_action(intercept, &mut self.close_request_pending) {
            CloseRequestAction::Exit => self.exit_requested = true,
            CloseRequestAction::Emit => self.events.push(json!({"type":"closeRequest"})),
            CloseRequestAction::Ignore => {}
        }
    }
    fn root_color(&self, key: &str, fallback: &str) -> String {
        self.tree
            .entries
            .get(&self.tree.root)
            .map(|entry| entry.node.string(key, fallback).to_string())
            .unwrap_or_else(|| fallback.to_string())
    }
    fn window_chrome_suppressed(&self) -> bool {
        // An Android activity fills the screen: no frame around it.
        cfg!(target_os = "android")
            || self
                .window
                .as_ref()
                .is_some_and(|window| window.is_maximized() || window.fullscreen().is_some())
    }
    fn apply_custom_window_chrome(&self) {
        if self.document.window.decorations {
            return;
        }
        let Some(window) = &self.window else {
            return;
        };
        if let Err(chrome_error) = configure_custom_window_chrome(
            window,
            opaque_border_rgb(
                &self.root_color("borderColor", "#e4e4e7"),
                &self.root_color("background", "#ffffff"),
            ),
            self.window_chrome_suppressed(),
        ) {
            self.events
                .push(error(format!("Custom window chrome: {chrome_error}")));
        }
    }
    /// Where a desktop widget first looks for room: the work-area point its
    /// `position` names, and which point of the widget goes there.
    #[cfg(target_os = "windows")]
    fn desktop_widget_aim(&self, window: &Window) -> ((f64, f64), (i32, i32)) {
        use crate::protocol::WindowPositionPreset::*;
        let anchor = match self.document.window.position.as_ref() {
            Some(WindowPosition::Coordinates { x, y, physical }) => {
                let scale = if *physical {
                    1.0
                } else {
                    window.scale_factor()
                };
                return (
                    (0.0, 0.0),
                    ((x * scale).round() as i32, (y * scale).round() as i32),
                );
            }
            Some(WindowPosition::Preset(preset)) => match preset {
                TopLeft => (0.0, 0.0),
                Top => (0.5, 0.0),
                TopRight => (1.0, 0.0),
                Left => (0.0, 0.5),
                Center => (0.5, 0.5),
                Right => (1.0, 0.5),
                BottomLeft => (0.0, 1.0),
                Bottom => (0.5, 1.0),
                BottomRight => (1.0, 1.0),
            },
            None => (0.5, 0.5),
        };
        let aim = window_work_area(window).map_or((0, 0), |(position, size)| {
            (
                position.x + (size.width as f64 * anchor.0).round() as i32,
                position.y + (size.height as f64 * anchor.1).round() as i32,
            )
        });
        (anchor, aim)
    }
    /// Puts a desktop widget on the desktop icon grid (Windows).
    fn attach_desktop_widget(&mut self, window: &Window) {
        let Some(widget) = self.document.window.desktop_widget else {
            return;
        };
        #[cfg(target_os = "windows")]
        {
            let (anchor, aim) = self.desktop_widget_aim(window);
            if let Err(message) =
                crate::desktop_widget::attach(window, widget.columns, widget.rows, anchor, aim)
            {
                self.events
                    .push(error(format!("desktop widget: {message}")));
            }
        }
        #[cfg(not(target_os = "windows"))]
        let _ = (widget, window);
    }
    fn sync_custom_window_chrome(&mut self) {
        if self.document.window.decorations {
            return;
        }
        let suppressed = self.window_chrome_suppressed();
        self.tree.set_window_chrome_suppressed(suppressed);
        self.apply_custom_window_chrome();
    }
    fn sync_custom_window_chrome_state(&mut self) {
        if self.document.window.decorations {
            return;
        }
        let suppressed = self.window_chrome_suppressed();
        if self.tree.set_window_chrome_suppressed(suppressed) {
            self.apply_custom_window_chrome();
        }
    }
    fn apply_initial_window_position(
        &self,
        event_loop: &ActiveEventLoop,
        window: &Window,
        use_work_area: bool,
    ) {
        if background_windows() {
            // Left of every monitor: the window renders and presents but is never on screen.
            let left = event_loop
                .available_monitors()
                .map(|monitor| monitor.position().x)
                .min()
                .unwrap_or(0);
            window.set_outer_position(PhysicalPosition::new(left - 8000, 0));
            return;
        }
        match self.document.window.position.as_ref() {
            Some(WindowPosition::Coordinates { x, y, physical }) => {
                // A saved position on a monitor that is gone (or moved) would open the
                // window off screen: centre it on the primary monitor instead.
                let scale = window.scale_factor();
                let size =
                    LogicalSize::new(self.document.window.width, self.document.window.height)
                        .to_physical::<f64>(scale);
                let at = if *physical {
                    PhysicalPosition::new(*x, *y)
                } else {
                    LogicalPosition::new(*x, *y).to_physical::<f64>(scale)
                };
                let on_screen = event_loop.available_monitors().any(|monitor| {
                    let (position, extent) = (monitor.position(), monitor.size());
                    let overlap_x = (at.x + size.width)
                        .min(f64::from(position.x) + f64::from(extent.width))
                        - at.x.max(f64::from(position.x));
                    let overlap_y = (at.y + 32.0 * scale)
                        .min(f64::from(position.y) + f64::from(extent.height))
                        - at.y.max(f64::from(position.y));
                    // The title bar strip must be reachable to drag the window back.
                    overlap_x >= 64.0 * scale && overlap_y >= 16.0 * scale
                });
                if on_screen {
                    window.set_outer_position(at);
                } else if let Some(monitor) = event_loop
                    .primary_monitor()
                    .or_else(|| window.current_monitor())
                {
                    window.set_outer_position(anchored_window_position(
                        &crate::protocol::WindowPositionPreset::Center,
                        monitor.position(),
                        monitor.size(),
                        size.cast(),
                    ));
                }
            }
            Some(WindowPosition::Preset(preset)) => {
                let Some(monitor) = event_loop
                    .primary_monitor()
                    .or_else(|| window.current_monitor())
                else {
                    return;
                };
                let (monitor_position, monitor_size) = if use_work_area {
                    window_work_area(window).unwrap_or_else(|| (monitor.position(), monitor.size()))
                } else {
                    (monitor.position(), monitor.size())
                };
                // A hidden Win32 window can temporarily report an outer size of 16x16 before
                // its first ShowWindow. Use the configured client size in that case so initial
                // anchoring is based on the real requested window dimensions.
                let outer_size = window.outer_size();
                let window_size = if outer_size.width <= 32 || outer_size.height <= 32 {
                    LogicalSize::new(self.document.window.width, self.document.window.height)
                        .to_physical(window.scale_factor())
                } else {
                    outer_size
                };
                window.set_outer_position(anchored_window_position(
                    preset,
                    monitor_position,
                    monitor_size,
                    window_size,
                ));
            }
            None => {}
        }
    }
    fn emit(&self, events: Vec<serde_json::Value>) {
        for event in events {
            self.events.push(event);
        }
    }
    /// A hidden window (headless apps and tests) gets no redraws from the OS,
    /// so its layout, and the `size` and virtual-list events layout sends,
    /// would wait for the next capture. Lay it out as soon as the tree changes.
    fn layout_hidden_window(&mut self) {
        // A parked window is laid out once it is shown again.
        if self.parked {
            return;
        }
        let Some(window) = self.window.as_ref() else {
            return;
        };
        if window.is_visible() != Some(false) {
            return;
        }
        let size = layout_viewport(window, &mut self.tree);
        if size.width <= 0.0 || size.height <= 0.0 {
            return;
        }
        if let Err(message) = self.tree.compute(size.width, size.height) {
            self.events
                .push(error(format!("Layout update failed: {message}")));
            return;
        }
        let layout_events = self.tree.take_layout_events();
        self.emit(layout_events);
    }
    fn redraw(&self) {
        if self.input_hold.is_some_and(|until| until > Instant::now()) {
            return;
        }
        if (self.tree.dirty.paint || self.tree.dirty.layout || self.tree.dirty.text)
            && let Some(window) = &self.window
        {
            request_frame(window);
        }
    }
    fn emit_motion_events(&mut self) {
        let events = self.tree.take_motion_events();
        self.emit(events);
    }
    fn advance_live_motion(&mut self) {
        if self.motion_test_clock {
            return;
        }
        let now_ms = self.motion_epoch.elapsed().as_secs_f64() * 1000.0;
        #[cfg(target_os = "android")]
        let now_ms = match crate::android::vsync::frame_age() {
            Some(age) => (now_ms - age.as_secs_f64() * 1000.0).max(self.tree.motion_time_ms()),
            None => now_ms,
        };
        self.tree.advance_motion(now_ms);
        self.emit_motion_events();
    }
    fn sync_input_clock(&mut self) {
        if self.motion_test_clock {
            return;
        }
        let now_ms = self.motion_epoch.elapsed().as_secs_f64() * 1000.0;
        self.tree.advance_clock(now_ms);
    }
    fn motion_deadline(&self, now: Instant) -> Option<Instant> {
        // Like a hidden browser tab: nothing on screen, no animation frames.
        // Motion is clock-based, so it is where it should be once shown.
        if self.motion_test_clock || self.parked || self.minimized() {
            return None;
        }
        let next_ms = self.tree.next_clock_tick_ms()?;
        let delta_ms = (next_ms - self.tree.motion_time_ms()).max(0.0);
        Some(now + Duration::from_secs_f64(delta_ms / 1000.0))
    }
    fn minimized(&self) -> bool {
        self.window.as_ref().is_some_and(|window| {
            let size = window.inner_size();
            size.width == 0 || size.height == 0
        })
    }
    /// Hides the window and gives its GPU device, swap chain and textures back,
    /// with the working set: an app in the tray costs memory and CPU for its
    /// state only. `unpark` builds them again from the retained tree.
    fn park(&mut self, event_loop: &ActiveEventLoop) {
        if let Some(window) = &self.window {
            window.set_visible(false);
        }
        if self.parked {
            return;
        }
        self.parked = true;
        self.release_graphics();
        self.trim_at.set(None);
        crate::release_free_memory();
        if self.trim_delay().is_some() {
            crate::trim_working_set();
        }
        self.memory_dirty.set(false);
        self.last_memory_release.set(Instant::now());
        self.sync_control_flow(event_loop);
    }
    /// Gives the GPU device, swap chain, textures and scene back.
    fn release_graphics(&mut self) {
        let state = std::mem::replace(&mut self.graphics, GraphicsState::Fatal);
        self.graphics = match state {
            GraphicsState::Ready(graphics) => {
                GraphicsState::Suspended(GraphicsCheckpoint::from_graphics(&graphics))
            }
            GraphicsState::Recovering(recovery) => GraphicsState::Suspended(recovery.checkpoint),
            other => other,
        };
        // Videos hold a reference to the renderer's device: without letting go, the device
        // (and its driver allocations) outlives the renderer.
        #[cfg(target_os = "windows")]
        self.videos.attach_renderer(None);
        self.scene = vello::Scene::new();
        self.glass = None;
        self.presentation_retry_at = None;
    }
    /// Minimized: nothing can be seen until it is restored, so the renderer and the
    /// pages it touched go back to the system, as for a parked window.
    fn iconify(&mut self, event_loop: &ActiveEventLoop) {
        if self.parked || self.iconic || !matches!(self.graphics, GraphicsState::Ready(_)) {
            return;
        }
        // Restoring builds the device again (tens of ms, then the first frame);
        // only `lowPower` apps trade that for the memory.
        if !self.document.low_power {
            return;
        }
        self.iconic = true;
        self.release_graphics();
        self.trim_at.set(None);
        crate::release_free_memory();
        if self.trim_delay().is_some() {
            crate::trim_working_set();
        }
        self.memory_dirty.set(false);
        self.last_memory_release.set(Instant::now());
        self.sync_control_flow(event_loop);
    }
    fn deiconify(&mut self) {
        if !self.iconic {
            return;
        }
        self.iconic = false;
        self.restore_graphics();
    }
    /// Builds a released renderer again for the same window and backend.
    fn restore_graphics(&mut self) {
        let Some(window) = self.window.clone() else {
            return;
        };
        if let GraphicsState::Suspended(checkpoint) =
            std::mem::replace(&mut self.graphics, GraphicsState::Fatal)
        {
            let result = match checkpoint.backend {
                Some(backend) => Graphics::recover(
                    window,
                    backend,
                    self.document.renderer,
                    self.document.window.backdrop.transparent(),
                ),
                None => Graphics::new(
                    window,
                    self.document.renderer,
                    self.document.window.backdrop.transparent(),
                ),
            };
            self.graphics = match result {
                Ok(mut graphics) => {
                    graphics.restore_counters(
                        checkpoint.frames,
                        checkpoint.generation.saturating_add(1).max(1),
                    );
                    GraphicsState::Ready(Box::new(graphics))
                }
                Err(error) => GraphicsState::Recovering(GraphicsRecovery {
                    checkpoint,
                    attempts: 1,
                    next_attempt: Instant::now() + graphics_recovery_delay(1),
                    cause: "GPU recreation after the window was shown failed".into(),
                    last_error: Some(error),
                }),
            };
        }
        self.tree.dirty.layout = true;
        self.tree.dirty.paint = true;
    }
    /// Shows a parked window: a new device, then the first frame painted before
    /// the window appears, as at startup.
    fn unpark(&mut self, event_loop: &ActiveEventLoop) {
        let Some(window) = self.window.clone() else {
            return;
        };
        if self.parked {
            self.parked = false;
            self.restore_graphics();
            self.advance_live_motion();
            if matches!(self.graphics, GraphicsState::Ready(_))
                && let Err(error) = self.prepare()
            {
                self.handle_render_error(event_loop, error);
            }
        }
        window.set_visible(true);
        window.set_minimized(false);
        if !background_windows() {
            window.focus_window();
        }
        self.redraw_frame(event_loop);
        self.sync_control_flow(event_loop);
    }
    fn request_present_now(&mut self) {
        self.presentation_retry_at = None;
        if let Some(window) = &self.window {
            window.request_redraw();
        }
    }
    fn schedule_present_retry(&mut self, event_loop: &ActiveEventLoop) {
        self.presentation_retry_at = Some(Instant::now() + PRESENT_RETRY_DELAY);
        self.sync_control_flow(event_loop);
    }
    /// Opt-in `EmptyWorkingSet` trim: the app's `memoryTrimDelay` (ms; unset or negative:
    /// never), `TARVE_TRIM` overriding it (0: never). Off by default: it only moves pages to
    /// the standby list, so Task Manager drops while the commit stays the same.
    fn trim_delay(&self) -> Option<Duration> {
        let ms = std::env::var("TARVE_TRIM")
            .ok()
            .and_then(|value| value.trim().parse::<f64>().ok())
            .map(|value| if value == 0.0 { -1.0 } else { value })
            .or(self.document.memory_trim_delay);
        match ms {
            Some(ms) if ms.is_finite() && ms >= 0.0 => Some(Duration::from_secs_f64(ms / 1000.0)),
            _ => None,
        }
    }
    /// Videos decode onto the D3D11 renderer's device when there is one (drawn with
    /// no copy), else onto their own and read the pictures back.
    fn attach_video_renderer(&mut self) {
        #[cfg(target_os = "windows")]
        if let GraphicsState::Ready(graphics) = &self.graphics {
            self.videos.attach_renderer(graphics.d3d11_device());
        }
    }

    /// Video engine news: media events out, new pictures into the tree.
    fn tick_videos(&mut self) {
        self.attach_video_renderer();
        let sizes = self.tree.video_display_sizes();
        self.videos.set_display_sizes(|id| sizes.get(id).copied());
        // A minimized window shows no video; before the first paint every one counts as shown.
        let minimized = self
            .window
            .as_ref()
            .is_some_and(|window| window.is_minimized().unwrap_or(false));
        let painted = self.tree.paints > 0;
        let tree = &self.tree;
        self.videos
            .set_visible(|id| !minimized && (!painted || tree.video_painted(id)));
        let events = self.videos.tick(Instant::now());
        self.emit(events);
        let frames = self.videos.take_frames();
        if frames.is_empty() {
            return;
        }
        let must_paint = self.videos.take_repaint();
        let mut repaint = false;
        for (id, frame) in frames {
            if must_paint.contains(&id) {
                self.tree.set_video_frame(&id, frame);
                repaint = true;
                continue;
            }
            // A video in its own composition layer: the picture goes there, no UI frame.
            #[cfg(target_os = "windows")]
            if let Some(next) = &frame
                && let GraphicsState::Ready(graphics) = &mut self.graphics
                && graphics.video_layered(&id)
                && let Some(view) = self.videos.view(&id)
                && self.tree.set_video_frame_layered(&id, next.clone())
            {
                match graphics.present_video(&id, &view, next.height >= 720) {
                    Ok(true) => continue,
                    Ok(false) => {}
                    Err(failure) => self.events.push(error(format!("video layer: {failure:?}"))),
                }
            }
            // Off screen: no paint for a picture nobody sees.
            if let Some(next) = &frame
                && self.tree.set_video_frame_unseen(&id, next)
            {
                continue;
            }
            self.tree.set_video_frame(&id, frame);
            repaint = true;
        }
        // Without a paint the renderer would keep the last pictures' textures (a
        // parked video's decoder, an off screen one's surfaces): hand it the current ones.
        #[cfg(target_os = "windows")]
        if !repaint && let GraphicsState::Ready(graphics) = &mut self.graphics {
            graphics.set_video_views(self.videos.views());
        }
        if repaint && let Some(window) = &self.window {
            window.request_redraw();
        }
    }

    fn sync_control_flow(&self, _event_loop: &ActiveEventLoop) {
        self.sync_power();
        let now = Instant::now();
        let startup_trim_at = if self.startup_trim_pending.get() {
            match self.trim_at.get() {
                Some(at) if at <= now => {
                    crate::trim_working_set();
                    self.trim_at.set(None);
                    self.startup_trim_pending.set(false);
                    None
                }
                at => at,
            }
        } else {
            None
        };
        let recovery_at = match &self.graphics {
            GraphicsState::Recovering(recovery) if recovery.next_attempt > now => {
                Some(recovery.next_attempt)
            }
            _ => None,
        };
        let present_at = self
            .presentation_retry_at
            .filter(|deadline| *deadline > now);
        let hold_at = self.input_hold.filter(|deadline| *deadline > now);
        let motion_at = self.motion_deadline(now);
        let media_at = self.media.deadline();
        #[cfg(target_os = "android")]
        let media_at = media_at
            .into_iter()
            .chain(crate::android::media::background_deadline(now))
            .chain(crate::android::frame_rate::deadline())
            .chain(background_poll::deadline(now))
            .min();
        let video_at = self.videos.deadline();
        let file_drag_at = self.file_drag.active().then(|| now + FILE_DRAG_POLL);
        let upgrade_at = self.gpu_upgrade.then(|| now + Duration::from_millis(2));
        let gpu_check_at = self.gpu_check_pending.then(|| now + GPU_CHECK_POLL);
        let deadline = [
            upgrade_at,
            gpu_check_at,
            file_drag_at,
            recovery_at,
            present_at,
            hold_at,
            motion_at,
            media_at,
            video_at,
            startup_trim_at,
        ]
        .into_iter()
        .flatten()
        .min();
        if let Some(deadline) = deadline {
            self.wanted_flow.set(ControlFlow::WaitUntil(deadline));
            return;
        }
        // Idle: hand free allocator pages back once activity settles, at most
        // every MEMORY_RELEASE_INTERVAL, so hover bursts don't trim per frame.
        // Once the app has been idle a few seconds after drawing, give the
        // pages startup and the last burst touched back to the OS.
        if let Some(at) = self.trim_at.get() {
            if at > now {
                self.wanted_flow.set(ControlFlow::WaitUntil(at));
                return;
            }
            crate::release_free_memory();
            crate::trim_working_set();
            self.trim_at.set(None);
            self.memory_dirty.set(false);
            self.last_memory_release.set(now);
        }
        if self.memory_dirty.get() {
            let release_at = self.last_memory_release.get() + MEMORY_RELEASE_INTERVAL;
            if release_at > now {
                self.wanted_flow.set(ControlFlow::WaitUntil(release_at));
                return;
            }
            crate::release_free_memory();
            self.memory_dirty.set(false);
            self.last_memory_release.set(now);
        }
        self.wanted_flow.set(ControlFlow::Wait);
    }
    /// Background for EcoQoS: minimized or hidden, and no sound or video due.
    fn sync_power(&self) {
        let playing = self.media.deadline().is_some() || self.videos.deadline().is_some();
        self.presence
            .set_background((self.parked || self.iconic) && !playing);
    }
    fn start_graphics_recovery(&mut self, event_loop: &ActiveEventLoop, cause: String) -> bool {
        if matches!(self.graphics, GraphicsState::Recovering(_)) {
            return true;
        }
        if matches!(self.graphics, GraphicsState::Fatal) {
            return false;
        }
        let now = Instant::now();
        if let Some(stable_since) = self.graphics_stable_since {
            self.graphics_recovery_episodes = graphics_recoveries_after_stability(
                self.graphics_recovery_episodes,
                now.duration_since(stable_since),
            );
        }
        if graphics_recovery_circuit_action(self.graphics_recovery_episodes)
            == GraphicsRecoveryCircuitAction::Fatal
        {
            self.fail(
                event_loop,
                format!(
                    "GPU recovery circuit breaker opened after {} recovery episodes without {} seconds of stable presentation; latest cause: {cause}",
                    self.graphics_recovery_episodes,
                    GRAPHICS_RECOVERY_WINDOW.as_secs()
                ),
            );
            return false;
        }
        self.graphics_recovery_episodes = self.graphics_recovery_episodes.saturating_add(1);
        self.graphics_stable_since = None;
        let state = std::mem::replace(&mut self.graphics, GraphicsState::Fatal);
        let checkpoint = match state {
            GraphicsState::Ready(graphics) => GraphicsCheckpoint::from_graphics(&graphics),
            GraphicsState::Suspended(checkpoint) => checkpoint,
            GraphicsState::Recovering(recovery) => {
                self.graphics = GraphicsState::Recovering(recovery);
                return true;
            }
            GraphicsState::Fatal => {
                self.graphics = GraphicsState::Fatal;
                return false;
            }
        };
        self.graphics = GraphicsState::Recovering(GraphicsRecovery {
            checkpoint,
            attempts: 0,
            next_attempt: Instant::now(),
            cause,
            last_error: None,
        });
        self.presentation_retry_at = None;
        true
    }
    fn try_graphics_recovery(&mut self, event_loop: &ActiveEventLoop) {
        let state = std::mem::replace(&mut self.graphics, GraphicsState::Fatal);
        let GraphicsState::Recovering(mut recovery) = state else {
            self.graphics = state;
            return;
        };
        let now = Instant::now();
        if now < recovery.next_attempt {
            self.graphics = GraphicsState::Recovering(recovery);
            self.sync_control_flow(event_loop);
            return;
        }
        let Some(window) = self.window.clone() else {
            self.fail(event_loop, "GPU recovery attempted without a window".into());
            return;
        };
        recovery.attempts = recovery.attempts.saturating_add(1);
        let result = if let Some(previous_backend) = recovery.checkpoint.backend {
            Graphics::recover(
                window,
                previous_backend,
                self.document.renderer,
                self.document.window.backdrop.transparent(),
            )
        } else {
            Graphics::new(
                window,
                self.document.renderer,
                self.document.window.backdrop.transparent(),
            )
        };
        match result {
            Ok(mut graphics) => {
                let generation = recovery.checkpoint.generation.saturating_add(1).max(1);
                graphics.restore_counters(recovery.checkpoint.frames, generation);
                self.graphics = GraphicsState::Ready(Box::new(graphics));
                self.tree.dirty.paint = true;
                self.presentation_retry_at = None;
                self.wanted_flow.set(ControlFlow::Wait);
                self.request_present_now();
            }
            Err(error) => match graphics_recovery_failure_action(recovery.attempts) {
                GraphicsRecoveryFailureAction::RetryAfter(delay) => {
                    recovery.last_error = Some(error);
                    recovery.next_attempt = now + delay;
                    self.graphics = GraphicsState::Recovering(recovery);
                    self.sync_control_flow(event_loop);
                }
                GraphicsRecoveryFailureAction::Fatal => {
                    let previous = recovery.last_error.as_deref().unwrap_or("none");
                    self.fail(
                        event_loop,
                        format!(
                            "GPU recovery exhausted after {} attempts; cause: {}; previous error: {previous}; final error: {error}",
                            recovery.attempts, recovery.cause
                        ),
                    );
                }
            },
        }
    }
    fn handle_graphics_fault(&mut self, event_loop: &ActiveEventLoop) -> bool {
        let fault = match &self.graphics {
            GraphicsState::Ready(graphics) => graphics.take_fault(),
            _ => None,
        };
        let Some(fault) = fault else {
            return false;
        };
        match graphics_fault_action(fault.kind) {
            GraphicsFaultAction::RecoverDevice => {
                if self.start_graphics_recovery(event_loop, fault.message) {
                    self.try_graphics_recovery(event_loop);
                }
            }
            GraphicsFaultAction::Fatal => self.fail(event_loop, fault.message),
        }
        true
    }
    /// The system material follows the window background's lightness (the app's
    /// theme), not the system theme: light text on a light material stays legible.
    /// Creates the window and its renderer; the window's backdrop is applied, the
    /// layout computed while the GPU device comes up. A window without a GDI
    /// redirection surface that only the CPU renderer could take is made again with one.
    fn create_graphics_window(
        &mut self,
        event_loop: &ActiveEventLoop,
        attributes: winit::window::WindowAttributes,
        without_redirection: bool,
    ) -> Result<(Arc<Window>, Graphics), String> {
        let open = |app: &mut Self,
                    attributes: winit::window::WindowAttributes|
         -> Result<(Arc<Window>, Graphics), String> {
            let window = Arc::new(
                event_loop
                    .create_window(attributes)
                    .map_err(|error| error.to_string())?,
            );
            app.memory_stages.record("window");
            if let Err(message) = apply_window_backdrop(
                &window,
                app.document.window.backdrop,
                app.document.window.decorations,
            ) {
                app.events
                    .push(error(format!("window backdrop: {message}")));
            }
            // Lay out and shape text while the GPU device (prewarmed on another thread
            // since tarve_start) finishes; prepare() then finds a clean layout.
            let size = layout_viewport(&window, &mut app.tree);
            let _ = app.tree.compute(size.width, size.height);
            crate::stats::trace("layout");
            let graphics = Graphics::new(
                window.clone(),
                app.document.renderer,
                app.document.window.backdrop.transparent(),
            )?;
            Ok((window, graphics))
        };
        #[cfg(target_os = "windows")]
        {
            use winit::platform::windows::WindowAttributesExtWindows;
            let fallback = attributes.clone().with_no_redirection_bitmap(false);
            let (window, graphics) = open(self, attributes)?;
            if without_redirection && graphics.backend() == crate::renderer::RendererBackend::Cpu {
                drop(graphics);
                drop(window);
                return open(self, fallback);
            }
            Ok((window, graphics))
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = without_redirection;
            open(self, attributes)
        }
    }
    fn sync_backdrop_appearance(&mut self, background: &str) {
        if !self.document.window.backdrop.blurred() {
            return;
        }
        let Some(dark) = hex_luminance(background).map(|luminance| luminance < 0.5) else {
            return;
        };
        if self.backdrop_dark == Some(dark) {
            return;
        }
        if let Some(window) = &self.window {
            set_backdrop_dark(window, dark);
            self.backdrop_dark = Some(dark);
        }
    }
    /// Reports the restored bounds (logical outer position, logical client size) and
    /// whether the window is maximized, when they change (`reportWindowState`).
    /// Minimized windows and moves while maximized keep the last restored bounds.
    fn sync_window_state(&mut self) {
        if !self.document.window.report_window_state {
            return;
        }
        let Some(window) = &self.window else {
            return;
        };
        if window.is_minimized().unwrap_or(false) || !window.is_visible().unwrap_or(true) {
            return;
        }
        let maximized = os_maximized(window);
        let fullscreen = window.fullscreen().is_some();
        if !maximized && !fullscreen {
            let scale = window.scale_factor();
            let size = window.inner_size().to_logical::<f64>(scale);
            // The position in physical screen px: logical px would depend on the
            // scale of the monitor the window reopens on (mixed-DPI setups).
            if let Ok(position) = window.outer_position() {
                self.restored_bounds = Some((
                    f64::from(position.x),
                    f64::from(position.y),
                    size.width,
                    size.height,
                ));
            }
        }
        let Some((x, y, width, height)) = self.restored_bounds else {
            return;
        };
        let round = |value: f64| (value * 100.0).round() / 100.0;
        let state = json!({
            "type": "windowState", "x": round(x), "y": round(y), "physical": true, "width": round(width),
            "height": round(height), "maximized": maximized, "fullscreen": fullscreen,
        });
        if self.window_state.as_ref() != Some(&state) {
            self.window_state = Some(state.clone());
            self.events.push(state);
        }
    }
    #[cfg(target_os = "windows")]
    fn apply_menu_bar(
        &mut self,
        menu: Option<Vec<crate::protocol::TrayMenuItem>>,
    ) -> Result<(), String> {
        use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
        if !self.document.window.decorations {
            return Err(
                "a frameless window has no native menu bar; use the Menubar component".into(),
            );
        }
        let Some(window) = &self.window else {
            return Err("the window is not open yet".into());
        };
        if self.menu_bar.is_none() {
            let handle = window.window_handle().map_err(|error| error.to_string())?;
            let RawWindowHandle::Win32(handle) = handle.as_raw() else {
                return Err("expected a Win32 window".into());
            };
            self.menu_bar = Some(crate::menu_bar::MenuBar::new(handle.hwnd.get() as _));
        }
        let bar = self.menu_bar.as_mut().expect("created above");
        bar.apply(menu.as_deref())
    }
    #[cfg(not(target_os = "windows"))]
    fn apply_menu_bar(
        &mut self,
        _menu: Option<Vec<crate::protocol::TrayMenuItem>>,
    ) -> Result<(), String> {
        Err(format!(
            "native menu bars are not supported on {} yet",
            std::env::consts::OS
        ))
    }
    /// Menu bar selections since the last loop iteration, as `menu` events.
    fn sync_menu_selections(&mut self) {
        #[cfg(target_os = "windows")]
        if let Some(bar) = &self.menu_bar {
            for command in crate::menu_bar::take_selected(bar.hwnd()) {
                if let Some(id) = crate::menu_bar::item_for(&bar.ids, command) {
                    self.events.push(json!({"type": "menu", "id": id}));
                }
            }
        }
    }
    /// The pointer in logical client coordinates: read from the OS where it can be
    /// (no pointer events arrive during a system drag), else the last one seen.
    fn pointer_point(&self) -> (f64, f64) {
        self.window
            .as_ref()
            .and_then(|window| {
                let scale = window.scale_factor();
                os_cursor_in_client(window).map(|(x, y)| (x / scale, y / scale))
            })
            .unwrap_or(self.tree.mouse)
    }
    /// Reports files dragged in from the system: `fileDragEnter`/`fileDragLeave` on
    /// the file drop target under the pointer as it changes, then one `fileDrop`
    /// with every file (`id` null when no target is under the pointer).
    fn sync_file_drag(&mut self) {
        if !self.file_drag.active() {
            return;
        }
        let point = self.pointer_point();
        let target = self.tree.file_drop_target_at(point);
        let drag = &mut self.file_drag;
        let mut events = Vec::new();
        if !drag.dropped.is_empty() {
            if let Some(over) = drag
                .over
                .take()
                .filter(|over| Some(over) != target.as_ref())
            {
                events.push(json!({"type": "fileDragLeave", "id": over}));
            }
            let paths = std::mem::take(&mut drag.dropped);
            let mut drop = json!({"type": "fileDrop", "paths": paths, "x": point.0, "y": point.1});
            if let Some(id) = target {
                drop["id"] = json!(id);
            }
            events.push(drop);
            *drag = FileDrag::default();
        } else if drag.entering || drag.over != target {
            if let Some(over) = drag.over.take() {
                events.push(json!({"type": "fileDragLeave", "id": over}));
            }
            if let Some(id) = &target {
                events.push(json!({"type": "fileDragEnter", "id": id, "paths": drag.hovered}));
            }
            drag.over = target;
            drag.entering = false;
        }
        for event in events {
            self.events.push(event);
        }
    }
    /// Reports a change of Windows "Transparency effects" while the window has a
    /// material backdrop (`transparencyEffects` event).
    fn sync_transparency_effects(&mut self) {
        let generation = SETTINGS_GENERATION.with(std::cell::Cell::get);
        if !self.document.window.backdrop.blurred() || self.settings_seen == generation {
            return;
        }
        self.settings_seen = generation;
        let enabled = transparency_effects_enabled();
        if self.transparency_effects.replace(enabled) != Some(enabled) {
            self.events
                .push(json!({"type": "transparencyEffects", "enabled": enabled}));
        }
    }
    fn present(&mut self, content_changed: bool) -> Result<PresentResult, RenderError> {
        let background = self.root_color("background", &self.document.window.background);
        self.sync_backdrop_appearance(&background);
        let present_started = Instant::now();
        let result = match &mut self.graphics {
            GraphicsState::Ready(graphics) => graphics.render(
                &self.scene,
                self.glass.as_ref(),
                color(&background),
                content_changed,
            ),
            _ => Err(RenderError::Fatal("Renderer not ready".into())),
        }?;
        self.frame_stats
            .present
            .push(present_started.elapsed().as_secs_f64() * 1000.0);
        if let GraphicsState::Ready(graphics) = &mut self.graphics {
            for ms in graphics.take_gpu_times() {
                self.frame_stats.gpu.push(ms);
            }
        }
        if result == PresentResult::Presented
            && let Some(delay) = self.trim_delay()
        {
            // The first trim runs `delay` after the first frame even while
            // animating (startup's pages are done with by then); later ones
            // wait until the window has been still that long.
            if !(self.startup_trim_pending.get() && self.trim_at.get().is_some()) {
                self.trim_at.set(Some(Instant::now() + delay));
            }
        }
        if result == PresentResult::Presented {
            self.present_times.push_back(Instant::now());
            self.prune_present_times();
        }
        if result == PresentResult::Presented && self.document.window.debug {
            let frames = match &self.graphics {
                GraphicsState::Ready(graphics) => graphics.frames(),
                _ => 0,
            };
            self.events.push(json!({"type":"frame", "frames":frames}));
        }
        Ok(result)
    }
    fn prune_present_times(&mut self) {
        let second = Duration::from_secs(1);
        while self
            .present_times
            .front()
            .is_some_and(|time| time.elapsed() > second)
        {
            self.present_times.pop_front();
        }
    }
    fn prepare(&mut self) -> Result<bool, RenderError> {
        let Some(window) = &self.window else {
            return Ok(false);
        };
        let scale = window.scale_factor();
        let physical = window.inner_size();
        // Minimized: nothing to paint, and D3D11 cannot size targets to zero.
        if physical.width == 0 || physical.height == 0 {
            return Ok(false);
        }
        let size = layout_viewport(window, &mut self.tree);
        // Only D3D11 paints released images (from their textures); any other
        // renderer, e.g. after a fallback, needs the pixels back.
        let d3d11 = {
            #[cfg(target_os = "windows")]
            {
                matches!(&self.graphics, GraphicsState::Ready(graphics) if graphics.backend() == crate::renderer::RendererBackend::D3d11)
            }
            #[cfg(not(target_os = "windows"))]
            {
                false
            }
        };
        if !d3d11 && !self.tree.released_image_keys().is_empty() {
            self.tree.restore_all_image_pixels();
        }
        let layout_started = Instant::now();
        let computed = self.tree.compute(size.width, size.height);
        self.frame_stats
            .layout
            .push(layout_started.elapsed().as_secs_f64() * 1000.0);
        computed.map_err(RenderError::Fatal)?;
        let layout_events = self.tree.take_layout_events();
        self.emit(layout_events);
        let content_changed = self.tree.dirty.paint;
        let paint_started = Instant::now();
        if content_changed {
            let tree = &mut self.tree;
            let mut retained_prepared = false;
            if let GraphicsState::Ready(graphics) = &mut self.graphics {
                #[cfg(target_os = "windows")]
                {
                    graphics.set_video_views(self.videos.views());
                    retained_prepared = graphics.prepare_d3d11_frame(
                        physical.width,
                        physical.height,
                        |target| tree.paint(scale, target),
                    )?;
                    if retained_prepared {
                        let (released, restored) = graphics.sync_d3d11_images(tree);
                        if released {
                            // The freed pixels go back to the OS on the next idle trim.
                            self.memory_dirty.set(true);
                        }
                        if restored {
                            window.request_redraw();
                        }
                    }
                }
                if !retained_prepared {
                    let (width, height) =
                        crate::renderer::scaled_size(physical.width, physical.height, scale);
                    let device_scale = scale * crate::renderer::render_scale(scale);
                    retained_prepared = graphics
                        .prepare_cpu_frame(width, height, device_scale, |target| {
                            tree.paint(device_scale, target)
                        })
                        .map_err(RenderError::Fatal)?;
                }
            }
            // Parked: nothing to show, and no scene to keep in memory.
            if !retained_prepared && !self.parked {
                let device_scale = scale * crate::renderer::render_scale(scale);
                let size = crate::renderer::scaled_size(physical.width, physical.height, scale);
                (self.scene, self.glass) = crate::glass::paint_scene(
                    &mut self.tree,
                    device_scale,
                    size,
                    &mut self.glass_seen,
                );
            }
            self.frame_stats
                .paint
                .push(paint_started.elapsed().as_secs_f64() * 1000.0);
        }
        let requests = self.tree.take_remote_image_requests();
        self.remote_images.request(requests);
        for message in self.tree.warnings.drain(..) {
            self.events.push(error(message));
        }
        Ok(content_changed)
    }

    fn handle_render_error(&mut self, event_loop: &ActiveEventLoop, error: RenderError) {
        match error {
            RenderError::RecoverDevice(message) => {
                if self.start_graphics_recovery(event_loop, message) {
                    self.try_graphics_recovery(event_loop);
                }
            }
            RenderError::Fatal(message) => self.fail(event_loop, message),
        }
    }
    fn fail(&mut self, _event_loop: &ActiveEventLoop, message: String) {
        self.fatal = Some(message);
        self.graphics = GraphicsState::Fatal;
        self.exit_requested = true;
    }
    fn redraw_frame(&mut self, event_loop: &ActiveEventLoop) {
        if self.parked {
            return;
        }
        if self
            .window
            .as_ref()
            .is_some_and(|window| window.inner_size().width == 0 || window.inner_size().height == 0)
        {
            return;
        }
        if matches!(self.graphics, GraphicsState::Recovering(_)) {
            self.try_graphics_recovery(event_loop);
            return;
        }
        if !matches!(self.graphics, GraphicsState::Ready(_)) {
            return;
        }
        if self.handle_graphics_fault(event_loop) {
            return;
        }
        let frame_started = Instant::now();
        self.advance_live_motion();
        let content_changed = match self.prepare() {
            Ok(content_changed) => content_changed,
            Err(error) => {
                self.handle_render_error(event_loop, error);
                return;
            }
        };
        // CPU cost only (motion, layout, paint); present can block on vsync.
        let frame_cpu_ms = frame_started.elapsed().as_secs_f64() * 1000.0;
        self.frame_stats.frame.push(frame_cpu_ms);
        if !self.ready_emitted {
            crate::stats::trace("painted");
        }
        match self.present(content_changed) {
            Ok(PresentResult::Presented) => {
                self.presentation_retry_at = None;
                self.tree.record_frame_time(frame_cpu_ms);
                #[cfg(target_os = "android")]
                self.android_frame_presented(frame_started);
                crate::stats::trace_frame(
                    frame_cpu_ms,
                    frame_started.elapsed().as_secs_f64() * 1000.0,
                );
                if self.graphics_recovery_episodes > 0 {
                    let now = Instant::now();
                    if let Some(stable_since) = self.graphics_stable_since {
                        self.graphics_recovery_episodes = graphics_recoveries_after_stability(
                            self.graphics_recovery_episodes,
                            now.duration_since(stable_since),
                        );
                        if self.graphics_recovery_episodes == 0 {
                            self.graphics_stable_since = None;
                        }
                    } else {
                        self.graphics_stable_since = Some(now);
                    }
                }
                if !self.ready_emitted {
                    self.ready_emitted = true;
                    self.memory_stages.record("firstFrame");
                    self.events.push(json!({"type":"ready"}));
                }
                self.sync_control_flow(event_loop);
            }
            Ok(PresentResult::RetryNow) => {
                self.graphics_stable_since = None;
                self.request_present_now();
            }
            Ok(PresentResult::RetryLater) => {
                self.graphics_stable_since = None;
                self.schedule_present_retry(event_loop);
            }
            Ok(PresentResult::Occluded) => {
                self.presentation_retry_at = None;
                self.graphics_stable_since = None;
                if !self.ready_emitted {
                    self.ready_emitted = true;
                    self.events.push(json!({"type":"ready"}));
                }
                self.sync_control_flow(event_loop);
            }
            Err(error) => self.handle_render_error(event_loop, error),
        }
    }
    fn sync_cursor(&mut self) {
        if let Some(window) = self.window.clone() {
            if let Some(direction) = self.resize_direction() {
                window.set_cursor(CursorIcon::from(direction));
                window.set_cursor_visible(true);
            } else {
                // A link or clickable span inside text wins over the text caret, as in a browser.
                // CSS `cursor` inherits: the nearest ancestor that sets one wins.
                let mut hidden = false;
                let explicit = {
                    let mut current = self.tree.hovered.clone();
                    let mut found = None;
                    while let Some(id) = current {
                        let Some(entry) = self.tree.entries.get(&id) else {
                            break;
                        };
                        if let Some(name) = entry.node.style["cursor"].as_str() {
                            hidden = name == "none";
                            found = if name == "auto" || hidden {
                                None
                            } else {
                                css_cursor(name)
                            };
                            break;
                        }
                        current = entry.parent.clone();
                    }
                    found
                };
                let cursor = if self.tree.pointer_on_scrollbar() {
                    CursorIcon::Default
                } else if self.tree.text_run_at_pointer().is_some() {
                    CursorIcon::Pointer
                } else if let Some(cursor) = explicit {
                    cursor
                } else if self.tree.selectable_text_at_pointer().is_some() {
                    CursorIcon::Text
                } else {
                    let hovered = self.tree.hovered.as_ref();
                    if hovered.is_some_and(|id| {
                        matches!(
                            self.tree.entries[id].node.kind.as_str(),
                            "input" | "textarea"
                        ) && self.tree.user_select_mode(id) == crate::tree::UserSelectMode::None
                    }) {
                        CursorIcon::Default
                    } else {
                        cursor_for_node(hovered.map(|id| &self.tree.entries[id].node))
                    }
                };
                window.set_cursor(cursor);
                window.set_cursor_visible(!hidden);
            }
            let target = self
                .tree
                .focused
                .as_ref()
                .filter(|id| ime_allowed_for_node(Some(&self.tree.entries[*id].node)))
                .cloned();
            if target != self.ime_target {
                self.tree.ime_cancel();
                set_ime_allowed(&window, false);
                self.ime_enabled = false;
                self.ime_target = target.clone();
            }
            set_ime_allowed(&window, target.is_some());
            if self.ime_enabled
                && target.is_some()
                && let Some(rect) = self.tree.ime_cursor_area()
            {
                window.set_ime_cursor_area(
                    LogicalPosition::new(rect.x0, rect.y0),
                    LogicalSize::new(rect.width().max(1.0), rect.height().max(1.0)),
                );
            }
        }
    }
    fn resize_direction(&self) -> Option<ResizeDirection> {
        if self.document.window.decorations || !self.document.window.resizable {
            return None;
        }
        let window = self.window.as_ref()?;
        if window.is_maximized() || window.fullscreen().is_some() {
            return None;
        }
        let size = window.inner_size().to_logical::<f64>(window.scale_factor());
        let (x, y) = self.tree.mouse;
        if x < 0.0 || y < 0.0 || x > size.width || y > size.height {
            return None;
        }
        let edge = 6.0;
        let left = x <= edge;
        let right = x >= size.width - edge;
        let top = y <= edge;
        let bottom = y >= size.height - edge;
        match (left, right, top, bottom) {
            (true, _, true, _) => Some(ResizeDirection::NorthWest),
            (_, true, true, _) => Some(ResizeDirection::NorthEast),
            (true, _, _, true) => Some(ResizeDirection::SouthWest),
            (_, true, _, true) => Some(ResizeDirection::SouthEast),
            (true, _, _, _) => Some(ResizeDirection::West),
            (_, true, _, _) => Some(ResizeDirection::East),
            (_, _, true, _) => Some(ResizeDirection::North),
            (_, _, _, true) => Some(ResizeDirection::South),
            _ => None,
        }
    }
    fn sync_pointer_from_os(&mut self) -> Vec<serde_json::Value> {
        let Some(window) = &self.window else {
            return vec![];
        };
        let Some((x, y)) = os_cursor_in_client(window) else {
            return vec![];
        };
        let scale = window.scale_factor();
        let (x, y) = (x / scale, y / scale);
        if self.tree.hovered.is_some()
            && (self.tree.mouse.0 - x).abs() < 0.5
            && (self.tree.mouse.1 - y).abs() < 0.5
        {
            return vec![];
        }
        self.tree.pointer_move(x, y)
    }
    fn titlebar_pressed(&mut self) {
        // A phone's window fills the screen: a TitleBar is only the app's top bar there.
        if cfg!(target_os = "android") {
            return;
        }
        let Some(window) = &self.window else {
            return;
        };
        if let Some(direction) = self.resize_direction() {
            let _ = window.drag_resize_window(direction);
            return;
        }
        let Some(id) = self.tree.hovered.as_deref() else {
            return;
        };
        if !self.tree.entries[id].node.drag_region {
            return;
        }
        let now = Instant::now();
        let position = self.tree.mouse;
        let double_click = self.last_titlebar_click.is_some_and(|(at, previous)| {
            now.duration_since(at) <= Duration::from_millis(500)
                && (position.0 - previous.0).abs() <= 4.0
                && (position.1 - previous.1).abs() <= 4.0
        });
        if double_click {
            if self.document.window.resizable {
                window.set_maximized(!window.is_maximized());
            }
            self.last_titlebar_click = None;
        } else {
            self.last_titlebar_click = Some((now, position));
            let _ = window.drag_window();
        }
    }
    fn handle_window_actions(
        &mut self,
        event_loop: &ActiveEventLoop,
        events: &[serde_json::Value],
    ) {
        let Some(window) = self.window.clone() else {
            return;
        };
        for event in events {
            if event["type"] != "click" {
                continue;
            }
            let Some(id) = event["id"].as_str() else {
                continue;
            };
            match self
                .tree
                .entries
                .get(id)
                .map(|entry| entry.node.window_action.as_str())
            {
                Some("minimize") => window.set_minimized(true),
                Some("toggleMaximize") => window.set_maximized(!window.is_maximized()),
                Some("toggleFullscreen") => toggle_fullscreen(&window),
                Some("close") => self.request_close(event_loop),
                _ => {}
            }
        }
    }
}

#[cfg(all(test, target_os = "windows"))]
mod accessibility_tests;
impl ApplicationHandler<Command> for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if let Some(window) = self.window.clone() {
            let state = std::mem::replace(&mut self.graphics, GraphicsState::Fatal);
            match state {
                GraphicsState::Suspended(checkpoint) => {
                    let result = if let Some(previous_backend) = checkpoint.backend {
                        Graphics::recover(
                            window,
                            previous_backend,
                            self.document.renderer,
                            self.document.window.backdrop.transparent(),
                        )
                    } else {
                        Graphics::new(
                            window,
                            self.document.renderer,
                            self.document.window.backdrop.transparent(),
                        )
                    };
                    match result {
                        Ok(mut graphics) => {
                            let generation = checkpoint.generation.saturating_add(1).max(1);
                            graphics.restore_counters(checkpoint.frames, generation);
                            self.graphics = GraphicsState::Ready(Box::new(graphics));
                            self.tree.dirty.paint = true;
                            self.request_present_now();
                        }
                        Err(error) => {
                            self.graphics = GraphicsState::Recovering(GraphicsRecovery {
                                checkpoint,
                                attempts: 1,
                                next_attempt: Instant::now() + graphics_recovery_delay(1),
                                cause: "GPU recreation after application resume failed".into(),
                                last_error: Some(error),
                            });
                            self.sync_control_flow(event_loop);
                        }
                    }
                }
                other => self.graphics = other,
            }
            return;
        }
        let options = &self.document.window;
        let visible = options.visible;
        // Background windows sit under every other window as well as not activating.
        let level = if background_windows() {
            crate::protocol::WindowLevel::AlwaysOnBottom
        } else {
            options.level
        };
        if self.is_main {
            keep_at_bottom(level == crate::protocol::WindowLevel::AlwaysOnBottom);
        }
        crate::stats::trace("resumed");
        let icon = self.document.window_icon.as_deref().map(window_icons);
        if let Some(Err(message)) = &icon {
            self.events.push(error(format!("window icon: {message}")));
        }
        let icon = icon.and_then(Result::ok);
        let mut attributes = Window::default_attributes()
            .with_title(&options.title)
            .with_inner_size(LogicalSize::new(options.width, options.height))
            .with_min_inner_size(LogicalSize::new(options.min_width, options.min_height))
            .with_resizable(options.resizable)
            .with_decorations(options.decorations)
            .with_window_level(winit_window_level(level))
            .with_visible(false)
            .with_active(!background_windows());
        if options.backdrop.transparent() {
            // macOS and Wayland/X11 (KDE) blur through winit; Windows in apply_window_backdrop.
            attributes = attributes
                .with_transparent(true)
                .with_blur(options.backdrop.blurred());
        }
        // Windows: a small title-bar icon and a large taskbar one. Elsewhere the
        // one window icon (X11 _NET_WM_ICON) serves every size, so it is the large one.
        #[cfg(target_os = "windows")]
        {
            use winit::platform::windows::WindowAttributesExtWindows;
            attributes = attributes
                .with_window_icon(icon.as_ref().map(|icons| icons.small.clone()))
                .with_taskbar_icon(icon.map(|icons| icons.large))
                .with_skip_taskbar(options.skip_taskbar);
        }
        #[cfg(not(target_os = "windows"))]
        {
            attributes = attributes.with_window_icon(icon.map(|icons| icons.large));
        }
        // X11 WM_CLASS / Wayland app_id: matches the desktop entry's StartupWMClass.
        #[cfg(target_os = "linux")]
        if let Some(identity) = self.document.app_identity.as_ref() {
            attributes = winit::platform::x11::WindowAttributesExtX11::with_name(
                attributes,
                identity.id.clone(),
                identity.id.clone(),
            );
            attributes = winit::platform::wayland::WindowAttributesExtWayland::with_name(
                attributes,
                identity.id.clone(),
                identity.id.clone(),
            );
        }
        // A transparent window drawn by the GPU skips the GDI redirection surface:
        // DirectComposition shows the UI and nothing opaque sits under it. The CPU
        // renderer presents through GDI, so a window it ends up on is made again with one.
        let cpu = self.document.renderer == crate::protocol::RendererPreference::Cpu
            || std::env::var_os("TARVE_RENDERER").is_some_and(|value| value == "cpu");
        let without_redirection =
            cfg!(target_os = "windows") && options.backdrop.transparent() && !cpu;
        #[cfg(target_os = "windows")]
        let attributes = {
            use winit::platform::windows::WindowAttributesExtWindows;
            attributes.with_no_redirection_bitmap(without_redirection)
        };
        let created = self.create_graphics_window_cpu_first(
            event_loop,
            attributes,
            without_redirection,
            options.backdrop.transparent(),
        );
        match created {
            Ok((window, graphics)) => {
                {
                    {
                        self.memory_stages.record("graphics");
                        self.graphics = GraphicsState::Ready(Box::new(graphics));
                        install_dpi_scaled_size(&window, self.is_main);
                        self.window = Some(window.clone());
                        self.motion_epoch = Instant::now();
                        self.apply_initial_window_position(event_loop, &window, false);
                        if self.is_main {
                            self.attach_desktop_widget(&window);
                        }
                        self.sync_custom_window_chrome();
                        if let Err(error) = self.prepare() {
                            self.handle_render_error(event_loop, error);
                            return;
                        }
                        crate::stats::trace("prepared");
                        self.initialize_accessibility(event_loop, window.as_ref());
                        self.sync_environment(true);
                        crate::stats::trace("a11y");
                        #[cfg(target_os = "linux")]
                        if let Err(message) = crate::x11_state::add_window_states(
                            &window,
                            &crate::x11_state::states_for(&self.document.window),
                        ) {
                            self.events.push(error(format!("window state: {message}")));
                        }
                        // Keep the HWND hidden while WGPU, layout, text and the first scene are
                        // prepared. Making it visible immediately before the synchronous present
                        // prevents Windows from compositing an empty client area on startup.
                        if visible {
                            window.set_visible(true);
                        }
                        crate::stats::trace("visible");
                        if self.is_main && self.document.window.skip_taskbar {
                            hide_from_task_switcher(&window);
                        }
                        // Once visible, native decorations have their final outer dimensions.
                        // Re-apply the anchor to make native-chrome windows exact as well.
                        if self.document.window.desktop_widget.is_none() {
                            self.apply_initial_window_position(event_loop, &window, true);
                        }
                        // After the final position: the restored bounds are recorded first,
                        // so un-maximizing goes back to them.
                        if self.document.window.maximized
                            && self.document.window.desktop_widget.is_none()
                        {
                            self.sync_window_state();
                            window.set_maximized(true);
                        }
                        self.redraw_frame(event_loop);
                        if self.document.window.backdrop.blurred() {
                            restore_dwm_transitions(&window);
                        }
                    }
                }
            }
            Err(error) => self.fail(event_loop, error),
        }
    }
    fn user_event(&mut self, event_loop: &ActiveEventLoop, command: Command) {
        let mut accessibility_changed = false;
        // `motionAdvance` is the hand-off to the deterministic test clock. Do not
        // sample wall time immediately before applying it, otherwise the first
        // deterministic step depends on how long the command spent in transit.
        if !matches!(&command, Command::MotionAdvance { .. }) {
            self.advance_live_motion();
        }
        let apply_started = Instant::now();
        if matches!(
            command,
            Command::Patch { .. } | Command::Mutate { .. } | Command::Update { .. }
        ) {
            self.input_hold = None;
            // Transitions a patch starts begin now, not at the last painted frame: after
            // an idle spell that frame is long gone and they would end at once.
            self.sync_input_clock();
        }
        match command {
            Command::Patch { nodes } => {
                let chrome_changed = nodes.iter().any(|node| {
                    node.id == self.tree.root && node.style.get("borderColor").is_some()
                });
                if let Err(error) = self.tree.patch(nodes) {
                    self.events.push(crate::protocol::error(error));
                } else {
                    accessibility_changed = true;
                    if chrome_changed {
                        self.sync_custom_window_chrome();
                    }
                }
                self.frame_stats
                    .apply
                    .push(apply_started.elapsed().as_secs_f64() * 1000.0);
            }
            Command::Mutate { mutations } => {
                let chrome_changed = mutations.iter().any(|mutation| match mutation {
                    crate::protocol::TreeMutation::Patch { node }
                    | crate::protocol::TreeMutation::Create { node } => {
                        node.id == self.tree.root && node.style.get("borderColor").is_some()
                    }
                    _ => false,
                });
                if let Err(error) = self.tree.mutate(mutations) {
                    self.events.push(crate::protocol::error(error));
                } else {
                    accessibility_changed = true;
                    if chrome_changed {
                        self.sync_custom_window_chrome();
                    }
                }
                self.frame_stats
                    .apply
                    .push(apply_started.elapsed().as_secs_f64() * 1000.0);
            }
            Command::Update { root } => {
                self.tree.update(*root);
                self.sync_custom_window_chrome();
                accessibility_changed = true;
                self.frame_stats
                    .apply
                    .push(apply_started.elapsed().as_secs_f64() * 1000.0);
            }
            Command::Stats { request_id, reset } => self.stats(request_id, reset),
            Command::Close => self.exit_requested = true,
            Command::CancelCloseRequest => self.close_request_pending = false,
            Command::MenuBar { menu } => {
                if let Err(message) = self.apply_menu_bar(menu) {
                    self.events.push(error(format!("menu bar: {message}")));
                }
            }
            Command::WindowTitle { title } => {
                if let Some(window) = &self.window {
                    window.set_title(&title);
                }
                self.document.window.title = title;
            }
            Command::WindowLevel { level } => {
                self.document.window.level = level;
                if self.is_main {
                    keep_at_bottom(level == crate::protocol::WindowLevel::AlwaysOnBottom);
                }
                if let Some(window) = &self.window {
                    window.set_window_level(winit_window_level(level));
                }
            }
            Command::Window { action } => {
                if let Some(window) = &self.window {
                    match action.as_str() {
                        // An activity cannot hide: it goes to the background, still running.
                        #[cfg(target_os = "android")]
                        "hide" | "minimize" => crate::android::move_to_back(),
                        "show" => self.unpark(event_loop),
                        #[cfg(not(target_os = "android"))]
                        "hide" => self.park(event_loop),
                        #[cfg(not(target_os = "android"))]
                        "minimize" => window.set_minimized(true),
                        "focus" if !background_windows() => window.focus_window(),
                        "maximize" => window.set_maximized(true),
                        "unmaximize" => window.set_maximized(false),
                        "fullscreen" => window.set_fullscreen(Some(Fullscreen::Borderless(None))),
                        "exitFullscreen" => window.set_fullscreen(None),
                        "toggleFullscreen" => toggle_fullscreen(window),
                        // Brought back for the user (a second launch, a tray click): shown,
                        // restored if minimized and focused.
                        "activate" => {
                            self.unpark(event_loop);
                            if let Some(window) = &self.window {
                                window.set_minimized(false);
                                if !background_windows() {
                                    window.focus_window();
                                }
                            }
                        }
                        other => self
                            .events
                            .push(error(format!("unknown window action {other}"))),
                    }
                }
            }
            Command::Tray { tray } => {
                let proxy = self.event_proxy.clone();
                let result = self
                    .tray
                    .get_or_insert_with(|| crate::tray::Tray::new(proxy))
                    .apply(tray);
                // Ok carries the trayAvailability event (no tray host is a state, not an error).
                let event = result.unwrap_or_else(|message| Some(error(message)));
                event.into_iter().for_each(|event| self.events.push(event));
            }
            Command::Media {
                id,
                action,
                src,
                time,
                volume,
                muted,
                looped,
                kind,
                rate,
                track,
            } => {
                let video_load = action == "load" && kind.as_deref() == Some("video");
                let events = if action == "textTrack" {
                    if self.videos.handles(&id) {
                        self.videos.set_text_track(&id, track)
                    } else {
                        Vec::new()
                    }
                } else if action == "audioTrack" {
                    match track {
                        Some(track) if self.videos.handles(&id) => {
                            self.videos.set_audio_track(&id, track)
                        }
                        // An <audio> element plays its file's first audio stream only.
                        _ => Vec::new(),
                    }
                } else if action == "rate" {
                    let rate = rate
                        .filter(|rate| rate.is_finite() && *rate > 0.0)
                        .unwrap_or(1.0);
                    if self.videos.handles(&id) {
                        self.videos.set_rate(&id, rate)
                    } else {
                        self.media.set_rate(&id, rate)
                    }
                } else if video_load {
                    // A `<video>` that used to be `<audio>` stops its sound first.
                    let mut events = self
                        .media
                        .command(&id, "unload", None, None, None, None, None);
                    self.attach_video_renderer();
                    // Windows mixes a video's sound into the app's audio output;
                    // GStreamer (Linux) plays it through its own sink: no stream opened for it.
                    #[cfg(target_os = "windows")]
                    let mixer = self.media.output_mixer().ok();
                    #[cfg(not(target_os = "windows"))]
                    let mixer: Option<()> = None;
                    events.extend(self.videos.load(
                        &id,
                        crate::video::VideoLoad {
                            src: src.as_deref().unwrap_or(""),
                            looped: looped.unwrap_or(false),
                            muted: muted.unwrap_or(false),
                            volume: volume.unwrap_or(1.0) as f32,
                        },
                        mixer,
                    ));
                    events
                } else if self.videos.handles(&id) {
                    if action == "load" {
                        let mut events = self.videos.command(&id, "unload", None, None, None, None);
                        self.tree.set_video_frame(&id, None);
                        events.extend(self.media.command(
                            &id,
                            &action,
                            src.as_deref(),
                            time,
                            volume,
                            muted,
                            looped,
                        ));
                        events
                    } else {
                        self.videos
                            .command(&id, &action, time, volume, muted, looped)
                    }
                } else {
                    self.media
                        .command(&id, &action, src.as_deref(), time, volume, muted, looped)
                };
                self.emit(events);
                self.tick_videos();
                self.sync_control_flow(event_loop);
            }
            Command::VideoWake => {
                self.tick_videos();
                self.sync_control_flow(event_loop);
            }
            Command::SystemMedia { session } => {
                #[cfg(target_os = "windows")]
                {
                    if self.system_media.is_none()
                        && session.is_some()
                        && let Some(window) = self.window.as_ref()
                    {
                        match crate::smtc::SystemMedia::new(window, self.event_proxy.clone()) {
                            Ok(controls) => self.system_media = Some(controls),
                            Err(message) => {
                                self.events.push(error(format!("system media: {message}")))
                            }
                        }
                    }
                    if let Some(controls) = self.system_media.as_mut()
                        && let Err(message) = controls.update(session.as_ref())
                    {
                        self.events.push(error(format!("system media: {message}")));
                    }
                }
                #[cfg(target_os = "android")]
                crate::android::media::set_session(session);
                #[cfg(not(any(target_os = "windows", target_os = "android")))]
                let _ = session;
            }
            Command::SystemMediaEvent { action, time } => {
                #[cfg(target_os = "android")]
                for event in crate::android::media::action(&mut self.media, &action) {
                    self.events.push(event);
                }
                let mut event = json!({"type":"systemMedia", "action":action});
                if let Some(time) = time {
                    event["time"] = json!(time);
                }
                self.events.push(event);
            }
            Command::Notify { id, title, body } => {
                let app_name = self
                    .document
                    .app_identity
                    .as_ref()
                    .map(|identity| identity.name.trim())
                    .filter(|name| !name.is_empty())
                    .or_else(|| Some(self.document.window.title.trim()).filter(|t| !t.is_empty()))
                    .unwrap_or("Tarve")
                    .to_owned();
                let notification = crate::notification::Notification {
                    id: id.as_deref(),
                    title: &title,
                    body: &body,
                    app_name: &app_name,
                };
                #[cfg(target_os = "windows")]
                let result = crate::notification::show(
                    &notification,
                    self.document.app_identity.as_ref(),
                    self.event_proxy.clone(),
                )
                .or_else(|error| match self.tray.as_mut() {
                    // A toast that cannot show (no notification platform) falls back to the tray balloon.
                    Some(tray) => tray.notify(&title, &body),
                    None => Err(error),
                });
                #[cfg(not(target_os = "windows"))]
                let result = crate::notification::show(&notification, self.event_proxy.clone());
                if let Err(message) = result {
                    self.events.push(error(message));
                }
            }
            Command::RemoteImage { url, result } => {
                self.tree.finish_remote_image(url, result);
                for message in self.tree.warnings.drain(..) {
                    self.events.push(error(message));
                }
                self.redraw();
            }
            Command::TrayEvent { event } => {
                if event["type"] == "trayRecreate" {
                    #[cfg(target_os = "windows")]
                    if let Some(tray) = self.tray.as_mut() {
                        let event = tray.publish(true);
                        event.into_iter().for_each(|event| self.events.push(event));
                    }
                } else {
                    if event["type"] == "notificationClick"
                        && let Some(window) = self.window.as_ref()
                        && window.is_visible() != Some(false)
                    {
                        window.set_minimized(false);
                        window.focus_window();
                    }
                    self.events.push(event);
                }
            }
            Command::FrameRate { max_fps } => {
                // Animation frames per second: the requested rate, or the
                // display's refresh rate for `null`. Motion is clock-based, so
                // this changes how many frames are drawn, not animation speed.
                let fps = max_fps
                    .filter(|fps| fps.is_finite() && *fps > 0.0)
                    .or_else(|| {
                        let monitor = self.window.as_ref()?.current_monitor()?;
                        Some(f64::from(monitor.refresh_rate_millihertz()?) / 1000.0)
                    })
                    .unwrap_or(60.0)
                    .min(1000.0);
                self.tree.set_motion_frame_ms(1000.0 / fps);
                self.sync_control_flow(event_loop);
            }
            Command::FrameOverlay { enabled } => {
                if self.tree.set_frame_overlay(enabled) {
                    self.redraw();
                }
            }
            Command::Focus { id } => {
                if let Some(blurred) = self.tree.focus(&id) {
                    self.events.push(json!({"type":"blur", "id":blurred}));
                }
                accessibility_changed = true;
            }
            Command::ScrollToItem {
                id,
                index,
                offset,
                smooth,
            } => {
                match self.tree.request_virtual_scroll_to_item(
                    &id,
                    index,
                    offset.unwrap_or(0.0),
                    smooth,
                ) {
                    Ok(events) => self.emit(events),
                    Err(message) => self.events.push(error(message)),
                }
            }
            Command::Selection { request_id } => {
                let focused = self.tree.focused.clone();
                let selection = focused
                    .as_deref()
                    .and_then(|id| self.tree.accessibility_text_selection(id));
                let (anchor, focus) = selection.unwrap_or((0, 0));
                let id = focused.filter(|_| selection.is_some());
                self.events.push(json!({"type":"selection", "requestId":request_id, "target":id, "anchor":anchor, "focus":focus}));
            }
            Command::Layout { ids, request_id } => {
                let size = self
                    .window
                    .as_ref()
                    .map(|window| layout_viewport(window, &mut self.tree))
                    .filter(|size| size.width > 0.0 && size.height > 0.0)
                    .map(|size| (size.width, size.height))
                    // Before the window exists (or while minimized) the requested size stands in.
                    .unwrap_or((
                        self.document.window.width as f32,
                        self.document.window.height as f32,
                    ));
                match self.tree.compute(size.0, size.1) {
                    Ok(()) => {
                        let events = self.tree.take_layout_events();
                        self.emit(events);
                    }
                    Err(message) => self.events.push(error(message)),
                }
                if let Some(window) = &self.window {
                    window.request_redraw();
                }
                let boxes = self.tree.layout_boxes(&ids);
                self.events
                    .push(json!({"type":"layout", "requestId":request_id, "boxes":boxes}));
            }
            Command::Inspect { request_id } => {
                if let Err(e) = self.prepare() {
                    self.handle_render_error(event_loop, e);
                    return;
                }
                if let Some(window) = &self.window {
                    let size = window.inner_size().to_logical::<f64>(window.scale_factor());
                    let frames = match &self.graphics {
                        GraphicsState::Ready(graphics) => graphics.frames(),
                        GraphicsState::Recovering(recovery) => recovery.checkpoint.frames,
                        GraphicsState::Suspended(checkpoint) => checkpoint.frames,
                        GraphicsState::Fatal => 0,
                    };
                    let glyph_rasterizations = match &self.graphics {
                        GraphicsState::Ready(graphics) => graphics.glyph_rasterizations(),
                        _ => None,
                    };
                    let video_layers = match &self.graphics {
                        GraphicsState::Ready(graphics) => graphics.video_layers(),
                        _ => (0, None),
                    };
                    let window_alpha = match &self.graphics {
                        GraphicsState::Ready(graphics) => graphics.shows_alpha(),
                        _ => false,
                    };
                    let fps = self
                        .present_times
                        .iter()
                        .filter(|time| time.elapsed() <= Duration::from_secs(1))
                        .count();
                    self.events.push(json!({"type":"inspect", "requestId":request_id, "snapshot": {
                        "frames": frames, "fps": fps, "layouts":self.tree.layouts, "shapes":self.tree.text.shapes, "paints":self.tree.paints,
                        "hovered":self.tree.hovered, "focused":self.tree.focused, "nodes":self.tree.snapshots(), "width":size.width, "height":size.height, "scale":window.scale_factor(),
                        "layoutNodes":self.tree.layout_node_count(), "layoutNodesCreated":self.tree.layout_nodes_created, "measureCalls":self.tree.measure_calls, "paintedNodes":self.tree.painted_nodes,
                        "activeMotions":self.tree.active_motion_count(), "glyphRasterizations": glyph_rasterizations,
                        "videoLayers": video_layers.0, "videoLayerError": video_layers.1, "windowAlpha": window_alpha,
                        "transparencyEffects": transparency_effects_enabled()
                    }}));
                }
            }
            Command::Resize { width, height } if self.document.window.debug => {
                if width.is_finite()
                    && height.is_finite()
                    && width > 0.0
                    && height > 0.0
                    && width < 32_768.0
                    && height < 32_768.0
                    && let Some(window) = &self.window
                {
                    let _ = window.request_inner_size(LogicalSize::new(width, height));
                }
            }
            Command::Capture { path, request_id } if self.document.window.debug => {
                // A parked window still captures, as it did hidden: a renderer
                // for this one frame, given back afterwards.
                let parked = self.parked;
                if parked {
                    self.parked = false;
                    self.restore_graphics();
                }
                let background = self.root_color("background", &self.document.window.background);
                let result = match self.prepare() {
                    Err(RenderError::RecoverDevice(message)) => {
                        Err(CaptureError::RecoverDevice(message))
                    }
                    Err(RenderError::Fatal(message)) => Err(CaptureError::FatalGpu(message)),
                    Ok(_) => match &mut self.graphics {
                        GraphicsState::Ready(graphics) => graphics.capture(
                            &self.scene,
                            self.glass.as_ref(),
                            color(&background),
                            &path,
                        ),
                        _ => Err(CaptureError::Request("Window renderer is not ready".into())),
                    },
                };
                if parked {
                    self.release_graphics();
                    self.parked = true;
                }
                match result {
                    Ok(()) => self
                        .events
                        .push(json!({"type":"captured", "requestId":request_id, "path":path})),
                    Err(error) => {
                        let message = error.message().to_string();
                        self.events.push(json!({"type":"captured", "requestId":request_id, "path":path, "error":message}));
                        match error {
                            CaptureError::RecoverDevice(message) => {
                                if self.start_graphics_recovery(event_loop, message) {
                                    self.try_graphics_recovery(event_loop);
                                }
                                return;
                            }
                            CaptureError::FatalGpu(message) => {
                                self.fail(event_loop, message);
                                return;
                            }
                            CaptureError::Request(_) => {}
                        }
                    }
                }
                if self.handle_graphics_fault(event_loop) {
                    return;
                }
            }
            Command::MotionAdvance {
                milliseconds,
                request_id,
            } if self.document.window.debug => {
                if !milliseconds.is_finite() || !(0.0..=60_000.0).contains(&milliseconds) {
                    self.events.push(json!({
                        "type":"motionAdvanced",
                        "requestId":request_id,
                        "milliseconds":milliseconds,
                        "activeMotions":self.tree.active_motion_count(),
                        "error":"motionAdvance milliseconds must be finite and between 0 and 60000"
                    }));
                } else {
                    self.motion_test_clock = true;
                    let next = self.tree.motion_time_ms() + milliseconds;
                    self.tree.advance_motion(next);
                    self.emit_motion_events();
                    self.events.push(json!({
                        "type":"motionAdvanced",
                        "requestId":request_id,
                        "milliseconds":milliseconds,
                        "activeMotions":self.tree.active_motion_count()
                    }));
                }
            }
            Command::WebSignIn(request) => self.web_sign_in(request),
            Command::Permissions(request) => self.permissions(request),
            Command::Share(request) => self.share(request),
            Command::Location(request) => self.location(request),
            Command::Authenticate(request) => self.authenticate(request),
            Command::FileDialog(crate::protocol::requests::FileDialog {
                mode,
                options,
                request_id,
            }) => self.file_dialog(request_id, &mode, options),
            Command::Input {
                action,
                x,
                y,
                delta,
                delta_x,
                delta_y,
                text,
            } if self.document.window.debug => {
                let events = match action.as_str() {
                    "move" => self.tree.pointer_move(x.unwrap_or(0.0), y.unwrap_or(0.0)),
                    "down" => self.tree.pointer_down(),
                    "up" => self.tree.pointer_up(),
                    "wheel" => self
                        .tree
                        .wheel_2d(delta_x.unwrap_or(0.0), delta_y.or(delta).unwrap_or(0.0)),
                    "text" => self.tree.type_text(text.as_deref().unwrap_or("")),
                    "key" if text.as_deref() == Some("Escape") => {
                        vec![json!({"type":"escape"})]
                    }
                    "key" => self.tree.key(text.as_deref().unwrap_or("")),
                    _ => vec![],
                };
                self.emit(events);
                accessibility_changed = true;
            }
            #[cfg(any(target_os = "windows", target_os = "linux", target_os = "android"))]
            Command::Accessibility { event } => match event.window_event {
                AccessKitWindowEvent::InitialTreeRequested => {
                    if let Some(accessibility) = self.accessibility.as_mut() {
                        accessibility.set_active(true);
                    }
                    accessibility_changed = true;
                }
                AccessKitWindowEvent::ActionRequested(request) => {
                    if let Some(accessibility) = self.accessibility.as_mut() {
                        accessibility.set_active(true);
                    }
                    let events = self.handle_accessibility_action(request);
                    self.handle_window_actions(event_loop, &events);
                    self.emit(events);
                    accessibility_changed = true;
                }
                AccessKitWindowEvent::AccessibilityDeactivated => {
                    if let Some(accessibility) = self.accessibility.as_mut() {
                        accessibility.set_active(false);
                    }
                }
            },
            _ => self
                .events
                .push(error("Diagnostic command requires debug: true")),
        }
        let interaction_events = self.tree.take_interaction_events();
        self.emit(interaction_events);
        if accessibility_changed {
            self.sync_accessibility();
            self.layout_hidden_window();
        }
        self.sync_cursor();
        self.redraw();
        self.sync_control_flow(event_loop);
    }
    fn suspended(&mut self, event_loop: &ActiveEventLoop) {
        let state = std::mem::replace(&mut self.graphics, GraphicsState::Fatal);
        self.graphics = match state {
            GraphicsState::Ready(graphics) => {
                GraphicsState::Suspended(GraphicsCheckpoint::from_graphics(&graphics))
            }
            GraphicsState::Recovering(recovery) => GraphicsState::Suspended(recovery.checkpoint),
            GraphicsState::Suspended(checkpoint) => GraphicsState::Suspended(checkpoint),
            GraphicsState::Fatal => GraphicsState::Fatal,
        };
        self.presentation_retry_at = None;
        self.sync_control_flow(event_loop);
    }
    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        self.upgrade_graphics();
        // Android reports the system bars and the keyboard as a content rect, not a resize.
        #[cfg(target_os = "android")]
        self.android_about_to_wait();
        let now = Instant::now();
        let present_due = self
            .presentation_retry_at
            .is_some_and(|deadline| deadline <= now);
        let recovery_due = matches!(
            &self.graphics,
            GraphicsState::Recovering(recovery) if recovery.next_attempt <= now
        );
        let motion_due = !self.motion_test_clock
            && !self.parked
            && self.tree.next_clock_tick_ms().is_some_and(|deadline| {
                deadline <= self.motion_epoch.elapsed().as_secs_f64() * 1000.0 + 0.001
            });
        if present_due {
            self.presentation_retry_at = None;
        }
        if self.input_hold.is_some_and(|until| until <= now) {
            self.input_hold = None;
            self.redraw();
        }
        let media_events = self.media.tick(now);
        self.emit(media_events);
        self.sync_file_drag();
        self.sync_menu_selections();
        self.sync_transparency_effects();
        self.tick_videos();
        if motion_due {
            self.advance_live_motion();
        }
        let gpu_redraw = self.poll_gpu_check();
        if (present_due || recovery_due || motion_due || gpu_redraw)
            && let Some(window) = &self.window
        {
            window.request_redraw();
        }
        self.sync_control_flow(event_loop);
    }
    fn window_event(&mut self, event_loop: &ActiveEventLoop, id: WindowId, event: WindowEvent) {
        let _ = id;
        #[cfg(target_os = "android")]
        let Some(event) = self.android_input(event_loop, id, event) else {
            return;
        };
        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "android"))]
        if let (Some(accessibility), Some(window)) = (&mut self.accessibility, &self.window) {
            accessibility.process_event(window.as_ref(), &event);
        }
        // Input timestamps drive undo coalescing and caret blink phase. Only the
        // clock moves here (O(1)); motion tracks keep stepping on their deadlines.
        if matches!(
            event,
            WindowEvent::KeyboardInput { .. }
                | WindowEvent::MouseInput { .. }
                | WindowEvent::Ime(_)
        ) {
            self.sync_input_clock();
        }
        // A release or key a JS handler may answer: hold its frame for that patch.
        let holds_for_js = matches!(
            event,
            WindowEvent::MouseInput {
                state: ElementState::Released,
                ..
            } | WindowEvent::KeyboardInput { .. }
        );
        let mut events = vec![];
        // DOM-style input events go first; the match below may replace `events`.
        let mut dom_events = vec![];
        let mut accessibility_changed = false;
        // Apps that listen to every key (a DOM `keydown`) get both phases first,
        // whatever is focused; Tarve's own key handling still follows.
        if self.document.keyboard_events
            && let WindowEvent::KeyboardInput {
                event: key_event, ..
            } = &event
        {
            dom_events.push(dom_keyboard_event(
                key_event,
                self.modifiers,
                self.tree.focused.as_deref(),
            ));
        }
        if self.document.pointer_events
            && let WindowEvent::MouseInput { state, button, .. } = &event
        {
            let button = match button {
                MouseButton::Left => 0,
                MouseButton::Middle => 1,
                MouseButton::Right => 2,
                MouseButton::Back => 3,
                MouseButton::Forward => 4,
                MouseButton::Other(other) => 5 + i64::from(*other),
            };
            let phase = if *state == ElementState::Pressed {
                "down"
            } else {
                "up"
            };
            dom_events.push(self.dom_pointer_event(phase, json!({ "button": button })));
        }
        match event {
            WindowEvent::CloseRequested => self.request_close(event_loop),
            WindowEvent::Moved(_) => self.sync_window_state(),
            WindowEvent::HoveredFile(path) => {
                if self.file_drag.hovered.is_empty() {
                    self.file_drag.entering = true;
                }
                self.file_drag
                    .hovered
                    .push(path.to_string_lossy().into_owned());
            }
            WindowEvent::DroppedFile(path) => {
                self.file_drag
                    .dropped
                    .push(path.to_string_lossy().into_owned());
            }
            WindowEvent::HoveredFileCancelled => {
                if let Some(over) = self.file_drag.over.take() {
                    self.events
                        .push(json!({"type": "fileDragLeave", "id": over}));
                }
                self.file_drag = FileDrag::default();
            }
            WindowEvent::Resized(size) => {
                if size.width == 0 || size.height == 0 {
                    self.iconify(event_loop);
                } else {
                    self.deiconify();
                }
                if size.width > 0
                    && size.height > 0
                    && let Some(window) = &self.window
                {
                    let logical = size.to_logical::<f64>(window_dpi_scale(window));
                    // While the user moves the window the logical size stays frozen:
                    // resizes on the way are DPI transitions, not user intent.
                    // While the user moves the window the logical size stays frozen:
                    // resizes on the way are DPI transitions, not user intent.
                    with_logical_size(u64::from(window.id()), |state| {
                        if !state.moving.get() || state.size.get().is_none() {
                            state.size.set(Some((logical.width, logical.height)));
                        }
                    });
                }
                if size.width > 0 && size.height > 0 {
                    let resize_error = if let GraphicsState::Ready(graphics) = &mut self.graphics {
                        graphics.resize(size.width, size.height).err()
                    } else {
                        None
                    };
                    if let Some(error) = resize_error {
                        self.handle_render_error(event_loop, error);
                        return;
                    }
                    self.tree.dirty.layout = true;
                    self.tree.dirty.paint = true;
                    self.presentation_retry_at = None;
                }
                self.sync_custom_window_chrome_state();
                self.sync_window_state();
                accessibility_changed = true;
            }
            WindowEvent::ScaleFactorChanged {
                scale_factor,
                mut inner_size_writer,
            } => {
                // Keep the window's logical size on the new monitor; recomputing it
                // from the current physical size would compound a stale resize.
                if let Some((width, height)) = self.window.as_ref().and_then(|window| {
                    with_logical_size(u64::from(window.id()), |state| state.size.get())
                }) {
                    let _ = inner_size_writer.request_inner_size(
                        LogicalSize::new(width, height).to_physical::<u32>(scale_factor),
                    );
                }
                self.tree.dirty.layout = true;
                self.tree.dirty.paint = true;
                accessibility_changed = true;
            }
            WindowEvent::Occluded(false) => self.request_present_now(),
            WindowEvent::Occluded(true) => {
                self.presentation_retry_at = None;
                self.sync_control_flow(event_loop);
            }
            WindowEvent::RedrawRequested => {
                self.memory_dirty.set(true);
                self.redraw_frame(event_loop);
                return;
            }
            WindowEvent::CursorMoved { position, .. } => {
                let scale = self.window.as_ref().unwrap().scale_factor();
                events = self
                    .tree
                    .pointer_move(position.x / scale, position.y / scale);
                accessibility_changed = self.tree.accessibility_selection_dragging()
                    || events.iter().any(|event| {
                        matches!(event["type"].as_str(), Some("valueChange" | "scroll"))
                    });
            }
            WindowEvent::CursorLeft { .. } => events = self.tree.pointer_leave(),
            WindowEvent::MouseInput {
                state,
                button: MouseButton::Left,
                ..
            } => {
                if state == ElementState::Pressed {
                    // After a window move loop (or a DPI change) Windows may skip the move
                    // before the next press: stale hover would miss the TitleBar drag.
                    events = self.sync_pointer_from_os();
                    events.extend(self.tree.pointer_down());
                    self.reopen_ime_on_focused_press();
                    self.titlebar_pressed();
                } else {
                    events = self.tree.pointer_up();
                    self.handle_window_actions(event_loop, &events);
                }
                accessibility_changed = true;
            }
            WindowEvent::MouseInput {
                state: ElementState::Pressed,
                button: MouseButton::Right,
                ..
            } => {
                events = self.tree.pointer_context();
            }
            WindowEvent::MouseWheel { delta, phase, .. } => {
                // A notch: the system's lines per notch of ~33 px (100 px as browsers), eased.
                let notch = matches!(delta, MouseScrollDelta::LineDelta(..));
                let (mut dx, mut dy) = match delta {
                    MouseScrollDelta::LineDelta(x, y) => {
                        let step = wheel_lines_per_notch() * 100.0 / 3.0;
                        (-x as f64 * step, -y as f64 * step)
                    }
                    MouseScrollDelta::PixelDelta(p) => {
                        let scale = self.window.as_ref().unwrap().scale_factor();
                        (-p.x / scale, -p.y / scale)
                    }
                };
                if self.modifiers.shift_key() && dx.abs() <= f64::EPSILON {
                    dx = dy;
                    dy = 0.0;
                }
                if self.document.pointer_events {
                    dom_events.push(
                        self.dom_pointer_event("wheel", json!({ "deltaX": dx, "deltaY": dy })),
                    );
                }
                events = if notch {
                    self.tree.wheel_notch(dx, dy)
                } else {
                    if phase == winit::event::TouchPhase::Started {
                        self.tree.begin_wheel_gesture();
                    }
                    let ended = phase == winit::event::TouchPhase::Ended;
                    self.tree.wheel_pixels(dx, dy, ended)
                };
                accessibility_changed = !events.is_empty();
            }
            WindowEvent::ModifiersChanged(modifiers) => self.modifiers = modifiers.state(),
            WindowEvent::KeyboardInput { event, .. } if event.state == ElementState::Pressed => {
                events = self.clipboard_shortcut(&event.logical_key);
                let editing = ime_allowed_for_node(
                    self.tree
                        .focused
                        .as_ref()
                        .and_then(|id| self.tree.entries.get(id))
                        .map(|entry| &entry.node),
                );
                let typing = editing && text_field_consumes(&event.logical_key, self.modifiers);
                if !event.repeat
                    && !typing
                    && !(editing && editing_shortcut(&event.logical_key, self.modifiers))
                    && let Some(shortcut) = shortcut_name(&event.logical_key, self.modifiers)
                {
                    events.push(json!({"type":"shortcut", "shortcut":shortcut}));
                }
                let key = match &event.logical_key {
                    Key::Named(NamedKey::Tab) => Some(if self.modifiers.shift_key() {
                        "ShiftTab"
                    } else {
                        "Tab"
                    }),
                    Key::Named(NamedKey::Enter) => Some(
                        if self.modifiers.control_key() || self.modifiers.super_key() {
                            "ModEnter"
                        } else if self.modifiers.shift_key() {
                            "ShiftEnter"
                        } else {
                            "Enter"
                        },
                    ),
                    Key::Named(NamedKey::Space) => Some("Space"),
                    Key::Named(NamedKey::Backspace) => Some(if word_modifier(self.modifiers) {
                        "WordBackspace"
                    } else {
                        "Backspace"
                    }),
                    Key::Named(NamedKey::Delete) => Some(if word_modifier(self.modifiers) {
                        "WordDelete"
                    } else {
                        "Delete"
                    }),
                    Key::Named(NamedKey::ArrowLeft) => Some(
                        match (word_modifier(self.modifiers), self.modifiers.shift_key()) {
                            (true, true) => "ShiftWordLeft",
                            (true, false) => "WordLeft",
                            (false, true) => "ShiftArrowLeft",
                            (false, false) => "ArrowLeft",
                        },
                    ),
                    Key::Named(NamedKey::ArrowRight) => Some(
                        match (word_modifier(self.modifiers), self.modifiers.shift_key()) {
                            (true, true) => "ShiftWordRight",
                            (true, false) => "WordRight",
                            (false, true) => "ShiftArrowRight",
                            (false, false) => "ArrowRight",
                        },
                    ),
                    Key::Named(NamedKey::ArrowUp) => Some(if self.modifiers.shift_key() {
                        "ShiftArrowUp"
                    } else {
                        "ArrowUp"
                    }),
                    Key::Named(NamedKey::ArrowDown) => Some(if self.modifiers.shift_key() {
                        "ShiftArrowDown"
                    } else {
                        "ArrowDown"
                    }),
                    Key::Named(NamedKey::Home) => Some(if self.modifiers.shift_key() {
                        "ShiftHome"
                    } else {
                        "Home"
                    }),
                    Key::Named(NamedKey::End) => Some(if self.modifiers.shift_key() {
                        "ShiftEnd"
                    } else {
                        "End"
                    }),
                    Key::Named(NamedKey::Escape) => {
                        let handled = self.tree.key("Escape");
                        if handled.is_empty() {
                            events.push(json!({"type":"escape"}));
                        } else {
                            events.extend(handled);
                        }
                        None
                    }
                    Key::Character(value)
                        if self.modifiers.control_key() && value.eq_ignore_ascii_case("a") =>
                    {
                        Some("SelectAll")
                    }
                    Key::Character(value)
                        if self.modifiers.control_key() && value.eq_ignore_ascii_case("z") =>
                    {
                        Some(if self.modifiers.shift_key() {
                            "Redo"
                        } else {
                            "Undo"
                        })
                    }
                    Key::Character(value)
                        if self.modifiers.control_key() && value.eq_ignore_ascii_case("y") =>
                    {
                        Some("Redo")
                    }
                    _ => None,
                };
                if let Some(key) = key {
                    events.extend(self.tree.key(key));
                }
                if !self.modifiers.control_key()
                    && !self.modifiers.super_key()
                    && !self.tree.ime_active()
                    && (key.is_none() || key == Some("Space"))
                    && let Some(text) = event.text
                {
                    events.extend(self.tree.type_text(&text));
                }
                accessibility_changed = true;
            }
            WindowEvent::Ime(Ime::Enabled) => {
                self.ime_enabled = self.ime_target.is_some();
                if let Some(target) = self.ime_target.clone() {
                    self.tree.ime_enabled(&target);
                }
            }
            WindowEvent::Ime(Ime::Disabled) => {
                self.ime_enabled = false;
                self.tree.ime_cancel();
            }
            WindowEvent::Ime(Ime::Preedit(text, cursor)) => {
                if self.ime_enabled
                    && let Some(target) = self.ime_target.clone()
                {
                    self.tree.ime_preedit(&target, &text, cursor);
                }
            }
            WindowEvent::Ime(Ime::Commit(text)) => {
                if self.ime_enabled
                    && let Some(target) = self.ime_target.clone()
                {
                    events = self.tree.ime_commit(&target, &text);
                    accessibility_changed = true;
                }
            }
            WindowEvent::Focused(false) => {
                self.ime_enabled = false;
                self.ime_target = None;
                events.extend(self.tree.cancel_pointer_drag());
                if let Some(blurred) = self.tree.blur() {
                    events.push(json!({"type":"blur", "id":blurred}));
                }
                accessibility_changed = true;
            }
            _ => {}
        }
        events.extend(self.tree.take_interaction_events());
        if !dom_events.is_empty() {
            dom_events.append(&mut events);
            events = dom_events;
        }
        if holds_for_js && !events.is_empty() && !self.parked {
            self.input_hold = Some(Instant::now() + INPUT_HOLD);
        }
        self.emit(events);
        if accessibility_changed {
            self.sync_accessibility();
            self.layout_hidden_window();
        }
        self.sync_cursor();
        self.redraw();
    }
}

#[cfg(all(test, target_os = "linux"))]
mod linux_backend_tests;
mod window_chrome;
#[allow(unused_imports)]
pub(crate) use window_chrome::*;
