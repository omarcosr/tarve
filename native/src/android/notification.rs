//! `app.notify` on Android: `dev.tarve.TarveNotifications` (packages/core/android/java) posts
//! the notification, asking for POST_NOTIFICATIONS first on Android 13+; a tap opens the app
//! through `dev.tarve.TarveNotificationOpen`, which reports `notificationClick` here. Timed and
//! place notifications (`schedule`) are armed in `dev.tarve.TarveScheduledNotifications`
//! (AlarmManager, LocationManager proximity alerts) and fire with the app closed.

use super::{LOG_WARN, log, with_env};
use jni::JNIEnv;
use jni::objects::{JClass, JObject, JString, JValue};
use serde_json::json;

extern "system" fn native_click(mut env: JNIEnv, _: JClass, id: JString) {
    let id = (!id.is_null())
        .then(|| env.get_string(&id).map(String::from).ok())
        .flatten()
        .filter(|id| !id.is_empty());
    let mut event = json!({"type": "notificationClick"});
    if let Some(id) = id {
        event["id"] = json!(id);
    }
    crate::bridge::entry_points::emit(event);
}

fn load_class<'local>(
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

pub(crate) fn show(id: &str, title: &str, body: &str) -> Result<(), String> {
    with_env(|env, activity| {
        let class = load_class(env, activity, "dev.tarve.TarveNotifications")?;
        env.register_native_methods(
            &class,
            &[jni::NativeMethod {
                name: "nativeClick".into(),
                sig: "(Ljava/lang/String;)V".into(),
                fn_ptr: native_click as *mut std::ffi::c_void,
            }],
        )?;
        let (id, title, body) = (
            env.new_string(id)?,
            env.new_string(title)?,
            env.new_string(body)?,
        );
        env.call_static_method(
            &class,
            "show",
            "(Landroid/app/Activity;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V",
            &[
                JValue::Object(activity),
                JValue::Object(&id),
                JValue::Object(&title),
                JValue::Object(&body),
            ],
        )?;
        Ok(())
    })
    .map_err(|error| {
        log(LOG_WARN, &format!("tarve: notification: {error}"));
        format!("notification: {error}")
    })
}

/// Arms (`set`) or drops (`cancel`) a timed or place notification.
pub(crate) fn schedule(
    request: &crate::protocol::notifications::ScheduleNotification,
) -> Result<(), String> {
    with_env(|env, activity| {
        let class = load_class(env, activity, "dev.tarve.TarveScheduledNotifications")?;
        let id = env.new_string(&request.id)?;
        if request.action == "cancel" {
            env.call_static_method(
                &class,
                "cancel",
                "(Landroid/content/Context;Ljava/lang/String;)V",
                &[JValue::Object(activity), JValue::Object(&id)],
            )?;
            return Ok(());
        }
        let (title, body) = (env.new_string(&request.title)?, env.new_string(&request.body)?);
        let place = request.place.as_ref();
        env.call_static_method(
            &class,
            "set",
            "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;JZDDFZ)V",
            &[
                JValue::Object(activity),
                JValue::Object(&id),
                JValue::Object(&title),
                JValue::Object(&body),
                JValue::Long(request.at.map_or(-1, |at| at.max(0.0) as i64)),
                JValue::Bool(place.is_some().into()),
                JValue::Double(place.map_or(0.0, |p| p.latitude)),
                JValue::Double(place.map_or(0.0, |p| p.longitude)),
                JValue::Float(place.map_or(0.0, |p| p.radius as f32)),
                JValue::Bool(place.is_some_and(|p| p.leave).into()),
            ],
        )?;
        Ok(())
    })
    .map_err(|error| {
        log(LOG_WARN, &format!("tarve: scheduled notification: {error}"));
        format!("scheduled notification: {error}")
    })
}
