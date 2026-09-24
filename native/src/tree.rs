use crate::{
    paint::PaintTarget,
    protocol::Node,
    text::{AccessibilityTextLine, TEXT_KEYS, TextEngine},
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Path,
    sync::Arc,
};
use taffy::prelude::*;
use unicode_segmentation::UnicodeSegmentation;
use vello::{
    Scene,
    kurbo::{Affine, Cap, Rect as BoxRect, RoundedRect, Stroke, Vec2},
    peniko::{Blob, Color, Fill, ImageAlphaType, ImageData, ImageFormat},
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
    "aspectRatio",
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
const MAX_SVG_RASTER_DIMENSION: u32 = 4096;

fn load_image_data(path: &str) -> Result<ImageData, String> {
    let extension = Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default();
    if extension.eq_ignore_ascii_case("svg") {
        return load_svg_image(path);
    }
    let image = image::open(path).map_err(|error| error.to_string())?;
    let rgba = image.to_rgba8();
    Ok(ImageData {
        width: rgba.width(),
        height: rgba.height(),
        format: ImageFormat::Rgba8,
        alpha_type: ImageAlphaType::Alpha,
        data: Blob::new(Arc::new(rgba.into_raw())),
    })
}

fn load_svg_image(path: &str) -> Result<ImageData, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    let options = resvg::usvg::Options {
        resources_dir: fs::canonicalize(path)
            .ok()
            .and_then(|resolved| resolved.parent().map(Path::to_path_buf)),
        ..resvg::usvg::Options::default()
    };
    let tree = resvg::usvg::Tree::from_data(&bytes, &options).map_err(|error| error.to_string())?;
    let intrinsic = tree.size().to_int_size();
    let largest = intrinsic.width().max(intrinsic.height()).max(1);
    let scale = if largest > MAX_SVG_RASTER_DIMENSION {
        MAX_SVG_RASTER_DIMENSION as f32 / largest as f32
    } else {
        1.0
    };
    let width = ((intrinsic.width() as f32 * scale).round() as u32).max(1);
    let height = ((intrinsic.height() as f32 * scale).round() as u32).max(1);
    let mut pixmap = resvg::tiny_skia::Pixmap::new(width, height)
        .ok_or_else(|| format!("SVG raster target is too large: {width}x{height}"))?;
    resvg::render(
        &tree,
        resvg::tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );
    Ok(ImageData {
        width,
        height,
        format: ImageFormat::Rgba8,
        alpha_type: ImageAlphaType::AlphaPremultiplied,
        data: Blob::new(Arc::new(pixmap.take())),
    })
}

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
    axis: ScrollbarAxis,
    grab: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ScrollbarAxis {
    Horizontal,
    Vertical,
}

#[derive(Clone, Debug)]
struct ImeComposition {
    target: String,
    base_value: String,
    replace_start: usize,
    replace_end: usize,
    original_caret: usize,
    original_anchor: Option<usize>,
    preedit: String,
    cursor: Option<(usize, usize)>,
}

#[derive(Clone, Debug)]
struct ImeBlock {
    target: String,
    boundary_seen: bool,
}

struct ImeDisplay {
    node: Node,
    value: String,
    marked_range: (usize, usize),
    cursor_range: Option<(usize, usize)>,
}

struct EditLayout {
    node: Node,
    value: String,
    caret: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AccessibilityScrollAlignment {
    Top,
    Bottom,
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

fn input_display_index(node: &Node, value: &str, actual_index: usize) -> usize {
    if node.kind == "input" && node.input_type == "password" {
        let actual_index = floor_boundary(value, actual_index.min(value.len()));
        value[..actual_index].graphemes(true).count() * '•'.len_utf8()
    } else {
        floor_boundary(value, actual_index.min(value.len()))
    }
}

fn input_actual_index(node: &Node, value: &str, display_index: usize) -> usize {
    if node.kind == "input" && node.input_type == "password" {
        let graphemes = display_index / '•'.len_utf8();
        value
            .grapheme_indices(true)
            .nth(graphemes)
            .map(|(index, _)| index)
            .unwrap_or(value.len())
    } else {
        floor_boundary(value, display_index.min(value.len()))
    }
}

fn valid_number_edit(value: &str) -> bool {
    if value.is_empty() {
        return true;
    }
    let mut exponent_at = None;
    for (index, ch) in value.char_indices() {
        if matches!(ch, 'e' | 'E') {
            if exponent_at.is_some() {
                return false;
            }
            exponent_at = Some(index);
        }
    }
    let (mantissa, exponent) = exponent_at.map_or((value, None), |index| {
        (&value[..index], Some(&value[index + 1..]))
    });
    let mantissa_body = mantissa.strip_prefix(['+', '-']).unwrap_or(mantissa);
    if mantissa_body
        .chars()
        .any(|ch| !ch.is_ascii_digit() && ch != '.')
        || mantissa_body.chars().filter(|ch| *ch == '.').count() > 1
    {
        return false;
    }
    if let Some(exponent) = exponent {
        if !mantissa_body.chars().any(|ch| ch.is_ascii_digit()) {
            return false;
        }
        let exponent = exponent.strip_prefix(['+', '-']).unwrap_or(exponent);
        exponent.chars().all(|ch| ch.is_ascii_digit())
    } else {
        true
    }
}

pub struct Entry {
    pub node: Node,
    pub(crate) children: Vec<String>,
    pub(crate) parent: Option<String>,
    layout_id: Option<NodeId>,
    layout_dirty: bool,
    structure_dirty: bool,
    measure_dirty: bool,
    pub rect: BoxRect,
    bounds: BoxRect,
    pub scroll_x: f64,
    pub scroll_max_x: f64,
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
    svgs: HashMap<String, crate::svg::SvgScene>,
    stacking: HashMap<String, f32>,
    window_chrome_suppressed: bool,
    pub dirty: Dirty,
    pub hovered: Option<String>,
    pub focused: Option<String>,
    pressed: Option<String>,
    scroll_drag: Option<ScrollDrag>,
    pub mouse: (f64, f64),
    caret: usize,
    selection_anchor: Option<usize>,
    text_dragging: bool,
    ime: Option<ImeComposition>,
    ime_blocked: Option<ImeBlock>,
    modal_focus_returns: Vec<(String, Option<String>)>,
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

    fn portal_roots(&self) -> Vec<String> {
        self.order
            .iter()
            .filter(|id| {
                if !self.entries[*id].node.portal {
                    return false;
                }
                let mut parent = self.entries[*id].parent.as_deref();
                while let Some(parent_id) = parent {
                    if self.entries[parent_id].node.portal {
                        return false;
                    }
                    parent = self.entries[parent_id].parent.as_deref();
                }
                true
            })
            .cloned()
            .collect()
    }

    fn ancestor_scroll_offset(&self, id: &str) -> Vec2 {
        let mut offset = Vec2::ZERO;
        let mut parent = self.entries[id].parent.as_deref();
        while let Some(parent_id) = parent {
            let entry = &self.entries[parent_id];
            offset += Vec2::new(entry.scroll_x, entry.scroll);
            parent = self.entries[parent_id].parent.as_deref();
        }
        offset
    }

    fn outside_dismissal_at_pointer(&self) -> Option<String> {
        let mut portals: Vec<_> = self
            .portal_roots()
            .into_iter()
            .filter(|id| self.entries[id].node.dismiss_on_outside)
            .collect();
        portals.sort_by(|a, b| {
            self.stacking
                .get(a)
                .copied()
                .unwrap_or(0.0)
                .total_cmp(&self.stacking.get(b).copied().unwrap_or(0.0))
        });
        let portal = portals.last()?;
        let offset = self.ancestor_scroll_offset(portal);
        let bounds = self.entries[portal].bounds + Vec2::new(-offset.x, -offset.y);
        (!bounds.contains(self.mouse)).then(|| portal.clone())
    }

    pub fn new(root: Node) -> Self {
        let mut tree = Self {
            root: root.id.clone(),
            entries: HashMap::new(),
            order: Vec::new(),
            layout: TaffyTree::new(),
            text: TextEngine::new(),
            images: HashMap::new(),
            svgs: HashMap::new(),
            stacking: HashMap::new(),
            window_chrome_suppressed: false,
            dirty: Dirty::all(),
            hovered: None,
            focused: None,
            pressed: None,
            scroll_drag: None,
            mouse: (-1.0, -1.0),
            caret: 0,
            selection_anchor: None,
            text_dragging: false,
            ime: None,
            ime_blocked: None,
            modal_focus_returns: Vec::new(),
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
        let previous_modal = self.active_modal().map(str::to_string);
        let previous_focus = self.focused.clone();
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
                || id
                    .strip_suffix("::ime")
                    .is_some_and(|id| self.entries.contains_key(id))
        });
        self.prune_images();
        self.prune_svgs();
        let restore_focus = self.modal_focus_transition(previous_modal, previous_focus);
        self.prune_interaction();
        if let Some(id) = restore_focus {
            self.focus(&id);
        }
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
            if let Some(incoming) = node.value.as_deref()
                && let Some(ime) = self
                    .ime
                    .as_ref()
                    .filter(|ime| ime.target == node.id && incoming != ime.base_value)
            {
                let boundary_seen = ime.preedit.is_empty();
                self.ime = None;
                self.ime_blocked = Some(ImeBlock {
                    target: node.id.clone(),
                    boundary_seen,
                });
                self.text.layouts.remove(&format!("{}::ime", node.id));
                self.selection_anchor = None;
                self.caret = floor_boundary(incoming, self.caret.min(incoming.len()));
                self.dirty.paint = true;
            }
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
                || node.display_text() != prev.node.display_text()
                || TEXT_KEYS
                    .iter()
                    .any(|key| node.style[*key] != prev.node.style[*key]);
            if structure_dirty || layout_dirty || measure_dirty {
                self.dirty.layout = true;
            }
            if node.display_text() != prev.node.display_text()
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
            match load_image_data(&node.src) {
                Ok(image) => {
                    self.images.insert(node.src.clone(), image);
                }
                Err(e) => self.warnings.push(format!("Image '{}': {e}", node.src)),
            }
        }
        if node.kind == "svg" {
            let changed = previous
                .as_ref()
                .is_none_or(|entry| entry.node.svg != node.svg || entry.node.kind != node.kind);
            if changed || !self.svgs.contains_key(&node.id) {
                match crate::svg::compile(&node.svg) {
                    Ok(scene) => {
                        self.svgs.insert(node.id.clone(), scene);
                    }
                    Err(error) => {
                        self.svgs.remove(&node.id);
                        self.warnings.push(format!("SVG '{}': {error}", node.id));
                    }
                }
            }
        } else {
            self.svgs.remove(&node.id);
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
                scroll_x: previous.as_ref().map(|e| e.scroll_x).unwrap_or(0.0),
                scroll_max_x: previous.as_ref().map(|e| e.scroll_max_x).unwrap_or(0.0),
                scroll: previous.as_ref().map(|e| e.scroll).unwrap_or(0.0),
                scroll_max: previous.as_ref().map(|e| e.scroll_max).unwrap_or(0.0),
            },
        );
    }
    pub fn patch(&mut self, nodes: Vec<Node>) -> Result<(), String> {
        let previous_modal = self.active_modal().map(str::to_string);
        let previous_focus = self.focused.clone();
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
        self.prune_svgs();
        let restore_focus = self.modal_focus_transition(previous_modal, previous_focus);
        self.prune_interaction();
        if let Some(id) = restore_focus {
            self.focus(&id);
        }
        self.refresh_stacking();
        Ok(())
    }

    fn modal_focus_transition(
        &mut self,
        previous_modal: Option<String>,
        previous_focus: Option<String>,
    ) -> Option<String> {
        let next_modal = self.active_modal().map(str::to_string);
        if previous_modal == next_modal {
            return None;
        }

        let valid_return = |id: &str| self.entries.contains_key(id);
        match next_modal {
            Some(next) => {
                if let Some(position) = self
                    .modal_focus_returns
                    .iter()
                    .position(|(modal, _)| modal == &next)
                {
                    let closed = self.modal_focus_returns.split_off(position + 1);
                    return closed
                        .into_iter()
                        .rev()
                        .filter_map(|(_, focus)| focus)
                        .find(|id| valid_return(id));
                }

                let fallback = previous_focus.filter(|id| valid_return(id)).or_else(|| {
                    self.modal_focus_returns
                        .iter()
                        .rev()
                        .filter_map(|(_, focus)| focus.as_ref())
                        .find(|id| valid_return(id))
                        .cloned()
                });
                self.modal_focus_returns.retain(|(modal, _)| {
                    self.entries
                        .get(modal)
                        .is_some_and(|entry| entry.node.modal)
                });
                self.modal_focus_returns.push((next, fallback));
                None
            }
            None => {
                let closed = std::mem::take(&mut self.modal_focus_returns);
                closed
                    .into_iter()
                    .rev()
                    .filter_map(|(_, focus)| focus)
                    .find(|id| valid_return(id))
            }
        }
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
    fn prune_svgs(&mut self) {
        self.svgs.retain(|id, _| {
            self.entries
                .get(id)
                .is_some_and(|entry| entry.node.kind == "svg")
        });
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
        entry.scroll_max_x = if entry.node.kind == "scroll"
            && matches!(
                entry.node.scroll_orientation.as_str(),
                "horizontal" | "both"
            ) {
            layout.scroll_width() as f64
        } else {
            0.0
        };
        entry.scroll_max = if entry.node.kind == "scroll"
            && matches!(entry.node.scroll_orientation.as_str(), "vertical" | "both")
        {
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
        entry.scroll_x = entry.scroll_x.clamp(0.0, entry.scroll_max_x);
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
        self.paint(scale, &mut scene);
        scene
    }
    pub(crate) fn paint<P: PaintTarget>(&mut self, scale: f64, target: &mut P) {
        self.painted_nodes = 0;
        let root_rect = self.entries[&self.root].rect;
        self.paint_node(&self.root.clone(), Vec2::ZERO, scale, root_rect, target);
        let mut portals = self.portal_roots();
        portals.sort_by(|a, b| {
            self.stacking
                .get(a)
                .copied()
                .unwrap_or(0.0)
                .total_cmp(&self.stacking.get(b).copied().unwrap_or(0.0))
        });
        for portal in portals {
            let offset = self.ancestor_scroll_offset(&portal);
            self.paint_node(&portal, offset, scale, root_rect, target);
        }
        self.paints += 1;
        self.dirty.paint = false;
    }
    fn visual_state_for(&self, id: &str, node: &Node) -> VisualState {
        let otp_slot_focused = node.control.as_ref().is_some_and(|control| {
            if control.role != "otpSlot" || control.group.is_empty() {
                return false;
            }
            let Some(focused) = self.focused.as_deref() else {
                return false;
            };
            if focused != control.group {
                return false;
            }
            let Some(input) = self.entries.get(focused) else {
                return false;
            };
            let value = input.node.value.as_deref().unwrap_or("");
            let caret = floor_boundary(value, self.caret.min(value.len()));
            let caret_slot = value[..caret].graphemes(true).count();
            let max_slot = control.max.max(0.0) as usize;
            control.value.max(0.0) as usize == caret_slot.min(max_slot)
        });
        VisualState {
            hovered: self.hovered.as_deref() == Some(id),
            active: self.pressed.as_deref() == Some(id) && self.hovered.as_deref() == Some(id),
            focused: self.focused.as_deref() == Some(id) || otp_slot_focused,
            disabled: node.disabled,
        }
    }
    fn paint_node<P: PaintTarget>(
        &mut self,
        id: &str,
        offset: Vec2,
        scale: f64,
        clip: BoxRect,
        target: &mut P,
    ) {
        let entry = &self.entries[id];
        let bounds = entry.bounds + Vec2::new(-offset.x, -offset.y);
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
        let rect = entry.rect + Vec2::new(-offset.x, -offset.y);
        let scroll_x = entry.scroll_x;
        let scroll = entry.scroll;
        let scroll_max_x = entry.scroll_max_x;
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
        let state = self.visual_state_for(id, &node);
        let suppress_root_chrome = self.window_chrome_suppressed && id == self.root;
        let radius = if suppress_root_chrome {
            0.0
        } else {
            visual_number(&node, "radius", 0.0, state) as f64
        };
        let shape = RoundedRect::from_rect(rect, radius);
        let bg = visual_string(&node, "background", "#00000000", state);
        if bg != "#00000000" {
            target.fill(Fill::NonZero, transform, color(bg), &shape);
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
                target.stroke(
                    &Stroke::new(width),
                    transform,
                    border_color,
                    &RoundedRect::from_rect(
                        rect.inset(-width / 2.0),
                        (radius - width / 2.0).max(0.0),
                    ),
                );
            } else {
                target.push_clip(Fill::NonZero, transform, &shape);
                if border[0] > 0.0 {
                    target.fill(
                        Fill::NonZero,
                        transform,
                        border_color,
                        &BoxRect::new(
                            rect.x0,
                            rect.y0,
                            rect.x1,
                            (rect.y0 + border[0]).min(rect.y1),
                        ),
                    );
                }
                if border[1] > 0.0 {
                    target.fill(
                        Fill::NonZero,
                        transform,
                        border_color,
                        &BoxRect::new(
                            (rect.x1 - border[1]).max(rect.x0),
                            rect.y0,
                            rect.x1,
                            rect.y1,
                        ),
                    );
                }
                if border[2] > 0.0 {
                    target.fill(
                        Fill::NonZero,
                        transform,
                        border_color,
                        &BoxRect::new(
                            rect.x0,
                            (rect.y1 - border[2]).max(rect.y0),
                            rect.x1,
                            rect.y1,
                        ),
                    );
                }
                if border[3] > 0.0 {
                    target.fill(
                        Fill::NonZero,
                        transform,
                        border_color,
                        &BoxRect::new(
                            rect.x0,
                            rect.y0,
                            (rect.x0 + border[3]).min(rect.x1),
                            rect.y1,
                        ),
                    );
                }
                target.pop_layer();
            }
        }
        let outline_width = visual_number(&node, "outlineWidth", 0.0, state).max(0.0) as f64;
        if outline_width > 0.0 {
            paint_outline(
                target,
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
            let ime_display = self.ime_display(id);
            let render_node = ime_display
                .as_ref()
                .map(|display| display.node.clone())
                .unwrap_or_else(|| node.clone());
            if ime_display.is_some() {
                self.text.prepare(&render_node);
            }
            let pad = node.insets("padding");
            let available_width =
                (rect.width() - pad[1] as f64 - pad[3] as f64 - border[1] - border[3]).max(0.0)
                    as f32;
            let (tw, th) = self.text.measure(
                &render_node.id,
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
                && render_node.value.as_deref().unwrap_or("").is_empty()
            {
                visual_string(&node, "placeholderColor", "#a1a1aa", state)
            } else {
                visual_string(&node, "foreground", "#18181b", state)
            };
            target.push_clip(Fill::NonZero, transform, &shape);
            if matches!(node.kind.as_str(), "input" | "textarea")
                && self.focused.as_deref() == Some(id)
                && ime_display.is_none()
                && let Some((start, end)) = self.selected_range()
            {
                let wrap_width = (node.kind == "textarea").then_some(available_width);
                for selection in self.selection_rects(id, start, end, wrap_width) {
                    target.fill(
                        Fill::NonZero,
                        transform,
                        color(visual_string(&node, "selectionColor", "#dbeafe", state)),
                        &BoxRect::new(
                            x + selection.x0,
                            y + selection.y0,
                            x + selection.x1,
                            y + selection.y1,
                        ),
                    );
                }
            }
            if let Some(display) = &ime_display {
                let wrap_width = (node.kind == "textarea").then_some(available_width);
                if let Some((anchor, caret)) = display.cursor_range
                    && anchor != caret
                {
                    for selection in self.text_range_rects(
                        &display.node,
                        &display.node.id,
                        &display.value,
                        anchor.min(caret),
                        anchor.max(caret),
                        wrap_width,
                    ) {
                        target.fill(
                            Fill::NonZero,
                            transform,
                            color(visual_string(&node, "selectionColor", "#dbeafe", state)),
                            &BoxRect::new(
                                x + selection.x0,
                                y + selection.y0,
                                x + selection.x1,
                                y + selection.y1,
                            ),
                        );
                    }
                }
                for marked in self.text_range_rects(
                    &display.node,
                    &display.node.id,
                    &display.value,
                    display.marked_range.0,
                    display.marked_range.1,
                    wrap_width,
                ) {
                    let underline_y = y + marked.y1 - 1.0;
                    target.fill(
                        Fill::NonZero,
                        transform,
                        color(visual_string(&node, "caretColor", "#18181b", state)),
                        &BoxRect::new(x + marked.x0, underline_y, x + marked.x1, underline_y + 1.0),
                    );
                }
            }
            self.text.draw(
                target,
                &render_node,
                (x, y),
                available_width,
                color(foreground),
                scale,
            );
            if matches!(node.kind.as_str(), "input" | "textarea")
                && self.focused.as_deref() == Some(id)
            {
                let caret = if let Some(display) = &ime_display {
                    display.cursor_range.map(|(_, caret)| caret)
                } else {
                    let value = node.value.as_deref().unwrap_or("");
                    Some(floor_boundary(value, self.caret.min(value.len())))
                };
                if let Some(caret) = caret {
                    let value = ime_display
                        .as_ref()
                        .map(|display| display.value.as_str())
                        .unwrap_or_else(|| node.value.as_deref().unwrap_or(""));
                    let display_index = input_display_index(&render_node, value, caret);
                    let wrap_width = (node.kind == "textarea").then_some(available_width);
                    if let Some(cursor) =
                        self.text
                            .caret_rect(&render_node.id, display_index, wrap_width)
                    {
                        let content_right = rect.x1 - pad[1] as f64 - border[1];
                        let cx = (x + cursor.x0).clamp(x, content_right.max(x));
                        let cy0 = y + cursor.y0;
                        let cy1 = y + cursor.y1;
                        target.fill(
                            Fill::NonZero,
                            transform,
                            color(visual_string(&node, "caretColor", "#18181b", state)),
                            &BoxRect::new(cx, cy0, cx + 1.0, cy1.max(cy0 + 1.0)),
                        );
                    }
                }
            }
            target.pop_layer();
        }
        if node.kind == "svg"
            && let Some(scene) = self.svgs.get(id).cloned()
        {
            crate::svg::draw(
                target,
                &scene,
                rect,
                color(visual_string(&node, "foreground", "#18181b", state)),
                scale,
            );
        }
        if node.kind == "slider" {
            crate::controls::slider(
                target,
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
            target.push_clip(Fill::NonZero, transform, &shape);
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
                target.draw_image(
                    &node.src,
                    image,
                    transform * Affine::translate((tx, ty)) * Affine::scale(factor),
                );
            } else {
                target.fill(
                    Fill::NonZero,
                    transform,
                    color(visual_string(
                        &node,
                        "placeholderBackground",
                        "#f4f4f5",
                        state,
                    )),
                    &shape,
                );
            }
            target.pop_layer();
        }
        if node.kind == "scroll" {
            target.push_clip(Fill::NonZero, transform, &shape);
        }
        let child_clip = if node.kind == "scroll" {
            clip.intersect(rect)
        } else {
            clip
        };
        for child in &children {
            if self.entries[child].node.portal && !node.portal {
                continue;
            }
            self.paint_node(
                child,
                offset + Vec2::new(scroll_x, scroll),
                scale,
                child_clip,
                target,
            );
        }
        if node.kind == "scroll" {
            target.pop_layer();
        }
        if matches!(node.kind.as_str(), "scroll" | "textarea") && scroll_max > 0.0 {
            let track = rect.height() - 12.0;
            let thumb = (track * rect.height() / (rect.height() + scroll_max)).max(28.0);
            let top = rect.y0 + 6.0 + (track - thumb) * scroll / scroll_max;
            target.fill(
                Fill::NonZero,
                transform,
                color(visual_string(&node, "scrollbarColor", "#d4d4d8", state)),
                &RoundedRect::new(rect.x1 - 7.0, top, rect.x1 - 3.0, top + thumb, 2.0),
            );
        }
        if node.kind == "scroll" && scroll_max_x > 0.0 {
            let track = rect.width() - 12.0;
            let thumb = (track * rect.width() / (rect.width() + scroll_max_x))
                .max(28.0)
                .min(track);
            let left = rect.x0 + 6.0 + (track - thumb) * scroll_x / scroll_max_x;
            target.fill(
                Fill::NonZero,
                transform,
                color(visual_string(&node, "scrollbarColor", "#d4d4d8", state)),
                &RoundedRect::new(left, rect.y1 - 7.0, left + thumb, rect.y1 - 3.0, 2.0),
            );
        }
    }
    fn hit_root(&self, scroll_only: bool) -> Option<String> {
        let root_rect = self.entries[&self.root].rect;
        let mut portals = self.portal_roots();
        portals.sort_by(|a, b| {
            self.stacking
                .get(a)
                .copied()
                .unwrap_or(0.0)
                .total_cmp(&self.stacking.get(b).copied().unwrap_or(0.0))
        });
        for portal in portals.iter().rev() {
            if let Some(id) = self.hit(
                portal,
                self.ancestor_scroll_offset(portal),
                root_rect,
                scroll_only,
            ) {
                return Some(id);
            }
        }
        self.hit(&self.root, Vec2::ZERO, root_rect, scroll_only)
    }

    fn hit(&self, id: &str, offset: Vec2, clip: BoxRect, scroll_only: bool) -> Option<String> {
        let entry = &self.entries[id];
        if !(entry.bounds + Vec2::new(-offset.x, -offset.y)).contains(self.mouse) {
            return None;
        }
        if entry.node.disabled || entry.node.string("display", "flex") == "none" {
            return None;
        }
        let rect = entry.rect + Vec2::new(-offset.x, -offset.y);
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
            if self.entries[child].node.portal && !entry.node.portal {
                continue;
            }
            if let Some(id) = self.hit(
                child,
                offset + Vec2::new(entry.scroll_x, entry.scroll),
                clip,
                scroll_only,
            ) {
                return Some(id);
            }
        }
        let blocks_pointer = entry.node.string("pointerEvents", "auto") == "block";
        let eligible = if scroll_only {
            (matches!(entry.node.kind.as_str(), "scroll" | "textarea")
                && (entry.scroll_max > 0.0 || entry.scroll_max_x > 0.0))
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
    fn accessibility_interactive(&self, id: &str) -> bool {
        self.interactive(id)
            && self
                .active_modal()
                .is_none_or(|modal| self.is_descendant_of(id, modal))
    }
    fn accessibility_in_scope(&self, id: &str) -> bool {
        self.entries.contains_key(id)
            && self
                .active_modal()
                .is_none_or(|modal| self.is_descendant_of(id, modal))
    }
    fn roving_group(&self, id: &str) -> Option<&str> {
        let group = self.entries.get(id)?.node.roving_group.as_str();
        (!group.is_empty()).then_some(group).or_else(|| {
            self.entries[id]
                .node
                .control
                .as_ref()
                .map(|control| control.group.as_str())
                .filter(|group| !group.is_empty())
        })
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
            if let Some(group) = self.roving_group(id) {
                let choice = group_choice
                    .entry(group.to_string())
                    .or_insert_with(|| id.clone());
                let chosen = self.entries[id]
                    .node
                    .control
                    .as_ref()
                    .is_some_and(|control| {
                        control.selected == Some(true) || control.checked == Some(true)
                    });
                if chosen {
                    *choice = id.clone();
                }
            }
        }
        if let Some(id) = &self.focused
            && let Some(group) = self.roving_group(id)
            && group_choice.contains_key(group)
        {
            group_choice.insert(group.to_string(), id.clone());
        }
        self.order
            .iter()
            .filter(|id| {
                self.interactive(id)
                    && self.entries[*id].node.focusable
                    && modal.is_none_or(|modal| self.is_descendant_of(id, modal))
                    && self
                        .roving_group(id)
                        .is_none_or(|group| group_choice.get(group) == Some(*id))
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
            self.ime_cancel();
            blurred = self.focused.replace(id.to_string());
            self.selection_anchor = None;
            self.text_dragging = false;
            self.caret = self.entries[id].node.value.as_deref().map_or(0, str::len);
            self.dirty.paint = true;
        }
        let mut ancestor = self.entries[id].parent.clone();
        while let Some(parent_id) = ancestor {
            if self.entries[&parent_id].node.kind == "scroll"
                && let (Some(target), Some(viewport)) =
                    (self.visible_rect(id), self.visible_rect(&parent_id))
            {
                let delta_x = if target.x0 < viewport.x0 {
                    target.x0 - viewport.x0
                } else if target.x1 > viewport.x1 {
                    target.x1 - viewport.x1
                } else {
                    0.0
                };
                let delta_y = if target.y0 < viewport.y0 {
                    target.y0 - viewport.y0
                } else if target.y1 > viewport.y1 {
                    target.y1 - viewport.y1
                } else {
                    0.0
                };
                let entry = self.entries.get_mut(&parent_id).unwrap();
                let next_x = (entry.scroll_x + delta_x).clamp(0.0, entry.scroll_max_x);
                let next_y = (entry.scroll + delta_y).clamp(0.0, entry.scroll_max);
                if next_x != entry.scroll_x || next_y != entry.scroll {
                    entry.scroll_x = next_x;
                    entry.scroll = next_y;
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
            self.ime_cancel();
            self.focused = None;
            self.caret = 0;
            self.selection_anchor = None;
            self.text_dragging = false;
            if modal.is_some()
                && let Some(id) = self.focus_order().into_iter().next()
            {
                let _ = self.focus(&id);
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

    pub(crate) fn active_modal(&self) -> Option<&str> {
        self.order
            .iter()
            .rev()
            .find(|id| self.entries[*id].node.modal)
            .map(String::as_str)
    }

    pub(crate) fn is_descendant_of(&self, id: &str, ancestor: &str) -> bool {
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
    pub(crate) fn visible_rect(&self, id: &str) -> Option<BoxRect> {
        let entry = self.entries.get(id)?;
        let mut offset = Vec2::ZERO;
        let mut current = entry.parent.as_deref();
        while let Some(parent_id) = current {
            let parent = self.entries.get(parent_id)?;
            offset += Vec2::new(parent.scroll_x, parent.scroll);
            current = parent.parent.as_deref();
        }
        Some(entry.rect + Vec2::new(-offset.x, -offset.y))
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
    fn splitter_from_pointer(&mut self, id: &str) -> Vec<Value> {
        let Some(entry) = self.entries.get(id) else {
            return vec![];
        };
        let Some(parent_id) = entry.parent.clone() else {
            return vec![];
        };
        let Some(rect) = self.visible_rect(&parent_id) else {
            return vec![];
        };
        let Some(control) = entry.node.control.as_ref() else {
            return vec![];
        };
        let ratio = if control.orientation == "vertical" {
            ((self.mouse.1 - rect.y0) / rect.height().max(1.0)).clamp(0.0, 1.0)
        } else {
            ((self.mouse.0 - rect.x0) / rect.width().max(1.0)).clamp(0.0, 1.0)
        };
        let value = control.min + (control.max - control.min) * ratio;
        self.set_slider(id, value)
    }
    pub fn pointer_move(&mut self, x: f64, y: f64) -> Vec<Value> {
        self.mouse = (x, y);
        if self.text_dragging
            && let Some(id) = self.focused.clone()
            && matches!(self.entries[&id].node.kind.as_str(), "input" | "textarea")
        {
            self.place_text_caret_from_pointer(&id);
            if self.entries[&id].node.kind == "textarea" {
                self.ensure_focused_textarea_caret_visible();
            }
        }
        if let Some(drag) = &self.scroll_drag {
            let id = drag.id.clone();
            let axis = drag.axis;
            let grab = drag.grab;
            return self.drag_scrollbar(&id, axis, grab);
        }
        let next = self.hit_root(false);
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
            .filter(|id| matches!(self.entries[id].node.kind.as_str(), "slider" | "splitter"))
        {
            events.extend(if self.entries[&id].node.kind == "splitter" {
                self.splitter_from_pointer(&id)
            } else {
                self.slider_from_pointer(&id)
            });
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
        self.text_dragging = false;
        self.ime_cancel();
        let blurred = self.focused.take();
        if blurred.is_some() || self.pressed.take().is_some() {
            self.caret = 0;
            self.selection_anchor = None;
            self.dirty.paint = true;
        }
        blurred
    }
    pub fn pointer_down(&mut self) -> Vec<Value> {
        if let Some(id) = self.outside_dismissal_at_pointer() {
            self.pressed = None;
            self.text_dragging = false;
            return vec![json!({"type":"outside", "id":id})];
        }
        if let Some((id, axis, grab)) = self.scrollbar_at_pointer() {
            self.pressed = None;
            self.scroll_drag = Some(ScrollDrag {
                id: id.clone(),
                axis,
                grab,
            });
            return self.drag_scrollbar(&id, axis, grab);
        }
        self.hovered = self.hit_root(false);
        self.pressed = self.hovered.clone();
        let mut events = vec![];
        if let Some(id) = self.hovered.clone() {
            if let Some(blurred) = self.focus(&id) {
                events.push(json!({"type":"blur", "id":blurred}));
            }
            if matches!(self.entries[&id].node.kind.as_str(), "input" | "textarea") {
                if self.ime_target() == Some(id.as_str()) {
                    self.ime_cancel();
                }
                self.place_text_caret_from_pointer(&id);
                self.selection_anchor = Some(self.caret);
                self.text_dragging = true;
            } else {
                self.text_dragging = false;
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
            .filter(|id| matches!(self.entries[id].node.kind.as_str(), "slider" | "splitter"))
        {
            events.extend(if self.entries[&id].node.kind == "splitter" {
                self.splitter_from_pointer(&id)
            } else {
                self.slider_from_pointer(&id)
            });
        }
        events
    }
    pub fn pointer_up(&mut self) -> Vec<Value> {
        self.text_dragging = false;
        if self.selection_anchor == Some(self.caret) {
            self.selection_anchor = None;
        }
        if self.scroll_drag.take().is_some() {
            return vec![];
        }
        self.hovered = self.hit_root(false);
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
    pub fn pointer_context(&mut self) -> Vec<Value> {
        if let Some(id) = self.outside_dismissal_at_pointer() {
            return vec![json!({"type":"outside", "id":id})];
        }
        self.hovered = self.hit_root(false);
        let Some(id) = self.hovered.clone() else {
            return vec![];
        };
        vec![json!({"type":"context", "id":id, "x":self.mouse.0, "y":self.mouse.1})]
    }
    #[cfg(test)]
    pub fn wheel(&mut self, delta: f64) -> Vec<Value> {
        self.wheel_2d(0.0, delta)
    }
    pub fn wheel_2d(&mut self, delta_x: f64, delta_y: f64) -> Vec<Value> {
        if let Some(id) = self.hit_root(true) {
            let entry = &self.entries[&id];
            let speed = if entry.node.kind == "scroll" {
                entry.node.scroll_speed
            } else {
                1.0
            };
            let (dx, dy) = match entry.node.kind.as_str() {
                "textarea" => (0.0, delta_y),
                "scroll" => match entry.node.scroll_orientation.as_str() {
                    "horizontal" => {
                        let horizontal = if delta_x.abs() > f64::EPSILON {
                            delta_x
                        } else {
                            delta_y
                        };
                        (horizontal, 0.0)
                    }
                    "both" => (delta_x, delta_y),
                    _ => (0.0, delta_y),
                },
                _ => (0.0, 0.0),
            };
            return self.scroll_to_2d(&id, entry.scroll_x + dx * speed, entry.scroll + dy * speed);
        }
        vec![]
    }
    fn scrollbar_at_pointer(&self) -> Option<(String, ScrollbarAxis, f64)> {
        let id = self.hit_root(true)?;
        let entry = self.entries.get(&id)?;
        if !matches!(entry.node.kind.as_str(), "scroll" | "textarea")
            || (entry.scroll_max <= 0.0 && entry.scroll_max_x <= 0.0)
        {
            return None;
        }
        let rect = self.visible_rect(&id)?;
        if entry.scroll_max > 0.0 {
            let track = rect.height() - 12.0;
            if track > 0.0
                && self.mouse.0 >= rect.x1 - 10.0
                && self.mouse.0 <= rect.x1
                && self.mouse.1 >= rect.y0 + 6.0
                && self.mouse.1 <= rect.y1 - 6.0
            {
                let thumb = (track * rect.height() / (rect.height() + entry.scroll_max))
                    .max(28.0)
                    .min(track);
                let top = rect.y0 + 6.0 + (track - thumb) * entry.scroll / entry.scroll_max;
                let grab = if self.mouse.1 >= top && self.mouse.1 <= top + thumb {
                    self.mouse.1 - top
                } else {
                    thumb / 2.0
                };
                return Some((id, ScrollbarAxis::Vertical, grab));
            }
        }
        if entry.node.kind == "scroll" && entry.scroll_max_x > 0.0 {
            let track = rect.width() - 12.0;
            if track > 0.0
                && self.mouse.1 >= rect.y1 - 10.0
                && self.mouse.1 <= rect.y1
                && self.mouse.0 >= rect.x0 + 6.0
                && self.mouse.0 <= rect.x1 - 6.0
            {
                let thumb = (track * rect.width() / (rect.width() + entry.scroll_max_x))
                    .max(28.0)
                    .min(track);
                let left = rect.x0 + 6.0 + (track - thumb) * entry.scroll_x / entry.scroll_max_x;
                let grab = if self.mouse.0 >= left && self.mouse.0 <= left + thumb {
                    self.mouse.0 - left
                } else {
                    thumb / 2.0
                };
                return Some((id, ScrollbarAxis::Horizontal, grab));
            }
        }
        None
    }
    fn drag_scrollbar(&mut self, id: &str, axis: ScrollbarAxis, grab: f64) -> Vec<Value> {
        let Some(entry) = self.entries.get(id) else {
            return vec![];
        };
        let Some(rect) = self.visible_rect(id) else {
            return vec![];
        };
        let (track, thumb, pointer, start, max) = match axis {
            ScrollbarAxis::Vertical => {
                let track = rect.height() - 12.0;
                let thumb = (track * rect.height() / (rect.height() + entry.scroll_max))
                    .max(28.0)
                    .min(track);
                (track, thumb, self.mouse.1, rect.y0, entry.scroll_max)
            }
            ScrollbarAxis::Horizontal => {
                let track = rect.width() - 12.0;
                let thumb = (track * rect.width() / (rect.width() + entry.scroll_max_x))
                    .max(28.0)
                    .min(track);
                (track, thumb, self.mouse.0, rect.x0, entry.scroll_max_x)
            }
        };
        let travel = track - thumb;
        if travel <= 0.0 || max <= 0.0 {
            return vec![];
        }
        let offset = ((pointer - grab - start - 6.0) / travel).clamp(0.0, 1.0) * max;
        match axis {
            ScrollbarAxis::Vertical => self.scroll_to_2d(id, entry.scroll_x, offset),
            ScrollbarAxis::Horizontal => self.scroll_to_2d(id, offset, entry.scroll),
        }
    }
    fn scroll_to(&mut self, id: &str, offset: f64) -> Vec<Value> {
        let x = self.entries.get(id).map_or(0.0, |entry| entry.scroll_x);
        self.scroll_to_2d(id, x, offset)
    }
    fn scroll_to_2d(&mut self, id: &str, offset_x: f64, offset_y: f64) -> Vec<Value> {
        if !offset_x.is_finite() || !offset_y.is_finite() {
            return vec![];
        }
        let entry = self.entries.get_mut(id).unwrap();
        let next_x = offset_x.clamp(0.0, entry.scroll_max_x);
        let next_y = offset_y.clamp(0.0, entry.scroll_max);
        if (next_x - entry.scroll_x).abs() < 1e-6 && (next_y - entry.scroll).abs() < 1e-6 {
            return vec![];
        }
        entry.scroll_x = next_x;
        entry.scroll = next_y;
        if !entry
            .node
            .control
            .as_ref()
            .is_some_and(|control| control.role == "virtualList")
        {
            self.dirty.paint = true;
        }
        let (offset, max) =
            if entry.node.kind == "scroll" && entry.node.scroll_orientation == "horizontal" {
                (next_x, entry.scroll_max_x)
            } else {
                (next_y, entry.scroll_max)
            };
        vec![json!({
            "type":"scroll", "id":id, "offset":offset, "max":max,
            "offsetX":next_x, "offsetY":next_y,
            "maxX":entry.scroll_max_x, "maxY":entry.scroll_max
        })]
    }

    fn ime_display(&self, id: &str) -> Option<ImeDisplay> {
        let ime = self
            .ime
            .as_ref()
            .filter(|ime| ime.target == id && !ime.preedit.is_empty())?;
        let entry = self.entries.get(id)?;
        if !matches!(entry.node.kind.as_str(), "input" | "textarea") {
            return None;
        }
        let base = entry.node.value.as_deref().unwrap_or("");
        if base != ime.base_value {
            return None;
        }
        let start = floor_boundary(base, ime.replace_start.min(base.len()));
        let end = floor_boundary(base, ime.replace_end.min(base.len())).max(start);
        let mut value = String::with_capacity(base.len() - (end - start) + ime.preedit.len());
        value.push_str(&base[..start]);
        value.push_str(&ime.preedit);
        value.push_str(&base[end..]);
        let marked_range = (start, start + ime.preedit.len());
        let cursor_range = ime.cursor.map(|(anchor, caret)| {
            let anchor = floor_char_boundary(&ime.preedit, anchor.min(ime.preedit.len()));
            let caret = floor_char_boundary(&ime.preedit, caret.min(ime.preedit.len()));
            (start + anchor, start + caret)
        });
        let mut node = entry.node.clone();
        node.id = format!("{id}::ime");
        node.value = Some(value.clone());
        node.placeholder.clear();
        Some(ImeDisplay {
            node,
            value,
            marked_range,
            cursor_range,
        })
    }

    fn prepare_edit_layout(&mut self, id: &str) -> Option<EditLayout> {
        if let Some(display) = self.ime_display(id) {
            let caret = display
                .cursor_range
                .map(|(_, caret)| caret)
                .unwrap_or(display.marked_range.1);
            self.text.prepare(&display.node);
            return Some(EditLayout {
                node: display.node,
                value: display.value,
                caret,
            });
        }
        let entry = self.entries.get(id)?;
        if !matches!(entry.node.kind.as_str(), "input" | "textarea") {
            return None;
        }
        let node = entry.node.clone();
        let value = node.value.clone().unwrap_or_default();
        let caret = floor_boundary(&value, self.caret.min(value.len()));
        self.text.prepare(&node);
        Some(EditLayout { node, value, caret })
    }

    pub(crate) fn ime_cursor_area(&mut self) -> Option<BoxRect> {
        let id = self.focused.clone()?;
        let entry = self.entries.get(&id)?;
        if !matches!(entry.node.kind.as_str(), "input" | "textarea") {
            return None;
        }
        let visible = self.visible_rect(&id)?;
        let pad = entry.node.insets("padding");
        let border = entry.node.insets("borderWidth");
        let scroll = entry.scroll;
        let multiline = entry.node.kind == "textarea";
        let available_width =
            (entry.rect.width() - (pad[1] + pad[3] + border[1] + border[3]) as f64).max(0.0) as f32;
        let layout = self.prepare_edit_layout(&id)?;
        let wrap_width = multiline.then_some(available_width);
        let (_, text_height) = self.text.measure(&layout.node.id, wrap_width);
        let display_index = input_display_index(&layout.node, &layout.value, layout.caret);
        let cursor = self
            .text
            .caret_rect(&layout.node.id, display_index, wrap_width)?;
        let origin_x = visible.x0 + pad[3] as f64 + border[3] as f64;
        let origin_y = if multiline {
            visible.y0 + pad[0] as f64 + border[0] as f64 - scroll
        } else {
            visible.y0 + (visible.height() - text_height as f64) / 2.0
        };
        let content_right = visible.x1 - pad[1] as f64 - border[1] as f64;
        let x = (origin_x + cursor.x0).clamp(origin_x, content_right.max(origin_x));
        let y = origin_y + cursor.y0;
        let width = (cursor.x1 - cursor.x0).max(1.0);
        let height = (cursor.y1 - cursor.y0).max(1.0);
        Some(BoxRect::new(x, y, x + width, y + height))
    }

    fn clear_ime_layout(&mut self, target: &str) {
        self.text.layouts.remove(&format!("{target}::ime"));
    }

    pub(crate) fn ime_active(&self) -> bool {
        self.ime.as_ref().is_some_and(|ime| !ime.preedit.is_empty())
    }

    pub(crate) fn ime_target(&self) -> Option<&str> {
        self.ime.as_ref().map(|ime| ime.target.as_str())
    }

    pub(crate) fn ime_enabled(&mut self, target: &str) {
        if self.focused.as_deref() == Some(target) {
            self.ime_blocked = None;
        }
    }

    #[cfg(test)]
    pub(crate) fn ime_display_text(&self) -> Option<String> {
        let target = self.ime.as_ref()?.target.as_str();
        self.ime_display(target)
            .map(|display| display.node.display_text())
    }

    #[cfg(test)]
    pub(crate) fn ime_cursor_bytes(&self) -> Option<(usize, usize)> {
        self.ime.as_ref()?.cursor
    }

    #[cfg(test)]
    pub(crate) fn ime_marked_rects(&mut self) -> Vec<BoxRect> {
        let id = match self.ime.as_ref() {
            Some(ime) => ime.target.clone(),
            None => return vec![],
        };
        let Some(display) = self.ime_display(&id) else {
            return vec![];
        };
        let entry = &self.entries[&id];
        let pad = entry.node.insets("padding");
        let border = entry.node.insets("borderWidth");
        let available_width =
            (entry.rect.width() - (pad[1] + pad[3] + border[1] + border[3]) as f64).max(0.0) as f32;
        let wrap_width = (entry.node.kind == "textarea").then_some(available_width);
        self.text.prepare(&display.node);
        self.text_range_rects(
            &display.node,
            &display.node.id,
            &display.value,
            display.marked_range.0,
            display.marked_range.1,
            wrap_width,
        )
    }

    pub(crate) fn ime_preedit(&mut self, target: &str, text: &str, cursor: Option<(usize, usize)>) {
        if self.focused.as_deref() != Some(target)
            || !self
                .entries
                .get(target)
                .is_some_and(|entry| matches!(entry.node.kind.as_str(), "input" | "textarea"))
        {
            return;
        }

        if self
            .ime_blocked
            .as_ref()
            .is_some_and(|blocked| blocked.target == target)
        {
            if text.is_empty()
                && let Some(blocked) = self.ime_blocked.as_mut()
            {
                if blocked.boundary_seen {
                    self.ime_blocked = None;
                } else {
                    blocked.boundary_seen = true;
                }
            }
            return;
        }

        if text.is_empty() {
            if let Some(ime) = self.ime.as_mut().filter(|ime| ime.target == target) {
                ime.preedit.clear();
                ime.cursor = None;
                self.clear_ime_layout(target);
                self.dirty.paint = true;
                self.ensure_focused_textarea_caret_visible();
            }
            return;
        }

        let value = self.entries[target].node.value.clone().unwrap_or_default();
        let restart = self.ime.as_ref().is_none_or(|ime| {
            ime.target != target || ime.base_value != value || ime.preedit.is_empty()
        });
        if restart {
            self.ime_cancel();
            self.ime_blocked = None;
            let caret = floor_boundary(&value, self.caret.min(value.len()));
            let (replace_start, replace_end) = self.selected_range().unwrap_or((caret, caret));
            self.ime = Some(ImeComposition {
                target: target.to_string(),
                base_value: value,
                replace_start,
                replace_end,
                original_caret: self.caret,
                original_anchor: self.selection_anchor,
                preedit: String::new(),
                cursor: None,
            });
        }

        let normalized_cursor = cursor.map(|(anchor, caret)| {
            (
                floor_char_boundary(text, anchor.min(text.len())),
                floor_char_boundary(text, caret.min(text.len())),
            )
        });
        if let Some(ime) = self.ime.as_mut() {
            ime.preedit.clear();
            ime.preedit.push_str(text);
            ime.cursor = normalized_cursor;
        }
        self.clear_ime_layout(target);
        self.dirty.paint = true;
        self.ensure_focused_textarea_caret_visible();
    }

    pub(crate) fn ime_cancel(&mut self) {
        let Some(ime) = self.ime.take() else {
            return;
        };
        let boundary_seen = ime.preedit.is_empty();
        self.ime_blocked = Some(ImeBlock {
            target: ime.target.clone(),
            boundary_seen,
        });
        self.clear_ime_layout(&ime.target);
        if self.focused.as_deref() == Some(ime.target.as_str())
            && let Some(entry) = self.entries.get(&ime.target)
        {
            let value = entry.node.value.as_deref().unwrap_or("");
            self.caret = floor_boundary(value, ime.original_caret.min(value.len()));
            self.selection_anchor = ime
                .original_anchor
                .map(|anchor| floor_boundary(value, anchor.min(value.len())));
        }
        self.dirty.paint = true;
        self.ensure_focused_textarea_caret_visible();
    }

    pub(crate) fn ime_commit(&mut self, target: &str, text: &str) -> Vec<Value> {
        if self.focused.as_deref() != Some(target)
            || !self
                .entries
                .get(target)
                .is_some_and(|entry| matches!(entry.node.kind.as_str(), "input" | "textarea"))
        {
            return vec![];
        }

        let Some(ime) = self.ime.take() else {
            if self
                .ime_blocked
                .as_ref()
                .is_some_and(|blocked| blocked.target == target)
            {
                self.ime_blocked = None;
                return vec![];
            }
            return self.type_text(text);
        };
        if ime.target != target {
            self.ime = Some(ime);
            return vec![];
        }
        self.clear_ime_layout(target);
        if self
            .ime_blocked
            .as_ref()
            .is_some_and(|blocked| blocked.target == target)
        {
            self.ime_blocked = None;
        }

        let multiline = self.entries[target].node.kind == "textarea";
        let current = self.entries[target].node.value.clone().unwrap_or_default();
        if current != ime.base_value {
            self.caret = floor_boundary(&current, self.caret.min(current.len()));
            self.selection_anchor = None;
            self.dirty.paint = true;
            return vec![];
        }
        let start = floor_boundary(&current, ime.replace_start.min(current.len()));
        let end = floor_boundary(&current, ime.replace_end.min(current.len())).max(start);
        let committed: String = text
            .chars()
            .filter(|ch| !ch.is_control() || (multiline && *ch == '\n'))
            .collect();
        let mut value = current;
        value.replace_range(start..end, &committed);
        if self.entries[target].node.kind == "input"
            && self.entries[target].node.input_type == "number"
            && !valid_number_edit(&value)
        {
            let base = self.entries[target].node.value.as_deref().unwrap_or("");
            self.caret = floor_boundary(base, ime.original_caret.min(base.len()));
            self.selection_anchor = ime
                .original_anchor
                .map(|anchor| floor_boundary(base, anchor.min(base.len())));
            self.dirty.paint = true;
            return vec![];
        }
        self.caret = start + committed.len();
        self.selection_anchor = None;
        self.set_input(target.to_string(), value)
    }

    fn selected_range(&self) -> Option<(usize, usize)> {
        let anchor = self.selection_anchor?;
        let id = self.focused.as_ref()?;
        if !matches!(self.entries[id].node.kind.as_str(), "input" | "textarea") {
            return None;
        }
        let value = self.entries[id].node.value.as_deref().unwrap_or("");
        let a = floor_boundary(value, anchor.min(value.len()));
        let b = floor_boundary(value, self.caret.min(value.len()));
        (a != b).then_some((a.min(b), a.max(b)))
    }
    pub fn selected_text(&self) -> Option<String> {
        let id = self.focused.as_ref()?;
        if self.entries[id].node.kind == "input" && self.entries[id].node.input_type == "password" {
            return None;
        }
        let value = self.entries[id].node.value.as_deref().unwrap_or("");
        let (start, end) = self.selected_range()?;
        Some(value[start..end].to_string())
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
        if self.ime_target() == Some(id.as_str())
            && matches!(self.entries[&id].node.kind.as_str(), "input" | "textarea")
        {
            if self.ime_active() {
                if key == "Escape" {
                    self.ime_cancel();
                }
                return vec![];
            } else {
                self.ime_cancel();
            }
        }
        if self.entries[&id]
            .node
            .control
            .as_ref()
            .is_some_and(|control| control.role == "treeitem")
            && matches!(key, "ArrowLeft" | "ArrowRight")
        {
            return vec![json!({"type":"key", "id":id, "key":key})];
        }
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
        if self.entries[&id].node.kind == "splitter" {
            let control = self.entries[&id].node.control.as_ref().unwrap();
            let value = match (control.orientation.as_str(), key) {
                ("vertical", "ArrowDown") | ("horizontal", "ArrowRight") => {
                    control.value + control.step
                }
                ("vertical", "ArrowUp") | ("horizontal", "ArrowLeft") => {
                    control.value - control.step
                }
                (_, "Home") => control.min,
                (_, "End") => control.max,
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
        if let Some(group) = self.roving_group(&id).map(str::to_string)
            && (self
                .entries
                .get(&group)
                .and_then(|entry| entry.node.control.as_ref())
                .is_some_and(|control| {
                    matches!(
                        control.role.as_str(),
                        "navigation" | "togglegroup" | "tree" | "grid"
                    )
                })
                || self.entries[&id]
                    .node
                    .control
                    .as_ref()
                    .is_some_and(|control| {
                        matches!(
                            control.role.as_str(),
                            "toggle" | "menuitem" | "treeitem" | "row"
                        )
                    }))
            && (if self
                .entries
                .get(&group)
                .and_then(|entry| entry.node.control.as_ref())
                .is_some_and(|control| matches!(control.role.as_str(), "tree" | "grid"))
                || self.entries[&id]
                    .node
                    .control
                    .as_ref()
                    .is_some_and(|control| matches!(control.role.as_str(), "treeitem" | "row"))
            {
                matches!(key, "ArrowUp" | "ArrowDown" | "Home" | "End")
            } else {
                matches!(
                    key,
                    "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Home" | "End"
                )
            })
        {
            let choices: Vec<_> = self
                .order
                .iter()
                .filter(|candidate| {
                    self.interactive(candidate)
                        && self.roving_group(candidate) == Some(group.as_str())
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
            return self.focus(&choices[next]).map_or_else(Vec::new, |blurred| {
                vec![json!({"type":"blur", "id":blurred})]
            });
        }
        if !matches!(self.entries[&id].node.kind.as_str(), "input" | "textarea") {
            return vec![];
        }
        let multiline = self.entries[&id].node.kind == "textarea";
        let value = self.entries[&id].node.value.clone().unwrap_or_default();
        self.caret = floor_boundary(&value, self.caret.min(value.len()));
        let selecting = key.starts_with("Shift");
        let key = key.strip_prefix("Shift").unwrap_or(key);
        if selecting && self.selection_anchor.is_none() {
            self.selection_anchor = Some(self.caret);
        }
        match key {
            "SelectAll" => {
                self.selection_anchor = Some(0);
                self.caret = value.len();
            }
            "Home" => {
                self.caret = if multiline {
                    self.textarea_visual_edge(&id, false).unwrap_or(0)
                } else {
                    0
                };
                if !selecting {
                    self.selection_anchor = None;
                }
            }
            "End" => {
                self.caret = if multiline {
                    self.textarea_visual_edge(&id, true).unwrap_or(value.len())
                } else {
                    value.len()
                };
                if !selecting {
                    self.selection_anchor = None;
                }
            }
            "ArrowLeft" => {
                self.caret = previous_boundary(&value, self.caret);
                if !selecting {
                    self.selection_anchor = None;
                }
            }
            "ArrowRight" => {
                self.caret = next_boundary(&value, self.caret);
                if !selecting {
                    self.selection_anchor = None;
                }
            }
            "ArrowUp" if multiline => {
                if let Some(next) = self.textarea_vertical_index(&id, -1.0) {
                    self.caret = next;
                }
                if !selecting {
                    self.selection_anchor = None;
                }
            }
            "ArrowDown" if multiline => {
                if let Some(next) = self.textarea_vertical_index(&id, 1.0) {
                    self.caret = next;
                }
                if !selecting {
                    self.selection_anchor = None;
                }
            }
            "Enter" if multiline => {
                let mut changed = value.clone();
                if let Some((start, end)) = self.selected_range() {
                    changed.replace_range(start..end, "");
                    self.caret = start;
                }
                changed.insert(self.caret, '\n');
                self.caret += 1;
                self.selection_anchor = None;
                return self.set_input(id, changed);
            }
            "Backspace" | "Delete" => {
                let mut changed = value.clone();
                if let Some((start, end)) = self.selected_range() {
                    changed.replace_range(start..end, "");
                    self.caret = start;
                } else if key == "Backspace" {
                    let start = previous_boundary(&value, self.caret);
                    changed.replace_range(start..self.caret, "");
                    self.caret = start;
                } else {
                    changed.replace_range(self.caret..next_boundary(&value, self.caret), "");
                }
                self.selection_anchor = None;
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
        self.ime_cancel();
        let Some(id) = self.focused.clone() else {
            return vec![];
        };
        if !matches!(self.entries[&id].node.kind.as_str(), "input" | "textarea") {
            return vec![];
        }
        let multiline = self.entries[&id].node.kind == "textarea";
        let mut value = self.entries[&id].node.value.clone().unwrap_or_default();
        if let Some((start, end)) = self.selected_range() {
            value.replace_range(start..end, "");
            self.caret = start;
        }
        self.caret = floor_boundary(&value, self.caret.min(value.len()));
        let text: String = text
            .chars()
            .filter(|c| !c.is_control() || (multiline && *c == '\n'))
            .collect();
        value.insert_str(self.caret, &text);
        if self.entries[&id].node.kind == "input"
            && self.entries[&id].node.input_type == "number"
            && !valid_number_edit(&value)
        {
            return vec![];
        }
        self.caret += text.len();
        self.selection_anchor = None;
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

    pub(crate) fn accessibility_text_selection(&self, id: &str) -> Option<(usize, usize)> {
        if self.focused.as_deref() != Some(id) {
            return None;
        }
        let entry = self.entries.get(id)?;
        if !matches!(entry.node.kind.as_str(), "input" | "textarea") {
            return None;
        }
        let value = entry.node.value.as_deref().unwrap_or("");
        let focus = floor_boundary(value, self.caret.min(value.len()));
        let anchor = self
            .selection_anchor
            .map(|anchor| floor_boundary(value, anchor.min(value.len())))
            .unwrap_or(focus);
        Some((anchor, focus))
    }

    pub(crate) fn accessibility_text_lines(
        &mut self,
        id: &str,
        value: &str,
    ) -> Vec<AccessibilityTextLine> {
        let Some(entry) = self.entries.get(id) else {
            return vec![];
        };
        if !matches!(entry.node.kind.as_str(), "input" | "textarea") {
            return vec![];
        }
        let node = entry.node.clone();
        let scroll = entry.scroll;
        let rect = entry.rect;
        let Some(visible) = self.visible_rect(id) else {
            return vec![];
        };
        let pad = node.insets("padding");
        let border = node.insets("borderWidth");
        let multiline = node.kind == "textarea";
        let available_width =
            (rect.width() - (pad[1] + pad[3] + border[1] + border[3]) as f64).max(0.0) as f32;
        let wrap_width = multiline.then_some(available_width);
        self.text.prepare(&node);
        let (_, text_height) = self.text.measure(id, wrap_width);
        let origin_x = visible.x0 + pad[3] as f64 + border[3] as f64;
        let origin_y = if multiline {
            visible.y0 + pad[0] as f64 + border[0] as f64 - scroll
        } else {
            visible.y0 + (visible.height() - text_height as f64) / 2.0
        };
        let mut lines = self.text.accessibility_lines(id, value, wrap_width);
        for line in &mut lines {
            line.x0 += origin_x;
            line.x1 += origin_x;
            line.y0 += origin_y;
            line.y1 += origin_y;
        }
        lines
    }

    pub(crate) fn accessibility_selection_dragging(&self) -> bool {
        self.text_dragging
    }

    pub(crate) fn accessibility_focus(&mut self, id: &str) -> Vec<Value> {
        self.focus(id).map_or_else(Vec::new, |blurred| {
            vec![json!({"type":"blur", "id":blurred})]
        })
    }

    pub(crate) fn accessibility_blur(&mut self, id: &str) -> Vec<Value> {
        if self.focused.as_deref() != Some(id) {
            return vec![];
        }
        self.blur()
            .map(|blurred| vec![json!({"type":"blur", "id":blurred})])
            .unwrap_or_default()
    }

    pub(crate) fn accessibility_click(&self, id: &str) -> Vec<Value> {
        if !self.accessibility_interactive(id) {
            return vec![];
        }
        let node = &self.entries[id].node;
        if matches!(node.kind.as_str(), "button" | "pressable") {
            vec![json!({"type":"click", "id":id})]
        } else {
            vec![]
        }
    }

    pub(crate) fn accessibility_context(&self, id: &str) -> Vec<Value> {
        if !self.accessibility_interactive(id) {
            return vec![];
        }
        let Some(rect) = self.visible_rect(id) else {
            return vec![];
        };
        vec![json!({
            "type":"context",
            "id":id,
            "x":rect.center().x,
            "y":rect.center().y
        })]
    }

    fn valid_accessibility_text_value(&self, id: &str, value: &str) -> bool {
        let Some(entry) = self.entries.get(id) else {
            return false;
        };
        if !self.accessibility_interactive(id)
            || !matches!(entry.node.kind.as_str(), "input" | "textarea")
            || value
                .chars()
                .any(|ch| ch.is_control() && !(entry.node.kind == "textarea" && ch == '\n'))
        {
            return false;
        }
        entry.node.kind != "input" || entry.node.input_type != "number" || valid_number_edit(value)
    }

    pub(crate) fn accessibility_set_text_value(&mut self, id: &str, value: &str) -> Vec<Value> {
        if !self.valid_accessibility_text_value(id, value) {
            return vec![];
        }
        if self.ime_target() == Some(id) {
            self.ime_cancel();
        }
        if self.focused.as_deref() == Some(id) {
            self.caret = value.len();
            self.selection_anchor = None;
        }
        self.set_input(id.to_string(), value.to_string())
    }

    pub(crate) fn accessibility_replace_selected_text(
        &mut self,
        id: &str,
        replacement: &str,
    ) -> Vec<Value> {
        if self.focused.as_deref() != Some(id) {
            return vec![];
        }
        let Some(entry) = self.entries.get(id) else {
            return vec![];
        };
        if !matches!(entry.node.kind.as_str(), "input" | "textarea") {
            return vec![];
        }
        let mut value = entry.node.value.clone().unwrap_or_default();
        let (start, end) = self
            .selected_range()
            .unwrap_or_else(|| (self.caret.min(value.len()), self.caret.min(value.len())));
        value.replace_range(start..end, replacement);
        if !self.valid_accessibility_text_value(id, &value) {
            return vec![];
        }
        self.ime_cancel();
        self.caret = start + replacement.len();
        self.selection_anchor = None;
        self.set_input(id.to_string(), value)
    }

    pub(crate) fn accessibility_set_text_selection(
        &mut self,
        id: &str,
        anchor_character: usize,
        focus_character: usize,
    ) -> Vec<Value> {
        let Some(entry) = self.entries.get(id) else {
            return vec![];
        };
        if !self.accessibility_interactive(id)
            || !matches!(entry.node.kind.as_str(), "input" | "textarea")
        {
            return vec![];
        }
        let value = entry.node.value.clone().unwrap_or_default();
        let multiline = entry.node.kind == "textarea";
        let byte_at_character = |character: usize| {
            value
                .grapheme_indices(true)
                .nth(character)
                .map(|(index, _)| index)
                .unwrap_or(value.len())
        };
        let anchor = byte_at_character(anchor_character);
        let focus = byte_at_character(focus_character);
        let events = self.accessibility_focus(id);
        self.ime_cancel();
        self.caret = focus;
        self.selection_anchor = (anchor != focus).then_some(anchor);
        if multiline {
            self.ensure_focused_textarea_caret_visible();
        }
        self.dirty.paint = true;
        events
    }

    pub(crate) fn accessibility_set_numeric_value(&mut self, id: &str, value: f64) -> Vec<Value> {
        if !self.accessibility_interactive(id)
            || !self
                .entries
                .get(id)
                .is_some_and(|entry| matches!(entry.node.kind.as_str(), "slider" | "splitter"))
        {
            return vec![];
        }
        self.set_slider(id, value)
    }

    pub(crate) fn accessibility_adjust_numeric(&mut self, id: &str, direction: f64) -> Vec<Value> {
        let Some(control) = self
            .entries
            .get(id)
            .filter(|_| self.accessibility_interactive(id))
            .and_then(|entry| entry.node.control.as_ref())
        else {
            return vec![];
        };
        self.set_slider(id, control.value + control.step * direction.signum())
    }

    pub(crate) fn accessibility_scroll_by(
        &mut self,
        id: &str,
        direction_x: f64,
        direction_y: f64,
        page: bool,
    ) -> Vec<Value> {
        if !self.accessibility_in_scope(id) {
            return vec![];
        }
        let Some(entry) = self.entries.get(id) else {
            return vec![];
        };
        if !matches!(entry.node.kind.as_str(), "scroll" | "textarea")
            || (entry.scroll_max <= 0.0 && entry.scroll_max_x <= 0.0)
        {
            return vec![];
        }
        let rect = self.visible_rect(id);
        let amount_x = if page {
            rect.map_or(120.0, |rect| (rect.width() - 24.0).max(36.0))
        } else {
            36.0
        };
        let amount_y = if page {
            rect.map_or(120.0, |rect| (rect.height() - 24.0).max(36.0))
        } else {
            36.0
        };
        self.scroll_to_2d(
            id,
            entry.scroll_x + amount_x * direction_x.signum(),
            entry.scroll + amount_y * direction_y.signum(),
        )
    }

    pub(crate) fn accessibility_set_scroll(
        &mut self,
        id: &str,
        offset_x: f64,
        offset_y: f64,
    ) -> Vec<Value> {
        if !self.accessibility_in_scope(id) {
            return vec![];
        }
        let Some(entry) = self.entries.get(id) else {
            return vec![];
        };
        if !matches!(entry.node.kind.as_str(), "scroll" | "textarea")
            || (entry.scroll_max <= 0.0 && entry.scroll_max_x <= 0.0)
        {
            return vec![];
        }
        self.scroll_to_2d(id, offset_x, offset_y)
    }

    pub(crate) fn accessibility_scroll_into_view(&mut self, id: &str) -> Vec<Value> {
        if !self.accessibility_in_scope(id) {
            return vec![];
        }
        let mut ancestors = Vec::new();
        let mut parent = self.entries[id].parent.clone();
        while let Some(parent_id) = parent {
            parent = self.entries[&parent_id].parent.clone();
            if matches!(
                self.entries[&parent_id].node.kind.as_str(),
                "scroll" | "textarea"
            ) && (self.entries[&parent_id].scroll_max > 0.0
                || self.entries[&parent_id].scroll_max_x > 0.0)
            {
                ancestors.push(parent_id);
            }
        }
        let mut events = Vec::new();
        for ancestor in ancestors {
            let (Some(target), Some(viewport)) =
                (self.visible_rect(id), self.visible_rect(&ancestor))
            else {
                continue;
            };
            let delta_x = if target.x0 < viewport.x0 {
                target.x0 - viewport.x0
            } else if target.x1 > viewport.x1 {
                target.x1 - viewport.x1
            } else {
                0.0
            };
            let delta_y = if target.y0 < viewport.y0 {
                target.y0 - viewport.y0
            } else if target.y1 > viewport.y1 {
                target.y1 - viewport.y1
            } else {
                0.0
            };
            if delta_x != 0.0 || delta_y != 0.0 {
                let entry = &self.entries[&ancestor];
                events.extend(self.scroll_to_2d(
                    &ancestor,
                    entry.scroll_x + delta_x,
                    entry.scroll + delta_y,
                ));
            }
        }
        events
    }

    pub(crate) fn accessibility_scroll_text_position_into_view(
        &mut self,
        id: &str,
        character: usize,
        alignment: Option<AccessibilityScrollAlignment>,
    ) -> Vec<Value> {
        if !self.accessibility_in_scope(id) {
            return vec![];
        }
        let Some(entry) = self.entries.get(id) else {
            return vec![];
        };
        if !matches!(entry.node.kind.as_str(), "input" | "textarea") {
            return self.accessibility_scroll_into_view(id);
        }
        let value = entry.node.value.clone().unwrap_or_default();
        let byte = value
            .grapheme_indices(true)
            .nth(character)
            .map(|(index, _)| index)
            .unwrap_or(value.len());
        let multiline = entry.node.kind == "textarea";
        let display_byte = input_display_index(&entry.node, &value, byte);
        let mut events = Vec::new();

        if multiline {
            let Some((width, viewport_height, _)) = self.textarea_metrics(id) else {
                return vec![];
            };
            self.text.prepare(&self.entries[id].node.clone());
            if let Some(cursor) = self.text.caret_rect(id, display_byte, Some(width)) {
                let current = self.entries[id].scroll;
                let next = match alignment {
                    Some(AccessibilityScrollAlignment::Top) => cursor.y0,
                    Some(AccessibilityScrollAlignment::Bottom) => cursor.y1 - viewport_height,
                    None if cursor.y0 < current => cursor.y0,
                    None if cursor.y1 > current + viewport_height => cursor.y1 - viewport_height,
                    None => current,
                };
                if next != current {
                    events.extend(self.scroll_to(id, next));
                }
            }
        }

        if let Some(alignment) = alignment {
            let mut ancestors = Vec::new();
            let mut parent = self.entries[id].parent.clone();
            while let Some(parent_id) = parent {
                parent = self.entries[&parent_id].parent.clone();
                if matches!(
                    self.entries[&parent_id].node.kind.as_str(),
                    "scroll" | "textarea"
                ) && (self.entries[&parent_id].scroll_max > 0.0
                    || self.entries[&parent_id].scroll_max_x > 0.0)
                {
                    ancestors.push(parent_id);
                }
            }
            for ancestor in ancestors {
                let Some(target) = self.accessibility_text_position_rect(id, display_byte) else {
                    break;
                };
                let Some(viewport) = self.visible_rect(&ancestor) else {
                    continue;
                };
                let delta_x = if target.x0 < viewport.x0 {
                    target.x0 - viewport.x0
                } else if target.x1 > viewport.x1 {
                    target.x1 - viewport.x1
                } else {
                    0.0
                };
                let delta_y = match alignment {
                    AccessibilityScrollAlignment::Top => target.y0 - viewport.y0,
                    AccessibilityScrollAlignment::Bottom => target.y1 - viewport.y1,
                };
                if delta_x != 0.0 || delta_y != 0.0 {
                    let entry = &self.entries[&ancestor];
                    events.extend(self.scroll_to_2d(
                        &ancestor,
                        entry.scroll_x + delta_x,
                        entry.scroll + delta_y,
                    ));
                }
            }
        } else {
            events.extend(self.accessibility_scroll_into_view(id));
        }
        events
    }

    fn accessibility_text_position_rect(
        &mut self,
        id: &str,
        display_byte: usize,
    ) -> Option<BoxRect> {
        let entry = self.entries.get(id)?;
        if !matches!(entry.node.kind.as_str(), "input" | "textarea") {
            return self.visible_rect(id);
        }
        let node = entry.node.clone();
        let scroll = entry.scroll;
        let rect = entry.rect;
        let visible = self.visible_rect(id)?;
        let pad = node.insets("padding");
        let border = node.insets("borderWidth");
        let multiline = node.kind == "textarea";
        let available_width =
            (rect.width() - (pad[1] + pad[3] + border[1] + border[3]) as f64).max(0.0) as f32;
        let wrap_width = multiline.then_some(available_width);
        self.text.prepare(&node);
        let (_, text_height) = self.text.measure(id, wrap_width);
        let cursor = self.text.caret_rect(id, display_byte, wrap_width)?;
        let origin_x = visible.x0 + pad[3] as f64 + border[3] as f64;
        let origin_y = if multiline {
            visible.y0 + pad[0] as f64 + border[0] as f64 - scroll
        } else {
            visible.y0 + (visible.height() - text_height as f64) / 2.0
        };
        Some(BoxRect::new(
            origin_x + cursor.x0,
            origin_y + cursor.y0,
            origin_x + cursor.x1.max(cursor.x0 + 1.0),
            origin_y + cursor.y1.max(cursor.y0 + 1.0),
        ))
    }

    fn selection_rects(
        &mut self,
        id: &str,
        start: usize,
        end: usize,
        width: Option<f32>,
    ) -> Vec<BoxRect> {
        let node = self.entries[id].node.clone();
        let value = node.value.clone().unwrap_or_default();
        self.text_range_rects(&node, id, &value, start, end, width)
    }

    fn text_range_rects(
        &mut self,
        node: &Node,
        layout_id: &str,
        value: &str,
        start: usize,
        end: usize,
        width: Option<f32>,
    ) -> Vec<BoxRect> {
        let start = floor_boundary(value, start.min(value.len()));
        let end = floor_boundary(value, end.min(value.len())).max(start);
        if start == end {
            return vec![];
        }
        let display_start = input_display_index(node, value, start);
        let display_end = input_display_index(node, value, end);
        self.text
            .range_rects(layout_id, display_start, display_end, width)
            .into_iter()
            .filter(|rect| rect.x1 > rect.x0 && rect.y1 > rect.y0)
            .map(|rect| BoxRect::new(rect.x0, rect.y0, rect.x1, rect.y1))
            .collect()
    }

    fn place_text_caret_from_pointer(&mut self, id: &str) {
        let entry = &self.entries[id];
        let pad = entry.node.insets("padding");
        let border = entry.node.insets("borderWidth");
        let rect = self.visible_rect(id).unwrap_or(entry.rect);
        let width =
            (entry.rect.width() - (pad[1] + pad[3] + border[1] + border[3]) as f64).max(0.0) as f32;
        let x = (self.mouse.0 - rect.x0 - pad[3] as f64 - border[3] as f64).max(0.0) as f32;
        let multiline = entry.node.kind == "textarea";
        let y = if multiline {
            (self.mouse.1 - rect.y0 - pad[0] as f64 - border[0] as f64 + entry.scroll).max(0.0)
                as f32
        } else {
            0.0
        };
        let value = entry.node.value.as_deref().unwrap_or("");
        if let Some(index) = self.text.index_at(id, x, y, multiline.then_some(width)) {
            self.caret = input_actual_index(&entry.node, value, index);
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
        let cursor = self.text.caret_rect(id, caret, Some(width))?;
        let x = cursor.x0 as f32;
        let y = if direction < 0.0 {
            (cursor.y0 as f32 - 1.0).max(0.0)
        } else {
            cursor.y1 as f32 + 1.0
        };
        let next = self.text.index_at(id, x, y, Some(width))?;
        Some(floor_boundary(&value, next.min(value.len())))
    }

    fn textarea_visual_edge(&mut self, id: &str, end: bool) -> Option<usize> {
        let (width, _, value) = self.textarea_metrics(id)?;
        let caret = floor_boundary(&value, self.caret.min(value.len()));
        let cursor = self.text.caret_rect(id, caret, Some(width))?;
        let x = if end { width } else { 0.0 };
        let y = ((cursor.y0 + cursor.y1) * 0.5) as f32;
        let next = self.text.index_at(id, x, y, Some(width))?;
        Some(floor_boundary(&value, next.min(value.len())))
    }

    fn ensure_focused_textarea_caret_visible(&mut self) {
        let Some(id) = self.focused.clone() else {
            return;
        };
        let Some((width, viewport_height, _)) = self.textarea_metrics(&id) else {
            return;
        };
        let Some(layout) = self.prepare_edit_layout(&id) else {
            return;
        };
        let display_index = input_display_index(&layout.node, &layout.value, layout.caret);
        let Some(cursor) = self
            .text
            .caret_rect(&layout.node.id, display_index, Some(width))
        else {
            return;
        };
        let content_height = self.text.measure(&layout.node.id, Some(width)).1 as f64;
        let entry = self.entries.get_mut(&id).unwrap();
        entry.scroll_max = (content_height - viewport_height).max(0.0);
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
        self.snapshot_node(&self.root, Vec2::ZERO, &mut result);
        result
    }
    fn snapshot_node(&self, id: &str, offset: Vec2, out: &mut Vec<Value>) {
        let e = &self.entries[id];
        out.push(json!({
            "id":id,"kind":e.node.kind,
            "x":e.rect.x0-offset.x,"y":e.rect.y0-offset.y,
            "width":e.rect.width(),"height":e.rect.height(),
            "scroll":e.scroll,"scrollMax":e.scroll_max,
            "scrollX":e.scroll_x,"scrollY":e.scroll,
            "scrollMaxX":e.scroll_max_x,"scrollMaxY":e.scroll_max,
            "text":e.node.display_text(),"control":e.node.control
        }));
        for child in &e.children {
            self.snapshot_node(child, offset + Vec2::new(e.scroll_x, e.scroll), out);
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
    pub(crate) fn svg_cache_len(&self) -> usize {
        self.svgs.len()
    }
    #[cfg(test)]
    pub(crate) fn svg_cache_scene(&self, id: &str) -> Option<crate::svg::SvgScene> {
        self.svgs.get(id).cloned()
    }
    #[cfg(test)]
    pub(crate) fn resolved_visual_string(&self, id: &str, key: &str, fallback: &str) -> String {
        let entry = &self.entries[id];
        let state = self.visual_state_for(id, &entry.node);
        visual_string(&entry.node, key, fallback, state).to_string()
    }
    #[cfg(test)]
    pub(crate) fn resolved_visual_number(&self, id: &str, key: &str, fallback: f32) -> f32 {
        let entry = &self.entries[id];
        let state = self.visual_state_for(id, &entry.node);
        visual_number(&entry.node, key, fallback, state)
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
fn floor_char_boundary(value: &str, position: usize) -> usize {
    let mut position = position.min(value.len());
    while position > 0 && !value.is_char_boundary(position) {
        position -= 1;
    }
    position
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

fn paint_outline<P: PaintTarget>(
    target: &mut P,
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
            target,
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
            target,
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
                target,
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
                target,
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
                target,
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
                target,
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
                target,
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
            target,
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
fn paint_outline_stroke<P: PaintTarget>(
    target: &mut P,
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
    target.stroke(
        &stroke,
        transform,
        outline_color,
        &RoundedRect::from_rect(outline_rect, outline_radius),
    );
}

#[allow(clippy::too_many_arguments)]
fn paint_directional_outline<P: PaintTarget>(
    target: &mut P,
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
        target,
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
        target.push_clip(Fill::NonZero, transform, &clip);
        paint_outline_stroke(
            target,
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
        target.pop_layer();
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
        flex_direction: match node.string(
            "direction",
            if node.kind == "row" { "row" } else { "column" },
        ) {
            "row" => FlexDirection::Row,
            "row-reverse" => FlexDirection::RowReverse,
            "column-reverse" => FlexDirection::ColumnReverse,
            _ => FlexDirection::Column,
        },
        aspect_ratio: node.style["aspectRatio"]
            .as_f64()
            .map(|value| value as f32)
            .filter(|value| value.is_finite() && *value > 0.0),
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
        if matches!(node.scroll_orientation.as_str(), "horizontal" | "both") {
            style.overflow.x = taffy::style::Overflow::Scroll;
            style.min_size.width = length(0.0);
        }
        if matches!(node.scroll_orientation.as_str(), "vertical" | "both") {
            style.overflow.y = taffy::style::Overflow::Scroll;
            style.min_size.height = length(0.0);
        }
    }
    if style.display == Display::Grid {
        style.grid_template_columns =
            vec![flex(1.0); node.number("columns", 2.0).clamp(1.0, 24.0) as usize];
    }
    style
}
