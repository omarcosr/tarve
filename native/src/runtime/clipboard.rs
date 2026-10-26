//! Ctrl+C/X/V in text fields: the system clipboard (arboard; the activity's on Android).
use super::*;

impl App {
    pub(super) fn clipboard_shortcut(&mut self, key: &Key) -> Vec<serde_json::Value> {
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
        #[cfg(target_os = "android")]
        {
            if key == "v" {
                return match crate::android::clipboard_text() {
                    Some(text) if !text.is_empty() => self.tree.type_text(&text),
                    _ => vec![],
                };
            }
            let Some(text) = self.tree.selected_text() else {
                return vec![];
            };
            if crate::android::set_clipboard_text(&text) && key == "x" {
                return self.tree.key("Backspace");
            }
            vec![]
        }
        #[cfg(not(target_os = "android"))]
        {
            let Ok(mut clipboard) = arboard::Clipboard::new() else {
                return vec![];
            };
            if key == "v" {
                if let Ok(text) = clipboard.get_text()
                    && !text.is_empty()
                {
                    return self.tree.type_text(&text);
                }
                return self.rich_paste(&mut clipboard);
            }
            let Some(text) = self.tree.selected_text() else {
                return vec![];
            };
            if clipboard.set_text(text).is_ok() && key == "x" {
                return self.tree.key("Backspace");
            }
            vec![]
        }
    }
    /// Clipboard payloads without text (file lists, bitmaps) are forwarded to
    /// the focused node as a `paste` event instead of being dropped.
    #[cfg(not(target_os = "android"))]
    fn rich_paste(&self, clipboard: &mut arboard::Clipboard) -> Vec<serde_json::Value> {
        let Some(id) = self.tree.focused.clone() else {
            return vec![];
        };
        if let Ok(files) = clipboard.get().file_list()
            && !files.is_empty()
        {
            let files: Vec<String> = files
                .iter()
                .take(MAX_PASTE_FILES)
                .map(|path| path.to_string_lossy().into_owned())
                .collect();
            return vec![json!({"type":"paste", "id":id, "files":files})];
        }
        if let Ok(image) = clipboard.get_image()
            && image.width > 0
            && image.height > 0
            && image.width <= MAX_PASTE_IMAGE_DIMENSION
            && image.height <= MAX_PASTE_IMAGE_DIMENSION
            && image
                .width
                .checked_mul(image.height)
                .and_then(|pixels| pixels.checked_mul(4))
                .is_some_and(|bytes| bytes == image.bytes.len() && bytes <= MAX_PASTE_IMAGE_BYTES)
        {
            use base64::Engine as _;
            let rgba = base64::engine::general_purpose::STANDARD.encode(&image.bytes);
            return vec![json!({
                "type":"paste",
                "id":id,
                "image":{"width":image.width, "height":image.height, "rgba":rgba}
            })];
        }
        vec![]
    }
}
