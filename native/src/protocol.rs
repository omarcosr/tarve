use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;
use unicode_segmentation::UnicodeSegmentation;

pub const VERSION: u32 = 23;

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
    pub checked: bool,
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
    pub src: String,
    #[serde(default)]
    pub fit: String,
    #[serde(default)]
    pub disabled: bool,
    pub value: Option<String>,
    #[serde(default)]
    pub placeholder: String,
    #[serde(default = "default_input_type")]
    pub input_type: String,
    pub control: Option<Control>,
    #[serde(default)]
    pub modal: bool,
    #[serde(default)]
    pub portal: bool,
    #[serde(default)]
    pub dismiss_on_outside: bool,
    #[serde(default = "default_true")]
    pub focusable: bool,
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
    pub fn is_text(&self) -> bool {
        matches!(self.kind.as_str(), "text" | "button" | "input" | "textarea")
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
}
#[derive(Clone, Debug, Deserialize)]
pub struct Document {
    pub version: u32,
    pub window: WindowOptions,
    pub root: Node,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Command {
    Patch {
        nodes: Vec<Node>,
    },
    Update {
        root: Box<Node>,
    },
    Close,
    Focus {
        id: String,
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
    Input {
        action: String,
        x: Option<f64>,
        y: Option<f64>,
        delta: Option<f64>,
        text: Option<String>,
    },
}

pub fn validate(root: &Node) -> Result<(), String> {
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
            "button",
            "image",
            "scroll",
            "input",
            "textarea",
            "pressable",
            "icon",
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
        if node.id.is_empty() || !ids.insert(&node.id) || !node.children.is_empty() {
            return Err("A property patch must have unique IDs and no children".into());
        }
    }
    Ok(())
}

fn validate_control(node: &Node) -> Result<(), String> {
    if node.kind == "input"
        && !["text", "password", "email", "number", "search", "tel", "url"]
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
