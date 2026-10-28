//! Where a node's box starts, and the popups that move so they stay inside the window.
use super::{BoxRect, Tree};

impl Tree {
    /// The absolute origin of `id`, whose parent starts at `parent`.
    pub(super) fn layout_origin(&self, id: &str, parent: (f64, f64)) -> Result<(f64, f64), String> {
        let entry = &self.entries[id];
        let layout_id = entry.layout_id.unwrap();
        let size = self
            .layout
            .layout(layout_id)
            .map_err(|e| e.to_string())?
            .size;
        // Taffy rounds each location relative to its parent but each size from the absolute
        // edges: summing rounded locations can put a child a pixel off its parent's edge (a
        // bottom-aligned bar ending below its plot). Positions are snapped from the
        // unrounded absolute origin instead, so every edge is round(absolute edge).
        let unrounded = self.layout.unrounded_layout(layout_id);
        let origin = (
            parent.0 + unrounded.location.x as f64,
            parent.1 + unrounded.location.y as f64,
        );
        // A popup's anchor (its parent, the trigger) and the window are laid out before it.
        let popup_frame = (entry.node.portal && entry.node.dismiss_on_outside && id != self.root)
            .then(|| {
                let anchor = self.entries[entry.parent.as_ref()?].rect;
                Some((anchor, self.entries[&self.root].rect))
            })
            .flatten();
        Ok(match popup_frame {
            Some((anchor, view)) => keep_popup_in_view(
                origin,
                (size.width as f64, size.height as f64),
                anchor,
                view,
            ),
            None => origin,
        })
    }
}

/// Where a popup (a portal that dismisses on outside presses: a menu, popover or select) sits
/// so it stays inside the window, as Floating UI's `flip` and `shift`: one that runs past an
/// edge moves to the other side of its anchor (below → above, start-aligned → end-aligned)
/// when that side has room, else slides back inside by 8 px. A popup that already fits, or one
/// as large as the window (an overlay), stays where layout put it.
fn keep_popup_in_view(
    origin: (f64, f64),
    size: (f64, f64),
    anchor: BoxRect,
    view: BoxRect,
) -> (f64, f64) {
    const MARGIN: f64 = 8.0;
    const EPSILON: f64 = 0.5;
    let axis = |start: f64, len: f64, a0: f64, a1: f64, v0: f64, v1: f64| -> f64 {
        if start >= v0 - EPSILON && start + len <= v1 + EPSILON {
            return start;
        }
        let (lo, hi) = (v0 + MARGIN, v1 - MARGIN);
        if len >= hi - lo {
            return lo.min(v0.max(start));
        }
        if start + len > v1 {
            if start >= a1 - EPSILON {
                // After the anchor: mirror the gap to its other side.
                let flipped = a0 - (start - a1) - len;
                if flipped >= lo {
                    return flipped;
                }
            } else if (start - a0).abs() <= EPSILON && a1 - len >= lo {
                // Aligned to the anchor's start edge: align to its end edge.
                return a1 - len;
            }
        } else if start + len <= a0 + EPSILON {
            let flipped = a1 + (a0 - start - len);
            if flipped + len <= hi {
                return flipped;
            }
        } else if (start + len - a1).abs() <= EPSILON && a0 + len <= hi {
            return a0;
        }
        start.clamp(lo, hi - len)
    };
    (
        axis(origin.0, size.0, anchor.x0, anchor.x1, view.x0, view.x1),
        axis(origin.1, size.1, anchor.y0, anchor.y1, view.y0, view.y1),
    )
}
