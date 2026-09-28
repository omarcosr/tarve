use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::sync::Arc;
use unicode_segmentation::UnicodeSegmentation;

pub const VERSION: u32 = 42;

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RendererPreference {
    #[default]
    Auto,
    Gpu,
    Cpu,
}

fn range_max() -> f64 {
    100.0
}
fn range_step() -> f64 {
    1.0
}
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Control {
    pub role: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub checked: Option<bool>,
    #[serde(default)]
    pub selected: Option<bool>,
    #[serde(default)]
    pub expanded: Option<bool>,
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub orientation: String,
    #[serde(default)]
    pub value: f64,
    #[serde(default)]
    pub min: f64,
    #[serde(default = "range_max")]
    pub max: f64,
    #[serde(default = "range_step")]
    pub step: f64,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub sort_direction: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VirtualListLayout {
    pub estimated_item_height: f64,
    pub item_count: usize,
    pub window_start: usize,
    pub window_end: usize,
    #[serde(default)]
    pub rendered_keys: Vec<String>,
    pub retained_key: Option<String>,
    #[serde(default = "default_virtual_list_alignment")]
    pub alignment: String,
    #[serde(default)]
    pub follow_tail: bool,
    pub scroll_request: Option<VirtualListScrollRequest>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VirtualListScrollRequest {
    pub generation: u64,
    pub offset: f64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextHighlightRange {
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextHighlight {
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub ranges: Vec<TextHighlightRange>,
    pub active_index: Option<usize>,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    pub color: Option<String>,
    pub active_color: Option<String>,
}

fn default_virtual_list_alignment() -> String {
    "top".into()
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ImageSource {
    Encoded {
        key: String,
        data: String,
        #[serde(default)]
        media_type: String,
    },
    Rgba {
        key: String,
        data: String,
        width: u32,
        height: u32,
        #[serde(default)]
        premultiplied: bool,
    },
}

impl ImageSource {
    pub fn key(&self) -> &str {
        match self {
            Self::Encoded { key, .. } | Self::Rgba { key, .. } => key,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub style: Value,
    #[serde(default)]
    pub children: Vec<Node>,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub language: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub show_line_numbers: bool,
    #[serde(default)]
    pub syntax_theme: Value,
    #[serde(default = "default_true")]
    pub word_diff: bool,
    #[serde(default)]
    pub collapsed_paths: Vec<String>,
    pub max_lines: Option<usize>,
    #[serde(default)]
    pub old_text: Option<String>,
    #[serde(default)]
    pub new_text: Option<String>,
    pub highlight: Option<TextHighlight>,
    #[serde(skip)]
    pub rich: Option<Arc<crate::rich::RichContent>>,
    #[serde(default)]
    pub src: String,
    pub image: Option<ImageSource>,
    #[serde(default)]
    pub fit: String,
    #[serde(default)]
    pub svg: String,
    #[serde(default)]
    pub disabled: bool,
    pub value: Option<String>,
    #[serde(default)]
    pub placeholder: String,
    #[serde(default = "default_input_type")]
    pub input_type: String,
    #[serde(default = "default_scroll_speed")]
    pub scroll_speed: f64,
    #[serde(default = "default_scroll_orientation")]
    pub scroll_orientation: String,
    pub virtual_list: Option<VirtualListLayout>,
    pub control: Option<Control>,
    #[serde(default)]
    pub modal: bool,
    #[serde(default)]
    pub portal: bool,
    #[serde(default)]
    pub dismiss_on_outside: bool,
    #[serde(default)]
    pub labelled_by: Vec<String>,
    #[serde(default)]
    pub close_intercept: bool,
    #[serde(default = "default_true")]
    pub focusable: bool,
    #[serde(default)]
    pub roving_group: String,
    #[serde(default)]
    pub drag_region: bool,
    #[serde(default)]
    pub window_action: String,
}

fn default_true() -> bool {
    true
}
fn default_input_type() -> String {
    "text".into()
}
fn default_scroll_speed() -> f64 {
    1.0
}
fn default_scroll_orientation() -> String {
    "vertical".into()
}

impl Node {
    pub fn number(&self, key: &str, fallback: f32) -> f32 {
        self.style[key]
            .as_f64()
            .map(|n| n as f32)
            .filter(|n| n.is_finite())
            .unwrap_or(fallback)
    }
    pub fn string<'a>(&'a self, key: &str, fallback: &'a str) -> &'a str {
        self.style[key].as_str().unwrap_or(fallback)
    }
    /// A string style key that is absent by default. `None` means "do not paint
    /// this layer at all", which is how a row opts out of a background wash.
    pub fn optional_string<'a>(&'a self, key: &str) -> Option<&'a str> {
        self.style[key].as_str().filter(|value| !value.is_empty())
    }
    pub fn is_text(&self) -> bool {
        matches!(
            self.kind.as_str(),
            "text" | "markdown" | "code" | "button" | "input" | "textarea"
        )
    }
    pub fn interactive(&self) -> bool {
        !self.disabled
            && matches!(
                self.kind.as_str(),
                "button" | "input" | "textarea" | "pressable" | "slider" | "splitter"
            )
    }
    pub fn text_value(&self) -> &str {
        if matches!(self.kind.as_str(), "input" | "textarea") {
            self.value
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or(&self.placeholder)
        } else {
            &self.text
        }
    }
    pub fn display_text(&self) -> String {
        if self.kind == "input" && self.input_type == "password" {
            let value = self.value.as_deref().unwrap_or("");
            if value.is_empty() {
                self.placeholder.clone()
            } else {
                "•".repeat(value.graphemes(true).count())
            }
        } else {
            self.text_value().to_string()
        }
    }
    pub fn insets(&self, key: &str) -> [f32; 4] {
        let value = &self.style[key];
        if let Some(n) = value.as_f64() {
            return [n as f32; 4];
        }
        ["top", "right", "bottom", "left"].map(|side| value[side].as_f64().unwrap_or(0.0) as f32)
    }
    pub fn signature(&self, keys: &[&str]) -> Vec<Value> {
        keys.iter().map(|k| self.style[*k].clone()).collect()
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WindowPositionPreset {
    TopLeft,
    Top,
    TopRight,
    Left,
    Center,
    Right,
    BottomLeft,
    Bottom,
    BottomRight,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub enum WindowPosition {
    Preset(WindowPositionPreset),
    Coordinates { x: f64, y: f64 },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowOptions {
    pub title: String,
    pub width: f64,
    pub height: f64,
    pub min_width: f64,
    pub min_height: f64,
    pub background: String,
    #[serde(default = "default_true")]
    pub decorations: bool,
    #[serde(default = "default_true")]
    pub resizable: bool,
    pub position: Option<WindowPosition>,
    #[serde(default)]
    pub debug: bool,
    #[serde(default = "default_true")]
    pub visible: bool,
}
#[derive(Clone, Debug, Deserialize)]
pub struct Document {
    pub version: u32,
    #[serde(default)]
    pub renderer: RendererPreference,
    pub window: WindowOptions,
    pub root: Node,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TreeMutation {
    Create { node: Box<Node> },
    Patch { node: Box<Node> },
    Children { id: String, children: Vec<String> },
    Remove { id: String },
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDialogFilter {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub extensions: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDialogOptions {
    pub title: Option<String>,
    pub directory: Option<String>,
    pub file_name: Option<String>,
    #[serde(default)]
    pub filters: Vec<FileDialogFilter>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Command {
    Patch {
        nodes: Vec<Node>,
    },
    Mutate {
        mutations: Vec<TreeMutation>,
    },
    Update {
        root: Box<Node>,
    },
    Close,
    CancelCloseRequest,
    Focus {
        id: String,
    },
    ScrollToItem {
        id: String,
        index: usize,
        offset: Option<f64>,
    },
    Inspect {
        #[serde(rename = "requestId")]
        request_id: String,
    },
    Resize {
        width: f64,
        height: f64,
    },
    Capture {
        path: String,
        #[serde(rename = "requestId")]
        request_id: String,
    },
    FileDialog {
        mode: String,
        #[serde(default)]
        options: FileDialogOptions,
        #[serde(rename = "requestId")]
        request_id: String,
    },
    Input {
        action: String,
        x: Option<f64>,
        y: Option<f64>,
        delta: Option<f64>,
        #[serde(rename = "deltaX")]
        delta_x: Option<f64>,
        #[serde(rename = "deltaY")]
        delta_y: Option<f64>,
        text: Option<String>,
    },
    #[cfg(target_os = "windows")]
    #[serde(skip)]
    Accessibility {
        event: accesskit_winit::Event,
    },
}

#[cfg(target_os = "windows")]
impl From<accesskit_winit::Event> for Command {
    fn from(event: accesskit_winit::Event) -> Self {
        Self::Accessibility { event }
    }
}

pub fn validate(root: &Node) -> Result<(), String> {
    fn validate_style(n: &Node) -> Result<(), String> {
        if let Some(value) = n.style.get("userSelect") {
            let Some(value) = value.as_str() else {
                return Err(format!("userSelect must be a string on {}", n.id));
            };
            if !matches!(value, "auto" | "text" | "none" | "all") {
                return Err(format!("Invalid userSelect on {}: {value}", n.id));
            }
        }
        for (name, style) in [("style", &n.style)].into_iter().chain(
            ["hover", "focus", "focusVisible", "active", "disabled"]
                .into_iter()
                .filter_map(|name| n.style.get(name).map(|style| (name, style))),
        ) {
            if let Some(value) = style.get("textDecoration") {
                let Some(value) = value.as_str() else {
                    return Err(format!(
                        "textDecoration must be a string in {name} on {}",
                        n.id
                    ));
                };
                if !matches!(value, "none" | "underline" | "overline" | "line-through") {
                    return Err(format!(
                        "Invalid textDecoration in {name} on {}: {value}",
                        n.id
                    ));
                }
            }
        }
        Ok(())
    }
    fn walk(n: &Node, ids: &mut HashSet<String>, depth: usize) -> Result<(), String> {
        if depth > 128 || ids.len() > 20_000 {
            return Err("UI tree exceeds size/depth limit".into());
        }
        if n.id.is_empty() || !ids.insert(n.id.clone()) {
            return Err(format!("Invalid or duplicate id: {}", n.id));
        }
        if ![
            "window",
            "titlebar",
            "view",
            "row",
            "column",
            "text",
            "markdown",
            "code",
            "diff",
            "button",
            "image",
            "scroll",
            "input",
            "textarea",
            "pressable",
            "svg",
            "slider",
            "splitter",
        ]
        .contains(&n.kind.as_str())
        {
            return Err(format!("Unknown component: {}", n.kind));
        }
        if depth > 0 && n.kind == "window" {
            return Err("Only the root can be a Window".into());
        }
        validate_control(n)?;
        validate_style(n)?;
        for child in &n.children {
            walk(child, ids, depth + 1)?;
        }
        Ok(())
    }
    if root.kind != "window" {
        return Err("Root must be Window".into());
    }
    walk(root, &mut HashSet::new(), 0)
}

pub fn validate_mutations(mutations: &[TreeMutation]) -> Result<(), String> {
    if mutations.len() > 40_000 {
        return Err("Mutation batch exceeds operation limit".into());
    }
    for mutation in mutations {
        match mutation {
            TreeMutation::Create { node } => {
                validate_patch(std::slice::from_ref(node.as_ref()))?;
                if node.kind == "window" {
                    return Err("Structural mutations cannot create a Window".into());
                }
                if ![
                    "titlebar",
                    "view",
                    "row",
                    "column",
                    "text",
                    "markdown",
                    "code",
                    "diff",
                    "button",
                    "image",
                    "scroll",
                    "input",
                    "textarea",
                    "pressable",
                    "svg",
                    "slider",
                    "splitter",
                ]
                .contains(&node.kind.as_str())
                {
                    return Err(format!("Unknown component: {}", node.kind));
                }
            }
            TreeMutation::Patch { node } => {
                validate_patch(std::slice::from_ref(node.as_ref()))?;
            }
            TreeMutation::Children { id, children } => {
                if id.is_empty() || children.len() > 20_000 {
                    return Err("Invalid structural children mutation".into());
                }
                let mut seen = HashSet::with_capacity(children.len());
                if children
                    .iter()
                    .any(|child| child.is_empty() || !seen.insert(child))
                {
                    return Err("Children mutation requires unique non-empty IDs".into());
                }
            }
            TreeMutation::Remove { id } => {
                if id.is_empty() {
                    return Err("Remove mutation requires a node ID".into());
                }
            }
        }
    }
    Ok(())
}
pub fn error(message: impl ToString) -> Value {
    json!({"type":"error", "message": message.to_string()})
}

pub fn validate_patch(nodes: &[Node]) -> Result<(), String> {
    if nodes.len() > 20_000 {
        return Err("Patch exceeds node limit".into());
    }
    let mut ids = HashSet::new();
    for node in nodes {
        validate_control(node)?;
        if let Some(value) = node.style.get("userSelect") {
            let Some(value) = value.as_str() else {
                return Err(format!("userSelect must be a string on {}", node.id));
            };
            if !matches!(value, "auto" | "text" | "none" | "all") {
                return Err(format!("Invalid userSelect on {}: {value}", node.id));
            }
        }
        for (name, style) in [("style", &node.style)].into_iter().chain(
            ["hover", "focus", "focusVisible", "active", "disabled"]
                .into_iter()
                .filter_map(|name| node.style.get(name).map(|style| (name, style))),
        ) {
            if let Some(value) = style.get("textDecoration") {
                let Some(value) = value.as_str() else {
                    return Err(format!(
                        "textDecoration must be a string in {name} on {}",
                        node.id
                    ));
                };
                if !matches!(value, "none" | "underline" | "overline" | "line-through") {
                    return Err(format!(
                        "Invalid textDecoration in {name} on {}: {value}",
                        node.id
                    ));
                }
            }
        }
        if node.id.is_empty() || !ids.insert(&node.id) || !node.children.is_empty() {
            return Err("A property patch must have unique IDs and no children".into());
        }
    }
    Ok(())
}

pub fn validate_file_dialog(mode: &str, options: &FileDialogOptions) -> Result<(), String> {
    if !matches!(mode, "openFile" | "openFiles" | "openFolder" | "saveFile") {
        return Err(format!("Unsupported file dialog mode: {mode}"));
    }
    if options
        .title
        .as_ref()
        .is_some_and(|value| value.len() > 4096)
        || options
            .file_name
            .as_ref()
            .is_some_and(|value| value.len() > 4096)
        || options
            .directory
            .as_ref()
            .is_some_and(|value| value.len() > 32_768)
    {
        return Err("File dialog text exceeds length limit".into());
    }
    if options.filters.len() > 64 {
        return Err("File dialog filter limit exceeded".into());
    }
    for filter in &options.filters {
        if filter.name.is_empty()
            || filter.name.len() > 256
            || filter.extensions.is_empty()
            || filter.extensions.len() > 64
        {
            return Err("File dialog filters require a name and 1-64 extensions".into());
        }
        if filter.extensions.iter().any(|extension| {
            let extension = extension.trim().trim_start_matches('.');
            extension.is_empty()
                || extension.len() > 32
                || extension.contains(['/', '\\', '*', '?'])
        }) {
            return Err("Invalid file dialog extension".into());
        }
    }
    Ok(())
}

fn validate_control(node: &Node) -> Result<(), String> {
    if matches!(node.kind.as_str(), "markdown" | "code" | "diff") && !node.children.is_empty() {
        return Err(format!("{} must be a leaf node", node.kind));
    }
    if node.kind == "diff" {
        // `old_text`/`new_text` default to empty strings so the protocol can
        // carry them unconditionally, so their presence cannot be the test.
        // What matters is that the caller supplied exactly one coherent input:
        // a patch, a text pair, or nothing at all — and nothing at all is the
        // legitimate "no changes" state, not an error.
        let has_patch = !node.source.is_empty();
        let has_pair = node
            .new_text
            .as_deref()
            .is_some_and(|text| !text.is_empty())
            || node
                .old_text
                .as_deref()
                .is_some_and(|text| !text.is_empty());
        if has_patch && has_pair {
            return Err("Diff accepts a patch or oldText/newText, not both".into());
        }
    }
    if node.kind == "scroll" && (!node.scroll_speed.is_finite() || node.scroll_speed <= 0.0) {
        return Err("Scroll speed must be finite and greater than zero".into());
    }
    if node.kind == "scroll"
        && !["vertical", "horizontal", "both"].contains(&node.scroll_orientation.as_str())
    {
        return Err(format!(
            "Unsupported scroll orientation: {}",
            node.scroll_orientation
        ));
    }
    if let Some(virtual_list) = &node.virtual_list {
        if node.kind != "scroll"
            || !virtual_list.estimated_item_height.is_finite()
            || virtual_list.estimated_item_height <= 0.0
            || virtual_list.window_start > virtual_list.window_end
            || virtual_list.window_end > virtual_list.item_count
            || virtual_list.rendered_keys.len()
                != virtual_list.window_end - virtual_list.window_start
            || virtual_list.rendered_keys.iter().any(String::is_empty)
            || virtual_list
                .retained_key
                .as_ref()
                .is_some_and(|key| key.is_empty() || virtual_list.rendered_keys.contains(key))
            || !matches!(virtual_list.alignment.as_str(), "top" | "bottom")
            || virtual_list
                .scroll_request
                .as_ref()
                .is_some_and(|request| request.generation == 0 || !request.offset.is_finite())
        {
            return Err("Invalid virtual list layout metadata".into());
        }
        let mut seen = HashSet::with_capacity(virtual_list.rendered_keys.len());
        if virtual_list
            .rendered_keys
            .iter()
            .any(|key| !seen.insert(key))
        {
            return Err("Virtual list rendered keys must be unique".into());
        }
    }
    if node.kind == "input"
        && ![
            "text", "password", "email", "number", "search", "tel", "url",
        ]
        .contains(&node.input_type.as_str())
    {
        return Err(format!("Unsupported input type: {}", node.input_type));
    }
    if matches!(node.kind.as_str(), "slider" | "splitter") {
        let control = node
            .control
            .as_ref()
            .ok_or("Range control requires range properties")?;
        if ![control.value, control.min, control.max, control.step]
            .iter()
            .all(|n| n.is_finite())
            || control.max <= control.min
            || control.step <= 0.0
        {
            return Err("Range control requires finite values, max > min and step > 0".into());
        }
    }
    Ok(())
}
