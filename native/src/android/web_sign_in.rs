//! `app.webSignIn`: Google or OAuth sign-in in the system WebView (`dev.tarve.TarveWebSignIn`,
//! packages/core/android/java). The activity answers with the Cookie header of `cookieUrl`,
//! straight into the bridge's event queue: the app's activity is paused meanwhile, and the JS
//! (or Go) side waits on that queue, not on the event loop.

use super::{LOG_WARN, log, with_env};
use jni::JNIEnv;
use jni::objects::{JClass, JObject, JString, JValue};
use serde_json::json;

extern "system" fn native_result(mut env: JNIEnv, _: JClass, request: JString, cookie: JString) {
    let Ok(request_id) = env.get_string(&request).map(String::from) else {
        return;
    };
    let cookie = (!cookie.is_null())
        .then(|| env.get_string(&cookie).map(String::from).ok())
        .flatten();
    crate::bridge::entry_points::emit(
        json!({"type": "webSignIn", "requestId": request_id, "cookie": cookie}),
    );
}

/// Opens the sign-in activity; Err when it cannot start (the request then fails at once).
pub(crate) fn start(
    request_id: &str,
    url: &str,
    cookie_url: &str,
    cookies: &[String],
) -> Result<(), String> {
    with_env(|env, activity| {
        let loader = env
            .call_method(activity, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])?
            .l()?;
        let name = env.new_string("dev.tarve.TarveWebSignIn")?;
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
                sig: "(Ljava/lang/String;Ljava/lang/String;)V".into(),
                fn_ptr: native_result as *mut std::ffi::c_void,
            }],
        )?;
        let intent = env.new_object(
            "android/content/Intent",
            "(Landroid/content/Context;Ljava/lang/Class;)V",
            &[JValue::Object(activity), JValue::Object(&class)],
        )?;
        let put = |env: &mut JNIEnv, key: &str, value: &str| -> jni::errors::Result<()> {
            let key = env.new_string(key)?;
            let value = env.new_string(value)?;
            env.call_method(
                &intent,
                "putExtra",
                "(Ljava/lang/String;Ljava/lang/String;)Landroid/content/Intent;",
                &[JValue::Object(&key), JValue::Object(&value)],
            )?;
            Ok(())
        };
        put(env, "requestId", request_id)?;
        put(env, "url", url)?;
        put(env, "cookieUrl", cookie_url)?;
        let names =
            env.new_object_array(cookies.len() as i32, "java/lang/String", JObject::null())?;
        for (index, cookie) in cookies.iter().enumerate() {
            let value = env.new_string(cookie)?;
            env.set_object_array_element(&names, index as i32, value)?;
        }
        let key = env.new_string("cookies")?;
        env.call_method(
            &intent,
            "putExtra",
            "(Ljava/lang/String;[Ljava/lang/String;)Landroid/content/Intent;",
            &[JValue::Object(&key), JValue::Object(&names)],
        )?;
        env.call_method(
            activity,
            "startActivity",
            "(Landroid/content/Intent;)V",
            &[JValue::Object(&intent)],
        )?;
        Ok(())
    })
    .map_err(|error| {
        log(LOG_WARN, &format!("tarve: web sign-in: {error}"));
        format!("Could not open the sign-in page: {error}")
    })
}
