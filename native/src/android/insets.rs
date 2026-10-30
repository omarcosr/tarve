//! What covers the window's edges: the status and navigation bars, the display cutout and the
//! keyboard. Targeting API 35 the activity is edge-to-edge (the window, and its content rect,
//! span the whole screen), so `dev.tarve.TarveActivity` reads the decor view's `WindowInsets`
//! and hands them over here; `layout_viewport` keeps the UI inside them while the window's
//! background still paints behind the bars.

use super::permissions::load_class;
use super::{LOG_WARN, log, with_env};
use jni::JNIEnv;
use jni::objects::JClass;
use jni::sys::jint;
use std::sync::Mutex;

/// Left, top, right, bottom, in physical pixels.
static INSETS: Mutex<[i32; 4]> = Mutex::new([0; 4]);

extern "system" fn native_insets(
    _: JNIEnv,
    _: JClass,
    left: jint,
    top: jint,
    right: jint,
    bottom: jint,
) {
    let insets = [left, top, right, bottom].map(|inset| inset.max(0));
    let previous = std::mem::replace(
        &mut *INSETS.lock().unwrap_or_else(|p| p.into_inner()),
        insets,
    );
    // The looper may be idle (a keyboard is no input event): wake it to lay out again.
    if previous != insets
        && let Some(app) = super::app()
    {
        app.create_waker().wake();
    }
}

/// The window's insets (left, top, right, bottom, physical pixels); zero until reported.
pub(crate) fn current() -> [i32; 4] {
    *INSETS.lock().unwrap_or_else(|p| p.into_inner())
}

/// Registers `nativeInsets` and has the activity report the insets it already has.
pub(crate) fn attach() {
    let attached = with_env(|env, activity| {
        let class = load_class(env, activity, "dev.tarve.TarveActivity")?;
        env.register_native_methods(
            &class,
            &[jni::NativeMethod {
                name: "nativeInsets".into(),
                sig: "(IIII)V".into(),
                fn_ptr: native_insets as *mut std::ffi::c_void,
            }],
        )?;
        env.call_static_method(&class, "attachInsets", "()V", &[])?;
        Ok(())
    });
    if let Err(error) = attached {
        log(LOG_WARN, &format!("tarve: window insets: {error}"));
    }
}
