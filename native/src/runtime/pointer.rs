//! Pointer input the tree does not see as is: DOM-style `pointer` events, and two-finger
//! pinches from a trackpad (macOS) or a touch screen (android::touch).
use super::*;

impl App {
    /// A DOM-style `pointer` event at the pointer, on the deepest node under it.
    pub(super) fn dom_pointer_event(
        &self,
        phase: &str,
        extra: serde_json::Value,
    ) -> serde_json::Value {
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
    /// A pinch step as `pinch` events for the pinchable node under the pointer.
    pub(super) fn pinch(
        &mut self,
        phase: winit::event::TouchPhase,
        delta: f64,
    ) -> Vec<serde_json::Value> {
        let phase = match phase {
            winit::event::TouchPhase::Started => "start",
            winit::event::TouchPhase::Moved => "move",
            winit::event::TouchPhase::Ended => "end",
            winit::event::TouchPhase::Cancelled => "cancel",
        };
        self.tree.pinch(phase, delta)
    }
}
