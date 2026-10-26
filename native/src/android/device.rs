//! Device services on Android (crate::device): the share chooser (`dev.tarve.TarveShare`, files
//! through `TarveFileProvider`), location (`TarveLocation`, the framework LocationManager) and
//! the biometric check (`TarveBiometric`, android.hardware.biometrics.BiometricPrompt). Java in
//! packages/core/android/java; answers go straight into the bridge's event queue.

use super::permissions::{load_class, strings};
use super::{LOG_WARN, log, with_env};
use crate::device::{authenticate_event, location_event, position_json};
use crate::protocol::requests::{Authenticate, Location, Share};
use jni::JNIEnv;
use jni::objects::{JClass, JDoubleArray, JObject, JString, JValue};
use jni::sys::jboolean;

fn optional_string(env: &mut JNIEnv, value: &JString) -> Option<String> {
    (!value.is_null())
        .then(|| env.get_string(value).map(String::from).ok())
        .flatten()
}

fn java_string<'local>(
    env: &mut JNIEnv<'local>,
    value: &Option<String>,
) -> jni::errors::Result<JObject<'local>> {
    Ok(match value {
        Some(value) => JObject::from(env.new_string(value)?),
        None => JObject::null(),
    })
}

/// Opens the chooser; the request answers at once (`supported: true`).
pub(crate) fn share(request: &Share) -> Result<(), String> {
    with_env(|env, activity| {
        let class = load_class(env, activity, "dev.tarve.TarveShare")?;

        let title = java_string(env, &request.title)?;
        let body = java_string(env, &request.text)?;
        let url = java_string(env, &request.url)?;
        let files = strings(env, &request.files)?;
        let error = env
            .call_static_method(
                &class,
                "share",
                "(Landroid/app/Activity;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;)Ljava/lang/String;",
                &[
                    JValue::Object(activity),
                    JValue::Object(&title),
                    JValue::Object(&body),
                    JValue::Object(&url),
                    JValue::Object(&files),
                ],
            )?
            .l()?;
        Ok(optional_string(env, &JString::from(error)))
    })
    .map_err(|error| {
        log(LOG_WARN, &format!("tarve: share: {error}"));
        format!("Could not open the share sheet: {error}")
    })?
    .map_or(Ok(()), Err)
}

extern "system" fn native_location(
    mut env: JNIEnv,
    _: JClass,
    id: JString,
    watch: jboolean,
    fix: JDoubleArray,
    code: JString,
    message: JString,
) {
    let Ok(id) = env.get_string(&id).map(String::from) else {
        return;
    };
    let position = (!fix.is_null())
        .then(|| {
            let mut values = [f64::NAN; 8];
            env.get_double_array_region(&fix, 0, &mut values).ok()?;
            Some(position_json(&values))
        })
        .flatten();
    let code = optional_string(&mut env, &code);
    let message = optional_string(&mut env, &message);
    crate::bridge::entry_points::emit(location_event(
        &id,
        watch != 0,
        position,
        code.as_deref(),
        message.as_deref(),
    ));
}

/// `get`, `watch` or `clear` through `TarveLocation`; Err when it cannot start.
pub(crate) fn location(request: &Location) -> Result<(), String> {
    with_env(|env, activity| {
        let class = load_class(env, activity, "dev.tarve.TarveLocation")?;
        env.register_native_methods(
            &class,
            &[jni::NativeMethod {
                name: "nativeLocation".into(),
                sig: "(Ljava/lang/String;Z[DLjava/lang/String;Ljava/lang/String;)V".into(),
                fn_ptr: native_location as *mut std::ffi::c_void,
            }],
        )?;
        let id = env.new_string(&request.request_id)?;
        let high = JValue::Bool(request.high_accuracy.into());
        let millis = |value: Option<f64>, default: f64| {
            JValue::Long(value.unwrap_or(default).clamp(0.0, 3_600_000.0) as i64)
        };
        match request.action.as_str() {
            "clear" => {
                env.call_static_method(
                    &class,
                    "clear",
                    "(Ljava/lang/String;)V",
                    &[JValue::Object(&id)],
                )?;
            }
            "watch" => {
                env.call_static_method(
                    &class,
                    "watch",
                    "(Landroid/content/Context;Ljava/lang/String;Z)V",
                    &[JValue::Object(activity), JValue::Object(&id), high],
                )?;
            }
            _ => {
                env.call_static_method(
                    &class,
                    "get",
                    "(Landroid/content/Context;Ljava/lang/String;ZJJ)V",
                    &[
                        JValue::Object(activity),
                        JValue::Object(&id),
                        high,
                        millis(request.timeout_ms, 30_000.0),
                        millis(request.maximum_age_ms, 0.0),
                    ],
                )?;
            }
        }
        Ok(())
    })
    .map_err(|error| {
        log(LOG_WARN, &format!("tarve: location: {error}"));
        format!("Could not read the location: {error}")
    })
}

extern "system" fn native_authenticated(
    mut env: JNIEnv,
    _: JClass,
    id: JString,
    success: jboolean,
    code: JString,
    message: JString,
) {
    let Ok(id) = env.get_string(&id).map(String::from) else {
        return;
    };
    let code = optional_string(&mut env, &code);
    let message = optional_string(&mut env, &message);
    crate::bridge::entry_points::emit(authenticate_event(
        &id,
        success != 0,
        code.as_deref(),
        message.as_deref(),
    ));
}

/// Shows BiometricPrompt (`TarveBiometric`); Err when it cannot start.
pub(crate) fn authenticate(request: &Authenticate) -> Result<(), String> {
    with_env(|env, activity| {
        let class = load_class(env, activity, "dev.tarve.TarveBiometric")?;
        env.register_native_methods(
            &class,
            &[jni::NativeMethod {
                name: "nativeResult".into(),
                sig: "(Ljava/lang/String;ZLjava/lang/String;Ljava/lang/String;)V".into(),
                fn_ptr: native_authenticated as *mut std::ffi::c_void,
            }],
        )?;
        let id = env.new_string(&request.request_id)?;
        let reason = env.new_string(&request.reason)?;
        env.call_static_method(
            &class,
            "authenticate",
            "(Landroid/app/Activity;Ljava/lang/String;Ljava/lang/String;)V",
            &[
                JValue::Object(activity),
                JValue::Object(&id),
                JValue::Object(&reason),
            ],
        )?;
        Ok(())
    })
    .map_err(|error| {
        log(LOG_WARN, &format!("tarve: authenticate: {error}"));
        format!("Could not show the biometric prompt: {error}")
    })
}
