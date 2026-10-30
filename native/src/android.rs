//! Android: the NativeActivity entry point and the services desktop builds get from the OS.
//!
//! `android_main` owns the activity's looper, so the winit event loop runs on its thread
//! (`run_on_main`, used by `tarve_start`). The app runs beside it on its own thread:
//! a Go app built as `libtarveapp.so` (`TarveAndroidMain`), otherwise the JS bundle in
//! the APK's `assets/tarve/app.js` on the embedded QuickJS-ng (`qjs.rs`). Both reach the
//! native runtime through the same C ABI as Bun, Node.js and txiki.js on the desktop.

use jni::JNIEnv;
use jni::objects::{JObject, JString, JValue};
use std::ffi::{CString, c_char, c_void};
use std::io::{BufRead, BufReader};
use std::os::fd::FromRawFd;
use std::sync::{Condvar, Mutex, OnceLock, mpsc};
use std::time::{Duration, Instant};
use winit::platform::android::activity::AndroidApp;

mod bun_host;
pub(crate) mod file_dialog;
mod qjs;
pub(crate) mod system_bars;

static APP: OnceLock<AndroidApp> = OnceLock::new();
static MAIN: OnceLock<Mutex<mpsc::Sender<MainJob>>> = OnceLock::new();

enum MainJob {
    Run(Box<dyn FnOnce() + Send>),
    Finish,
}

pub(crate) fn app() -> Option<AndroidApp> {
    APP.get().cloned()
}

/// Runs `job` on the android_main thread: winit polls the activity's looper there.
pub(crate) fn run_on_main(job: impl FnOnce() + Send + 'static) -> Result<(), String> {
    MAIN.get()
        .ok_or("Tarve on Android starts from android_main (NativeActivity)")?
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .send(MainJob::Run(Box::new(job)))
        .map_err(|_| "The Android activity has finished".into())
}

#[unsafe(no_mangle)]
fn android_main(app: AndroidApp) {
    // winit builds one event loop per process, and the runtime one app. An activity
    // re-created in a process that already ran one (the system destroyed it while the
    // process stayed) restarts in a fresh process.
    static RAN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if RAN.swap(true, std::sync::atomic::Ordering::SeqCst) {
        restart_process();
        return;
    }
    forward_stdio();
    let _ = APP.set(app.clone());
    configure_environment(&app);
    insets::attach();
    let (tx, rx) = mpsc::channel();
    let _ = MAIN.set(Mutex::new(tx.clone()));
    let guest = app.clone();
    let spawned = std::thread::Builder::new()
        .name("tarve-app".into())
        // QuickJS recurses on the native stack (deep component trees, JSON).
        .stack_size(32 << 20)
        .spawn(move || {
            perf_hint::register_current_thread();
            if let Err(message) = run_app(&guest) {
                log(LOG_ERROR, &format!("tarve: {message}"));
            }
            let _ = tx.send(MainJob::Finish);
        });
    if let Err(error) = spawned {
        log(
            LOG_ERROR,
            &format!("tarve: could not start the app thread: {error}"),
        );
        return;
    }
    while let Ok(job) = rx.recv() {
        match job {
            MainJob::Run(job) => job(),
            MainJob::Finish => break,
        }
    }
    // The app has ended: end the process with it, so the next launch starts clean
    // instead of finding the event loop and the native app already used.
    finish_activity();
    std::process::exit(0);
}

pub(crate) fn move_to_back() {
    let moved = with_env(|env, activity| {
        env.call_method(activity, "moveTaskToBack", "(Z)Z", &[JValue::Bool(1)])?
            .z()
    });
    if !matches!(moved, Ok(true)) {
        log(LOG_WARN, &format!("tarve: moveTaskToBack: {moved:?}"));
    }
}

fn finish_activity() {
    let _ = with_env(|env, activity| {
        env.call_method(activity, "finishAndRemoveTask", "()V", &[])?;
        Ok(())
    });
}

/// Starts this app's launcher activity in a new task, then ends this process.
fn restart_process() {
    let started = with_env(|env, activity| {
        let manager = env
            .call_method(
                activity,
                "getPackageManager",
                "()Landroid/content/pm/PackageManager;",
                &[],
            )?
            .l()?;
        let name = env
            .call_method(activity, "getPackageName", "()Ljava/lang/String;", &[])?
            .l()?;
        let intent = env
            .call_method(
                &manager,
                "getLaunchIntentForPackage",
                "(Ljava/lang/String;)Landroid/content/Intent;",
                &[JValue::Object(&name)],
            )?
            .l()?;
        if intent.is_null() {
            return Ok(false);
        }
        // FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_CLEAR_TASK
        env.call_method(
            &intent,
            "addFlags",
            "(I)Landroid/content/Intent;",
            &[JValue::Int(0x1000_8000)],
        )?;
        env.call_method(
            activity,
            "startActivity",
            "(Landroid/content/Intent;)V",
            &[JValue::Object(&intent)],
        )?;
        Ok(true)
    });
    log(
        LOG_WARN,
        &format!("tarve: activity re-created in a used process; restarting ({started:?})"),
    );
    std::process::exit(0);
}

fn run_app(app: &AndroidApp) -> Result<(), String> {
    if let Some(executable) = bun_host::executable() {
        return bun_host::run(executable);
    }
    if let Some(main) = go_entry() {
        // SAFETY: `TarveAndroidMain` is the cgo export `tarve build --target android` adds
        // to the Go app's main package; it takes nothing and returns when main does.
        unsafe { main() };
        return Ok(());
    }
    qjs::run(app)
}

unsafe extern "C" {
    fn dlopen(name: *const c_char, flags: i32) -> *mut c_void;
    fn dlsym(handle: *mut c_void, name: *const c_char) -> *mut c_void;
    fn pipe(fds: *mut i32) -> i32;
    fn dup2(old: i32, new: i32) -> i32;
}

/// A Go app ships as `libtarveapp.so` next to the runtime (`go build -buildmode=c-shared`).
fn go_entry() -> Option<unsafe extern "C" fn()> {
    const RTLD_NOW: i32 = 2;
    // SAFETY: dlopen/dlsym with NUL-terminated names; a missing library or symbol is null.
    unsafe {
        let handle = dlopen(c"libtarveapp.so".as_ptr(), RTLD_NOW);
        if handle.is_null() {
            return None;
        }
        let symbol = dlsym(handle, c"TarveAndroidMain".as_ptr());
        if symbol.is_null() {
            log(
                LOG_ERROR,
                "tarve: libtarveapp.so has no TarveAndroidMain export",
            );
            return None;
        }
        Some(std::mem::transmute::<*mut c_void, unsafe extern "C" fn()>(
            symbol,
        ))
    }
}

pub(crate) const LOG_INFO: i32 = 4;
pub(crate) const LOG_WARN: i32 = 5;
pub(crate) const LOG_ERROR: i32 = 6;

#[link(name = "log")]
unsafe extern "C" {
    fn __android_log_write(priority: i32, tag: *const c_char, text: *const c_char) -> i32;
}

pub(crate) fn log(priority: i32, message: &str) {
    for line in message.lines() {
        let text = CString::new(line.replace('\0', " ")).unwrap_or_default();
        // SAFETY: both strings are NUL-terminated and outlive the call.
        unsafe { __android_log_write(priority, c"tarve".as_ptr(), text.as_ptr()) };
    }
}

/// stdout and stderr (Rust, Go and the JS console) go to logcat, tagged `tarve`.
fn forward_stdio() {
    let mut fds = [0_i32; 2];
    // SAFETY: a fresh pipe; its write end replaces fds 1 and 2 for the whole process.
    unsafe {
        if pipe(fds.as_mut_ptr()) != 0 {
            return;
        }
        dup2(fds[1], 1);
        dup2(fds[1], 2);
    }
    // SAFETY: the read end belongs to this File from here on.
    let reader = unsafe { std::fs::File::from_raw_fd(fds[0]) };
    let _ = std::thread::Builder::new()
        .name("tarve-logcat".into())
        .spawn(move || {
            for line in BufReader::new(reader).lines().map_while(Result::ok) {
                log(LOG_INFO, &line);
            }
        });
}

/// HOME, TMPDIR and LANG as a desktop process has them; TARVE_NATIVE names the loaded runtime.
fn configure_environment(app: &AndroidApp) {
    let files = app
        .internal_data_path()
        .map(|path| path.to_string_lossy().into_owned());
    let cache = with_env(|env, activity| {
        let dir = env
            .call_method(activity, "getCacheDir", "()Ljava/io/File;", &[])?
            .l()?;
        let path = env
            .call_method(&dir, "getAbsolutePath", "()Ljava/lang/String;", &[])?
            .l()?;
        Ok(env.get_string(&JString::from(path))?.into())
    })
    .ok();
    let locale = with_env(|env, _| {
        let locale = env
            .call_static_method(
                "java/util/Locale",
                "getDefault",
                "()Ljava/util/Locale;",
                &[],
            )?
            .l()?;
        let tag = env
            .call_method(&locale, "toLanguageTag", "()Ljava/lang/String;", &[])?
            .l()?;
        Ok::<String, jni::errors::Error>(env.get_string(&JString::from(tag))?.into())
    })
    .ok();
    // The screen in dp, so the app's first render already has the phone's width and
    // orientation (its root's size events correct it to the content area).
    let screen = with_env(|env, activity| {
        let resources = env
            .call_method(
                activity,
                "getResources",
                "()Landroid/content/res/Resources;",
                &[],
            )?
            .l()?;
        let metrics = env
            .call_method(
                &resources,
                "getDisplayMetrics",
                "()Landroid/util/DisplayMetrics;",
                &[],
            )?
            .l()?;
        let width = env.get_field(&metrics, "widthPixels", "I")?.i()?;
        let height = env.get_field(&metrics, "heightPixels", "I")?.i()?;
        let density = env.get_field(&metrics, "density", "F")?.f()?.max(0.1);
        Ok(format!(
            "{}x{}",
            (width as f32 / density).round(),
            (height as f32 / density).round()
        ))
    })
    .ok();
    let mut vars: Vec<(&str, String)> = vec![("TARVE_NATIVE", "libtarve_native.so".into())];
    if let Some(screen) = screen {
        vars.push(("TARVE_VIEWPORT", screen));
    }
    // `adb shell setprop debug.tarve.trace 1`: startup phases in logcat (TARVE_TRACE=1).
    if system_property("debug.tarve.trace").as_deref() == Some("1") {
        vars.push(("TARVE_TRACE", "1".into()));
    }
    // `adb shell setprop debug.tarve.renderer gpu|cpu`: TARVE_RENDERER for A/B measurements.
    if let Some(renderer) = system_property("debug.tarve.renderer").filter(|r| !r.is_empty()) {
        vars.push(("TARVE_RENDERER", renderer));
    }
    // `adb shell setprop debug.tarve.density <px per dp>`: the render resolution cap (renderer.rs).
    if let Some(density) = system_property("debug.tarve.density").filter(|d| !d.is_empty()) {
        vars.push(("TARVE_RENDER_DENSITY", density));
    }
    if let Some(glass) = system_property("debug.tarve.glass").filter(|g| !g.is_empty()) {
        vars.push(("TARVE_GLASS", glass));
    }
    if system_property("debug.tarve.gpumem").as_deref() == Some("1") {
        vars.push(("TARVE_GPU_REPORT", "1".into()));
    }
    if let Some(files) = &files {
        vars.push(("HOME", files.clone()));
    }
    if let Some(cache) = cache.or_else(|| files.clone()) {
        vars.push(("TMPDIR", cache));
    }
    if let Some(locale) = locale.filter(|tag| !tag.is_empty() && tag != "und") {
        vars.push(("LANG", format!("{}.UTF-8", locale.replace('-', "_"))));
    }
    for (key, value) in vars {
        if std::env::var_os(key).is_none() {
            // SAFETY: set before the app thread starts; nothing else reads the environment yet.
            unsafe { std::env::set_var(key, value) };
        }
    }
}

// c_char is u8 on aarch64 and i8 on x86_64.
#[allow(clippy::unnecessary_cast)]
fn system_property(name: &str) -> Option<String> {
    unsafe extern "C" {
        fn __system_property_get(name: *const c_char, value: *mut c_char) -> i32;
    }
    let name = CString::new(name).ok()?;
    // PROP_VALUE_MAX
    let mut value = [0 as c_char; 92];
    // SAFETY: a NUL-terminated name and a PROP_VALUE_MAX buffer.
    let length = unsafe { __system_property_get(name.as_ptr(), value.as_mut_ptr()) };
    (length > 0).then(|| {
        let bytes: Vec<u8> = value[..length as usize].iter().map(|&c| c as u8).collect();
        String::from_utf8_lossy(&bytes).into_owned()
    })
}

/// Runs `f` with a JNI environment attached to this thread and the activity.
pub(crate) fn with_env<T>(
    f: impl FnOnce(&mut JNIEnv, &JObject) -> jni::errors::Result<T>,
) -> Result<T, String> {
    let context = ndk_context::android_context();
    // SAFETY: android-activity initialises ndk-context with the process VM and the activity.
    let vm = unsafe { jni::JavaVM::from_raw(context.vm().cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    // The Activity itself (ndk-context's context is the Application, which has no
    // moveTaskToBack or finishAndRemoveTask); the Application before android_main ran.
    let object = APP
        .get()
        .map(|app| app.activity_as_ptr())
        .filter(|activity| !activity.is_null())
        .unwrap_or_else(|| context.context());
    // SAFETY: a global reference android-activity keeps alive for the activity's lifetime.
    let activity = unsafe { JObject::from_raw(object.cast()) };
    let result = f(&mut env, &activity);
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
    }
    result.map_err(|e| e.to_string())
}

fn clipboard_manager<'local>(
    env: &mut JNIEnv<'local>,
    activity: &JObject,
) -> jni::errors::Result<JObject<'local>> {
    let name = env.new_string("clipboard")?;
    env.call_method(
        activity,
        "getSystemService",
        "(Ljava/lang/String;)Ljava/lang/Object;",
        &[JValue::Object(&name)],
    )?
    .l()
}

pub(crate) fn clipboard_text() -> Option<String> {
    with_env(|env, activity| {
        let manager = clipboard_manager(env, activity)?;
        if manager.is_null() {
            return Ok(None);
        }
        let clip = env
            .call_method(
                &manager,
                "getPrimaryClip",
                "()Landroid/content/ClipData;",
                &[],
            )?
            .l()?;
        if clip.is_null() || env.call_method(&clip, "getItemCount", "()I", &[])?.i()? < 1 {
            return Ok(None);
        }
        let item = env
            .call_method(
                &clip,
                "getItemAt",
                "(I)Landroid/content/ClipData$Item;",
                &[JValue::Int(0)],
            )?
            .l()?;
        let text = env
            .call_method(
                &item,
                "coerceToText",
                "(Landroid/content/Context;)Ljava/lang/CharSequence;",
                &[JValue::Object(activity)],
            )?
            .l()?;
        if text.is_null() {
            return Ok(None);
        }
        let text = env
            .call_method(&text, "toString", "()Ljava/lang/String;", &[])?
            .l()?;
        Ok(Some(env.get_string(&JString::from(text))?.into()))
    })
    .ok()
    .flatten()
}

pub(crate) fn set_clipboard_text(text: &str) -> bool {
    with_env(|env, activity| {
        let manager = clipboard_manager(env, activity)?;
        if manager.is_null() {
            return Ok(false);
        }
        let label = env.new_string("text")?;
        let value = env.new_string(text)?;
        let clip = env
            .call_static_method(
                "android/content/ClipData",
                "newPlainText",
                "(Ljava/lang/CharSequence;Ljava/lang/CharSequence;)Landroid/content/ClipData;",
                &[JValue::Object(&label), JValue::Object(&value)],
            )?
            .l()?;
        env.call_method(
            &manager,
            "setPrimaryClip",
            "(Landroid/content/ClipData;)V",
            &[JValue::Object(&clip)],
        )?;
        Ok(true)
    })
    .unwrap_or(false)
}

/// `Intent.ACTION_VIEW` on the URI: the browser, the dialer, the mail app.
pub(crate) fn open_external(target: &str) -> Result<(), String> {
    with_env(|env, activity| {
        let text = env.new_string(target)?;
        let uri = env
            .call_static_method(
                "android/net/Uri",
                "parse",
                "(Ljava/lang/String;)Landroid/net/Uri;",
                &[JValue::Object(&text)],
            )?
            .l()?;
        let action = env.new_string("android.intent.action.VIEW")?;
        let intent = env.new_object(
            "android/content/Intent",
            "(Ljava/lang/String;Landroid/net/Uri;)V",
            &[JValue::Object(&action), JValue::Object(&uri)],
        )?;
        // FLAG_ACTIVITY_NEW_TASK
        env.call_method(
            &intent,
            "addFlags",
            "(I)Landroid/content/Intent;",
            &[JValue::Int(0x1000_0000)],
        )?;
        env.call_method(
            activity,
            "startActivity",
            "(Landroid/content/Intent;)V",
            &[JValue::Object(&intent)],
        )?;
        Ok(())
    })
    .map_err(|error| format!("Could not open external URI: {error}"))
}

/// Wakes the app thread's loop: a native event was queued or a request finished.
static HOST_WAKE: (Mutex<u64>, Condvar) = (Mutex::new(0), Condvar::new());

pub(crate) fn notify_host() {
    let (count, wake) = &HOST_WAKE;
    *count.lock().unwrap_or_else(|p| p.into_inner()) += 1;
    wake.notify_all();
}

/// Blocks until `notify_host` runs after `seen`, or `timeout` passes. True when woken.
pub(crate) fn wait_host(seen: &mut u64, timeout: Duration) -> bool {
    let (count, wake) = &HOST_WAKE;
    let deadline = Instant::now() + timeout;
    let mut current = count.lock().unwrap_or_else(|p| p.into_inner());
    while *current == *seen {
        let now = Instant::now();
        if now >= deadline {
            return false;
        }
        current = wake
            .wait_timeout(current, deadline - now)
            .unwrap_or_else(|p| p.into_inner())
            .0;
    }
    *seen = *current;
    true
}

pub(crate) mod device;
pub(crate) mod insets;
pub(crate) mod keys;
pub(crate) mod media;
pub(crate) mod notification;
pub(crate) mod open_intent;
pub(crate) mod permissions;
pub(crate) mod web_sign_in;

pub(crate) mod cpu_surface;
pub(crate) mod fling;
pub(crate) mod frame_rate;
pub(crate) mod perf_hint;
pub(crate) mod touch;
pub(crate) mod vsync;

pub(crate) fn read_asset(app: &AndroidApp, name: &str) -> Option<Vec<u8>> {
    use std::io::Read;
    let name = CString::new(name).ok()?;
    let mut asset = app.asset_manager().open(&name)?;
    let mut bytes = Vec::new();
    asset.read_to_end(&mut bytes).ok()?;
    Some(bytes)
}
