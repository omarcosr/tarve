//! The app's file dialogs on Android: the system document picker (`dev.tarve.TarveFilePicker`,
//! packages/core/android/java), answering into the bridge's event queue as `fileDialog` with
//! paths in the app's cache, the way web_sign_in answers.

use super::{LOG_WARN, log, with_env};
use crate::protocol::FileDialogOptions;
use jni::JNIEnv;
use jni::objects::{JClass, JObject, JObjectArray, JString, JValue};
use serde_json::json;

extern "system" fn native_result(
    mut env: JNIEnv,
    _: JClass,
    request: JString,
    paths: JObjectArray,
    error: JString,
) {
    let Ok(request_id) = env.get_string(&request).map(String::from) else {
        return;
    };
    let count = env.get_array_length(&paths).unwrap_or(0);
    let paths: Vec<String> = (0..count)
        .filter_map(|index| {
            let path = JString::from(env.get_object_array_element(&paths, index).ok()?);
            env.get_string(&path).map(String::from).ok()
        })
        .collect();
    let error = (!error.is_null())
        .then(|| env.get_string(&error).map(String::from).ok())
        .flatten();
    let mut event = json!({"type": "fileDialog", "requestId": request_id, "paths": paths});
    if let Some(error) = error {
        event["error"] = json!(error);
    }
    crate::bridge::entry_points::emit(event);
}

/// Opens the picker; Err when it cannot start (the request then fails at once).
pub(crate) fn start(
    request_id: &str,
    mode: &str,
    options: &FileDialogOptions,
) -> Result<(), String> {
    with_env(|env, activity| {
        let loader = env
            .call_method(activity, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])?
            .l()?;
        let name = env.new_string("dev.tarve.TarveFilePicker")?;
        let class = env
            .call_method(
                &loader,
                "loadClass",
                "(Ljava/lang/String;)Ljava/lang/Class;",
                &[JValue::Object(&name)],
            )?
            .l()?;
        let class = JClass::from(class);
        env.register_native_methods(
            &class,
            &[jni::NativeMethod {
                name: "nativeResult".into(),
                sig: "(Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)V".into(),
                fn_ptr: native_result as *mut std::ffi::c_void,
            }],
        )?;
        let intent = env.new_object(
            "android/content/Intent",
            "(Landroid/content/Context;Ljava/lang/Class;)V",
            &[JValue::Object(activity), JValue::Object(&class)],
        )?;
        let put = |env: &mut JNIEnv, key: &str, value: &JObject| -> jni::errors::Result<()> {
            let key = env.new_string(key)?;
            let signature = if env.is_instance_of(value, "java/lang/String")? {
                "(Ljava/lang/String;Ljava/lang/String;)Landroid/content/Intent;"
            } else {
                "(Ljava/lang/String;[Ljava/lang/String;)Landroid/content/Intent;"
            };
            env.call_method(
                &intent,
                "putExtra",
                signature,
                &[JValue::Object(&key), JValue::Object(value)],
            )?;
            Ok(())
        };
        let value = env.new_string(request_id)?;
        put(env, "requestId", &value)?;
        let value = env.new_string(mode)?;
        put(env, "mode", &value)?;
        if let Some(file_name) = &options.file_name {
            let value = env.new_string(file_name)?;
            put(env, "fileName", &value)?;
        }
        let extensions: Vec<&String> = options
            .filters
            .iter()
            .flat_map(|filter| &filter.extensions)
            .collect();
        if !extensions.is_empty() {
            let array =
                env.new_object_array(extensions.len() as i32, "java/lang/String", JObject::null())?;
            for (index, extension) in extensions.iter().enumerate() {
                let value = env.new_string(extension)?;
                env.set_object_array_element(&array, index as i32, value)?;
            }
            put(env, "extensions", &array)?;
        }
        env.call_method(
            activity,
            "startActivity",
            "(Landroid/content/Intent;)V",
            &[JValue::Object(&intent)],
        )?;
        Ok(())
    })
    .map_err(|error| {
        log(LOG_WARN, &format!("tarve: file dialog: {error}"));
        format!("Could not open the document picker: {error}")
    })
}
