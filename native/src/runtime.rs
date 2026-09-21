use crate::{
    bridge::Events,
    protocol::{Command, Document, error},
    renderer::Graphics,
    tree::{Tree, color},
};
use serde_json::json;
use std::sync::{Arc, mpsc::SyncSender};
use winit::{
    application::ApplicationHandler,
    dpi::{LogicalPosition, LogicalSize},
    event::{ElementState, Ime, MouseButton, MouseScrollDelta, WindowEvent},
    event_loop::{ActiveEventLoop, ControlFlow, EventLoop, EventLoopProxy},
    keyboard::{Key, ModifiersState, NamedKey},
    window::{CursorIcon, Window, WindowId},
};

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
}
impl App {
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
            let kind = self
                .tree
                .hovered
                .as_ref()
                .map(|id| self.tree.entries[id].node.kind.as_str());
            window.set_cursor(match kind {
                Some("button") => CursorIcon::Pointer,
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
            .with_resizable(true);
        match event_loop.create_window(attributes) {
            Ok(window) => {
                let window = Arc::new(window);
                match Graphics::new(window.clone()) {
                    Ok(graphics) => {
                        self.graphics = Some(graphics);
                        self.window = Some(window);
                        self.events.push(json!({"type":"ready"}));
                        self.redraw();
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
                if let Err(error) = self.tree.patch(nodes) {
                    self.events.push(crate::protocol::error(error));
                }
            }
            Command::Update { root } => self.tree.update(root),
            Command::Close => event_loop.exit(),
            Command::Focus { id } => self.tree.focus(&id),
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
                let result = self.prepare().and_then(|_| {
                    self.graphics
                        .as_mut()
                        .ok_or("Window is not ready".to_string())?
                        .capture(&self.scene, color(&self.document.window.background), &path)
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
                    "wheel" => {
                        self.tree.wheel(delta.unwrap_or(0.0));
                        vec![]
                    }
                    "text" => self.tree.type_text(text.as_deref().unwrap_or("")),
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
                if let Some(graphics) = &mut self.graphics {
                    graphics.resize(size.width, size.height);
                }
                self.tree.dirty.layout = true;
                self.tree.dirty.paint = true;
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
                let result = self.prepare().and_then(|_| {
                    self.graphics
                        .as_mut()
                        .ok_or("Renderer not ready".to_string())?
                        .render(&self.scene, color(&self.document.window.background))
                });
                if let Err(error) = result {
                    self.fail(event_loop, error);
                } else if self.document.window.debug {
                    self.events.push(
                        json!({"type":"frame", "frames":self.graphics.as_ref().unwrap().frames}),
                    );
                }
                return;
            }
            WindowEvent::CursorMoved { position, .. } => {
                let scale = self.window.as_ref().unwrap().scale_factor();
                events = self
                    .tree
                    .pointer_move(position.x / scale, position.y / scale);
            }
            WindowEvent::CursorLeft { .. } => events = self.tree.pointer_move(-1.0, -1.0),
            WindowEvent::MouseInput {
                state,
                button: MouseButton::Left,
                ..
            } => {
                if state == ElementState::Pressed {
                    events = self.tree.pointer_down();
                } else {
                    events = self.tree.pointer_up();
                }
            }
            WindowEvent::MouseWheel { delta, .. } => {
                let dy = match delta {
                    MouseScrollDelta::LineDelta(_, y) => -y as f64 * 36.0,
                    MouseScrollDelta::PixelDelta(p) => {
                        -p.y / self.window.as_ref().unwrap().scale_factor()
                    }
                };
                self.tree.wheel(dy);
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
                    Key::Named(NamedKey::Home) => Some("Home"),
                    Key::Named(NamedKey::End) => Some("End"),
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
                self.tree.focused = None;
                self.tree.dirty.paint = true;
            }
            _ => {}
        }
        self.emit(events);
        self.sync_cursor();
        self.redraw();
    }
}
