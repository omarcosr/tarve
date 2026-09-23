use crate::{
    bridge::Events,
    protocol::{
        Command, Document, FileDialogOptions, Node, WindowPosition, WindowPositionPreset, error,
    },
    renderer::{
        CaptureError, Graphics, GraphicsFaultKind, PresentResult, RenderError, RendererBackend,
    },
    tree::{AccessibilityScrollAlignment, Tree, color},
};

#[cfg(target_os = "windows")]
use crate::accessibility::AccessibilityBridge;
#[cfg(target_os = "windows")]
use accesskit::{Action, ActionData, ActionRequest, ScrollHint, ScrollUnit};
#[cfg(target_os = "windows")]
use accesskit_winit::WindowEvent as AccessKitWindowEvent;

#[cfg(target_os = "windows")]
fn accessibility_scroll_alignment(
    data: Option<&ActionData>,
) -> Option<AccessibilityScrollAlignment> {
    match data {
        Some(ActionData::ScrollHint(ScrollHint::TopLeft | ScrollHint::TopEdge)) => {
            Some(AccessibilityScrollAlignment::Top)
        }
        Some(ActionData::ScrollHint(ScrollHint::BottomRight | ScrollHint::BottomEdge)) => {
            Some(AccessibilityScrollAlignment::Bottom)
        }
        _ => None,
    }
}

#[cfg(target_os = "windows")]
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

#[cfg(not(target_os = "windows"))]
fn run_file_dialog(
    _window: Option<&Arc<Window>>,
    _mode: &str,
    _options: FileDialogOptions,
) -> Result<Vec<String>, String> {
    Err("Native file dialogs are currently supported on Windows only".into())
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
    window::{CursorIcon, ResizeDirection, Window, WindowId},
};

pub(crate) fn cursor_for_node(node: Option<&Node>) -> CursorIcon {
    match node {
        Some(node) if node.kind == "splitter" => {
            if node
                .control
                .as_ref()
                .is_some_and(|control| control.orientation == "vertical")
            {
                CursorIcon::RowResize
            } else {
                CursorIcon::ColResize
            }
        }
        Some(node) if matches!(node.kind.as_str(), "button" | "pressable" | "slider") => {
            CursorIcon::Pointer
        }
        Some(node) if matches!(node.kind.as_str(), "input" | "textarea") => CursorIcon::Text,
        _ => CursorIcon::Default,
    }
}

pub(crate) fn ime_allowed_for_node(node: Option<&Node>) -> bool {
    node.is_some_and(|node| matches!(node.kind.as_str(), "input" | "textarea"))
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

#[cfg(target_os = "windows")]
fn configure_custom_window_chrome(
    window: &Window,
    border: &str,
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
    let hex = border.trim_start_matches('#');
    let rgb = u32::from_str_radix(hex.get(..6).unwrap_or("e4e4e7"), 16).unwrap_or(0x00e4e4e7);
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

#[cfg(not(target_os = "windows"))]
fn configure_custom_window_chrome(_: &Window, _: &str, _: bool) -> Result<(), String> {
    Ok(())
}

pub fn run(
    document: Document,
    events: Arc<Events>,
    ready: SyncSender<EventLoopProxy<Command>>,
) -> Result<(), String> {
    let mut builder = EventLoop::<Command>::with_user_event();
    #[cfg(target_os = "windows")]
    {
        use winit::platform::windows::EventLoopBuilderExtWindows;
        builder.with_any_thread(true);
    }
    #[cfg(target_os = "linux")]
    {
        use winit::platform::x11::EventLoopBuilderExtX11;
        builder.with_any_thread(true);
    }
    let event_loop = builder.build().map_err(|e| e.to_string())?;
    event_loop.set_control_flow(ControlFlow::Wait);
    let event_proxy = event_loop.create_proxy();
    ready.send(event_proxy.clone()).map_err(|e| e.to_string())?;
    let tree = Tree::new(document.root.clone());
    let mut app = App {
        document,
        events,
        tree,
        graphics: GraphicsState::Suspended(GraphicsCheckpoint::default()),
        window: None,
        modifiers: ModifiersState::empty(),
        scene: vello::Scene::new(),
        fatal: None,
        ready_emitted: false,
        presentation_retry_at: None,
        graphics_recovery_episodes: 0,
        graphics_stable_since: None,
        ime_target: None,
        ime_enabled: false,
        last_titlebar_click: None,
        close_request_pending: false,
        event_proxy,
        #[cfg(target_os = "windows")]
        accessibility: None,
    };
    event_loop.run_app(&mut app).map_err(|e| e.to_string())?;
    if let Some(error) = app.fatal {
        return Err(error);
    }
    Ok(())
}

struct App {
    document: Document,
    events: Arc<Events>,
    tree: Tree,
    graphics: GraphicsState,
    window: Option<Arc<Window>>,
    modifiers: ModifiersState,
    scene: vello::Scene,
    fatal: Option<String>,
    ready_emitted: bool,
    presentation_retry_at: Option<Instant>,
    graphics_recovery_episodes: usize,
    graphics_stable_since: Option<Instant>,
    ime_target: Option<String>,
    ime_enabled: bool,
    last_titlebar_click: Option<(Instant, (f64, f64))>,
    close_request_pending: bool,
    event_proxy: EventLoopProxy<Command>,
    #[cfg(target_os = "windows")]
    accessibility: Option<AccessibilityBridge>,
}

const MAX_GRAPHICS_RECOVERY_ATTEMPTS: u8 = 3;
const MAX_GRAPHICS_RECOVERY_EPISODES: usize = 3;
const GRAPHICS_RECOVERY_WINDOW: Duration = Duration::from_secs(30);
const PRESENT_RETRY_DELAY: Duration = Duration::from_millis(16);

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

pub(crate) fn graphics_fault_action(kind: GraphicsFaultKind) -> GraphicsFaultAction {
    match kind {
        GraphicsFaultKind::DeviceLost | GraphicsFaultKind::Internal => {
            GraphicsFaultAction::RecoverDevice
        }
        GraphicsFaultKind::OutOfMemory | GraphicsFaultKind::Validation => {
            GraphicsFaultAction::Fatal
        }
    }
}

pub(crate) fn graphics_recovery_delay(attempt: u8) -> Duration {
    match attempt {
        0 | 1 => Duration::from_millis(100),
        2 => Duration::from_millis(250),
        _ => Duration::from_millis(500),
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum GraphicsRecoveryFailureAction {
    RetryAfter(Duration),
    Fatal,
}

pub(crate) fn graphics_recovery_failure_action(attempts: u8) -> GraphicsRecoveryFailureAction {
    if attempts >= MAX_GRAPHICS_RECOVERY_ATTEMPTS {
        GraphicsRecoveryFailureAction::Fatal
    } else {
        GraphicsRecoveryFailureAction::RetryAfter(graphics_recovery_delay(attempts))
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum GraphicsRecoveryCircuitAction {
    Allow,
    Fatal,
}

pub(crate) fn graphics_recovery_circuit_action(
    recoveries_in_window: usize,
) -> GraphicsRecoveryCircuitAction {
    if recoveries_in_window >= MAX_GRAPHICS_RECOVERY_EPISODES {
        GraphicsRecoveryCircuitAction::Fatal
    } else {
        GraphicsRecoveryCircuitAction::Allow
    }
}

pub(crate) fn graphics_recoveries_after_stability(
    recovery_episodes: usize,
    stable_for: Duration,
) -> usize {
    if stable_for >= GRAPHICS_RECOVERY_WINDOW {
        0
    } else {
        recovery_episodes
    }
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
    #[cfg(target_os = "windows")]
    fn initialize_accessibility(&mut self, event_loop: &ActiveEventLoop, window: &Window) {
        self.accessibility = Some(AccessibilityBridge::new(
            event_loop,
            window,
            self.event_proxy.clone(),
        ));
    }

    #[cfg(not(target_os = "windows"))]
    fn initialize_accessibility(&mut self, _: &ActiveEventLoop, _: &Window) {}

    #[cfg(target_os = "windows")]
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
        let size = window.inner_size().to_logical::<f32>(scale);
        if let Err(message) = self.tree.compute(size.width, size.height) {
            self.events.push(error(format!(
                "Accessibility layout update failed: {message}"
            )));
            return;
        }
        for message in self.tree.warnings.drain(..) {
            self.events.push(error(message));
        }
        if let Some(accessibility) = self.accessibility.as_mut() {
            accessibility.sync(&mut self.tree, &self.document.window.title, scale);
        }
    }

    #[cfg(not(target_os = "windows"))]
    fn sync_accessibility(&mut self) {}

    #[cfg(target_os = "windows")]
    fn handle_accessibility_action(&mut self, request: ActionRequest) -> Vec<serde_json::Value> {
        let text_run_start = self
            .accessibility
            .as_ref()
            .and_then(|accessibility| accessibility.text_run_start(request.target_node));
        let Some(native_id) = self
            .accessibility
            .as_ref()
            .and_then(|accessibility| accessibility.resolve(request.target_node))
            .map(str::to_string)
        else {
            return vec![];
        };
        if !self.tree.entries.contains_key(&native_id) {
            return vec![];
        }
        match request.action {
            Action::Focus => self.tree.accessibility_focus(&native_id),
            Action::Blur => self.tree.accessibility_blur(&native_id),
            Action::Click | Action::Expand | Action::Collapse => {
                self.tree.accessibility_click(&native_id)
            }
            Action::ShowContextMenu => self.tree.accessibility_context(&native_id),
            Action::Increment => self.tree.accessibility_adjust_numeric(&native_id, 1.0),
            Action::Decrement => self.tree.accessibility_adjust_numeric(&native_id, -1.0),
            Action::SetValue => match request.data {
                Some(ActionData::Value(value)) => {
                    self.tree.accessibility_set_text_value(&native_id, &value)
                }
                Some(ActionData::NumericValue(value)) => {
                    self.tree.accessibility_set_numeric_value(&native_id, value)
                }
                _ => vec![],
            },
            Action::ReplaceSelectedText => match request.data {
                Some(ActionData::Value(value)) => self
                    .tree
                    .accessibility_replace_selected_text(&native_id, &value),
                _ => vec![],
            },
            Action::SetTextSelection => match request.data {
                Some(ActionData::SetTextSelection(selection)) => {
                    let positions = self.accessibility.as_ref().and_then(|accessibility| {
                        let anchor = accessibility.resolve_text_position(selection.anchor)?;
                        let focus = accessibility.resolve_text_position(selection.focus)?;
                        (anchor.0 == native_id && focus.0 == native_id)
                            .then_some((anchor.1, focus.1))
                    });
                    positions.map_or_else(Vec::new, |(anchor, focus)| {
                        self.tree
                            .accessibility_set_text_selection(&native_id, anchor, focus)
                    })
                }
                _ => vec![],
            },
            Action::ScrollUp | Action::ScrollDown | Action::ScrollLeft | Action::ScrollRight => {
                let page = matches!(request.data, Some(ActionData::ScrollUnit(ScrollUnit::Page)));
                let (direction_x, direction_y) = match request.action {
                    Action::ScrollUp => (0.0, -1.0),
                    Action::ScrollDown => (0.0, 1.0),
                    Action::ScrollLeft => (-1.0, 0.0),
                    Action::ScrollRight => (1.0, 0.0),
                    _ => (0.0, 0.0),
                };
                self.tree
                    .accessibility_scroll_by(&native_id, direction_x, direction_y, page)
            }
            Action::SetScrollOffset => match request.data {
                Some(ActionData::SetScrollOffset(point)) => self
                    .tree
                    .accessibility_set_scroll(&native_id, point.x, point.y),
                _ => vec![],
            },
            Action::ScrollIntoView => {
                if let Some(character) = text_run_start {
                    let alignment = accessibility_scroll_alignment(request.data.as_ref());
                    self.tree.accessibility_scroll_text_position_into_view(
                        &native_id, character, alignment,
                    )
                } else {
                    self.tree.accessibility_scroll_into_view(&native_id)
                }
            }
            _ => vec![],
        }
    }

    fn request_close(&mut self, event_loop: &ActiveEventLoop) {
        let intercept = self
            .tree
            .entries
            .get(&self.tree.root)
            .is_some_and(|entry| entry.node.close_intercept);
        match close_request_action(intercept, &mut self.close_request_pending) {
            CloseRequestAction::Exit => event_loop.exit(),
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
        self.window
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
            &self.root_color("borderColor", "#e4e4e7"),
            self.window_chrome_suppressed(),
        ) {
            self.events
                .push(error(format!("Custom window chrome: {chrome_error}")));
        }
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
        match self.document.window.position.as_ref() {
            Some(WindowPosition::Coordinates { x, y }) => {
                window.set_outer_position(LogicalPosition::new(*x, *y));
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
    fn clipboard_shortcut(&mut self, key: &Key) -> Vec<serde_json::Value> {
        if !self.modifiers.control_key() {
            return vec![];
        }
        let Key::Character(key) = key else {
            return vec![];
        };
        let key = key.to_ascii_lowercase();
        if !matches!(key.as_str(), "c" | "v" | "x") {
            return vec![];
        }
        let Ok(mut clipboard) = arboard::Clipboard::new() else {
            return vec![];
        };
        if key == "v" {
            return clipboard
                .get_text()
                .map(|text| self.tree.type_text(&text))
                .unwrap_or_default();
        }
        let Some(text) = self.tree.selected_text() else {
            return vec![];
        };
        if clipboard.set_text(text).is_ok() && key == "x" {
            return self.tree.key("Backspace");
        }
        vec![]
    }
    fn emit(&self, events: Vec<serde_json::Value>) {
        for event in events {
            self.events.push(event);
        }
    }
    fn redraw(&self) {
        if (self.tree.dirty.paint || self.tree.dirty.layout || self.tree.dirty.text)
            && let Some(window) = &self.window
        {
            window.request_redraw();
        }
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
    fn sync_control_flow(&self, event_loop: &ActiveEventLoop) {
        let now = Instant::now();
        let recovery_at = match &self.graphics {
            GraphicsState::Recovering(recovery) if recovery.next_attempt > now => {
                Some(recovery.next_attempt)
            }
            _ => None,
        };
        let present_at = self
            .presentation_retry_at
            .filter(|deadline| *deadline > now);
        match (recovery_at, present_at) {
            (Some(a), Some(b)) => event_loop.set_control_flow(ControlFlow::WaitUntil(a.min(b))),
            (Some(deadline), None) | (None, Some(deadline)) => {
                event_loop.set_control_flow(ControlFlow::WaitUntil(deadline));
            }
            (None, None) => event_loop.set_control_flow(ControlFlow::Wait),
        }
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
            Graphics::recover(window, previous_backend)
        } else {
            Graphics::new(window, self.document.renderer)
        };
        match result {
            Ok(mut graphics) => {
                let generation = recovery.checkpoint.generation.saturating_add(1).max(1);
                graphics.restore_counters(recovery.checkpoint.frames, generation);
                self.graphics = GraphicsState::Ready(Box::new(graphics));
                self.tree.dirty.paint = true;
                self.presentation_retry_at = None;
                event_loop.set_control_flow(ControlFlow::Wait);
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
    fn present(&mut self, content_changed: bool) -> Result<PresentResult, RenderError> {
        let background = self.root_color("background", &self.document.window.background);
        let result = match &mut self.graphics {
            GraphicsState::Ready(graphics) => {
                graphics.render(&self.scene, color(&background), content_changed)
            }
            _ => Err(RenderError::Fatal("Renderer not ready".into())),
        }?;
        if result == PresentResult::Presented && self.document.window.debug {
            let frames = match &self.graphics {
                GraphicsState::Ready(graphics) => graphics.frames(),
                _ => 0,
            };
            self.events.push(json!({"type":"frame", "frames":frames}));
        }
        Ok(result)
    }
    fn prepare(&mut self) -> Result<bool, String> {
        let Some(window) = &self.window else {
            return Ok(false);
        };
        let scale = window.scale_factor();
        let physical = window.inner_size();
        let size = window.inner_size().to_logical::<f32>(scale);
        self.tree.compute(size.width, size.height)?;
        let content_changed = self.tree.dirty.paint;
        if content_changed {
            let tree = &mut self.tree;
            let cpu_prepared = match &mut self.graphics {
                GraphicsState::Ready(graphics) => {
                    graphics.prepare_cpu_frame(physical.width, physical.height, |target| {
                        tree.paint(scale, target)
                    })?
                }
                _ => false,
            };
            if !cpu_prepared {
                self.scene = self.tree.scene(scale);
            }
        }
        for message in self.tree.warnings.drain(..) {
            self.events.push(error(message));
        }
        Ok(content_changed)
    }
    fn fail(&mut self, event_loop: &ActiveEventLoop, message: String) {
        self.fatal = Some(message);
        self.graphics = GraphicsState::Fatal;
        event_loop.exit();
    }
    fn redraw_frame(&mut self, event_loop: &ActiveEventLoop) {
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
        let content_changed = match self.prepare() {
            Ok(content_changed) => content_changed,
            Err(error) => {
                self.fail(event_loop, error);
                return;
            }
        };
        match self.present(content_changed) {
            Ok(PresentResult::Presented) => {
                self.presentation_retry_at = None;
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
            Err(RenderError::RecoverDevice(message)) => {
                if self.start_graphics_recovery(event_loop, message) {
                    self.try_graphics_recovery(event_loop);
                }
            }
            Err(RenderError::Fatal(message)) => self.fail(event_loop, message),
        }
    }
    fn sync_cursor(&mut self) {
        if let Some(window) = self.window.clone() {
            if let Some(direction) = self.resize_direction() {
                window.set_cursor(CursorIcon::from(direction));
            } else {
                let hovered = self
                    .tree
                    .hovered
                    .as_ref()
                    .map(|id| &self.tree.entries[id].node);
                window.set_cursor(cursor_for_node(hovered));
            }
            let target = self
                .tree
                .focused
                .as_ref()
                .filter(|id| ime_allowed_for_node(Some(&self.tree.entries[*id].node)))
                .cloned();
            if target != self.ime_target {
                self.tree.ime_cancel();
                window.set_ime_allowed(false);
                self.ime_enabled = false;
                self.ime_target = target.clone();
            }
            window.set_ime_allowed(target.is_some());
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
    fn titlebar_pressed(&mut self) {
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
            window.set_maximized(!window.is_maximized());
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
                Some("close") => self.request_close(event_loop),
                _ => {}
            }
        }
    }
}

#[cfg(all(test, target_os = "windows"))]
mod accessibility_tests {
    use super::*;

    #[test]
    fn preserves_vertical_accesskit_scroll_hints_for_text_ranges() {
        assert_eq!(
            accessibility_scroll_alignment(Some(&ActionData::ScrollHint(ScrollHint::TopEdge))),
            Some(AccessibilityScrollAlignment::Top)
        );
        assert_eq!(
            accessibility_scroll_alignment(Some(&ActionData::ScrollHint(ScrollHint::BottomEdge))),
            Some(AccessibilityScrollAlignment::Bottom)
        );
        assert_eq!(
            accessibility_scroll_alignment(Some(&ActionData::ScrollHint(ScrollHint::LeftEdge))),
            None
        );
    }
}
impl ApplicationHandler<Command> for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if let Some(window) = self.window.clone() {
            let state = std::mem::replace(&mut self.graphics, GraphicsState::Fatal);
            match state {
                GraphicsState::Suspended(checkpoint) => {
                    match Graphics::new(window, self.document.renderer) {
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
        let attributes = Window::default_attributes()
            .with_title(&options.title)
            .with_inner_size(LogicalSize::new(options.width, options.height))
            .with_min_inner_size(LogicalSize::new(options.min_width, options.min_height))
            .with_resizable(options.resizable)
            .with_decorations(options.decorations)
            .with_visible(false);
        match event_loop.create_window(attributes) {
            Ok(window) => {
                let window = Arc::new(window);
                match Graphics::new(window.clone(), self.document.renderer) {
                    Ok(graphics) => {
                        self.graphics = GraphicsState::Ready(Box::new(graphics));
                        self.window = Some(window.clone());
                        self.apply_initial_window_position(event_loop, &window, false);
                        self.sync_custom_window_chrome();
                        if let Err(error) = self.prepare() {
                            self.fail(event_loop, error);
                            return;
                        }
                        self.initialize_accessibility(event_loop, window.as_ref());
                        // Keep the HWND hidden while WGPU, layout, text and the first scene are
                        // prepared. Making it visible immediately before the synchronous present
                        // prevents Windows from compositing an empty client area on startup.
                        window.set_visible(true);
                        // Once visible, native decorations have their final outer dimensions.
                        // Re-apply the anchor to make native-chrome windows exact as well.
                        self.apply_initial_window_position(event_loop, &window, true);
                        self.redraw_frame(event_loop);
                    }
                    Err(error) => self.fail(event_loop, error),
                }
            }
            Err(error) => self.fail(event_loop, error.to_string()),
        }
    }
    fn user_event(&mut self, event_loop: &ActiveEventLoop, command: Command) {
        let mut accessibility_changed = false;
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
            }
            Command::Update { root } => {
                self.tree.update(*root);
                self.sync_custom_window_chrome();
                accessibility_changed = true;
            }
            Command::Close => event_loop.exit(),
            Command::CancelCloseRequest => self.close_request_pending = false,
            Command::Focus { id } => {
                if let Some(blurred) = self.tree.focus(&id) {
                    self.events.push(json!({"type":"blur", "id":blurred}));
                }
                accessibility_changed = true;
            }
            Command::Inspect { request_id } => {
                if let Err(e) = self.prepare() {
                    self.fail(event_loop, e);
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
                    self.events.push(json!({"type":"inspect", "requestId":request_id, "snapshot": {
                        "frames": frames, "layouts":self.tree.layouts, "shapes":self.tree.text.shapes, "paints":self.tree.paints,
                        "hovered":self.tree.hovered, "focused":self.tree.focused, "nodes":self.tree.snapshots(), "width":size.width, "height":size.height, "scale":window.scale_factor(),
                        "layoutNodes":self.tree.layout_node_count(), "layoutNodesCreated":self.tree.layout_nodes_created, "measureCalls":self.tree.measure_calls, "paintedNodes":self.tree.painted_nodes
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
                let background = self.root_color("background", &self.document.window.background);
                let result = match self.prepare() {
                    Err(error) => Err(CaptureError::Request(error)),
                    Ok(_) => match &mut self.graphics {
                        GraphicsState::Ready(graphics) => {
                            graphics.capture(&self.scene, color(&background), &path)
                        }
                        _ => Err(CaptureError::Request("Window renderer is not ready".into())),
                    },
                };
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
            Command::FileDialog { mode, options, request_id } => {
                match run_file_dialog(self.window.as_ref(), &mode, options) {
                    Ok(paths) => self.events.push(json!({"type":"fileDialog", "requestId":request_id, "paths":paths})),
                    Err(message) => self.events.push(json!({"type":"fileDialog", "requestId":request_id, "paths":[], "error":message})),
                }
            }
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
                    "wheel" => self.tree.wheel_2d(
                        delta_x.unwrap_or(0.0),
                        delta_y.or(delta).unwrap_or(0.0),
                    ),
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
            #[cfg(target_os = "windows")]
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
            }
            _ => self
                .events
                .push(error("Diagnostic command requires debug: true")),
        }
        if accessibility_changed {
            self.sync_accessibility();
        }
        self.sync_cursor();
        self.redraw();
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
        let now = Instant::now();
        let present_due = self
            .presentation_retry_at
            .is_some_and(|deadline| deadline <= now);
        let recovery_due = matches!(
            &self.graphics,
            GraphicsState::Recovering(recovery) if recovery.next_attempt <= now
        );
        if present_due {
            self.presentation_retry_at = None;
        }
        if (present_due || recovery_due)
            && let Some(window) = &self.window
        {
            window.request_redraw();
        }
        self.sync_control_flow(event_loop);
    }
    fn window_event(&mut self, event_loop: &ActiveEventLoop, _: WindowId, event: WindowEvent) {
        #[cfg(target_os = "windows")]
        if let (Some(accessibility), Some(window)) = (&mut self.accessibility, &self.window) {
            accessibility.process_event(window.as_ref(), &event);
        }
        let mut events = vec![];
        let mut accessibility_changed = false;
        match event {
            WindowEvent::CloseRequested => self.request_close(event_loop),
            WindowEvent::Resized(size) => {
                if size.width > 0 && size.height > 0 {
                    if let GraphicsState::Ready(graphics) = &mut self.graphics {
                        graphics.resize(size.width, size.height);
                    }
                    self.tree.dirty.layout = true;
                    self.tree.dirty.paint = true;
                    self.presentation_retry_at = None;
                }
                self.sync_custom_window_chrome_state();
                accessibility_changed = true;
            }
            WindowEvent::ScaleFactorChanged { .. } => {
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
                    events = self.tree.pointer_down();
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
            WindowEvent::MouseWheel { delta, .. } => {
                let (mut dx, mut dy) = match delta {
                    MouseScrollDelta::LineDelta(x, y) => (-x as f64 * 36.0, -y as f64 * 36.0),
                    MouseScrollDelta::PixelDelta(p) => {
                        let scale = self.window.as_ref().unwrap().scale_factor();
                        (-p.x / scale, -p.y / scale)
                    }
                };
                if self.modifiers.shift_key() && dx.abs() <= f64::EPSILON {
                    dx = dy;
                    dy = 0.0;
                }
                events = self.tree.wheel_2d(dx, dy);
                accessibility_changed = !events.is_empty();
            }
            WindowEvent::ModifiersChanged(modifiers) => self.modifiers = modifiers.state(),
            WindowEvent::KeyboardInput { event, .. } if event.state == ElementState::Pressed => {
                events = self.clipboard_shortcut(&event.logical_key);
                if !event.repeat
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
                    Key::Named(NamedKey::Enter) => Some("Enter"),
                    Key::Named(NamedKey::Space) => Some("Space"),
                    Key::Named(NamedKey::Backspace) => Some("Backspace"),
                    Key::Named(NamedKey::Delete) => Some("Delete"),
                    Key::Named(NamedKey::ArrowLeft) => Some(if self.modifiers.shift_key() {
                        "ShiftArrowLeft"
                    } else {
                        "ArrowLeft"
                    }),
                    Key::Named(NamedKey::ArrowRight) => Some(if self.modifiers.shift_key() {
                        "ShiftArrowRight"
                    } else {
                        "ArrowRight"
                    }),
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
                if let Some(blurred) = self.tree.blur() {
                    events.push(json!({"type":"blur", "id":blurred}));
                }
                accessibility_changed = true;
            }
            _ => {}
        }
        self.emit(events);
        if accessibility_changed {
            self.sync_accessibility();
        }
        self.sync_cursor();
        self.redraw();
    }
}
