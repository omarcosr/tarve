//! Pixel scrolling (a finger on Android, a touchpad): each axis goes to the nearest scroll
//! area under the pointer that scrolls along it, as in a browser. A vertical swipe over a
//! horizontal shelf scrolls the page; only a mouse wheel's notches turn vertical into
//! horizontal over a horizontal-only area (`wheel_2d`).
use super::*;

/// Which axes a node scrolls along: (horizontal, vertical).
fn axes(node: &Node) -> (bool, bool) {
    match node.kind.as_str() {
        "textarea" => (false, true),
        "code" => (true, false),
        "scroll" => match node.scroll_orientation.as_str() {
            "horizontal" => (true, false),
            "both" => (true, true),
            _ => (false, true),
        },
        _ => (false, false),
    }
}

impl Tree {
    /// Puts the pointer at (x, y) for the scroll events that follow without hovering anything
    /// (a finger on a touch screen).
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    pub(crate) fn place_pointer(&mut self, x: f64, y: f64) {
        self.mouse = (x, y);
    }

    /// Whether a finger moving from the pointer drags what is under it (a slider, a splitter,
    /// a `draggable`) instead of scrolling.
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    pub(crate) fn drags_at_pointer(&self) -> bool {
        let mut id = self.hit_root(false);
        while let Some(current) = id {
            let Some(entry) = self.entries.get(&current) else {
                return false;
            };
            if matches!(entry.node.kind.as_str(), "slider" | "splitter") || entry.node.draggable {
                return true;
            }
            id = entry.parent.clone();
        }
        false
    }

    /// A text block under the pointer that scrolls its own long lines took the delta.
    pub(super) fn wheel_markdown(&mut self, delta_x: f64, delta_y: f64) -> bool {
        let Some(id) = self.hit_root(false) else {
            return false;
        };
        let Some(entry) = self
            .entries
            .get(&id)
            .filter(|entry| entry.node.kind == "markdown")
        else {
            return false;
        };
        let pad = entry.node.insets("padding");
        let border = entry.node.insets("borderWidth");
        let Some(rect) = self.visible_rect(&id) else {
            return false;
        };
        let width =
            (rect.width() - f64::from(pad[1] + pad[3] + border[1] + border[3])).max(0.0) as f32;
        let y = (self.mouse.1 - rect.y0 - f64::from(pad[0] + border[0])) as f32;
        let delta = if delta_x.abs() > f64::EPSILON {
            delta_x
        } else {
            delta_y
        };
        if self.text.scroll_markdown_block(&id, y, width, delta as f32) {
            self.dirty.paint = true;
            return true;
        }
        false
    }

    /// The nearest scroll area from `id` up that scrolls along an axis and has room to.
    fn scroller_for(&self, mut id: Option<String>, horizontal: bool) -> Option<String> {
        while let Some(current) = id {
            let entry = self.entries.get(&current)?;
            let (x, y) = axes(&entry.node);
            let room = if horizontal {
                entry.scroll_max_x
            } else {
                entry.scroll_max
            };
            if (if horizontal { x } else { y }) && room > 0.0 {
                return Some(current);
            }
            id = entry.parent.clone();
        }
        None
    }

    /// A mouse wheel notch (a line delta, not a touchpad's pixels): the vertical
    /// scroll area under the pointer eases to its new offset over a few frames
    /// instead of jumping, and notches that follow extend the trip from where
    /// the last one was headed. Everything else scrolls as `wheel_2d`.
    pub fn wheel_notch(&mut self, delta_x: f64, delta_y: f64) -> Vec<Value> {
        let over_markdown = self
            .hit_root(false)
            .and_then(|id| self.entries.get(&id))
            .is_some_and(|entry| entry.node.kind == "markdown");
        if delta_x.abs() <= f64::EPSILON
            && delta_y.abs() > f64::EPSILON
            && !over_markdown
            && let Some(id) = self.hit_root(true)
            && let Some(entry) = self.entries.get(&id)
            && (entry.node.kind == "textarea"
                || (entry.node.kind == "scroll" && entry.node.scroll_orientation != "horizontal"))
        {
            // A text area eases through wheel notches like a scroll view (its speed is 1).
            let speed = if entry.node.kind == "scroll" {
                entry.node.scroll_speed
            } else {
                1.0
            };
            let base = self
                .scroll_animations
                .get(&id)
                .filter(|animation| animation.wheel)
                .map_or(entry.scroll, |animation| animation.to);
            let to = (base + delta_y * speed).clamp(0.0, entry.scroll_max.max(0.0));
            let from = entry.scroll;
            self.scroll_animations.clear();
            if (to - from).abs() > 1e-6 {
                self.scroll_animations.insert(
                    id,
                    ScrollAnimation {
                        from,
                        to,
                        start_ms: f64::NAN,
                        duration_ms: WHEEL_EASE_MS,
                        wheel: true,
                    },
                );
                self.dirty.paint = true;
            }
            return vec![];
        }
        self.wheel_2d(delta_x, delta_y)
    }

    /// A touchpad's or a finger's scroll; `ended` (the input lifted) lets overscroll spring back.
    pub fn wheel_pixels(&mut self, delta_x: f64, delta_y: f64, ended: bool) -> Vec<Value> {
        let events = self.wheel_pixels_by(delta_x, delta_y);
        if ended {
            self.wheel_latch = None;
            self.release_overscroll();
        }
        events
    }

    /// A new pixel-scroll gesture begins: its first event picks the areas it scrolls.
    pub fn begin_wheel_gesture(&mut self) {
        self.wheel_latch = None;
    }

    /// The nearest area from `id` up that can still move along an axis in the delta's
    /// direction; the nearest with any room when none can (it takes the overscroll bump).
    fn scroller_toward(&self, id: Option<String>, horizontal: bool, delta: f64) -> Option<String> {
        let mut current = id.clone();
        while let Some(candidate) = self.scroller_for(current, horizontal) {
            let entry = &self.entries[&candidate];
            let (offset, max) = if horizontal {
                (entry.scroll_x, entry.scroll_max_x)
            } else {
                (entry.scroll, entry.scroll_max)
            };
            if (delta > 0.0 && offset < max - 0.5) || (delta < 0.0 && offset > 0.5) {
                return Some(candidate);
            }
            current = entry.parent.clone();
        }
        self.scroller_for(id, horizontal)
    }

    fn wheel_pixels_by(&mut self, delta_x: f64, delta_y: f64) -> Vec<Value> {
        self.scroll_animations.clear();
        if self.wheel_markdown(delta_x, delta_y) {
            return vec![];
        }
        // Touchpads that report no gesture phases: a pause ends the gesture.
        let now = std::time::Instant::now();
        if self
            .wheel_latch_at
            .is_some_and(|at| now.duration_since(at) > std::time::Duration::from_millis(300))
        {
            self.wheel_latch = None;
        }
        self.wheel_latch_at = Some(now);
        if self.wheel_latch.is_none() {
            let under = self.hit_root(true);
            self.wheel_latch = Some([
                self.scroller_toward(under.clone(), true, delta_x),
                self.scroller_toward(under, false, delta_y),
            ]);
        }
        let latch = self.wheel_latch.clone().unwrap_or_default();
        let mut events = Vec::new();
        for (axis, (horizontal, delta)) in
            [(true, delta_x), (false, delta_y)].into_iter().enumerate()
        {
            if delta.abs() <= f64::EPSILON {
                continue;
            }
            let Some(id) = latch[axis]
                .clone()
                .filter(|id| self.entries.contains_key(id))
            else {
                continue;
            };
            let entry = &self.entries[&id];
            let speed = if entry.node.kind == "scroll" {
                entry.node.scroll_speed
            } else {
                1.0
            };
            events.extend(self.scroll_with_overscroll(&id, horizontal, delta * speed));
        }
        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn node(id: &str, kind: &str, style: Value, children: Vec<Node>) -> Node {
        serde_json::from_value(json!({"id":id,"kind":kind,"style":style,"children":children}))
            .unwrap()
    }

    #[test]
    fn a_fling_into_an_end_stops_with_a_bump_and_springs_back_at_once() {
        let cards = node(
            "cards",
            "view",
            json!({"width":600,"height":80,"shrink":0}),
            vec![],
        );
        let mut shelf = node(
            "shelf",
            "scroll",
            json!({"width":200,"height":80}),
            vec![cards],
        );
        shelf.scroll_orientation = "horizontal".into();
        let mut tree = Tree::new(node("root", "window", json!({}), vec![shelf]));
        tree.compute(240.0, 200.0).unwrap();
        tree.pointer_move(40.0, 30.0);
        tree.wheel_pixels(30.0, 0.0, false);
        tree.set_momentum(true);
        tree.wheel_pixels(-60.0, 0.0, false);
        tree.set_momentum(false);
        assert!(tree.take_momentum_hit_end());
        assert!(tree.overscroll_of("shelf").x < 0.0);
        tree.advance_motion(16.0);
        tree.advance_motion(400.0);
        assert_eq!(tree.overscroll_of("shelf").x, 0.0);
        assert!(!tree.take_momentum_hit_end());
    }

    #[test]
    fn a_swipe_past_the_start_overscrolls_and_springs_back() {
        let cards = node(
            "cards",
            "view",
            json!({"width":600,"height":80,"shrink":0}),
            vec![],
        );
        let mut shelf = node(
            "shelf",
            "scroll",
            json!({"width":200,"height":80}),
            vec![cards],
        );
        shelf.scroll_orientation = "horizontal".into();
        let mut tree = Tree::new(node("root", "window", json!({}), vec![shelf]));
        tree.compute(240.0, 200.0).unwrap();
        tree.pointer_move(40.0, 30.0);
        tree.wheel_pixels(-30.0, 0.0, false);
        let pulled = tree.overscroll_of("shelf").x;
        assert!(pulled < 0.0 && pulled > -30.0, "{pulled}");
        assert_eq!(tree.entries["shelf"].scroll_x, 0.0);
        // Pulling back takes the overscroll first, then scrolls.
        tree.wheel_pixels(-pulled + 10.0, 0.0, false);
        assert_eq!(tree.overscroll_of("shelf").x, 0.0);
        assert!((tree.entries["shelf"].scroll_x - 10.0).abs() < 1e-6);
        tree.wheel_pixels(-40.0, 0.0, true);
        tree.advance_motion(16.0);
        tree.advance_motion(1000.0);
        assert_eq!(tree.overscroll_of("shelf").x, 0.0);
    }

    #[test]
    fn pixel_scroll_sends_each_axis_to_the_nearest_area_that_scrolls_along_it() {
        let cards = node(
            "cards",
            "view",
            json!({"width":600,"height":80,"shrink":0}),
            vec![],
        );
        let mut shelf = node(
            "shelf",
            "scroll",
            json!({"width":200,"height":80,"shrink":0}),
            vec![cards],
        );
        shelf.scroll_orientation = "horizontal".into();
        let tall = node(
            "tall",
            "view",
            json!({"width":200,"height":400,"shrink":0}),
            vec![],
        );
        let page = node(
            "page",
            "scroll",
            json!({"width":200,"height":150}),
            vec![shelf, tall],
        );
        let mut tree = Tree::new(node("root", "window", json!({}), vec![page]));
        tree.compute(240.0, 200.0).unwrap();
        tree.pointer_move(40.0, 30.0);

        tree.wheel_pixels(0.0, 50.0, false);
        assert_eq!(
            tree.entries["page"].scroll, 50.0,
            "a vertical swipe over the shelf scrolls the page"
        );
        assert_eq!(tree.entries["shelf"].scroll_x, 0.0);

        tree.pointer_move(40.0, 5.0);
        tree.wheel_pixels(70.0, 0.0, false);
        assert_eq!(
            tree.entries["shelf"].scroll_x, 70.0,
            "a sideways swipe scrolls the shelf"
        );
        assert_eq!(tree.entries["page"].scroll, 50.0);
    }

    #[test]
    fn a_swipe_keeps_its_scroll_area_while_content_slides_under_the_finger() {
        let lines = node(
            "lines",
            "view",
            json!({"width":200,"height":400,"shrink":0}),
            vec![],
        );
        let inner = node(
            "inner",
            "scroll",
            json!({"width":200,"height":100,"shrink":0}),
            vec![lines],
        );
        let top = node(
            "top",
            "view",
            json!({"width":200,"height":120,"shrink":0}),
            vec![],
        );
        let page = node(
            "page",
            "scroll",
            json!({"width":200,"height":150}),
            vec![top, inner],
        );
        let mut tree = Tree::new(node("root", "window", json!({}), vec![page]));
        tree.compute(240.0, 200.0).unwrap();
        // The finger starts over `top`; scrolling the page brings `inner` under it.
        tree.place_pointer(40.0, 20.0);
        tree.begin_wheel_gesture();
        for _ in 0..10 {
            tree.wheel_pixels(0.0, 20.0, false);
            tree.compute(240.0, 200.0).unwrap();
        }
        tree.wheel_pixels(0.0, 0.0, true);
        assert_eq!(
            tree.entries["inner"].scroll, 0.0,
            "the page's swipe never scrolls the inner area"
        );
        assert!((tree.entries["page"].scroll - tree.entries["page"].scroll_max).abs() < 1e-6);
        // A new swipe over the inner area scrolls it.
        tree.place_pointer(40.0, 100.0);
        tree.begin_wheel_gesture();
        tree.wheel_pixels(0.0, 30.0, true);
        assert_eq!(tree.entries["inner"].scroll, 30.0);
    }
}
