//! Which node a press at a point would reach, without moving the pointer state.
use super::*;

impl Tree {
    /// The node a press at `point` (logical px) would reach, found as for the pointer.
    pub(crate) fn pointer_target_at(&self, point: (f64, f64)) -> Option<String> {
        let root_rect = self.entries.get(&self.root)?.rect;
        let mouse = vello::kurbo::Point::new(point.0, point.1);
        for portal in self.portal_order.iter().rev() {
            if let Some(id) = self.hit(
                portal,
                self.ancestor_scroll_offset(portal),
                root_rect,
                false,
                mouse,
                self.pointer_muted_above(portal),
            ) {
                return Some(id);
            }
        }
        self.hit(&self.root, Vec2::ZERO, root_rect, false, mouse, false)
    }
}
