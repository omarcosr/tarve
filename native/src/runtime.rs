use crate::{
    bridge::Events,
    protocol::{Command, Document, error},
    renderer::Graphics,
    tree::{Tree, color},
};
use serde_json::json;
use std::{
    sync::{Arc, mpsc::SyncSender},
    time::{Duration, Instant},
};
use winit::{
    application::ApplicationHandler,
    dpi::{LogicalPosition, LogicalSize},
    event::{ElementState, Ime, MouseButton, MouseScrollDelta, WindowEvent},
    event_loop::{ActiveEventLoop, ControlFlow, EventLoop, EventLoopProxy},
    keyboard::{Key, ModifiersState, NamedKey},
    window::{CursorIcon, ResizeDirection, Window, WindowId},
};

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
    ready
        .send(event_loop.create_proxy())
        .map_err(|e| e.to_string())?;
    let tree = Tree::new(document.root.clone());
    let mut app = App {
        document,
        events,
        tree,
        graphics: None,
        window: None,
        modifiers: ModifiersState::empty(),
        scene: vello::Scene::new(),
        fatal: None,
        ime_preedit: false,
        last_titlebar_click: None,
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
    graphics: Option<Graphics>,
    window: Option<Arc<Window>>,
    modifiers: ModifiersState,
    scene: vello::Scene,
    fatal: Option<String>,
    ime_preedit: bool,
    last_titlebar_click: Option<(Instant, (f64, f64))>,
}
impl App {
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
    fn present(&mut self) -> Result<(), String> {
        let background = self.root_color("background", &self.document.window.background);
        self.graphics
            .as_mut()
            .ok_or("Renderer not ready".to_string())?
            .render(&self.scene, color(&background))?;
        if self.document.window.debug {
            self.events
                .push(json!({"type":"frame", "frames":self.graphics.as_ref().unwrap().frames}));
        }
        Ok(())
    }
    fn prepare(&mut self) -> Result<(), String> {
        let Some(window) = &self.window else {
            return Ok(());
        };
        let scale = window.scale_factor();
        let size = window.inner_size().to_logical::<f32>(scale);
        self.tree.compute(size.width, size.height)?;
        if self.tree.dirty.paint {
            self.scene = self.tree.scene(scale);
        }
        for message in self.tree.warnings.drain(..) {
            self.events.push(error(message));
        }
        Ok(())
    }
    fn fail(&mut self, event_loop: &ActiveEventLoop, message: String) {
        self.fatal = Some(message);
        event_loop.exit();
    }
    fn sync_cursor(&self) {
        if let Some(window) = &self.window {
            if let Some(direction) = self.resize_direction() {
                window.set_cursor(CursorIcon::from(direction));
                return;
            }
            let kind = self
                .tree
                .hovered
                .as_ref()
                .map(|id| self.tree.entries[id].node.kind.as_str());
            window.set_cursor(match kind {
                Some("button" | "pressable" | "slider") => CursorIcon::Pointer,
                Some("input") => CursorIcon::Text,
                _ => CursorIcon::Default,
            });
            let editing = self
                .tree
                .focused
                .as_ref()
                .is_some_and(|id| self.tree.entries[id].node.kind == "input");
            window.set_ime_allowed(editing);
            if let Some(id) = self.tree.focused.as_ref().filter(|_| editing) {
                let rect = self.tree.entries[id].rect;
                window.set_ime_cursor_area(
                    LogicalPosition::new(rect.x0 + 12.0, rect.y1),
                    LogicalSize::new(2.0, 20.0),
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
    fn handle_window_actions(&self, event_loop: &ActiveEventLoop, events: &[serde_json::Value]) {
        let Some(window) = &self.window else {
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
                Some("close") => event_loop.exit(),
                _ => {}
            }
        }
    }
}
impl ApplicationHandler<Command> for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
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
                match Graphics::new(window.clone()) {
                    Ok(graphics) => {
                        self.graphics = Some(graphics);
                        self.window = Some(window.clone());
                        self.sync_custom_window_chrome();
                        if let Err(error) = self.prepare() {
                            self.fail(event_loop, error);
                            return;
                        }
                        // Keep the HWND hidden while WGPU, layout, text and the first scene are
                        // prepared. Making it visible immediately before the synchronous present
                        // prevents Windows from compositing an empty client area on startup.
                        window.set_visible(true);
                        if let Err(error) = self.present() {
                            self.fail(event_loop, error);
                            return;
                        }
                        self.events.push(json!({"type":"ready"}));
                        if self
                            .graphics
                            .as_ref()
                            .is_some_and(|graphics| graphics.frames == 0)
                        {
                            self.redraw();
                        }
                    }
                    Err(error) => self.fail(event_loop, error),
                }
            }
            Err(error) => self.fail(event_loop, error.to_string()),
        }
    }
    fn user_event(&mut self, event_loop: &ActiveEventLoop, command: Command) {
        match command {
            Command::Patch { nodes } => {
                let chrome_changed = nodes.iter().any(|node| {
                    node.id == self.tree.root && node.style.get("borderColor").is_some()
                });
                if let Err(error) = self.tree.patch(nodes) {
                    self.events.push(crate::protocol::error(error));
                } else if chrome_changed {
                    self.sync_custom_window_chrome();
                }
            }
            Command::Update { root } => {
                self.tree.update(*root);
                self.sync_custom_window_chrome();
            }
            Command::Close => event_loop.exit(),
            Command::Focus { id } => {
                if let Some(blurred) = self.tree.focus(&id) {
                    self.events.push(json!({"type":"blur", "id":blurred}));
                }
            }
            Command::Inspect { request_id } => {
                if let Err(e) = self.prepare() {
                    self.fail(event_loop, e);
                    return;
                }
                if let Some(window) = &self.window {
                    let size = window.inner_size().to_logical::<f64>(window.scale_factor());
                    self.events.push(json!({"type":"inspect", "requestId":request_id, "snapshot": {
                        "frames": self.graphics.as_ref().map_or(0, |g| g.frames), "layouts":self.tree.layouts, "shapes":self.tree.text.shapes, "paints":self.tree.paints,
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
                let result = self.prepare().and_then(|_| {
                    self.graphics
                        .as_mut()
                        .ok_or("Window is not ready".to_string())?
                        .capture(&self.scene, color(&background), &path)
                });
                match result {
                    Ok(()) => self
                        .events
                        .push(json!({"type":"captured", "requestId":request_id, "path":path})),
                    Err(e) => self.events.push(error(e)),
                }
            }
            Command::Input {
                action,
                x,
                y,
                delta,
                text,
            } if self.document.window.debug => {
                let events = match action.as_str() {
                    "move" => self.tree.pointer_move(x.unwrap_or(0.0), y.unwrap_or(0.0)),
                    "down" => self.tree.pointer_down(),
                    "up" => self.tree.pointer_up(),
                    "wheel" => self.tree.wheel(delta.unwrap_or(0.0)),
                    "text" => self.tree.type_text(text.as_deref().unwrap_or("")),
                    "key" if text.as_deref() == Some("Escape") => {
                        vec![json!({"type":"escape"})]
                    }
                    "key" => self.tree.key(text.as_deref().unwrap_or("")),
                    _ => vec![],
                };
                self.emit(events);
            }
            _ => self
                .events
                .push(error("Diagnostic command requires debug: true")),
        }
        self.sync_cursor();
        self.redraw();
    }
    fn window_event(&mut self, event_loop: &ActiveEventLoop, _: WindowId, event: WindowEvent) {
        let mut events = vec![];
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::Resized(size) => {
                if self
                    .graphics
                    .as_mut()
                    .is_some_and(|graphics| graphics.resize(size.width, size.height))
                {
                    self.tree.dirty.layout = true;
                    self.tree.dirty.paint = true;
                }
                self.sync_custom_window_chrome_state();
            }
            WindowEvent::ScaleFactorChanged { .. } => {
                self.tree.dirty.layout = true;
                self.tree.dirty.paint = true;
            }
            WindowEvent::RedrawRequested => {
                if self
                    .window
                    .as_ref()
                    .is_some_and(|w| w.inner_size().width == 0 || w.inner_size().height == 0)
                {
                    return;
                }
                let result = self.prepare().and_then(|_| self.present());
                if let Err(error) = result {
                    self.fail(event_loop, error);
                }
                return;
            }
            WindowEvent::CursorMoved { position, .. } => {
                let scale = self.window.as_ref().unwrap().scale_factor();
                events = self
                    .tree
                    .pointer_move(position.x / scale, position.y / scale);
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
            }
            WindowEvent::MouseWheel { delta, .. } => {
                let dy = match delta {
                    MouseScrollDelta::LineDelta(_, y) => -y as f64 * 36.0,
                    MouseScrollDelta::PixelDelta(p) => {
                        -p.y / self.window.as_ref().unwrap().scale_factor()
                    }
                };
                events = self.tree.wheel(dy);
            }
            WindowEvent::ModifiersChanged(modifiers) => self.modifiers = modifiers.state(),
            WindowEvent::KeyboardInput { event, .. } if event.state == ElementState::Pressed => {
                events = self.clipboard_shortcut(&event.logical_key);
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
                    Key::Named(NamedKey::ArrowLeft) => Some("ArrowLeft"),
                    Key::Named(NamedKey::ArrowRight) => Some("ArrowRight"),
                    Key::Named(NamedKey::ArrowUp) => Some("ArrowUp"),
                    Key::Named(NamedKey::ArrowDown) => Some("ArrowDown"),
                    Key::Named(NamedKey::Home) => Some("Home"),
                    Key::Named(NamedKey::End) => Some("End"),
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
                    events = self.tree.key(key);
                }
                if !self.modifiers.control_key()
                    && !self.modifiers.super_key()
                    && !self.ime_preedit
                    && (key.is_none() || key == Some("Space"))
                    && let Some(text) = event.text
                {
                    events.extend(self.tree.type_text(&text));
                }
            }
            WindowEvent::Ime(Ime::Preedit(text, _)) => self.ime_preedit = !text.is_empty(),
            WindowEvent::Ime(Ime::Commit(text)) => {
                self.ime_preedit = false;
                events = self.tree.type_text(&text);
            }
            WindowEvent::Focused(false) => {
                if let Some(blurred) = self.tree.blur() {
                    events.push(json!({"type":"blur", "id":blurred}));
                }
            }
            _ => {}
        }
        self.emit(events);
        self.sync_cursor();
        self.redraw();
    }
}
