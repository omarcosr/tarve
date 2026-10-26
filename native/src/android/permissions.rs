//! Runtime permissions: `app.checkPermissions` reads `TarvePermissions.state` ("granted",
//! "prompt" until the user answered, "denied"), and
//! `app.requestPermissions` shows the system prompt from `dev.tarve.TarvePermissions`
//! (packages/core/android/java), answering into the bridge's queue as `permissions`. A name
//! without a dot is an `android.permission.` one (`CAMERA`); the manifest must declare it
//! (package.json `tarve.android.permissions` or `--permission`), or Android denies it at once.

use super::{LOG_WARN, log, with_env};
use jni::JNIEnv;
use jni::objects::{JClass, JObject, JObjectArray, JString, JValue};
use serde_json::{Map, Value, json};

pub(crate) fn full_name(name: &str) -> String {
    if name.contains('.') {
        name.to_owned()
    } else {
        format!("android.permission.{name}")
    }
}

/// "granted", "prompt" (never answered) or "denied", from `TarvePermissions.state`.
pub(crate) fn check(names: &[String]) -> Result<Map<String, Value>, String> {
    with_env(|env, activity| {
        let class = load_class(env, activity, "dev.tarve.TarvePermissions")?;
        let mut results = Map::new();
        for name in names {
            let permission = env.new_string(full_name(name))?;
            let state = env
                .call_static_method(
                    &class,
                    "state",
                    "(Landroid/content/Context;Ljava/lang/String;)Ljava/lang/String;",
                    &[JValue::Object(activity), JValue::Object(&permission)],
                )?
                .l()?;
            let state: String = env.get_string(&JString::from(state))?.into();
            results.insert(name.clone(), json!(state));
        }
        Ok(results)
    })
}

extern "system" fn native_result(
    mut env: JNIEnv,
    _: JClass,
    request: JString,
    names: JObjectArray,
    states: JObjectArray,
) {
    let Ok(request_id) = env.get_string(&request).map(String::from) else {
        return;
    };
    let count = env.get_array_length(&names).unwrap_or(0);
    let mut string = |array: &JObjectArray, index: i32| -> Option<String> {
        let value = JString::from(env.get_object_array_element(array, index).ok()?);
        env.get_string(&value).map(String::from).ok()
    };
    let mut results = Map::new();
    for index in 0..count {
        if let (Some(name), Some(value)) = (string(&names, index), string(&states, index)) {
            results.insert(name, json!(value));
        }
    }
    crate::bridge::entry_points::emit(
        json!({"type": "permissions", "requestId": request_id, "results": results}),
    );
}

pub(crate) fn load_class<'local>(
    env: &mut JNIEnv<'local>,
    activity: &JObject,
    name: &str,
) -> jni::errors::Result<JClass<'local>> {
    let loader = env
        .call_method(activity, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])?
        .l()?;
    let name = env.new_string(name)?;
    let class = env
        .call_method(
            &loader,
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[JValue::Object(&name)],
        )?
        .l()?;
    Ok(JClass::from(class))
}

pub(crate) fn strings<'local>(
    env: &mut JNIEnv<'local>,
    values: &[String],
) -> jni::errors::Result<JObjectArray<'local>> {
    let array = env.new_object_array(values.len() as i32, "java/lang/String", JObject::null())?;
    for (index, value) in values.iter().enumerate() {
        let value = env.new_string(value)?;
        env.set_object_array_element(&array, index as i32, value)?;
    }
    Ok(array)
}

/// The results at once when every permission is already granted; otherwise None, and the
/// prompt answers later.
pub(crate) fn request(
    request_id: &str,
    names: &[String],
) -> Result<Option<Map<String, Value>>, String> {
    let current = check(names)?;
    if current.values().all(|value| value == "granted") {
        return Ok(Some(current));
    }
    with_env(|env, activity| {
        let class = load_class(env, activity, "dev.tarve.TarvePermissions")?;
        env.register_native_methods(
            &class,
            &[jni::NativeMethod {
                name: "nativeResult".into(),
                sig: "(Ljava/lang/String;[Ljava/lang/String;[Ljava/lang/String;)V".into(),
                fn_ptr: native_result as *mut std::ffi::c_void,
            }],
        )?;
        let intent = env.new_object(
            "android/content/Intent",
            "(Landroid/content/Context;Ljava/lang/Class;)V",
            &[JValue::Object(activity), JValue::Object(&class)],
        )?;
        let request = env.new_string(request_id)?;
        let names_array = strings(env, names)?;
        let full: Vec<String> = names.iter().map(|name| full_name(name)).collect();
        let full_array = strings(env, &full)?;
        for (key, value, signature) in [
            (
                "requestId",
                JObject::from(request),
                "(Ljava/lang/String;Ljava/lang/String;)Landroid/content/Intent;",
            ),
            (
                "names",
                JObject::from(names_array),
                "(Ljava/lang/String;[Ljava/lang/String;)Landroid/content/Intent;",
            ),
            (
                "permissions",
                JObject::from(full_array),
                "(Ljava/lang/String;[Ljava/lang/String;)Landroid/content/Intent;",
            ),
        ] {
            let key = env.new_string(key)?;
            env.call_method(
                &intent,
                "putExtra",
                signature,
                &[JValue::Object(&key), JValue::Object(&value)],
            )?;
        }
        env.call_method(
            activity,
            "startActivity",
            "(Landroid/content/Intent;)V",
            &[JValue::Object(&intent)],
        )?;
        Ok(None)
    })
    .map_err(|error| {
        log(LOG_WARN, &format!("tarve: permissions: {error}"));
        format!("Could not ask for permissions: {error}")
    })
}
