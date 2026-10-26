//! What the system environment changes in the tree: the text size, and presses from a finger,
//! which reach a control a little beside it.
use super::Tree;

impl Tree {
    /// The system text size changed: every text shapes and lays out again.
    pub(crate) fn text_scale_changed(&mut self) {
        for entry in self.entries.values_mut() {
            // A diff's rows are as tall as its scaled font: without measuring it again its
            // scroll area keeps the old height (a blank strip after the last row).
            if entry.node.is_text() || entry.node.kind == "diff" {
                entry.measure_dirty = true;
            }
        }
        self.text.diff_layouts.clear();
        self.dirty.text = true;
        self.dirty.layout = true;
        self.dirty.paint = true;
    }

    /// Where a finger at (x, y) presses: there, or when nothing there takes a press, the
    /// nearest point within `reach` (logical px) that falls on an interactive node. A control
    /// smaller than a fingertip then answers as a 48 dp target does on Android.
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    pub(crate) fn touch_target(&mut self, x: f64, y: f64, reach: f64) -> (f64, f64) {
        let saved = self.mouse;
        self.mouse = (x, y);
        let mut target = (x, y);
        if self.hit_root(false).is_none() {
            'search: for ring in 1..=3 {
                let distance = reach * f64::from(ring) / 3.0;
                for step in 0..8 {
                    let angle = f64::from(step) * std::f64::consts::FRAC_PI_4;
                    let point = (x + distance * angle.cos(), y + distance * angle.sin());
                    self.mouse = point;
                    let interactive = self
                        .hit_root(false)
                        .and_then(|id| self.entries.get(&id))
                        .is_some_and(|entry| entry.node.interactive());
                    if interactive {
                        target = point;
                        break 'search;
                    }
                }
            }
        }
        self.mouse = saved;
        target
    }
}

#[cfg(test)]
mod tests {
    use super::Tree;
    use serde_json::json;

    fn tree() -> Tree {
        let root = json!({
            "id": "root", "kind": "window", "style": {"width": 300, "height": 300},
            "children": [{
                "id": "icon", "kind": "button", "text": "",
                "style": {"position": "absolute", "left": 100, "top": 100, "width": 24, "height": 24},
                "children": []
            }]
        });
        let mut tree = Tree::new(serde_json::from_value(root).unwrap());
        tree.compute(300.0, 300.0).unwrap();
        tree
    }

    #[test]
    fn a_finger_just_beside_a_small_control_presses_it() {
        let mut tree = tree();
        let (x, y) = tree.touch_target(92.0, 112.0, 12.0);
        assert!((100.0..=124.0).contains(&x) && (100.0..=124.0).contains(&y));
        assert_eq!(tree.touch_target(110.0, 110.0, 12.0), (110.0, 110.0));
        assert_eq!(tree.touch_target(40.0, 40.0, 12.0), (40.0, 40.0));
        assert_eq!(
            tree.mouse,
            (-1.0, -1.0),
            "probing leaves the pointer where it was"
        );
    }

    #[test]
    fn a_text_scale_change_lays_every_text_out_again() {
        let mut tree = tree();
        tree.text_scale_changed();
        assert!(tree.dirty.text && tree.dirty.layout);
        assert!(tree.entries["icon"].measure_dirty);
    }

    #[test]
    fn a_text_scale_change_measures_a_diff_again() {
        let root = json!({
            "id": "root", "kind": "window", "style": {},
            "children": [{"id": "diff", "kind": "diff", "text": "", "style": {}, "children": []}]
        });
        let mut tree = Tree::new(serde_json::from_value(root).unwrap());
        tree.compute(300.0, 300.0).unwrap();
        tree.text_scale_changed();
        assert!(tree.entries["diff"].measure_dirty);
    }
}
