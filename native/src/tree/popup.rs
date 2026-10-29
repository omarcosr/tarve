//! Where a node's box starts, and the popups that move so they stay inside the window.
use super::{BoxRect, Tree, Vec2};

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

/// `positionTryFallbacks`: where a portal shows against where layout put it.
impl Tree {
    /// How far `id`'s layout position is from where it shows: the scroll of
    /// every ancestor, less the shift a top-level portal on the chain takes
    /// from its `positionTryFallbacks`.
    pub(super) fn ancestor_scroll_offset(&self, id: &str) -> Vec2 {
        let mut offset = self.scroll_offset(id);
        let mut node = Some(id);
        while let Some(node_id) = node {
            if self.entries[node_id].node.portal {
                offset -= self.position_try_shift(node_id);
            }
            node = self.entries[node_id].parent.as_deref();
        }
        offset
    }

    pub(super) fn scroll_offset(&self, id: &str) -> Vec2 {
        let mut offset = Vec2::ZERO;
        let mut parent = self.entries[id].parent.as_deref();
        while let Some(parent_id) = parent {
            let entry = &self.entries[parent_id];
            offset += Vec2::new(entry.scroll_x, entry.scroll);
            parent = entry.parent.as_deref();
        }
        offset
    }

    /// CSS `position-try-fallbacks` for a top-level portal: keep its laid-out
    /// position when it fits the window, else take the first fallback that
    /// does, mirroring it across its containing block (`flip-block` swaps
    /// above/below, `flip-inline` left/right). None fitting keeps the base
    /// position. Evaluated against the current scroll, so it follows scrolling.
    ///
    /// The style sits on the portal or on its first child: a portal that is a
    /// wider positioning lane (a tooltip's, which lets its text wrap at its own
    /// max width) fits and mirrors the visible box inside it, and moves with it.
    pub(super) fn position_try_shift(&self, id: &str) -> Vec2 {
        let entry = &self.entries[id];
        let key = "positionTryFallbacks";
        let Some((value, rect)) = entry
            .node
            .style
            .get(key)
            .map(|value| (value, entry.rect))
            .or_else(|| {
                let child = &self.entries[entry.children.first()?];
                Some((child.node.style.get(key)?, child.rect))
            })
        else {
            return Vec2::ZERO;
        };
        let Ok(fallbacks) = crate::protocol::position_try_fallbacks(value) else {
            return Vec2::ZERO;
        };
        let Some(parent) = entry.parent.as_deref() else {
            return Vec2::ZERO;
        };
        let mut ancestor = Some(parent);
        while let Some(ancestor_id) = ancestor {
            if self.entries[ancestor_id].node.portal {
                return Vec2::ZERO;
            }
            ancestor = self.entries[ancestor_id].parent.as_deref();
        }
        let anchor = self.entries[parent].rect;
        let viewport = self.entries[&self.root].rect;
        let scroll = self.scroll_offset(id);
        let fits = |shift: Vec2| {
            let shown = rect + shift - scroll;
            const SLACK: f64 = 0.5;
            shown.x0 >= viewport.x0 - SLACK
                && shown.y0 >= viewport.y0 - SLACK
                && shown.x1 <= viewport.x1 + SLACK
                && shown.y1 <= viewport.y1 + SLACK
        };
        std::iter::once(crate::protocol::PositionTry {
            block: false,
            inline: false,
        })
        .chain(fallbacks)
        .map(|tactic| {
            Vec2::new(
                if tactic.inline {
                    anchor.x0 + anchor.x1 - rect.x1 - rect.x0
                } else {
                    0.0
                },
                if tactic.block {
                    anchor.y0 + anchor.y1 - rect.y1 - rect.y0
                } else {
                    0.0
                },
            )
        })
        .find(|&shift| fits(shift))
        .unwrap_or(Vec2::ZERO)
    }

    pub(super) fn outside_dismissal_at_pointer(&self) -> Option<String> {
        let mut portals: Vec<_> = self
            .portal_roots()
            .into_iter()
            .filter(|id| self.entries[id].node.dismiss_on_outside)
            .collect();
        portals.sort_by(|a, b| {
            self.stacking
                .get(a)
                .copied()
                .unwrap_or(0.0)
                .total_cmp(&self.stacking.get(b).copied().unwrap_or(0.0))
        });
        let Some(portal) = portals.last() else {
            // No open popup: an in-flow box (a menu inside the page) dismisses the same way.
            return self
                .order
                .iter()
                .rev()
                .filter(|id| {
                    let node = &self.entries[*id].node;
                    if !node.dismiss_on_outside || node.portal {
                        return false;
                    }
                    let mut current = Some(id.as_str());
                    while let Some(key) = current {
                        let entry = &self.entries[key];
                        if entry.node.string("display", "flex") == "none" {
                            return false;
                        }
                        current = entry.parent.as_deref();
                    }
                    true
                })
                .find(|id| {
                    let offset = self.ancestor_scroll_offset(id);
                    let bounds = self.entries[*id].bounds + Vec2::new(-offset.x, -offset.y);
                    !bounds.contains(self.mouse)
                })
                .cloned();
        };
        let offset = self.ancestor_scroll_offset(portal);
        let bounds = self.entries[portal].bounds + Vec2::new(-offset.x, -offset.y);
        (!bounds.contains(self.mouse)).then(|| portal.clone())
    }
}
