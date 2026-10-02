//! Browser entry point. Drives the same `Tree` the desktop runtime uses — Taffy layout,
//! Parley text, input handling and the vello_cpu paint path — and hands RGBA frames to
//! a canvas. Window chrome, clipboard, dialogs and accessibility stay desktop-only.

use crate::{
    paint::{CpuCachedImage, CpuPaintTarget},
    protocol::{Command, Document},
    text::web_fonts,
    tree::{Tree, color},
};
use parley::fontique::GenericFamily;
use serde_json::{Value, json};
use std::collections::HashMap;
use vello::kurbo::Rect;
use vello_cpu::{PixmapMut, RenderContext, Resources};
use wasm_bindgen::prelude::*;

/// Registers a TrueType/OpenType font for every tree created afterwards.
/// `generics` is a comma-separated list of CSS generic families (`system-ui,sans-serif`).
#[wasm_bindgen(js_name = registerFont)]
pub fn register_font(bytes: Vec<u8>, generics: &str) {
    let generics = generics
        .split(',')
        .filter_map(|name| GenericFamily::parse(name.trim()))
        .collect();
    web_fonts::register(bytes, generics);
}

#[wasm_bindgen]
pub struct WebTree {
    tree: Tree,
    background: String,
    context: RenderContext,
    resources: Resources,
    images: HashMap<String, CpuCachedImage>,
    pixels: Vec<u8>,
    width: f32,
    height: f32,
    scale: f64,
    events: Vec<Value>,
    painted: bool,
    frames: u64,
}

#[wasm_bindgen]
impl WebTree {
    /// Creates a tree from a `SceneDocument` JSON string.
    #[wasm_bindgen(constructor)]
    pub fn new(document: &str) -> Result<WebTree, JsError> {
        let document: Document =
            serde_json::from_str(document).map_err(|error| JsError::new(&error.to_string()))?;
        crate::protocol::validate(&document.root).map_err(|error| JsError::new(&error))?;
        let width = document.window.width as f32;
        let height = document.window.height as f32;
        let mut tree = Tree::new(document.root);
        // The page frames the canvas itself: no custom-window outline or rounded corners.
        tree.set_window_chrome_suppressed(true);
        Ok(WebTree {
            tree,
            background: document.window.background,
            context: RenderContext::new(1, 1),
            resources: Resources::new(),
            images: HashMap::new(),
            pixels: Vec::new(),
            width,
            height,
            scale: 1.0,
            events: Vec::new(),
            painted: false,
            frames: 0,
        })
    }

    /// Applies a JSON `NativeCommand`, including the diagnostic `inspect`, `input` and
    /// `motionAdvance` commands. Commands that need a desktop window are ignored.
    pub fn command(&mut self, command: &str) -> Result<(), JsError> {
        let command: Command =
            serde_json::from_str(command).map_err(|error| JsError::new(&error.to_string()))?;
        match command {
            Command::Patch { nodes } => {
                if let Err(error) = self.tree.patch(nodes) {
                    self.events.push(crate::protocol::error(error));
                }
            }
            Command::Mutate { mutations } => {
                if let Err(error) = self.tree.mutate(mutations) {
                    self.events.push(crate::protocol::error(error));
                }
            }
            Command::Update { root } => self.tree.update(*root),
            Command::Focus { id } => {
                if let Some(blurred) = self.tree.focus(&id) {
                    self.events.push(json!({"type":"blur", "id":blurred}));
                }
            }
            Command::ScrollToItem { id, index, offset } => {
                match self
                    .tree
                    .request_virtual_scroll_to_item(&id, index, offset.unwrap_or(0.0))
                {
                    Ok(events) => self.events.extend(events),
                    Err(message) => self.events.push(crate::protocol::error(message)),
                }
            }
            Command::FrameOverlay { enabled } => {
                self.tree.set_frame_overlay(enabled);
            }
            Command::Resize { width, height } => {
                self.resize(width as f32, height as f32, self.scale)
            }
            Command::Inspect { request_id } => {
                self.tree
                    .compute(self.width, self.height)
                    .map_err(|error| JsError::new(&error))?;
                let layout_events = self.tree.take_layout_events();
                self.events.extend(layout_events);
                self.events.push(json!({"type":"inspect", "requestId":request_id, "snapshot": {
                    "frames":self.frames, "layouts":self.tree.layouts, "shapes":self.tree.text.shapes,
                    "paints":self.tree.paints, "hovered":self.tree.hovered, "focused":self.tree.focused,
                    "nodes":self.tree.snapshots(), "width":self.width, "height":self.height, "scale":self.scale,
                    "layoutNodes":self.tree.layout_node_count(), "layoutNodesCreated":self.tree.layout_nodes_created,
                    "measureCalls":self.tree.measure_calls, "paintedNodes":self.tree.painted_nodes,
                    "activeMotions":self.tree.active_motion_count(), "glyphRasterizations":null
                }}));
            }
            Command::Input {
                action,
                x,
                y,
                delta,
                delta_x,
                delta_y,
                text,
            } => {
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
                self.events.extend(events);
            }
            Command::MotionAdvance {
                milliseconds,
                request_id,
            } => {
                if !milliseconds.is_finite() || !(0.0..=60_000.0).contains(&milliseconds) {
                    self.events.push(json!({
                        "type":"motionAdvanced", "requestId":request_id, "milliseconds":milliseconds,
                        "activeMotions":self.tree.active_motion_count(),
                        "error":"motionAdvance milliseconds must be finite and between 0 and 60000"
                    }));
                } else {
                    let next = self.tree.motion_time_ms() + milliseconds;
                    self.tree.advance_motion(next);
                    self.events.extend(self.tree.take_motion_events());
                    self.events.push(json!({
                        "type":"motionAdvanced", "requestId":request_id, "milliseconds":milliseconds,
                        "activeMotions":self.tree.active_motion_count()
                    }));
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// Sets the logical size and device pixel ratio of the canvas.
    pub fn resize(&mut self, width: f32, height: f32, scale: f64) {
        let resized = (width - self.width).abs() > f32::EPSILON
            || (height - self.height).abs() > f32::EPSILON;
        if resized || (scale - self.scale).abs() > f64::EPSILON {
            // A new size needs a new layout; `compute` skips layout unless it is marked dirty.
            self.tree.dirty.layout |= resized;
            self.width = width.max(1.0);
            self.height = height.max(1.0);
            self.scale = scale.max(0.5);
            self.tree.dirty.paint = true;
            self.painted = false;
        }
    }

    /// Moves the native clock to `now_ms` without stepping motion. Call before `command` so
    /// transitions started by a patch begin now, not at the last painted frame.
    #[wasm_bindgen(js_name = advanceClock)]
    pub fn advance_clock(&mut self, now_ms: f64) {
        self.tree.advance_clock(now_ms);
    }

    /// Advances motion to `now_ms`, lays out and paints when something changed.
    /// Returns true when `pixels()` holds a new frame.
    pub fn frame(&mut self, now_ms: f64) -> Result<bool, JsError> {
        self.tree.advance_clock(now_ms);
        self.tree.advance_motion(now_ms);
        self.events.extend(self.tree.take_motion_events());
        self.tree
            .compute(self.width, self.height)
            .map_err(|error| JsError::new(&error))?;
        let layout_events = self.tree.take_layout_events();
        self.events.extend(layout_events);
        for message in self.tree.warnings.drain(..) {
            self.events.push(crate::protocol::error(message));
        }
        if self.painted && !self.tree.dirty.paint {
            return Ok(false);
        }
        let device_width = self.device_width() as u16;
        let device_height = self.device_height() as u16;
        let background = self
            .tree
            .entries
            .get(&self.tree.root)
            .map(|entry| {
                entry
                    .node
                    .string("background", &self.background)
                    .to_string()
            })
            .unwrap_or_else(|| self.background.clone());
        self.context.reset_and_resize(device_width, device_height);
        // An opaque base keeps the frame ready for the canvas as-is: no per-pixel compositing.
        self.context.set_paint(color(&background));
        self.context.fill_rect(&Rect::new(
            0.0,
            0.0,
            f64::from(device_width),
            f64::from(device_height),
        ));
        {
            let mut target =
                CpuPaintTarget::new(&mut self.context, &mut self.resources, &mut self.images);
            self.tree.paint(self.scale, &mut target);
            target.finish();
        }
        self.context.flush();
        self.pixels.resize(
            usize::from(device_width) * usize::from(device_height) * 4,
            0,
        );
        {
            let pixmap = PixmapMut::new(device_width, device_height, &mut self.pixels)
                .ok_or_else(|| JsError::new("Invalid canvas size"))?;
            self.context.render(pixmap, &mut self.resources);
        }
        self.painted = true;
        self.frames += 1;
        Ok(true)
    }

    /// Address of the last frame's opaque RGBA8 pixels in wasm memory, so the page can
    /// hand them to the canvas without copying.
    #[wasm_bindgen(js_name = pixelsPtr)]
    pub fn pixels_ptr(&self) -> u32 {
        self.pixels.as_ptr() as u32
    }

    #[wasm_bindgen(js_name = pixelsLen)]
    pub fn pixels_len(&self) -> u32 {
        self.pixels.len() as u32
    }

    #[wasm_bindgen(js_name = deviceWidth)]
    pub fn device_width(&self) -> u32 {
        (f64::from(self.width) * self.scale)
            .round()
            .clamp(1.0, 4096.0) as u32
    }

    #[wasm_bindgen(js_name = deviceHeight)]
    pub fn device_height(&self) -> u32 {
        (f64::from(self.height) * self.scale)
            .round()
            .clamp(1.0, 4096.0) as u32
    }

    /// Milliseconds until motion, caret blink or another clock needs a frame, or -1 when idle.
    #[wasm_bindgen(js_name = nextTickMs)]
    pub fn next_tick_ms(&self) -> f64 {
        [
            self.tree.next_motion_tick_ms(),
            self.tree.next_clock_tick_ms(),
            self.tree.next_caret_blink_ms(),
        ]
        .into_iter()
        .flatten()
        .fold(-1.0, |earliest: f64, tick| {
            if earliest < 0.0 {
                tick
            } else {
                earliest.min(tick)
            }
        })
    }

    #[wasm_bindgen(js_name = pointerMove)]
    pub fn pointer_move(&mut self, x: f64, y: f64) {
        let events = self.tree.pointer_move(x, y);
        self.events.extend(events);
    }

    #[wasm_bindgen(js_name = pointerLeave)]
    pub fn pointer_leave(&mut self) {
        let events = self.tree.pointer_leave();
        self.events.extend(events);
    }

    #[wasm_bindgen(js_name = pointerDown)]
    pub fn pointer_down(&mut self) {
        let events = self.tree.pointer_down();
        self.events.extend(events);
    }

    #[wasm_bindgen(js_name = pointerUp)]
    pub fn pointer_up(&mut self) {
        let events = self.tree.pointer_up();
        self.events.extend(events);
    }

    #[wasm_bindgen(js_name = pointerContext)]
    pub fn pointer_context(&mut self) {
        let events = self.tree.pointer_context();
        self.events.extend(events);
    }

    pub fn wheel(&mut self, delta_x: f64, delta_y: f64) {
        let events = self.tree.wheel_2d(delta_x, delta_y);
        self.events.extend(events);
    }

    /// Sends a named key (`Enter`, `ShiftArrowLeft`, `Escape`…), as the desktop runtime does.
    /// Returns true when the tree handled it.
    pub fn key(&mut self, name: &str) -> bool {
        let events = self.tree.key(name);
        let handled = !events.is_empty();
        if name == "Escape" && !handled {
            self.events.push(json!({"type":"escape"}));
        }
        self.events.extend(events);
        handled
    }

    #[wasm_bindgen(js_name = typeText)]
    pub fn type_text(&mut self, text: &str) {
        let events = self.tree.type_text(text);
        self.events.extend(events);
    }

    pub fn blur(&mut self) {
        if let Some(blurred) = self.tree.blur() {
            self.events.push(json!({"type":"blur", "id":blurred}));
        }
    }

    #[wasm_bindgen(js_name = selectedText)]
    pub fn selected_text(&self) -> Option<String> {
        self.tree.selected_text()
    }

    /// CSS cursor for the hovered node: `text`, `col-resize`/`row-resize`, `pointer` or `default`.
    pub fn cursor(&self) -> String {
        if self.tree.selectable_text_at_pointer().is_some() {
            return "text".into();
        }
        match self
            .tree
            .hovered
            .as_ref()
            .and_then(|id| self.tree.entries.get(id))
        {
            Some(entry) if matches!(entry.node.kind.as_str(), "input" | "textarea") => {
                "text".into()
            }
            Some(entry) if entry.node.kind == "splitter" => {
                if entry
                    .node
                    .control
                    .as_ref()
                    .is_some_and(|control| control.orientation == "vertical")
                {
                    "row-resize".into()
                } else {
                    "col-resize".into()
                }
            }
            Some(entry) if entry.node.interactive() => "pointer".into(),
            _ => "default".into(),
        }
    }

    /// The `windowAction` (`minimize`, `toggleMaximize`, `close`) of a node, if it has one.
    #[wasm_bindgen(js_name = windowAction)]
    pub fn window_action(&self, id: &str) -> Option<String> {
        self.tree
            .entries
            .get(id)
            .map(|entry| entry.node.window_action.clone())
            .filter(|action| !action.is_empty())
    }

    /// Drains pending native events as a JSON array.
    #[wasm_bindgen(js_name = takeEvents)]
    pub fn take_events(&mut self) -> String {
        let interaction = self.tree.take_interaction_events();
        self.events.extend(interaction);
        serde_json::to_string(&std::mem::take(&mut self.events)).unwrap_or_else(|_| "[]".into())
    }
}
