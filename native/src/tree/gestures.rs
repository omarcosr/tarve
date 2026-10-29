//! A two-finger pinch (touch screens, trackpads), a gesture that spans several events.
use super::*;

impl Tree {
    /// A pinch step (`phase`: "start", "move", "end", "cancel"; `delta`: the scale change since
    /// the last step) as a `pinch` event for the node with `pinch` under the pointer, which
    /// keeps it for the whole gesture. `scale` is cumulative, 1 at the start.
    pub fn pinch(&mut self, phase: &str, delta: f64) -> Vec<Value> {
        if phase == "start" || self.pinch_target.is_none() {
            let mut node = self.hit_root(false);
            while let Some(id) = node.clone() {
                let entry = &self.entries[&id];
                if entry.node.pinch && !entry.node.disabled {
                    break;
                }
                node = entry.parent.clone();
            }
            self.pinch_target = node.map(|id| (id, 1.0));
            if phase != "start" && self.pinch_target.is_some() {
                // Joined mid-gesture (no start seen): report one first.
                let mut events = self.pinch_event("start");
                events.extend(self.pinch(phase, delta));
                return events;
            }
        } else if let Some((_, scale)) = self.pinch_target.as_mut() {
            *scale = (*scale * (1.0 + delta)).clamp(0.01, 100.0);
        }
        let events = self.pinch_event(if phase == "cancel" { "end" } else { phase });
        if matches!(phase, "end" | "cancel") {
            self.pinch_target = None;
        }
        events
    }
    fn pinch_event(&self, phase: &str) -> Vec<Value> {
        let Some((id, scale)) = &self.pinch_target else {
            return vec![];
        };
        vec![
            json!({"type":"pinch", "id":id, "phase":phase, "scale":scale, "x":self.mouse.0, "y":self.mouse.1}),
        ]
    }
}
