//! Android input before the shared handling: touch becomes the pointer, Back asks to close,
//! and key events get the modifiers and text winit's Android backend leaves out.
use super::*;

/// How far (dp) beside a control a finger still presses it: half of Material's 48 dp target
/// around a 24 dp icon.
const TOUCH_REACH: f64 = 12.0;

impl App {
    /// The event to handle, or None when it was handled here.
    pub(super) fn android_input(
        &mut self,
        event_loop: &ActiveEventLoop,
        window_id: WindowId,
        event: WindowEvent,
    ) -> Option<WindowEvent> {
        let event = crate::android::keys::adapt(event, &mut self.modifiers);
        if let WindowEvent::Focused(focused) = &event {
            crate::android::media::set_foreground(*focused);
            // Back from Settings: the font size or "remove animations" may have changed.
            if *focused {
                self.sync_environment(false);
            }
        }
        // A fling moves one step a frame, just before the frame is drawn.
        if matches!(event, WindowEvent::RedrawRequested) && crate::android::touch::flinging() {
            self.tree.set_momentum(true);
            for step in crate::android::touch::fling_step() {
                self.place_scroll_pointer(&step);
                self.window_event(event_loop, window_id, step);
            }
            self.tree.set_momentum(false);
            if self.tree.take_momentum_hit_end() {
                crate::android::touch::stop_fling();
            }
            if let Some(window) = &self.window {
                request_frame(window);
            }
        }
        if let WindowEvent::Touch(touch) = &event {
            let scale = self
                .window
                .as_ref()
                .map_or(1.0, |window| window.scale_factor());
            let touch = &self.reach_touch_target(*touch, scale);
            for synthesized in crate::android::touch::translate(touch, scale, |at| {
                self.tree.place_pointer(at.x / scale, at.y / scale);
                self.tree.drags_at_pointer()
            }) {
                self.place_scroll_pointer(&synthesized);
                self.window_event(event_loop, window_id, synthesized);
            }
            return None;
        }
        // Back asks to close, as the desktop close button does (`onCloseRequest` may keep it).
        if let WindowEvent::KeyboardInput { event: key, .. } = &event
            && key.logical_key == Key::Named(NamedKey::BrowserBack)
        {
            if key.state == ElementState::Released {
                self.request_close(event_loop);
            }
            return None;
        }
        Some(event)
    }

    /// A finger that lands beside every control but within TOUCH_REACH of one presses that
    /// control, for the whole touch: small icons answer as 48 dp targets.
    fn reach_touch_target(
        &mut self,
        mut touch: winit::event::Touch,
        scale: f64,
    ) -> winit::event::Touch {
        static SHIFT: std::sync::Mutex<(f64, f64)> = std::sync::Mutex::new((0.0, 0.0));
        let mut shift = SHIFT
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if touch.phase == winit::event::TouchPhase::Started {
            let (x, y) = (touch.location.x / scale, touch.location.y / scale);
            let target = self.tree.touch_target(x, y, TOUCH_REACH);
            *shift = ((target.0 - x) * scale, (target.1 - y) * scale);
            if let (Some(window), GraphicsState::Ready(graphics)) = (&self.window, &self.graphics) {
                crate::android::frame_rate::touch_started(window, !graphics.is_cpu());
            }
            crate::android::perf_hint::workload_increase();
        }
        let (dx, dy) = *shift;
        touch.location.x += dx;
        touch.location.y += dy;
        touch
    }

    /// A scroll from touch goes to the area under the finger's first touch, with no hover.
    fn place_scroll_pointer(&mut self, event: &WindowEvent) {
        if let WindowEvent::MouseWheel { .. } = event
            && let (Some(origin), Some(window)) =
                (crate::android::touch::scroll_origin(), self.window.as_ref())
        {
            let scale = window.scale_factor();
            self.tree.place_pointer(origin.x / scale, origin.y / scale);
        }
    }

    /// A frame reached the screen: vote for the refresh rate and report its cost to the scheduler.
    pub(super) fn android_frame_presented(&self, frame_started: Instant) {
        if let (Some(window), GraphicsState::Ready(graphics)) = (&self.window, &self.graphics) {
            crate::android::frame_rate::frame_presented(window, !graphics.is_cpu());
            crate::android::perf_hint::frame_done(
                frame_started.elapsed().as_nanos() as i64,
                crate::android::frame_rate::budget_nanos(),
            );
        }
    }
    /// Background playback follows the media; the system bars and keyboard arrive as a content
    /// rect, not a resize.
    pub(super) fn android_about_to_wait(&mut self) {
        if self.is_main {
            crate::android::media::sync(&self.media.playing(), &self.event_proxy);
            // The status bar's icons sit over the top bar when there is one, else the app.
            let background = self
                .tree
                .top_bar_background()
                .or_else(|| {
                    self.tree
                        .entries
                        .get(&self.tree.root)
                        .map(|entry| entry.node.string("background", ""))
                        .filter(|background| background.starts_with('#'))
                })
                .unwrap_or(&self.document.window.background);
            crate::android::system_bars::follow_background(background);
        }
        if let Some(window) = self.window.clone() {
            crate::android::frame_rate::settle(&window);
            let before = self.tree.viewport;
            layout_viewport(&window, &mut self.tree);
            if self.tree.viewport != before {
                self.tree.dirty.paint = true;
                window.request_redraw();
            }
        }
    }
}
