//! Input deadlines: the frame held for a click's patch, and the long-press clock that turns a
//! press held still into `Tree::fire_long_press`.
use super::*;
use serde_json::Value;

/// How long a press is held still before `longPress` (Android's default long-press timeout).
const LONG_PRESS: Duration = Duration::from_millis(500);

impl App {
    /// Starts the long-press clock on a press the tree may long-press (`pressed`), and stops it
    /// once the tree no longer waits for one (a release, a press that travelled).
    /// Automation presses call it too, so they time long presses like real ones.
    pub(super) fn sync_long_press(&mut self, pressed: bool) {
        if !self.tree.long_press_pending() {
            self.long_press_at = None;
        } else if pressed {
            self.long_press_at = Some(Instant::now() + LONG_PRESS);
        }
    }
    /// `Tree::pointer_move`; a press that travels stops waiting for a long press.
    pub(super) fn tree_pointer_move(&mut self, x: f64, y: f64) -> Vec<Value> {
        let events = self.tree.pointer_move(x, y);
        self.sync_long_press(false);
        events
    }
    /// `Tree::pointer_down`, starting the long-press clock when the press can become one.
    pub(super) fn tree_pointer_down(&mut self) -> Vec<Value> {
        let events = self.tree.pointer_down();
        self.sync_long_press(true);
        events
    }
    /// `Tree::pointer_up`; the release stops the long-press clock.
    pub(super) fn tree_pointer_up(&mut self) -> Vec<Value> {
        let events = self.tree.pointer_up();
        self.sync_long_press(false);
        events
    }
    /// The next input deadline: the click/key hold (while ahead) or the long-press clock.
    pub(super) fn input_deadline(&self, now: Instant) -> Option<Instant> {
        self.input_hold
            .filter(|deadline| *deadline > now)
            .into_iter()
            .chain(self.long_press_at)
            .min()
    }
    /// Expired input deadlines: an elapsed hold redraws; a press held long enough long-presses.
    pub(super) fn tick_input_deadlines(&mut self, now: Instant) {
        if self.input_hold.is_some_and(|until| until <= now) {
            self.input_hold = None;
            self.redraw();
        }
        if self.long_press_at.is_some_and(|at| at <= now) {
            self.long_press_at = None;
            let events = self.tree.fire_long_press();
            if !events.is_empty() {
                self.emit(events);
                self.redraw();
            }
        }
    }
}
