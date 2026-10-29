//! A remote image the network finished: the tree takes it, and failures reach the app.
use super::*;

impl App {
    pub(super) fn finish_remote_image(
        &mut self,
        url: String,
        result: Result<crate::tree::DecodedImage, String>,
    ) {
        self.tree.finish_remote_image(url, result);
        // `imageError` at once: a hidden window may not lay out again soon.
        let events = self.tree.take_layout_events();
        self.emit(events);
        for message in self.tree.warnings.drain(..) {
            self.events.push(error(message));
        }
        self.redraw();
    }
}
