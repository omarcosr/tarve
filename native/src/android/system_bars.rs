//! The system bar icons follow the window's background (`dev.tarve.TarveSystemBars`): dark
//! icons over a light app, light icons over a dark one.

use super::with_env;
use jni::objects::{JClass, JValue};
use std::sync::atomic::{AtomicU8, Ordering};

/// 0 unset, 1 light background, 2 dark background.
static APPLIED: AtomicU8 = AtomicU8::new(0);

/// Sets the bars for a window background (`#rrggbb[aa]`); a call with the same answer is free.
pub(crate) fn follow_background(background: &str) {
    let light = is_light(background);
    let state = if light { 1 } else { 2 };
    if APPLIED.swap(state, Ordering::Relaxed) == state {
        return;
    }
    let result = with_env(|env, activity| {
        let loader = env
            .call_method(activity, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])?
            .l()?;
        let name = env.new_string("dev.tarve.TarveSystemBars")?;
        let class = env
            .call_method(
                &loader,
                "loadClass",
                "(Ljava/lang/String;)Ljava/lang/Class;",
                &[JValue::Object(&name)],
            )?
            .l()?;
        env.call_static_method(
            JClass::from(class),
            "setLight",
            "(Landroid/app/Activity;Z)V",
            &[JValue::Object(activity), JValue::Bool(u8::from(light))],
        )?;
        Ok(())
    });
    if result.is_err() {
        APPLIED.store(0, Ordering::Relaxed);
    }
}

/// Relative luminance above the middle grey: dark icons read on it.
fn is_light(background: &str) -> bool {
    let color = crate::tree::color(background).to_rgba8();
    let channel = |c: u8| {
        let c = f32::from(c) / 255.0;
        if c <= 0.039_28 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    };
    let luminance =
        0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
    color.a > 0 && luminance > 0.4
}
