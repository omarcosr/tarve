//! Links and files the system asks the app to open. `dev.tarve.TarveActivity` (the
//! NativeActivity subclass the manifest names, packages/core/android/java) reads each VIEW
//! intent: the launch's own in onCreate and later ones in onNewIntent (the activity is
//! `singleTask`). A `content://` or `file://` document is copied into the app's cache first.
//! They reach the app as `open` events (`app.onOpenUrl` / `app.onOpenFiles`); those that
//! arrive before the app's runtime started wait in Java until `attach`.

use super::permissions::load_class;
use super::{LOG_WARN, log, with_env};
use jni::JNIEnv;
use jni::objects::{JClass, JObjectArray, JString};
use jni::sys::jboolean;
use serde_json::json;

fn strings(env: &mut JNIEnv, array: &JObjectArray) -> Vec<String> {
    if array.is_null() {
        return Vec::new();
    }
    let count = env.get_array_length(array).unwrap_or(0);
    (0..count)
        .filter_map(|index| {
            let value = JString::from(env.get_object_array_element(array, index).ok()?);
            env.get_string(&value).map(String::from).ok()
        })
        .collect()
}

extern "system" fn native_open(
    mut env: JNIEnv,
    _: JClass,
    urls: JObjectArray,
    files: JObjectArray,
    initial: jboolean,
) {
    let urls = strings(&mut env, &urls);
    let files = strings(&mut env, &files);
    if urls.is_empty() && files.is_empty() {
        return;
    }
    crate::bridge::entry_points::emit(
        json!({"type":"open", "urls":urls, "files":files, "initial": initial != 0}),
    );
}

/// Called once the app's host exists (`tarve_start`): registers `nativeOpen` and has
/// `TarveActivity` hand over the opens that arrived before. Nothing outside the activity's
/// process (the Bun host's child has no activity).
pub(crate) fn attach() {
    if super::app().is_none() {
        return;
    }
    let attached = with_env(|env, activity| {
        let class = load_class(env, activity, "dev.tarve.TarveActivity")?;
        env.register_native_methods(
            &class,
            &[jni::NativeMethod {
                name: "nativeOpen".into(),
                sig: "([Ljava/lang/String;[Ljava/lang/String;Z)V".into(),
                fn_ptr: native_open as *mut std::ffi::c_void,
            }],
        )?;
        env.call_static_method(&class, "attach", "()V", &[])?;
        Ok(())
    });
    if let Err(error) = attached {
        log(LOG_WARN, &format!("tarve: open intents: {error}"));
    }
}
