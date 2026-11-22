//! Keeping assistive technology's view of the tree current, and what follows a presented
//! frame (deferred layout, retired and offscreen text, accessibility held for the frame).
use super::*;

impl App {
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "android"))]
    pub(super) fn initialize_accessibility(&mut self, event_loop: &ActiveEventLoop, window: &Window) {
        self.accessibility = Some(AccessibilityBridge::new(
            event_loop,
            window,
            self.event_proxy.clone(),
        ));
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "android")))]
    pub(super) fn initialize_accessibility(&mut self, _: &ActiveEventLoop, _: &Window) {}

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "android"))]
    pub(super) fn sync_accessibility(&mut self) {
        self.accessibility_pending = false;
        self.last_accessibility_sync = Instant::now();
        let started = Instant::now();
        self.sync_accessibility_now();
        // App updates wait at least fifty times what this update cost: assistive technology
        // on a large animated tree takes at most a fiftieth of the CPU.
        self.accessibility_interval = (started.elapsed() * 50).max(ACCESSIBILITY_INTERVAL);
    }

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "android"))]
    pub(super) fn sync_accessibility_now(&mut self) {
        if !self
            .accessibility
            .as_ref()
            .is_some_and(AccessibilityBridge::is_active)
        {
            return;
        }
        let Some(window) = self.window.as_ref() else {
            return;
        };
        let scale = window.scale_factor();
        let size = layout_viewport(window, &mut self.tree);
        if let Err(message) = self.tree.compute(size.width, size.height) {
            self.events.push(error(format!(
                "Accessibility layout update failed: {message}"
            )));
            return;
        }
        let layout_events = self.tree.take_layout_events();
        self.emit(layout_events);
        for message in self.tree.warnings.drain(..) {
            self.events.push(error(message));
        }
        if let Some(accessibility) = self.accessibility.as_mut() {
            accessibility.sync(&mut self.tree, &self.document.window.title, scale);
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "android")))]
    pub(super) fn sync_accessibility(&mut self) {
        self.accessibility_pending = false;
        self.last_accessibility_sync = Instant::now();
    }

    /// After a frame is presented: what was left for after it.
    pub(super) fn after_present(&mut self) {
        // What the layout left offscreen (Tree::finish_deferred_layout) lays out now, before
        // any event reads it; a frame after this one paints it where it shows.
        self.tree.release_retired_text();
        match self.tree.finish_deferred_layout() {
            Ok(true) => {
                if let Some(window) = &self.window {
                    window.request_redraw();
                }
            }
            Ok(false) => {}
            Err(message) => self.events.push(error(message)),
        }
        // Texts far offscreen give their shaped layouts back; the idle release returns the pages.
        if self.tree.evict_offscreen_texts() {
            self.memory_dirty.set(true);
        }
        if self.accessibility_after_frame {
            self.accessibility_after_frame = false;
            self.sync_accessibility();
        }
    }

    /// A mouse button left an accessibility update for after the next frame
    /// (`accessibility_after_frame`); when no frame is coming, it happens now.
    pub(super) fn sync_accessibility_if_no_frame_comes(&mut self) {
        if self.accessibility_after_frame
            && (self.parked
                || self.minimized()
                || !matches!(self.graphics, GraphicsState::Ready(_))
                || !(self.tree.dirty.paint
                    || self.tree.dirty.layout
                    || self.tree.dirty.text
                    || self.input_hold.is_some()))
        {
            self.accessibility_after_frame = false;
            self.sync_accessibility();
        }
    }
}
