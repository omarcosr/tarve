//! Background playback: while an app plays media, the runtime runs `dev.tarve.TarveMediaService`
//! (packages/core/android/java, compiled into the APK's classes.dex), a foreground service with a
//! media notification and MediaSession, so Android keeps the process alive with the activity in
//! the background or the screen off. Every app gets this from its `<audio>`/`<video>` alone;
//! `app.systemMedia(...)` adds the title, artist, artwork and next/previous, as with SMTC on Windows.
//! The notification, lock screen and headset controls come back as `systemMedia` events; without
//! an app session, play and pause act on the media themselves.

use super::{LOG_WARN, log, with_env};
use crate::protocol::{Command, SystemMediaSession};
use jni::JNIEnv;
use jni::objects::{GlobalRef, JClass, JObject, JString, JValue};
use jni::sys::jdouble;
use serde_json::Value;
use std::sync::Mutex;
use winit::event_loop::EventLoopProxy;

struct State {
    proxy: Option<EventLoopProxy<Command>>,
    /// The service class through the app's class loader; None when the APK has no dex.
    class: Option<Option<GlobalRef>>,
    session: Option<SystemMediaSession>,
    /// Tracks the notification paused (no app session): its Play resumes them.
    paused: Vec<String>,
    /// What the service was last told, to call it only on changes.
    shown: Option<String>,
    /// When media was last active (playing, paused by the notification, or an app session).
    last_active: Option<std::time::Instant>,
}

static STATE: Mutex<State> = Mutex::new(State {
    proxy: None,
    class: None,
    session: None,
    paused: Vec::new(),
    shown: None,
    last_active: None,
});

static FOREGROUND: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

/// The activity gained or lost input focus (Home, recents, the screen turning off).
pub(crate) fn set_foreground(foreground: bool) {
    FOREGROUND.store(foreground, std::sync::atomic::Ordering::Relaxed);
}

pub(crate) fn foreground() -> bool {
    FOREGROUND.load(std::sync::atomic::Ordering::Relaxed)
}

/// winit's Android loop ignores wake-ups while the activity is in the background and runs only on
/// timeouts, so the app's commands (play from the notification, the next track) would wait for the
/// user to return. In the background, while media is or was recently active, the loop polls.
pub(crate) fn background_deadline(now: std::time::Instant) -> Option<std::time::Instant> {
    const POLL: std::time::Duration = std::time::Duration::from_millis(100);
    const GRACE: std::time::Duration = std::time::Duration::from_secs(60);
    if FOREGROUND.load(std::sync::atomic::Ordering::Relaxed) {
        return None;
    }
    let recent = state()
        .last_active
        .is_some_and(|at| now.duration_since(at) < GRACE);
    recent.then(|| now + POLL)
}

fn state() -> std::sync::MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(|p| p.into_inner())
}

/// `app.systemMedia(session)`: what the notification shows, and that the app handles its controls.
pub(crate) fn set_session(session: Option<SystemMediaSession>) {
    state().session = session;
}

extern "system" fn native_action(mut env: JNIEnv, _: JClass, action: JString, time: jdouble) {
    let Ok(action) = env.get_string(&action).map(String::from) else {
        return;
    };
    let time = (time >= 0.0).then_some(time);
    if let Some(proxy) = state().proxy.as_ref() {
        let _ = proxy.send_event(Command::SystemMediaEvent { action, time });
    }
}

fn load_class() -> Option<GlobalRef> {
    with_env(|env, activity| {
        let loader = env
            .call_method(activity, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])?
            .l()?;
        let name = env.new_string("dev.tarve.TarveMediaService")?;
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
                name: "nativeAction".into(),
                sig: "(Ljava/lang/String;D)V".into(),
                fn_ptr: native_action as *mut std::ffi::c_void,
            }],
        )?;
        env.new_global_ref(class)
    })
    .map_err(|error| {
        log(
            LOG_WARN,
            &format!("tarve: no background playback service: {error}"),
        )
    })
    .ok()
}

/// After every event-loop turn: starts, updates or stops the service to match the media.
pub(crate) fn sync(playing: &[String], proxy: &EventLoopProxy<Command>) {
    let mut state = state();
    if !playing.is_empty() {
        state.paused.clear();
    }
    let session = state.session.clone();
    let active = session.is_some() || !playing.is_empty() || !state.paused.is_empty();
    if active {
        state.last_active = Some(std::time::Instant::now());
    }
    let is_playing = session
        .as_ref()
        .map_or(!playing.is_empty(), |session| session.playing);
    let key = format!(
        "{active}|{is_playing}|{:?}",
        session.as_ref().map(|s| (
            &s.title,
            &s.artist,
            &s.album,
            &s.artwork,
            s.duration,
            s.can_next,
            s.can_previous,
            s.can_seek
        ))
    );
    if state.shown.as_deref() == Some(key.as_str()) || (!active && state.shown.is_none()) {
        return;
    }
    state.proxy.get_or_insert_with(|| proxy.clone());
    let class = state.class.get_or_insert_with(load_class).clone();
    let Some(class) = class else {
        state.shown = Some(key);
        return;
    };
    drop(state);
    let result = with_env(|env, activity| {
        fn text<'a>(env: &mut JNIEnv<'a>, value: Option<&str>) -> jni::errors::Result<JObject<'a>> {
            Ok(match value {
                Some(value) => env.new_string(value)?.into(),
                None => JObject::null(),
            })
        }
        let s = session.as_ref();
        let title = text(env, s.map(|s| s.title.as_str()))?;
        let artist = text(env, s.and_then(|s| s.artist.as_deref()))?;
        let album = text(env, s.and_then(|s| s.album.as_deref()))?;
        let artwork = text(env, s.and_then(|s| s.artwork.as_deref()))?;
        env.call_static_method(
            <&JClass>::from(class.as_obj()),
            "update",
            "(Landroid/app/Activity;ZLjava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;ZDDZZZ)V",
            &[
                JValue::Object(activity),
                JValue::Bool(active.into()),
                JValue::Object(&title),
                JValue::Object(&artist),
                JValue::Object(&album),
                JValue::Object(&artwork),
                JValue::Bool(is_playing.into()),
                JValue::Double(s.and_then(|s| s.duration).unwrap_or(-1.0)),
                JValue::Double(s.and_then(|s| s.position).unwrap_or(-1.0)),
                JValue::Bool(s.is_some_and(|s| s.can_next).into()),
                JValue::Bool(s.is_some_and(|s| s.can_previous).into()),
                JValue::Bool(s.is_some_and(|s| s.can_seek).into()),
            ],
        )?;
        Ok(())
    });
    if let Err(error) = result {
        log(LOG_WARN, &format!("tarve: background playback: {error}"));
    }
    state = self::state();
    state.shown = active.then_some(key);
}

/// A control from the notification, lock screen or a headset. With an app session the app
/// handles it (`systemMedia` event); without one, play and pause act on the media here.
pub(crate) fn action(media: &mut crate::media::Media, action: &str) -> Vec<Value> {
    let mut state = state();
    if state.session.is_some() {
        return Vec::new();
    }
    let mut events = Vec::new();
    match action {
        "pause" => {
            let ids = media.playing();
            for id in &ids {
                events.extend(media.command(id, "pause", None, None, None, None, None));
            }
            state.paused.extend(ids);
        }
        "play" => {
            for id in std::mem::take(&mut state.paused) {
                events.extend(media.command(&id, "play", None, None, None, None, None));
            }
        }
        _ => {}
    }
    events
}
