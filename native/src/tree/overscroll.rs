//! Overscroll: pixel scrolling past either end of a scroll area moves its content on with
//! growing resistance, and the content springs back once the finger lifts (or a fling that ran
//! into the end stops), as Android's and iOS's lists do. Without it a swipe toward an end the
//! area already rests at (a shelf at its start) does nothing at all and feels stuck.
use super::*;

/// How far content can be pulled past an end, as a share of the area's size.
const LIMIT: f64 = 0.2;
/// The spring back: the displacement falls by e every this many ms, fastest right at release
/// (a critically damped spring starts at rest and feels slow), so it is home in ~0.2 s.
const SPRING_MS: f64 = 45.0;
/// Below this displacement (px) the content is home.
const SETTLED: f64 = 0.5;
/// Without input for this long (a touchpad that never reports a lift), the spring starts.
const IDLE_MS: f64 = 80.0;

/// The overscroll of every scroll area, and whether the scroll in progress is momentum.
#[derive(Default)]
pub(crate) struct State {
    areas: HashMap<String, Overscroll>,
    /// The scroll events are a fling's: running into an end stops it (`hit_end`) after a small
    /// bump, instead of pushing the content past the end until the fling runs out.
    momentum: bool,
    hit_end: bool,
}

#[derive(Clone, Copy, Default)]
pub(crate) struct Overscroll {
    /// Displacement past the ends (px, scroll units): negative before the start.
    pub(crate) x: f64,
    pub(crate) y: f64,
    /// Held by input until this time; then released at `release` from `from`.
    touched_ms: f64,
    released: Option<(f64, (f64, f64))>,
}

impl Tree {
    /// The paint offset of `id`'s content past its ends.
    pub(crate) fn overscroll_of(&self, id: &str) -> Vec2 {
        self.overscroll
            .areas
            .get(id)
            .map_or(Vec2::ZERO, |o| Vec2::new(o.x, o.y))
    }

    /// Scrolls `id` by `delta` along one axis: first taking back any overscroll, then the
    /// scroll offset, and what the end stops goes into overscroll with resistance.
    pub(super) fn scroll_with_overscroll(
        &mut self,
        id: &str,
        horizontal: bool,
        delta: f64,
    ) -> Vec<Value> {
        let entry = &self.entries[id];
        let size = if horizontal {
            entry.rect.width()
        } else {
            entry.rect.height()
        };
        let (scroll_x, scroll) = (entry.scroll_x, entry.scroll);
        let now = self.motion_time_ms;
        let mut over = self.overscroll.areas.get(id).copied().unwrap_or_default();
        let axis = if horizontal { over.x } else { over.y };
        let mut delta = delta;
        let mut axis_next = axis;
        if axis != 0.0 && axis.signum() != delta.signum() {
            // Pulling back: the overscroll goes first.
            axis_next = axis + delta;
            delta = if axis_next.signum() == axis.signum() {
                0.0
            } else {
                axis_next
            };
            if delta != 0.0 {
                axis_next = 0.0;
            }
        }
        let mut events = Vec::new();
        if delta != 0.0 {
            let (x, y) = if horizontal {
                (scroll_x + delta, scroll)
            } else {
                (scroll_x, scroll + delta)
            };
            events = self.scroll_to_2d(id, x, y);
            let entry = &self.entries[id];
            let reached = if horizontal {
                entry.scroll_x - scroll_x
            } else {
                entry.scroll - scroll
            };
            let left = delta - reached;
            if left.abs() > 1e-6 && self.overscroll.momentum {
                self.overscroll.hit_end = true;
            }
            if left.abs() > 1e-6 {
                let limit = (size * LIMIT).max(1.0);
                let resistance = 0.5 * (1.0 - (axis_next.abs() / limit)).max(0.0);
                axis_next = (axis_next + left * resistance).clamp(-limit, limit);
            }
        }
        if horizontal {
            over.x = axis_next;
        } else {
            over.y = axis_next;
        }
        over.touched_ms = now;
        over.released = None;
        if over.x != 0.0 || over.y != 0.0 || self.overscroll.areas.contains_key(id) {
            self.overscroll.areas.insert(id.to_string(), over);
            self.dirty.paint = true;
        }
        events
    }

    /// Marks the scroll events that follow as a fling's (true) or the finger's (false).
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    pub(crate) fn set_momentum(&mut self, momentum: bool) {
        self.overscroll.momentum = momentum;
    }

    /// Whether a fling ran into an end since the last call: the caller stops it, and the
    /// overscroll it left springs back at once.
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    pub(crate) fn take_momentum_hit_end(&mut self) -> bool {
        let hit = std::mem::take(&mut self.overscroll.hit_end);
        if hit {
            self.release_overscroll();
        }
        hit
    }

    /// The input stopped (a lift, a fling's end): every overscroll springs back.
    pub(super) fn release_overscroll(&mut self) {
        let now = self.motion_time_ms;
        for over in self.overscroll.areas.values_mut() {
            if over.released.is_none() {
                over.released = Some((now, (over.x, over.y)));
            }
        }
    }

    pub(super) fn advance_overscroll(&mut self) {
        if self.overscroll.areas.is_empty() {
            return;
        }
        let now = self.motion_time_ms;
        self.overscroll.areas.retain(|_, over| {
            if over.released.is_none() && now - over.touched_ms > IDLE_MS {
                over.released = Some((now, (over.x, over.y)));
            }
            let Some((start, (x, y))) = over.released else {
                return over.x != 0.0 || over.y != 0.0;
            };
            let t = ((now - start) / SPRING_MS).max(0.0);
            let k = (-t).exp();
            over.x = x * k;
            over.y = y * k;
            if over.x.abs() < SETTLED && over.y.abs() < SETTLED {
                over.x = 0.0;
                over.y = 0.0;
                return false;
            }
            true
        });
        self.dirty.paint = true;
    }

    /// Whether overscroll needs animation frames.
    pub(super) fn overscroll_animating(&self) -> bool {
        !self.overscroll.areas.is_empty()
    }
}
