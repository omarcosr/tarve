use crate::{
    protocol::Node,
    text::{TEXT_KEYS, TextEngine},
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};
use taffy::prelude::*;
use unicode_segmentation::UnicodeSegmentation;
use vello::{
    Scene,
    kurbo::{Affine, Cap, Rect as BoxRect, RoundedRect, Stroke, Vec2},
    peniko::{Blob, Color, Fill, ImageAlphaType, ImageBrush, ImageData, ImageFormat},
};

const LAYOUT_KEYS: &[&str] = &[
    "width",
    "height",
    "minWidth",
    "minHeight",
    "maxWidth",
    "maxHeight",
    "flex",
    "shrink",
    "direction",
    "wrap",
    "gap",
    "padding",
    "margin",
    "align",
    "justify",
    "display",
    "columns",
    "borderWidth",
    "position",
    "top",
    "right",
    "bottom",
    "left",
];

#[derive(Default, Clone, Copy, Debug)]
pub struct Dirty {
    pub layout: bool,
    pub text: bool,
    pub paint: bool,
}
impl Dirty {
    fn all() -> Self {
        Self {
            layout: true,
            text: true,
            paint: true,
        }
    }
}

#[derive(Clone, Copy)]
struct VisualState {
    hovered: bool,
    active: bool,
    focused: bool,
    disabled: bool,
}

struct ScrollDrag {
    id: String,
    grab: f64,
}

fn visual_value<'a>(node: &'a Node, key: &str, state: VisualState) -> &'a Value {
    let mut value = &node.style[key];

    if state.hovered
        && !state.disabled
        && let Some(candidate) = node.style.get("hover").and_then(|style| style.get(key))
        && !candidate.is_null()
    {
        value = candidate;
    }

    if state.active
        && !state.disabled
        && let Some(candidate) = node.style.get("active").and_then(|style| style.get(key))
        && !candidate.is_null()
    {
        value = candidate;
    }

    if state.focused
        && let Some(candidate) = node.style.get("focus").and_then(|style| style.get(key))
        && !candidate.is_null()
    {
        value = candidate;
    }

    if state.disabled
        && let Some(candidate) = node.style.get("disabled").and_then(|style| style.get(key))
        && !candidate.is_null()
    {
        value = candidate;
    }

    value
}

fn visual_string<'a>(node: &'a Node, key: &str, fallback: &'a str, state: VisualState) -> &'a str {
    visual_value(node, key, state).as_str().unwrap_or(fallback)
}

fn visual_number(node: &Node, key: &str, fallback: f32, state: VisualState) -> f32 {
    visual_value(node, key, state)
        .as_f64()
        .map(|value| value as f32)
        .filter(|value| value.is_finite())
        .unwrap_or(fallback)
}

fn visual_optional_number(node: &Node, key: &str, state: VisualState) -> Option<f64> {
    visual_value(node, key, state).as_f64()
}

pub struct Entry {
    pub node: Node,
    children: Vec<String>,
    parent: Option<String>,
    layout_id: Option<NodeId>,
    layout_dirty: bool,
    structure_dirty: bool,
    measure_dirty: bool,
    pub rect: BoxRect,
    bounds: BoxRect,
    pub scroll: f64,
    pub scroll_max: f64,
}
pub struct Tree {
    pub root: String,
    pub entries: HashMap<String, Entry>,
    pub order: Vec<String>,
    layout: TaffyTree<String>,
    pub text: TextEngine,
    images: HashMap<String, ImageData>,
    stacking: HashMap<String, f32>,
    window_chrome_suppressed: bool,
    pub dirty: Dirty,
    pub hovered: Option<String>,
    pub focused: Option<String>,
    pressed: Option<String>,
    scroll_drag: Option<ScrollDrag>,
    pub mouse: (f64, f64),
    caret: usize,
    select_all: bool,
    pub layouts: u64,
    pub paints: u64,
    pub layout_nodes_created: u64,
    pub measure_calls: u64,
    pub painted_nodes: u64,
    pub warnings: Vec<String>,
}

impl Tree {
    fn refresh_stacking(&mut self) {
        fn visit(
            entries: &HashMap<String, Entry>,
            id: &str,
            out: &mut HashMap<String, f32>,
        ) -> f32 {
            let entry = &entries[id];
            let highest = entry
                .children
                .iter()
                .fold(entry.node.number("zIndex", 0.0), |highest, child| {
                    highest.max(visit(entries, child, out))
                });
            out.insert(id.to_string(), highest);
            highest
        }
        let mut stacking = HashMap::with_capacity(self.entries.len());
        if self.entries.contains_key(&self.root) {
            visit(&self.entries, &self.root, &mut stacking);
        }
        self.stacking = stacking;
    }

    pub fn new(root: Node) -> Self {
        let mut tree = Self {
            root: root.id.clone(),
            entries: HashMap::new(),
            order: Vec::new(),
            layout: TaffyTree::new(),
            text: TextEngine::new(),
            images: HashMap::new(),
            stacking: HashMap::new(),
            window_chrome_suppressed: false,
            dirty: Dirty::all(),
            hovered: None,
            focused: None,
            pressed: None,
            scroll_drag: None,
            mouse: (-1.0, -1.0),
            caret: 0,
            select_all: false,
            layouts: 0,
            paints: 0,
            layout_nodes_created: 0,
            measure_calls: 0,
            painted_nodes: 0,
            warnings: Vec::new(),
        };
        tree.update(root);
        tree
    }
    pub fn set_window_chrome_suppressed(&mut self, suppressed: bool) -> bool {
        if self.window_chrome_suppressed == suppressed {
            return false;
        }
        self.window_chrome_suppressed = suppressed;
        if let Some(root) = self.entries.get_mut(&self.root) {
            root.layout_dirty = true;
        }
        self.dirty.layout = true;
        self.dirty.paint = true;
        true
    }
    pub fn update(&mut self, root: Node) {
        let mut old = std::mem::take(&mut self.entries);
        self.order.clear();
        self.root = root.id.clone();
        self.insert(root, &mut old, None);
        if !old.is_empty() {
            self.dirty = Dirty::all();
        }
        for removed in old.values() {
            if let Some(layout_id) = removed.layout_id {
                self.layout
                    .remove(layout_id)
                    .expect("retained layout node exists");
            }
        }
        self.text.retain(|id| {
            self.entries.contains_key(id)
                || id
                    .strip_suffix("::caret")
                    .is_some_and(|id| self.entries.contains_key(id))
        });
        self.prune_images();
        self.prune_interaction();
        self.refresh_stacking();
    }
    fn insert(&mut self, mut node: Node, old: &mut HashMap<String, Entry>, parent: Option<&str>) {
        // Store the hierarchy once. Entries own only their properties and child IDs.
        let children = std::mem::take(&mut node.children);
        let child_ids: Vec<String> = children.iter().map(|child| child.id.clone()).collect();
        let previous = old.remove(&node.id);
        let id = node.id.clone();
        self.order.push(node.id.clone());
        self.reconcile_node(node, child_ids, previous);
        self.entries.get_mut(&id).unwrap().parent = parent.map(str::to_string);
        for child in children {
            self.insert(child, old, Some(&id));
        }
    }
    fn reconcile_node(&mut self, mut node: Node, child_ids: Vec<String>, previous: Option<Entry>) {
        let mut layout_dirty = true;
        let mut structure_dirty = true;
        let mut measure_dirty = true;
        if let Some(prev) = &previous {
            if matches!(node.kind.as_str(), "input" | "textarea") && node.value.is_none() {
                node.value = prev.node.value.clone();
            }
            structure_dirty = prev.structure_dirty || child_ids != prev.children;
            layout_dirty = prev.layout_dirty
                || node.kind != prev.node.kind
                || LAYOUT_KEYS
                    .iter()
                    .any(|key| node.style[*key] != prev.node.style[*key]);
            measure_dirty = prev.measure_dirty
                || node.src != prev.node.src
                || node.kind != prev.node.kind
                || node.text_value() != prev.node.text_value()
                || TEXT_KEYS
                    .iter()
                    .any(|key| node.style[*key] != prev.node.style[*key]);
            if structure_dirty || layout_dirty || measure_dirty {
                self.dirty.layout = true;
            }
            if node.text_value() != prev.node.text_value()
                || TEXT_KEYS
                    .iter()
                    .any(|key| node.style[*key] != prev.node.style[*key])
            {
                self.text.layouts.remove(&node.id);
                self.dirty.text = true;
                self.dirty.layout = true;
            }
            if node != prev.node || structure_dirty {
                self.dirty.paint = true;
            }
        } else {
            self.dirty = Dirty::all();
        }
        if node.kind == "image" && !self.images.contains_key(&node.src) {
            match image::open(&node.src) {
                Ok(image) => {
                    let rgba = image.to_rgba8();
                    self.images.insert(
                        node.src.clone(),
                        ImageData {
                            width: rgba.width(),
                            height: rgba.height(),
                            format: ImageFormat::Rgba8,
                            alpha_type: ImageAlphaType::Alpha,
                            data: Blob::new(Arc::new(rgba.into_raw())),
                        },
                    );
                }
                Err(e) => self.warnings.push(format!("Image '{}': {e}", node.src)),
            }
        }
        let id = node.id.clone();
        self.entries.insert(
            id,
            Entry {
                node,
                children: child_ids,
                parent: previous.as_ref().and_then(|e| e.parent.clone()),
                layout_id: previous.as_ref().and_then(|e| e.layout_id),
                layout_dirty,
                structure_dirty,
                measure_dirty,
                rect: previous.as_ref().map(|e| e.rect).unwrap_or(BoxRect::ZERO),
                bounds: previous.as_ref().map(|e| e.bounds).unwrap_or(BoxRect::ZERO),
                scroll: previous.as_ref().map(|e| e.scroll).unwrap_or(0.0),
                scroll_max: previous.as_ref().map(|e| e.scroll_max).unwrap_or(0.0),
            },
        );
    }
    pub fn patch(&mut self, nodes: Vec<Node>) -> Result<(), String> {
        crate::protocol::validate_patch(&nodes)?;
        // Validate the whole patch before applying any part of it.
        for node in &nodes {
            if !self
                .entries
                .get(&node.id)
                .is_some_and(|entry| entry.node.kind == node.kind)
            {
                return Err(format!(
                    "Patch references a missing or changed node: {}",
                    node.id
                ));
            }
        }
        for node in nodes {
            let previous = self.entries.remove(&node.id).unwrap();
            let children = previous.children.clone();
            self.reconcile_node(node, children, Some(previous));
        }
        self.prune_images();
        self.prune_interaction();
        self.refresh_stacking();
        Ok(())
    }
    fn prune_images(&mut self) {
        let used: HashSet<String> = self
            .entries
            .values()
            .filter(|entry| entry.node.kind == "image" && !entry.node.src.is_empty())
            .map(|entry| entry.node.src.clone())
            .collect();
        self.images.retain(|src, _| used.contains(src));
    }
    pub fn compute(&mut self, width: f32, height: f32) -> Result<(), String> {
        if !self.dirty.layout && !self.dirty.text {
            return Ok(());
        }
        for entry in self.entries.values() {
            if entry.measure_dirty {
                self.text.prepare(&entry.node);
            }
        }
        let root = self.build_layout(&self.root.clone(), Some((width, height)))?;
        let text = &mut self.text;
        let nodes = &self.entries;
        let images = &self.images;
        let measure_calls = &mut self.measure_calls;
        self.layout
            .compute_layout_with_measure(
                root,
                Size {
                    width: AvailableSpace::Definite(width),
                    height: AvailableSpace::Definite(height),
                },
                |inputs, _, context, style| {
                    *measure_calls += 1;
                    taffy::compute_leaf_layout(
                        inputs,
                        style,
                        |_, _| 0.0,
                        |known, available| {
                            let Some(id) = context.as_deref() else {
                                return Size::ZERO;
                            };
                            let node = &nodes[id].node;
                            let mut measured = Size::ZERO;
                            if node.is_text() {
                                let max_width = if node.kind == "text" {
                                    known.width.or(match available.width {
                                        AvailableSpace::Definite(w) => Some(w),
                                        AvailableSpace::MinContent => Some(0.0),
                                        _ => None,
                                    })
                                } else {
                                    None
                                };
                                let (w, h) = text.measure(id, max_width);
                                measured = Size {
                                    width: w,
                                    height: h,
                                };
                            } else if let Some(image) = images.get(&node.src) {
                                let ratio = image.width as f32 / image.height as f32;
                                measured = Size {
                                    width: known
                                        .height
                                        .map(|h| h * ratio)
                                        .unwrap_or(image.width as f32),
                                    height: known
                                        .width
                                        .map(|w| w / ratio)
                                        .unwrap_or(image.height as f32),
                                };
                            }
                            Size {
                                width: known.width.unwrap_or(measured.width),
                                height: known.height.unwrap_or(measured.height),
                            }
                        },
                    )
                },
            )
            .map_err(|e| e.to_string())?;
        self.positions(&self.root.clone(), (0.0, 0.0))?;
        self.ensure_focused_textarea_caret_visible();
        self.layouts += 1;
        self.dirty.layout = false;
        self.dirty.text = false;
        self.dirty.paint = true;
        Ok(())
    }
    fn build_layout(&mut self, id: &str, viewport: Option<(f32, f32)>) -> Result<NodeId, String> {
        let child_ids = self.entries[id].children.clone();
        let children = child_ids
            .iter()
            .map(|child| self.build_layout(child, None))
            .collect::<Result<Vec<_>, _>>()?;
        let suppress_root_chrome = self.window_chrome_suppressed && id == self.root;
        let entry = self.entries.get_mut(id).unwrap();
        let style = if entry.layout_dirty || entry.layout_id.is_none() || viewport.is_some() {
            let mut style = layout_style(&entry.node, suppress_root_chrome);
            if let Some((w, h)) = viewport {
                style.size = Size {
                    width: length(w),
                    height: length(h),
                };
            }
            Some(style)
        } else {
            None
        };
        let layout_id = if let Some(layout_id) = entry.layout_id {
            if let Some(style) = style
                && self.layout.style(layout_id).map_err(|e| e.to_string())? != &style
            {
                self.layout
                    .set_style(layout_id, style)
                    .map_err(|e| e.to_string())?;
            }
            if entry.measure_dirty {
                self.layout
                    .mark_dirty(layout_id)
                    .map_err(|e| e.to_string())?;
            }
            layout_id
        } else {
            self.layout_nodes_created += 1;
            self.layout
                .new_leaf_with_context(style.unwrap(), id.to_string())
                .map_err(|e| e.to_string())?
        };
        if entry.structure_dirty || entry.layout_id.is_none() {
            self.layout
                .set_children(layout_id, &children)
                .map_err(|e| e.to_string())?;
        }
        entry.layout_id = Some(layout_id);
        entry.layout_dirty = false;
        entry.structure_dirty = false;
        entry.measure_dirty = false;
        Ok(layout_id)
    }
    fn positions(&mut self, id: &str, parent: (f64, f64)) -> Result<BoxRect, String> {
        let entry = self.entries.get_mut(id).unwrap();
        let layout = self
            .layout
            .layout(entry.layout_id.unwrap())
            .map_err(|e| e.to_string())?;
        let origin = (
            parent.0 + layout.location.x as f64,
            parent.1 + layout.location.y as f64,
        );
        entry.rect = BoxRect::from_origin_size(
            origin,
            (layout.size.width as f64, layout.size.height as f64),
        );
        entry.scroll_max = if entry.node.kind == "scroll" {
            layout.scroll_height() as f64
        } else if entry.node.kind == "textarea" {
            let pad = entry.node.insets("padding");
            let border = entry.node.insets("borderWidth");
            let width = (entry.rect.width() - (pad[1] + pad[3] + border[1] + border[3]) as f64)
                .max(0.0) as f32;
            let height =
                (entry.rect.height() - (pad[0] + pad[2] + border[0] + border[2]) as f64).max(0.0);
            (self.text.measure(id, Some(width)).1 as f64 - height).max(0.0)
        } else {
            0.0
        };
        entry.scroll = entry.scroll.clamp(0.0, entry.scroll_max);
        let children = entry.children.clone();
        let clips = entry.node.kind == "scroll";
        let mut bounds = entry.rect.inset(3.0);
        for child in children {
            let child_bounds = self.positions(&child, origin)?;
            if !clips {
                bounds = bounds.union(child_bounds);
            }
        }
        self.entries.get_mut(id).unwrap().bounds = bounds;
        Ok(bounds)
    }
    pub fn scene(&mut self, scale: f64) -> Scene {
        let mut scene = Scene::new();
        self.painted_nodes = 0;
        self.paint_node(
            &self.root.clone(),
            0.0,
            scale,
            self.entries[&self.root].rect,
            &mut scene,
        );
        self.paints += 1;
        self.dirty.paint = false;
        scene
    }
    fn paint_node(&mut self, id: &str, offset: f64, scale: f64, clip: BoxRect, scene: &mut Scene) {
        let entry = &self.entries[id];
        let bounds = entry.bounds + Vec2::new(0.0, -offset);
        if bounds.x1 <= clip.x0
            || bounds.x0 >= clip.x1
            || bounds.y1 <= clip.y0
            || bounds.y0 >= clip.y1
        {
            return;
        }
        let node = entry.node.clone();
        if node.string("display", "flex") == "none" {
            return;
        }
        let rect = entry.rect + Vec2::new(0.0, -offset);
        let scroll = entry.scroll;
        let scroll_max = entry.scroll_max;
        let mut children = entry.children.clone();
        children.sort_by(|a, b| {
            self.stacking
                .get(a)
                .copied()
                .unwrap_or(0.0)
                .total_cmp(&self.stacking.get(b).copied().unwrap_or(0.0))
        });
        self.painted_nodes += 1;
        let transform = Affine::scale(scale);
        let state = VisualState {
            hovered: self.hovered.as_deref() == Some(id),
            active: self.pressed.as_deref() == Some(id) && self.hovered.as_deref() == Some(id),
            focused: self.focused.as_deref() == Some(id),
            disabled: node.disabled,
        };
        let suppress_root_chrome = self.window_chrome_suppressed && id == self.root;
        let radius = if suppress_root_chrome {
            0.0
        } else {
            visual_number(&node, "radius", 0.0, state) as f64
        };
        let shape = RoundedRect::from_rect(rect, radius);
        let bg = visual_string(&node, "background", "#00000000", state);
        if bg != "#00000000" {
            scene.fill(Fill::NonZero, transform, color(bg), None, &shape);
        }
        let border = if suppress_root_chrome {
            [0.0; 4]
        } else {
            node.insets("borderWidth")
                .map(|value| value.max(0.0) as f64)
        };
        if border.iter().any(|width| *width > 0.0) {
            let border_color = color(visual_string(&node, "borderColor", "#e4e4e7", state));
            let uniform = border
                .iter()
                .all(|width| (*width - border[0]).abs() < f64::EPSILON);
            if uniform {
                let width = border[0];
                scene.stroke(
                    &Stroke::new(width),
                    transform,
                    border_color,
                    None,
                    &RoundedRect::from_rect(
                        rect.inset(-width / 2.0),
                        (radius - width / 2.0).max(0.0),
                    ),
                );
            } else {
                scene.push_clip_layer(Fill::NonZero, transform, &shape);
                if border[0] > 0.0 {
                    scene.fill(
                        Fill::NonZero,
                        transform,
                        border_color,
                        None,
                        &BoxRect::new(
                            rect.x0,
                            rect.y0,
                            rect.x1,
                            (rect.y0 + border[0]).min(rect.y1),
                        ),
                    );
                }
                if border[1] > 0.0 {
                    scene.fill(
                        Fill::NonZero,
                        transform,
                        border_color,
                        None,
                        &BoxRect::new(
                            (rect.x1 - border[1]).max(rect.x0),
                            rect.y0,
                            rect.x1,
                            rect.y1,
                        ),
                    );
                }
                if border[2] > 0.0 {
                    scene.fill(
                        Fill::NonZero,
                        transform,
                        border_color,
                        None,
                        &BoxRect::new(
                            rect.x0,
                            (rect.y1 - border[2]).max(rect.y0),
                            rect.x1,
                            rect.y1,
                        ),
                    );
                }
                if border[3] > 0.0 {
                    scene.fill(
                        Fill::NonZero,
                        transform,
                        border_color,
                        None,
                        &BoxRect::new(
                            rect.x0,
                            rect.y0,
                            (rect.x0 + border[3]).min(rect.x1),
                            rect.y1,
                        ),
                    );
                }
                scene.pop_layer();
            }
        }
        let outline_width = visual_number(&node, "outlineWidth", 0.0, state).max(0.0) as f64;
        if outline_width > 0.0 {
            paint_outline(
                scene,
                transform,
                rect,
                radius,
                Outline {
                    width: outline_width,
                    offset: visual_number(&node, "outlineOffset", 0.0, state) as f64,
                    radius_override: visual_optional_number(&node, "outlineRadius", state),
                    color: visual_string(&node, "outlineColor", "#a1a1aa", state),
                    style: visual_string(&node, "outlineStyle", "solid", state),
                },
            );
        }
        if node.is_text() {
            let pad = node.insets("padding");
            let available_width =
                (rect.width() - pad[1] as f64 - pad[3] as f64 - border[1] - border[3]).max(0.0)
                    as f32;
            let (tw, th) = self.text.measure(
                id,
                if matches!(node.kind.as_str(), "text" | "textarea") {
                    Some(available_width)
                } else {
                    None
                },
            );
            let mut x = rect.x0 + pad[3] as f64 + border[3];
            let y = if node.kind == "text" {
                rect.y0 + pad[0] as f64 + border[0]
            } else if node.kind == "textarea" {
                rect.y0 + pad[0] as f64 + border[0] - scroll
            } else {
                rect.y0 + (rect.height() - th as f64) / 2.0
            };
            if node.kind == "button" {
                x = rect.x0 + (rect.width() - tw as f64) / 2.0;
            }
            let foreground = if matches!(node.kind.as_str(), "input" | "textarea")
                && node.value.as_deref().unwrap_or("").is_empty()
            {
                visual_string(&node, "placeholderColor", "#a1a1aa", state)
            } else {
                visual_string(&node, "foreground", "#18181b", state)
            };
            scene.push_clip_layer(Fill::NonZero, transform, &shape);
            if matches!(node.kind.as_str(), "input" | "textarea")
                && self.focused.as_deref() == Some(id)
                && self.select_all
            {
                scene.fill(
                    Fill::NonZero,
                    transform,
                    color(visual_string(&node, "selectionColor", "#dbeafe", state)),
                    None,
                    &BoxRect::new(x, y, x + tw as f64, y + th as f64),
                );
            }
            self.text.draw(
                scene,
                &node,
                (x, y),
                available_width,
                color(foreground),
                scale,
            );
            if node.kind == "textarea" && self.focused.as_deref() == Some(id) {
                let value = node.value.as_deref().unwrap_or("");
                let caret = floor_boundary(value, self.caret.min(value.len()));
                if let Some(cursor) = self.text.caret_rect(id, caret, available_width) {
                    scene.fill(
                        Fill::NonZero,
                        transform,
                        color(visual_string(&node, "caretColor", "#18181b", state)),
                        None,
                        &BoxRect::new(x + cursor.x0, y + cursor.y0, x + cursor.x1, y + cursor.y1),
                    );
                }
            } else if node.kind == "input" && self.focused.as_deref() == Some(id) {
                // A real shaped prefix places the caret correctly for variable-width Latin text.
                let mut prefix = node.clone();
                prefix.id = format!("{}::caret", node.id);
                let value = node.value.as_deref().unwrap_or("");
                let caret = floor_boundary(value, self.caret.min(value.len()));
                prefix.value = Some(value[..caret].to_string());
                prefix.placeholder.clear();
                self.text.prepare(&prefix);
                let (cw, _) = self.text.measure(&prefix.id, None);
                let cx = (x + cw as f64).min(rect.x1 - 10.0);
                scene.fill(
                    Fill::NonZero,
                    transform,
                    color(visual_string(&node, "caretColor", "#18181b", state)),
                    None,
                    &BoxRect::new(cx, y + 3.0, cx + 1.0, y + th as f64 - 3.0),
                );
            }
            scene.pop_layer();
        }
        if node.kind == "icon" {
            crate::icons::draw(
                scene,
                &node.text,
                rect,
                color(visual_string(&node, "foreground", "#18181b", state)),
                node.number("strokeWidth", 1.75) as f64,
                scale,
            );
        }
        if node.kind == "slider" {
            crate::controls::slider(
                scene,
                &node,
                rect,
                scale,
                color(visual_string(
                    &node,
                    "foreground",
                    if node.disabled { "#a1a1aa" } else { "#18181b" },
                    state,
                )),
                color(visual_string(&node, "borderColor", "#e4e4e7", state)),
                color(visual_string(&node, "thumbColor", "#ffffff", state)),
            );
        }
        if node.kind == "image" {
            scene.push_clip_layer(Fill::NonZero, transform, &shape);
            if let Some(image) = self.images.get(&node.src) {
                let sx = rect.width() / image.width as f64;
                let sy = rect.height() / image.height as f64;
                let factor = if node.fit == "contain" {
                    sx.min(sy)
                } else {
                    sx.max(sy)
                };
                let tx = rect.x0 + (rect.width() - image.width as f64 * factor) / 2.0;
                let ty = rect.y0 + (rect.height() - image.height as f64 * factor) / 2.0;
                scene.draw_image(
                    &ImageBrush::new(image.clone()),
                    transform * Affine::translate((tx, ty)) * Affine::scale(factor),
                );
            } else {
                scene.fill(
                    Fill::NonZero,
                    transform,
                    color(visual_string(
                        &node,
                        "placeholderBackground",
                        "#f4f4f5",
                        state,
                    )),
                    None,
                    &shape,
                );
            }
            scene.pop_layer();
        }
        if node.kind == "scroll" {
            scene.push_clip_layer(Fill::NonZero, transform, &shape);
        }
        let child_clip = if node.kind == "scroll" {
            clip.intersect(rect)
        } else {
            clip
        };
        for child in &children {
            self.paint_node(child, offset + scroll, scale, child_clip, scene);
        }
        if node.kind == "scroll" {
            scene.pop_layer();
        }
        if matches!(node.kind.as_str(), "scroll" | "textarea") && scroll_max > 0.0 {
            let track = rect.height() - 12.0;
            let thumb = (track * rect.height() / (rect.height() + scroll_max)).max(28.0);
            let top = rect.y0 + 6.0 + (track - thumb) * scroll / scroll_max;
            scene.fill(
                Fill::NonZero,
                transform,
                color(visual_string(&node, "scrollbarColor", "#d4d4d8", state)),
                None,
                &RoundedRect::new(rect.x1 - 7.0, top, rect.x1 - 3.0, top + thumb, 2.0),
            );
        }
    }
    fn hit(&self, id: &str, offset: f64, clip: BoxRect, scroll_only: bool) -> Option<String> {
        let entry = &self.entries[id];
        if !(entry.bounds + Vec2::new(0.0, -offset)).contains(self.mouse) {
            return None;
        }
        if entry.node.disabled || entry.node.string("display", "flex") == "none" {
            return None;
        }
        let rect = entry.rect + Vec2::new(0.0, -offset);
        let clip = if entry.node.kind == "scroll" {
            clip.intersect(rect)
        } else {
            clip
        };
        if !clip.contains(self.mouse) {
            return None;
        }
        let mut children = entry.children.clone();
        children.sort_by(|a, b| {
            self.stacking
                .get(a)
                .copied()
                .unwrap_or(0.0)
                .total_cmp(&self.stacking.get(b).copied().unwrap_or(0.0))
        });
        for child in children.iter().rev() {
            if let Some(id) = self.hit(child, offset + entry.scroll, clip, scroll_only) {
                return Some(id);
            }
        }
        let blocks_pointer = entry.node.string("pointerEvents", "auto") == "block";
        let eligible = if scroll_only {
            (matches!(entry.node.kind.as_str(), "scroll" | "textarea") && entry.scroll_max > 0.0)
                || blocks_pointer
                || entry.node.modal
        } else {
            entry.node.interactive() || blocks_pointer
        };
        (eligible && rect.contains(self.mouse)).then(|| id.to_string())
    }
    fn interactive(&self, id: &str) -> bool {
        let Some(target) = self.entries.get(id) else {
            return false;
        };
        if !target.node.interactive() {
            return false;
        }
        let mut current = Some(id);
        while let Some(current_id) = current {
            let Some(entry) = self.entries.get(current_id) else {
                return false;
            };
            if entry.node.disabled || entry.node.string("display", "flex") == "none" {
                return false;
            }
            current = entry.parent.as_deref();
        }
        true
    }
    fn focus_order(&self) -> Vec<String> {
        let modal = self.active_modal();
        let mut group_choice = HashMap::<String, String>::new();
        for id in &self.order {
            if !self.interactive(id)
                || !self.entries[id].node.focusable
                || modal.is_some_and(|modal| !self.is_descendant_of(id, modal))
            {
                continue;
            }
            if let Some(control) = &self.entries[id].node.control
                && matches!(control.role.as_str(), "radio" | "tab")
                && !control.group.is_empty()
            {
                let choice = group_choice
                    .entry(control.group.clone())
                    .or_insert_with(|| id.clone());
                if control.checked {
                    *choice = id.clone();
                }
            }
        }
        if let Some(id) = &self.focused
            && let Some(control) = self.entries[id].node.control.as_ref()
            && matches!(control.role.as_str(), "radio" | "tab")
            && group_choice.contains_key(&control.group)
        {
            group_choice.insert(control.group.clone(), id.clone());
        }
        self.order
            .iter()
            .filter(|id| {
                self.interactive(id)
                    && self.entries[*id].node.focusable
                    && modal.is_none_or(|modal| self.is_descendant_of(id, modal))
                    && self.entries[*id]
                        .node
                        .control
                        .as_ref()
                        .is_none_or(|control| {
                            !matches!(control.role.as_str(), "radio" | "tab")
                                || control.group.is_empty()
                                || group_choice.get(&control.group) == Some(*id)
                        })
            })
            .cloned()
            .collect()
    }
    pub fn focus(&mut self, id: &str) -> Option<String> {
        let modal = self.active_modal();
        if !self.interactive(id)
            || !self.entries[id].node.focusable
            || modal.is_some_and(|modal| !self.is_descendant_of(id, modal))
        {
            return None;
        }
        let mut blurred = None;
        if self.focused.as_deref() != Some(id) {
            blurred = self.focused.replace(id.to_string());
            self.select_all = false;
            self.caret = self.entries[id].node.value.as_deref().map_or(0, str::len);
            self.dirty.paint = true;
        }
        let mut ancestor = self.entries[id].parent.clone();
        while let Some(parent_id) = ancestor {
            if self.entries[&parent_id].node.kind == "scroll"
                && let (Some(target), Some(viewport)) =
                    (self.visible_rect(id), self.visible_rect(&parent_id))
            {
                let delta = if target.y0 < viewport.y0 {
                    target.y0 - viewport.y0
                } else if target.y1 > viewport.y1 {
                    target.y1 - viewport.y1
                } else {
                    0.0
                };
                let entry = self.entries.get_mut(&parent_id).unwrap();
                let next = (entry.scroll + delta).clamp(0.0, entry.scroll_max);
                if next != entry.scroll {
                    entry.scroll = next;
                    self.dirty.paint = true;
                }
            }
            ancestor = self.entries[&parent_id].parent.clone();
        }
        blurred
    }
    fn prune_interaction(&mut self) {
        let keep_hovered = self
            .hovered
            .as_deref()
            .is_some_and(|id| self.interactive(id));
        let modal = self.active_modal().map(str::to_string);
        let keep_focused = self.focused.as_deref().is_some_and(|id| {
            self.interactive(id)
                && self.entries[id].node.focusable
                && modal
                    .as_deref()
                    .is_none_or(|modal| self.is_descendant_of(id, modal))
        });
        let keep_pressed = self
            .pressed
            .as_deref()
            .is_some_and(|id| self.interactive(id));
        let changed = (!keep_hovered && self.hovered.is_some())
            || (!keep_focused && self.focused.is_some())
            || (!keep_pressed && self.pressed.is_some());
        if !keep_hovered {
            self.hovered = None;
        }
        if !keep_focused {
            self.focused = None;
            self.caret = 0;
            self.select_all = false;
            if modal.is_some()
                && let Some(id) = self.focus_order().into_iter().next()
            {
                self.focused = Some(id);
            }
        }
        if !keep_pressed {
            self.pressed = None;
        }
        if self
            .scroll_drag
            .as_ref()
            .is_some_and(|drag| !self.entries.contains_key(&drag.id))
        {
            self.scroll_drag = None;
        }
        if changed {
            self.dirty.paint = true;
        }
    }

    fn active_modal(&self) -> Option<&str> {
        self.order
            .iter()
            .rev()
            .find(|id| self.entries[*id].node.modal)
            .map(String::as_str)
    }

    fn is_descendant_of(&self, id: &str, ancestor: &str) -> bool {
        let mut current = Some(id);
        while let Some(current_id) = current {
            if current_id == ancestor {
                return true;
            }
            current = self
                .entries
                .get(current_id)
                .and_then(|entry| entry.parent.as_deref());
        }
        false
    }
    fn visible_rect(&self, id: &str) -> Option<BoxRect> {
        let entry = self.entries.get(id)?;
        let mut offset = 0.0;
        let mut current = entry.parent.as_deref();
        while let Some(parent_id) = current {
            let parent = self.entries.get(parent_id)?;
            offset += parent.scroll;
            current = parent.parent.as_deref();
        }
        Some(entry.rect + Vec2::new(0.0, -offset))
    }
    fn set_slider(&mut self, id: &str, value: f64) -> Vec<Value> {
        if !value.is_finite() {
            return vec![];
        }
        let Some(entry) = self.entries.get_mut(id) else {
            return vec![];
        };
        let Some(control) = entry.node.control.as_mut() else {
            return vec![];
        };
        let steps = ((value - control.min) / control.step).round();
        let next = (control.min + steps * control.step).clamp(control.min, control.max);
        let tolerance = f64::EPSILON * next.abs().max(control.value.abs()).max(1.0);
        if (next - control.value).abs() <= tolerance {
            return vec![];
        }
        control.value = next;
        self.dirty.paint = true;
        vec![json!({"type":"valueChange", "id":id, "value":next})]
    }
    fn slider_from_pointer(&mut self, id: &str) -> Vec<Value> {
        let Some(rect) = self.visible_rect(id) else {
            return vec![];
        };
        let Some(control) = self
            .entries
            .get(id)
            .and_then(|entry| entry.node.control.as_ref())
        else {
            return vec![];
        };
        let inset = 8.0;
        let ratio = if control.orientation == "vertical" {
            let span = (rect.height() - 2.0 * inset).max(1.0);
            ((rect.y1 - inset - self.mouse.1) / span).clamp(0.0, 1.0)
        } else {
            let span = (rect.width() - 2.0 * inset).max(1.0);
            ((self.mouse.0 - rect.x0 - inset) / span).clamp(0.0, 1.0)
        };
        let value = control.min + (control.max - control.min) * ratio;
        self.set_slider(id, value)
    }
    pub fn pointer_move(&mut self, x: f64, y: f64) -> Vec<Value> {
        self.mouse = (x, y);
        if let Some(drag) = &self.scroll_drag {
            let id = drag.id.clone();
            let grab = drag.grab;
            return self.drag_scrollbar(&id, grab);
        }
        let next = self.hit(&self.root, 0.0, self.entries[&self.root].rect, false);
        let mut events = vec![];
        if next != self.hovered {
            if let Some(id) = &self.hovered {
                events.push(json!({"type":"hover", "id":id, "entered":false}));
            }
            if let Some(id) = &next {
                events.push(json!({"type":"hover", "id":id, "entered":true}));
            }
            self.hovered = next;
            self.dirty.paint = true;
        }
        if let Some(id) = self
            .pressed
            .clone()
            .filter(|id| self.entries[id].node.kind == "slider")
        {
            events.extend(self.slider_from_pointer(&id));
        }
        events
    }
    pub fn pointer_leave(&mut self) -> Vec<Value> {
        self.mouse = (-1.0, -1.0);
        if let Some(id) = self.hovered.take() {
            self.dirty.paint = true;
            vec![json!({"type":"hover", "id":id, "entered":false})]
        } else {
            vec![]
        }
    }
    pub fn blur(&mut self) -> Option<String> {
        self.scroll_drag = None;
        let blurred = self.focused.take();
        if blurred.is_some() || self.pressed.take().is_some() {
            self.caret = 0;
            self.select_all = false;
            self.dirty.paint = true;
        }
        blurred
    }
    pub fn pointer_down(&mut self) -> Vec<Value> {
        if let Some((id, grab)) = self.scrollbar_at_pointer() {
            self.pressed = None;
            self.scroll_drag = Some(ScrollDrag {
                id: id.clone(),
                grab,
            });
            return self.drag_scrollbar(&id, grab);
        }
        self.hovered = self.hit(&self.root, 0.0, self.entries[&self.root].rect, false);
        self.pressed = self.hovered.clone();
        let mut events = vec![];
        if let Some(id) = self.hovered.clone() {
            if let Some(blurred) = self.focus(&id) {
                events.push(json!({"type":"blur", "id":blurred}));
            }
            if self.entries[&id].node.kind == "textarea" {
                self.place_textarea_caret_from_pointer(&id);
            }
        } else {
            if let Some(blurred) = self.blur() {
                events.push(json!({"type":"blur", "id":blurred}));
            }
        }
        self.dirty.paint = true;
        if let Some(id) = self
            .pressed
            .clone()
            .filter(|id| self.entries[id].node.kind == "slider")
        {
            events.extend(self.slider_from_pointer(&id));
        }
        events
    }
    pub fn pointer_up(&mut self) -> Vec<Value> {
        if self.scroll_drag.take().is_some() {
            return vec![];
        }
        self.hovered = self.hit(&self.root, 0.0, self.entries[&self.root].rect, false);
        let mut out = vec![];
        if let Some(id) = self.pressed.take() {
            if self.hovered.as_ref() == Some(&id)
                && matches!(self.entries[&id].node.kind.as_str(), "button" | "pressable")
            {
                out.push(json!({"type":"click", "id":id}));
            }
            self.dirty.paint = true;
        }
        out
    }
    pub fn wheel(&mut self, delta: f64) -> Vec<Value> {
        if let Some(id) = self.hit(&self.root, 0.0, self.entries[&self.root].rect, true) {
            let next = self.entries[&id].scroll + delta;
            return self.scroll_to(&id, next);
        }
        vec![]
    }
    fn scrollbar_at_pointer(&self) -> Option<(String, f64)> {
        let id = self.hit(&self.root, 0.0, self.entries[&self.root].rect, true)?;
        let entry = self.entries.get(&id)?;
        if !matches!(entry.node.kind.as_str(), "scroll" | "textarea") || entry.scroll_max <= 0.0 {
            return None;
        }
        let rect = self.visible_rect(&id)?;
        let track = rect.height() - 12.0;
        if track <= 0.0
            || self.mouse.0 < rect.x1 - 10.0
            || self.mouse.0 > rect.x1
            || self.mouse.1 < rect.y0 + 6.0
            || self.mouse.1 > rect.y1 - 6.0
        {
            return None;
        }
        let thumb = (track * rect.height() / (rect.height() + entry.scroll_max))
            .max(28.0)
            .min(track);
        let top = rect.y0 + 6.0 + (track - thumb) * entry.scroll / entry.scroll_max;
        let grab = if self.mouse.1 >= top && self.mouse.1 <= top + thumb {
            self.mouse.1 - top
        } else {
            thumb / 2.0
        };
        Some((id, grab))
    }
    fn drag_scrollbar(&mut self, id: &str, grab: f64) -> Vec<Value> {
        let Some(entry) = self.entries.get(id) else {
            return vec![];
        };
        let Some(rect) = self.visible_rect(id) else {
            return vec![];
        };
        let track = rect.height() - 12.0;
        let thumb = (track * rect.height() / (rect.height() + entry.scroll_max))
            .max(28.0)
            .min(track);
        let travel = track - thumb;
        if travel <= 0.0 {
            return vec![];
        }
        let offset =
            ((self.mouse.1 - grab - rect.y0 - 6.0) / travel).clamp(0.0, 1.0) * entry.scroll_max;
        self.scroll_to(id, offset)
    }
    fn scroll_to(&mut self, id: &str, offset: f64) -> Vec<Value> {
        if !offset.is_finite() {
            return vec![];
        }
        let entry = self.entries.get_mut(id).unwrap();
        let next = offset.clamp(0.0, entry.scroll_max);
        if (next - entry.scroll).abs() < 1e-6 {
            return vec![];
        }
        entry.scroll = next;
        if !entry
            .node
            .control
            .as_ref()
            .is_some_and(|control| control.role == "virtualList")
        {
            self.dirty.paint = true;
        }
        vec![json!({"type":"scroll", "id":id, "offset":next, "max":entry.scroll_max})]
    }
    pub fn selected_text(&self) -> Option<String> {
        self.focused
            .as_ref()
            .filter(|_| self.select_all)
            .and_then(|id| self.entries[id].node.value.clone())
    }
    pub fn key(&mut self, key: &str) -> Vec<Value> {
        if key == "Tab" || key == "ShiftTab" {
            let ids = self.focus_order();
            if !ids.is_empty() {
                let index = self
                    .focused
                    .as_ref()
                    .and_then(|id| ids.iter().position(|i| i == id));
                let next = if key == "ShiftTab" {
                    index.map_or(ids.len() - 1, |i| (i + ids.len() - 1) % ids.len())
                } else {
                    index.map_or(0, |i| (i + 1) % ids.len())
                };
                if let Some(blurred) = self.focus(&ids[next]) {
                    return vec![json!({"type":"blur", "id":blurred})];
                }
            }
            return vec![];
        }
        let Some(id) = self.focused.clone() else {
            return vec![];
        };
        if self.entries[&id]
            .node
            .control
            .as_ref()
            .is_some_and(|control| control.role == "select")
            && matches!(key, "ArrowDown" | "ArrowUp" | "Home" | "End" | "Escape")
        {
            return vec![json!({"type":"key", "id":id, "key":key})];
        }
        if matches!(self.entries[&id].node.kind.as_str(), "button" | "pressable")
            && (key == "Enter" || key == "Space")
        {
            return vec![json!({"type":"click", "id": id})];
        }
        if self.entries[&id].node.kind == "slider" {
            let control = self.entries[&id].node.control.as_ref().unwrap();
            let value = match key {
                "ArrowRight" | "ArrowUp" => control.value + control.step,
                "ArrowLeft" | "ArrowDown" => control.value - control.step,
                "Home" => control.min,
                "End" => control.max,
                _ => return vec![],
            };
            return self.set_slider(&id, value);
        }
        if let Some(control) = &self.entries[&id].node.control
            && !control.group.is_empty()
            && matches!(control.role.as_str(), "radio" | "tab")
            && matches!(
                key,
                "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Home" | "End"
            )
        {
            let group = control.group.clone();
            let choices: Vec<_> = self
                .order
                .iter()
                .filter(|candidate| {
                    self.interactive(candidate)
                        && self.entries[*candidate]
                            .node
                            .control
                            .as_ref()
                            .is_some_and(|c| c.group == group)
                })
                .cloned()
                .collect();
            if choices.is_empty() {
                return vec![];
            }
            let index = choices
                .iter()
                .position(|candidate| candidate == &id)
                .unwrap_or(0);
            let next = match key {
                "Home" => 0,
                "End" => choices.len() - 1,
                "ArrowLeft" | "ArrowUp" => (index + choices.len() - 1) % choices.len(),
                _ => (index + 1) % choices.len(),
            };
            let blurred = self.focus(&choices[next]);
            let mut events = vec![json!({"type":"click", "id":choices[next]})];
            if let Some(blurred) = blurred {
                events.push(json!({"type":"blur", "id":blurred}));
            }
            return events;
        }
        if !matches!(self.entries[&id].node.kind.as_str(), "input" | "textarea") {
            return vec![];
        }
        let multiline = self.entries[&id].node.kind == "textarea";
        let value = self.entries[&id].node.value.clone().unwrap_or_default();
        self.caret = floor_boundary(&value, self.caret.min(value.len()));
        match key {
            "SelectAll" => self.select_all = true,
            "Home" => {
                self.caret = if multiline {
                    self.textarea_visual_edge(&id, false).unwrap_or(0)
                } else {
                    0
                };
                self.select_all = false;
            }
            "End" => {
                self.caret = if multiline {
                    self.textarea_visual_edge(&id, true).unwrap_or(value.len())
                } else {
                    value.len()
                };
                self.select_all = false;
            }
            "ArrowLeft" => {
                self.caret = previous_boundary(&value, self.caret);
                self.select_all = false;
            }
            "ArrowRight" => {
                self.caret = next_boundary(&value, self.caret);
                self.select_all = false;
            }
            "ArrowUp" if multiline => {
                if let Some(next) = self.textarea_vertical_index(&id, -1.0) {
                    self.caret = next;
                }
                self.select_all = false;
            }
            "ArrowDown" if multiline => {
                if let Some(next) = self.textarea_vertical_index(&id, 1.0) {
                    self.caret = next;
                }
                self.select_all = false;
            }
            "Enter" if multiline => {
                let mut changed = value.clone();
                if self.select_all {
                    changed.clear();
                    self.caret = 0;
                }
                changed.insert(self.caret, '\n');
                self.caret += 1;
                self.select_all = false;
                return self.set_input(id, changed);
            }
            "Backspace" | "Delete" => {
                let mut changed = value.clone();
                if self.select_all {
                    changed.clear();
                    self.caret = 0;
                } else if key == "Backspace" {
                    let start = previous_boundary(&value, self.caret);
                    changed.replace_range(start..self.caret, "");
                    self.caret = start;
                } else {
                    changed.replace_range(self.caret..next_boundary(&value, self.caret), "");
                }
                self.select_all = false;
                return self.set_input(id, changed);
            }
            _ => return vec![],
        }
        if multiline {
            self.ensure_focused_textarea_caret_visible();
        }
        self.dirty.paint = true;
        vec![]
    }
    pub fn type_text(&mut self, text: &str) -> Vec<Value> {
        let Some(id) = self.focused.clone() else {
            return vec![];
        };
        if !matches!(self.entries[&id].node.kind.as_str(), "input" | "textarea") {
            return vec![];
        }
        let multiline = self.entries[&id].node.kind == "textarea";
        let mut value = self.entries[&id].node.value.clone().unwrap_or_default();
        if self.select_all {
            value.clear();
            self.caret = 0;
        }
        self.caret = floor_boundary(&value, self.caret.min(value.len()));
        let text: String = text
            .chars()
            .filter(|c| !c.is_control() || (multiline && *c == '\n'))
            .collect();
        value.insert_str(self.caret, &text);
        self.caret += text.len();
        self.select_all = false;
        self.set_input(id, value)
    }
    fn set_input(&mut self, id: String, value: String) -> Vec<Value> {
        let entry = self.entries.get_mut(&id).unwrap();
        entry.node.value = Some(value.clone());
        entry.measure_dirty = true;
        self.text.layouts.remove(&id);
        self.dirty = Dirty::all();
        vec![json!({"type":"change", "id": id, "value": value})]
    }

    fn place_textarea_caret_from_pointer(&mut self, id: &str) {
        let entry = &self.entries[id];
        let pad = entry.node.insets("padding");
        let border = entry.node.insets("borderWidth");
        let rect = self.visible_rect(id).unwrap_or(entry.rect);
        let width =
            (entry.rect.width() - (pad[1] + pad[3] + border[1] + border[3]) as f64).max(0.0) as f32;
        let x = (self.mouse.0 - rect.x0 - pad[3] as f64 - border[3] as f64).max(0.0) as f32;
        let y = (self.mouse.1 - rect.y0 - pad[0] as f64 - border[0] as f64 + entry.scroll).max(0.0)
            as f32;
        let value = entry.node.value.as_deref().unwrap_or("");
        if let Some(index) = self.text.index_at(id, x, y, width) {
            self.caret = floor_boundary(value, index.min(value.len()));
            self.select_all = false;
            self.dirty.paint = true;
        }
    }

    fn textarea_metrics(&self, id: &str) -> Option<(f32, f64, String)> {
        let entry = self.entries.get(id)?;
        if entry.node.kind != "textarea" {
            return None;
        }
        let pad = entry.node.insets("padding");
        let border = entry.node.insets("borderWidth");
        let width =
            (entry.rect.width() - (pad[1] + pad[3] + border[1] + border[3]) as f64).max(0.0) as f32;
        let height =
            (entry.rect.height() - (pad[0] + pad[2] + border[0] + border[2]) as f64).max(0.0);
        Some((width, height, entry.node.value.clone().unwrap_or_default()))
    }

    fn textarea_vertical_index(&mut self, id: &str, direction: f32) -> Option<usize> {
        let (width, _, value) = self.textarea_metrics(id)?;
        let caret = floor_boundary(&value, self.caret.min(value.len()));
        let cursor = self.text.caret_rect(id, caret, width)?;
        let x = cursor.x0 as f32;
        let y = if direction < 0.0 {
            (cursor.y0 as f32 - 1.0).max(0.0)
        } else {
            cursor.y1 as f32 + 1.0
        };
        let next = self.text.index_at(id, x, y, width)?;
        Some(floor_boundary(&value, next.min(value.len())))
    }

    fn textarea_visual_edge(&mut self, id: &str, end: bool) -> Option<usize> {
        let (width, _, value) = self.textarea_metrics(id)?;
        let caret = floor_boundary(&value, self.caret.min(value.len()));
        let cursor = self.text.caret_rect(id, caret, width)?;
        let x = if end { width } else { 0.0 };
        let y = ((cursor.y0 + cursor.y1) * 0.5) as f32;
        let next = self.text.index_at(id, x, y, width)?;
        Some(floor_boundary(&value, next.min(value.len())))
    }

    fn ensure_focused_textarea_caret_visible(&mut self) {
        let Some(id) = self.focused.clone() else {
            return;
        };
        let Some((width, viewport_height, value)) = self.textarea_metrics(&id) else {
            return;
        };
        let caret = floor_boundary(&value, self.caret.min(value.len()));
        let Some(cursor) = self.text.caret_rect(&id, caret, width) else {
            return;
        };
        let entry = self.entries.get_mut(&id).unwrap();
        let next = if cursor.y0 < entry.scroll {
            cursor.y0
        } else if cursor.y1 > entry.scroll + viewport_height {
            cursor.y1 - viewport_height
        } else {
            entry.scroll
        };
        entry.scroll = next.clamp(0.0, entry.scroll_max);
    }

    pub fn snapshots(&self) -> Vec<Value> {
        let mut result = vec![];
        self.snapshot_node(&self.root, 0.0, &mut result);
        result
    }
    fn snapshot_node(&self, id: &str, offset: f64, out: &mut Vec<Value>) {
        let e = &self.entries[id];
        out.push(json!({"id":id,"kind":e.node.kind,"x":e.rect.x0,"y":e.rect.y0-offset,"width":e.rect.width(),"height":e.rect.height(),"scroll":e.scroll,"scrollMax":e.scroll_max,"text":e.node.text_value(),"control":e.node.control}));
        for child in &e.children {
            self.snapshot_node(child, offset + e.scroll, out);
        }
    }
    pub fn layout_node_count(&self) -> usize {
        self.layout.total_node_count()
    }
    #[cfg(test)]
    pub(crate) fn image_cache_len(&self) -> usize {
        self.images.len()
    }
    #[cfg(test)]
    pub(crate) fn resolved_visual_string(&self, id: &str, key: &str, fallback: &str) -> String {
        let entry = &self.entries[id];
        let state = VisualState {
            hovered: self.hovered.as_deref() == Some(id),
            active: self.pressed.as_deref() == Some(id) && self.hovered.as_deref() == Some(id),
            focused: self.focused.as_deref() == Some(id),
            disabled: entry.node.disabled,
        };
        visual_string(&entry.node, key, fallback, state).to_string()
    }
}

fn floor_boundary(value: &str, position: usize) -> usize {
    value
        .grapheme_indices(true)
        .map(|(i, _)| i)
        .chain(std::iter::once(value.len()))
        .take_while(|i| *i <= position)
        .last()
        .unwrap_or(0)
}
fn previous_boundary(value: &str, position: usize) -> usize {
    value
        .grapheme_indices(true)
        .map(|(i, _)| i)
        .take_while(|i| *i < position)
        .last()
        .unwrap_or(0)
}
fn next_boundary(value: &str, position: usize) -> usize {
    value
        .grapheme_indices(true)
        .map(|(i, _)| i)
        .find(|i| *i > position)
        .unwrap_or(value.len())
}

pub fn color(hex: &str) -> Color {
    let hex = hex.trim_start_matches('#');
    let number = u32::from_str_radix(hex, 16).unwrap_or(0);
    if hex.len() == 8 {
        Color::from_rgba8(
            (number >> 24) as u8,
            (number >> 16) as u8,
            (number >> 8) as u8,
            number as u8,
        )
    } else {
        Color::from_rgb8((number >> 16) as u8, (number >> 8) as u8, number as u8)
    }
}

struct Outline<'a> {
    width: f64,
    offset: f64,
    radius_override: Option<f64>,
    color: &'a str,
    style: &'a str,
}

fn paint_outline(
    scene: &mut Scene,
    transform: Affine,
    rect: BoxRect,
    base_radius: f64,
    outline: Outline<'_>,
) {
    let Outline {
        width,
        offset,
        radius_override,
        color: outline_color,
        style: outline_style,
    } = outline;
    if width <= 0.0 || matches!(outline_style, "none" | "hidden") {
        return;
    }
    match outline_style {
        "dashed" => paint_outline_stroke(
            scene,
            transform,
            rect,
            base_radius,
            width,
            offset,
            radius_override,
            color(outline_color),
            Stroke::new(width).with_dashes(0.0, [width * 3.0, width * 2.0]),
            width,
            offset,
        ),
        "dotted" => paint_outline_stroke(
            scene,
            transform,
            rect,
            base_radius,
            width,
            offset,
            radius_override,
            color(outline_color),
            Stroke::new(width)
                .with_caps(Cap::Round)
                .with_dashes(0.0, [0.01, width * 2.0]),
            width,
            offset,
        ),
        "double" => {
            let band = width / 3.0;
            paint_outline_stroke(
                scene,
                transform,
                rect,
                base_radius,
                band,
                offset,
                radius_override,
                color(outline_color),
                Stroke::new(band),
                width,
                offset,
            );
            paint_outline_stroke(
                scene,
                transform,
                rect,
                base_radius,
                band,
                offset + band * 2.0,
                radius_override,
                color(outline_color),
                Stroke::new(band),
                width,
                offset,
            );
        }
        "inset" | "outset" => {
            let light = shade_hex(outline_color, 0.35);
            let dark = shade_hex(outline_color, -0.35);
            let top_left = if outline_style == "inset" {
                &dark
            } else {
                &light
            };
            let bottom_right = if outline_style == "inset" {
                &light
            } else {
                &dark
            };
            paint_directional_outline(
                scene,
                transform,
                rect,
                base_radius,
                width,
                offset,
                radius_override,
                top_left,
                bottom_right,
                width,
                offset,
            );
        }
        "groove" | "ridge" => {
            let light = shade_hex(outline_color, 0.35);
            let dark = shade_hex(outline_color, -0.35);
            let band = width / 2.0;
            let outer_is_inset = outline_style == "groove";
            let (outer_tl, outer_br) = if outer_is_inset {
                (&dark, &light)
            } else {
                (&light, &dark)
            };
            let (inner_tl, inner_br) = if outer_is_inset {
                (&light, &dark)
            } else {
                (&dark, &light)
            };
            paint_directional_outline(
                scene,
                transform,
                rect,
                base_radius,
                band,
                offset,
                radius_override,
                inner_tl,
                inner_br,
                width,
                offset,
            );
            paint_directional_outline(
                scene,
                transform,
                rect,
                base_radius,
                band,
                offset + band,
                radius_override,
                outer_tl,
                outer_br,
                width,
                offset,
            );
        }
        _ => paint_outline_stroke(
            scene,
            transform,
            rect,
            base_radius,
            width,
            offset,
            radius_override,
            color(outline_color),
            Stroke::new(width),
            width,
            offset,
        ),
    }
}

#[allow(clippy::too_many_arguments)]
fn paint_outline_stroke(
    scene: &mut Scene,
    transform: Affine,
    rect: BoxRect,
    base_radius: f64,
    band_width: f64,
    band_offset: f64,
    radius_override: Option<f64>,
    outline_color: Color,
    stroke: Stroke,
    total_width: f64,
    total_offset: f64,
) {
    if band_width <= 0.0 {
        return;
    }
    let max_inset = (rect.width().min(rect.height()) / 2.0 - 0.01).max(0.0);
    let expansion = (band_offset + band_width / 2.0).max(-max_inset);
    let outline_rect = BoxRect::new(
        rect.x0 - expansion,
        rect.y0 - expansion,
        rect.x1 + expansion,
        rect.y1 + expansion,
    );
    let base_expansion = total_offset + total_width / 2.0;
    let outline_radius = radius_override
        .map(|radius| radius + expansion - base_expansion)
        .unwrap_or(base_radius + expansion)
        .max(0.0);
    scene.stroke(
        &stroke,
        transform,
        outline_color,
        None,
        &RoundedRect::from_rect(outline_rect, outline_radius),
    );
}

#[allow(clippy::too_many_arguments)]
fn paint_directional_outline(
    scene: &mut Scene,
    transform: Affine,
    rect: BoxRect,
    base_radius: f64,
    band_width: f64,
    band_offset: f64,
    radius_override: Option<f64>,
    top_left_color: &str,
    bottom_right_color: &str,
    total_width: f64,
    total_offset: f64,
) {
    paint_outline_stroke(
        scene,
        transform,
        rect,
        base_radius,
        band_width,
        band_offset,
        radius_override,
        color(bottom_right_color),
        Stroke::new(band_width),
        total_width,
        total_offset,
    );

    let outer = (band_offset + band_width).max(0.0);
    let clip_rect = BoxRect::new(
        rect.x0 - outer,
        rect.y0 - outer,
        rect.x1 + outer,
        rect.y1 + outer,
    );
    let center_x = (rect.x0 + rect.x1) / 2.0;
    let center_y = (rect.y0 + rect.y1) / 2.0;
    for clip in [
        BoxRect::new(clip_rect.x0, clip_rect.y0, clip_rect.x1, center_y),
        BoxRect::new(clip_rect.x0, clip_rect.y0, center_x, clip_rect.y1),
    ] {
        scene.push_clip_layer(Fill::NonZero, transform, &clip);
        paint_outline_stroke(
            scene,
            transform,
            rect,
            base_radius,
            band_width,
            band_offset,
            radius_override,
            color(top_left_color),
            Stroke::new(band_width),
            total_width,
            total_offset,
        );
        scene.pop_layer();
    }
}

fn shade_hex(hex: &str, amount: f64) -> String {
    let raw = hex.trim_start_matches('#');
    let parsed = u32::from_str_radix(raw, 16).unwrap_or(0);
    let (r, g, b, a) = if raw.len() == 8 {
        (
            (parsed >> 24) as u8,
            (parsed >> 16) as u8,
            (parsed >> 8) as u8,
            parsed as u8,
        )
    } else {
        ((parsed >> 16) as u8, (parsed >> 8) as u8, parsed as u8, 255)
    };
    let adjust = |channel: u8| -> u8 {
        if amount >= 0.0 {
            (channel as f64 + (255.0 - channel as f64) * amount.clamp(0.0, 1.0)).round() as u8
        } else {
            (channel as f64 * (1.0 + amount.clamp(-1.0, 0.0))).round() as u8
        }
    };
    format!(
        "#{:02x}{:02x}{:02x}{:02x}",
        adjust(r),
        adjust(g),
        adjust(b),
        a
    )
}
fn dimension(v: &Value) -> Dimension {
    if let Some(n) = v.as_f64() {
        return length(n as f32);
    }
    if let Some(s) = v
        .as_str()
        .and_then(|s| s.strip_suffix('%'))
        .and_then(|s| s.parse::<f32>().ok())
    {
        return percent(s / 100.0);
    }
    auto()
}
fn limit(v: &Value) -> LengthPercentageAuto {
    if let Some(n) = v.as_f64() {
        return length(n as f32);
    }
    if let Some(s) = v
        .as_str()
        .and_then(|s| s.strip_suffix('%'))
        .and_then(|s| s.parse::<f32>().ok())
    {
        return percent(s / 100.0);
    }
    auto()
}
fn layout_style(node: &Node, suppress_border: bool) -> Style {
    let pad = node.insets("padding");
    let margin = node.insets("margin");
    let border = if suppress_border {
        [0.0; 4]
    } else {
        node.insets("borderWidth").map(|value| value.max(0.0))
    };
    let mut style = Style {
        display: match node.string("display", "flex") {
            "grid" => Display::Grid,
            "none" => Display::None,
            _ => Display::Flex,
        },
        flex_direction: if node.string(
            "direction",
            if node.kind == "row" { "row" } else { "column" },
        ) == "row"
        {
            FlexDirection::Row
        } else {
            FlexDirection::Column
        },
        flex_wrap: if node.style["wrap"].as_bool().unwrap_or(false) {
            FlexWrap::Wrap
        } else {
            FlexWrap::NoWrap
        },
        position: if node.string("position", "relative") == "absolute" {
            Position::Absolute
        } else {
            Position::Relative
        },
        inset: Rect {
            top: limit(&node.style["top"]),
            right: limit(&node.style["right"]),
            bottom: limit(&node.style["bottom"]),
            left: limit(&node.style["left"]),
        },
        size: Size {
            width: dimension(&node.style["width"]),
            height: dimension(&node.style["height"]),
        },
        min_size: Size {
            width: limit(&node.style["minWidth"]),
            height: limit(&node.style["minHeight"]),
        },
        max_size: Size {
            width: limit(&node.style["maxWidth"]),
            height: limit(&node.style["maxHeight"]),
        },
        padding: Rect {
            top: length(pad[0]),
            right: length(pad[1]),
            bottom: length(pad[2]),
            left: length(pad[3]),
        },
        margin: Rect {
            top: length(margin[0]),
            right: length(margin[1]),
            bottom: length(margin[2]),
            left: length(margin[3]),
        },
        border: Rect {
            top: length(border[0]),
            right: length(border[1]),
            bottom: length(border[2]),
            left: length(border[3]),
        },
        gap: Size {
            width: length(node.number("gap", 0.0)),
            height: length(node.number("gap", 0.0)),
        },
        flex_grow: node.number("flex", 0.0),
        flex_shrink: node.number("shrink", 0.0),
        align_items: Some(match node.string("align", "stretch") {
            "start" => AlignItems::START,
            "center" => AlignItems::CENTER,
            "end" => AlignItems::END,
            _ => AlignItems::STRETCH,
        }),
        justify_content: Some(match node.string("justify", "start") {
            "center" => JustifyContent::CENTER,
            "end" => JustifyContent::END,
            "between" => JustifyContent::SPACE_BETWEEN,
            _ => JustifyContent::START,
        }),
        ..Default::default()
    };
    if node.style["flex"].as_f64().is_some_and(|n| n > 0.0) {
        style.flex_basis = length(0.0);
        style.min_size.width = length(0.0);
    }
    if node.kind == "scroll" {
        style.overflow.y = taffy::style::Overflow::Scroll;
        style.min_size.height = length(0.0);
    }
    if style.display == Display::Grid {
        style.grid_template_columns =
            vec![fr(1.0); node.number("columns", 2.0).clamp(1.0, 24.0) as usize];
    }
    style
}
