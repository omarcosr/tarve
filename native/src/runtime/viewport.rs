//! Where the UI is laid out inside the window, and the window calls Android needs paced.
use super::*;

/// The area the UI is laid out in (logical pixels), published to the tree as its viewport:
/// the whole window, except on Android, where the status and navigation bars and the
/// keyboard (`adjustResize`) cover the rest of the activity's surface.
pub(super) fn layout_viewport(window: &Window, tree: &mut crate::tree::Tree) -> LogicalSize<f32> {
    let scale = window.scale_factor();
    let physical = window.inner_size();
    #[cfg(target_os = "android")]
    if let Some(app) = crate::android::app() {
        let rect = app.content_rect();
        let (width, height) = (physical.width as i32, physical.height as i32);
        let (left, top) = (rect.left.clamp(0, width), rect.top.clamp(0, height));
        let (right, bottom) = (
            rect.right.clamp(left, width),
            rect.bottom.clamp(top, height),
        );
        if right > left && bottom > top {
            let scale = scale as f32;
            let size =
                LogicalSize::new((right - left) as f32 / scale, (bottom - top) as f32 / scale);
            set_viewport(
                tree,
                (
                    left as f32 / scale,
                    top as f32 / scale,
                    size.width,
                    size.height,
                ),
            );
            return size;
        }
    }
    let size = physical.to_logical::<f32>(scale);
    set_viewport(tree, (0.0, 0.0, size.width, size.height));
    size
}

fn set_viewport(tree: &mut crate::tree::Tree, viewport: (f32, f32, f32, f32)) {
    if tree.viewport != viewport {
        tree.viewport = viewport;
        tree.dirty.layout = true;
    }
}

/// A frame for the window: on Android at the next vsync (`android::vsync`), elsewhere now.
pub(super) fn request_frame(window: &Arc<Window>) {
    #[cfg(target_os = "android")]
    crate::android::vsync::request_redraw(window);
    #[cfg(not(target_os = "android"))]
    window.request_redraw();
}

/// The last value `set_ime_allowed` sent on Android (0 hidden, 1 shown, 2 unknown).
#[cfg(target_os = "android")]
static IME_ALLOWED: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(2);

/// `Window::set_ime_allowed`, which on Android shows or hides the soft keyboard on every
/// call (a binder call a frame from `sync_cursor`): there only when the value changes.
pub(super) fn set_ime_allowed(window: &Window, allowed: bool) {
    #[cfg(target_os = "android")]
    if IME_ALLOWED.swap(u8::from(allowed), std::sync::atomic::Ordering::Relaxed)
        == u8::from(allowed)
    {
        return;
    }
    window.set_ime_allowed(allowed);
}

/// Android: the user can hide the soft keyboard (Back, the keyboard's own hide key) while the
/// editor keeps focus, which `set_ime_allowed`'s cache never hears about. A press on the
/// focused editor forgets the cached value, so the next `sync_cursor` shows the keyboard again.
pub(super) fn forget_ime_allowed() {
    #[cfg(target_os = "android")]
    IME_ALLOWED.store(2, std::sync::atomic::Ordering::Relaxed);
}

impl App {
    /// Sends the system environment (text size, motion, pointer) to the app: when the window
    /// opens (`force`) and whenever it changed since.
    pub(super) fn sync_environment(&mut self, force: bool) {
        let previous = crate::environment::Environment::current();
        let environment = crate::environment::read();
        if !force && environment == previous {
            return;
        }
        if environment.apply() {
            self.tree.text_scale_changed();
            if let Some(window) = &self.window {
                request_frame(window);
            }
        }
        self.emit(vec![environment.event()]);
    }
}
