//! Long press: a press held still on a `long_press` node fires `longPress`, and its release
//! sends no `click`. The runtime keeps the clock; the tree tracks the press.
use super::*;

/// How far (logical px) a press may travel and still become a long press (Android's touch slop).
const LONG_PRESS_SLOP: f64 = 8.0;

#[derive(Default)]
pub(super) struct LongPress {
    /// A press that may become a long press: the node that asked and where the press began.
    pending: Option<(String, (f64, f64))>,
    /// The long-pressed node, whose release must not click.
    pressed: Option<String>,
}

impl Tree {
    /// The node a press on `id` long-presses: `id` or its nearest ancestor with `long_press`.
    fn long_press_target(&self, id: &str) -> Option<String> {
        let mut current = Some(id.to_string());
        while let Some(node) = current {
            let entry = self.entries.get(&node)?;
            if entry.node.long_press && !entry.node.disabled {
                return Some(node);
            }
            current = entry.parent.clone();
        }
        None
    }
    /// Whether the current press can still become a long press.
    pub fn long_press_pending(&self) -> bool {
        self.long_press.pending.is_some()
    }
    /// The press was held long enough: a `longPress` event, and its release will not click.
    pub fn fire_long_press(&mut self) -> Vec<Value> {
        let Some((id, _)) = self.long_press.pending.take() else {
            return vec![];
        };
        if self.pressed.is_none() || !self.entries.contains_key(&id) {
            return vec![];
        }
        self.long_press.pressed = Some(id.clone());
        vec![json!({"type":"longPress", "id":id})]
    }
    /// A new press (`pressed` is set): it may become a long press.
    pub(super) fn long_press_down(&mut self) {
        self.long_press.pressed = None;
        self.long_press.pending = self
            .pressed
            .as_deref()
            .and_then(|id| self.long_press_target(id))
            .map(|id| (id, self.mouse));
    }
    /// A finger or pointer that travels is a drag or a scroll, not a long press.
    pub(super) fn long_press_move(&mut self, x: f64, y: f64) {
        if let Some((_, origin)) = &self.long_press.pending
            && (x - origin.0).hypot(y - origin.1) > LONG_PRESS_SLOP
        {
            self.long_press.pending = None;
        }
    }
    /// The release ends the press; true when it was long-pressed (so it must not click).
    pub(super) fn long_press_up(&mut self) -> bool {
        self.long_press.pending = None;
        self.long_press.pressed.take().is_some()
    }
    /// Abandons an in-flight pointer drag (Escape, focus loss, source removed).
    /// A drag that never crossed the threshold ends silently.
    pub fn cancel_pointer_drag(&mut self) -> Vec<Value> {
        self.long_press.pending = None;
        match self.pointer_drag.take() {
            Some(drag) if drag.active => {
                self.pressed = None;
                self.dirty.paint = true;
                vec![json!({"type":"dragCancel", "id":drag.id})]
            }
            _ => vec![],
        }
    }
}
