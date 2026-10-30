//! The JS app on Android: the bundle `tarve build --target android` puts in
//! `assets/tarve/app.js`, evaluated on QuickJS-ng (the engine of txiki.js).
//!
//! The bundle's prelude (packages/core/android/prelude.ts) builds the globals the core
//! expects from `__tarveHost`: an FFI library with the C ABI Bun and Node.js load
//! (`tarve_start`, `tarve_poll_event`, …), timers, TextEncoder, fetch and synchronous
//! files. This loop runs the engine's jobs and timers, and wakes the bridge when the
//! native runtime queues an event (`notify_host`) instead of polling it.

use super::{LOG_ERROR, LOG_INFO, LOG_WARN, log, read_asset, wait_host};
use fetch::{IN_FLIGHT, deliver_fetches, start_fetch};
use rquickjs::prelude::Opt;
use rquickjs::promise::PromiseState;
use rquickjs::{
    Context, Ctx, Exception, Function, Module, Object, Persistent, Runtime, TypedArray, Value,
};
use std::cell::{Cell, RefCell};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use winit::platform::android::activity::AndroidApp;

mod bytecode;
mod dev;
mod fetch;
#[allow(unused_imports)]
pub(crate) use bytecode::*;

/// The "closed" event the bridge queues once the event loop has ended.
const APP_CLOSED: &[u8] = br#"{"type":"closed"}"#;

#[derive(Default)]
struct State {
    started: Cell<bool>,
    closed: Cell<bool>,
}

pub(super) fn run(app: &AndroidApp) -> Result<(), String> {
    let dev = dev::dev_directory(app);
    let bundle = match &dev {
        Some(directory) => {
            std::fs::read(directory.join("app.js")).map_err(|e| format!("dev/app.js: {e}"))?
        }
        None => read_asset(app, "tarve/app.js").ok_or(
            "this APK carries no app: neither assets/tarve/app.js nor libtarveapp.so is present",
        )?,
    };
    let files_dir = app
        .internal_data_path()
        .ok_or("the activity has no internal data directory")?;
    let mut assets = extract_assets(app, &files_dir)?;
    if let Some(directory) = &dev {
        dev::add_dev_assets(directory, &mut assets);
    }
    let runtime = Runtime::new().map_err(|e| e.to_string())?;
    // The app thread has a 32 MB stack (android_main).
    runtime.set_max_stack_size(24 << 20);
    runtime.set_host_promise_rejection_tracker(Some(Box::new(|ctx, _, reason, handled| {
        if !handled {
            log(
                LOG_ERROR,
                &format!("Unhandled promise rejection: {}", describe(&ctx, reason)),
            );
        }
    })));
    let context = Context::full(&runtime).map_err(|e| e.to_string())?;
    let state = Rc::new(State::default());
    context.with(|ctx| {
        install(&ctx, &state, &assets, &files_dir).map_err(|error| exception(&ctx, error))
    })?;
    // A pushed bundle changes on every save: no bytecode cache for it.
    let cache = dev
        .is_none()
        .then(|| bytecode_cache(&files_dir, &bundle))
        .flatten();
    let module = context.with(|ctx| {
        let declared =
            declare_bundle(&ctx, bundle, cache.as_deref()).map_err(|e| exception(&ctx, e))?;
        match declared.eval() {
            Ok((_, promise)) => Ok(Persistent::save(&ctx, promise)),
            Err(error) => Err(exception(&ctx, error)),
        }
    })?;
    crate::stats::trace("bundle");
    if dev.is_some() {
        // `tarve dev` times the reload by this line.
        log(LOG_INFO, "tarve dev: pushed bundle evaluated");
    }
    let mut seen = 0_u64;
    let mut module_settled = false;
    let mut closed_at: Option<Instant> = None;
    let tick = |context: &Context| {
        context.with(|ctx| {
            let tick = ctx.globals().get::<_, Function>("__tarveTick").ok()?;
            match tick.call::<_, f64>(()) {
                Ok(ms) if ms >= 0.0 => Some(ms),
                Ok(_) => None,
                Err(error) => {
                    log(LOG_ERROR, &exception(&ctx, error));
                    None
                }
            }
        })
    };
    loop {
        run_jobs(&runtime);
        deliver_fetches(&context);
        run_jobs(&runtime);
        let mut next = tick(&context);
        // Timers ran jobs (an `await` resuming); a timer one of them set is due later and
        // must be in the wait below, or the loop sleeps until the next native event.
        while runtime.is_job_pending() {
            run_jobs(&runtime);
            next = tick(&context);
        }
        if !module_settled {
            module_settled = context.with(|ctx| {
                let Ok(promise) = module.clone().restore(&ctx) else {
                    return true;
                };
                match promise.state() {
                    PromiseState::Pending => false,
                    PromiseState::Resolved => true,
                    PromiseState::Rejected => {
                        if let Some(Err(error)) = promise.result::<Value>() {
                            log(LOG_ERROR, &format!("app.js: {}", exception(&ctx, error)));
                        }
                        true
                    }
                }
            });
        }
        if state.closed.get() {
            closed_at.get_or_insert_with(Instant::now);
        }
        let idle =
            next.is_none() && IN_FLIGHT.load(Ordering::Acquire) == 0 && !runtime.is_job_pending();
        if idle && (state.closed.get() || (module_settled && !state.started.get())) {
            break;
        }
        // After the window closed, pending timers get a moment (saving state), not forever.
        if closed_at.is_some_and(|at| at.elapsed() > Duration::from_secs(3)) {
            break;
        }
        let mut timeout = next.map_or(Duration::from_secs(3600), |ms| {
            Duration::from_secs_f64(ms / 1000.0)
        });
        if closed_at.is_some() {
            timeout = timeout.min(Duration::from_millis(100));
        }
        if timeout.is_zero() || wait_host(&mut seen, timeout) {
            context.with(|ctx| {
                if let Ok(wake) = ctx.globals().get::<_, Function>("__tarveWake")
                    && let Err(error) = wake.call::<_, ()>(())
                {
                    log(LOG_ERROR, &exception(&ctx, error));
                }
            });
        }
    }
    Ok(())
}

fn run_jobs(runtime: &Runtime) {
    loop {
        match runtime.execute_pending_job() {
            Ok(true) => {}
            Ok(false) => return,
            Err(error) => error
                .0
                .with(|ctx| log(LOG_ERROR, &describe(&ctx, ctx.catch()))),
        }
    }
}

fn describe(_ctx: &Ctx, value: Value) -> String {
    if let Some(error) = value.as_exception() {
        let message = error.message().unwrap_or_default();
        return match error.stack() {
            Some(stack) if !stack.is_empty() => format!("{message}\n{stack}"),
            _ => message,
        };
    }
    value
        .get::<rquickjs::Coerced<String>>()
        .map(|text| text.0)
        .unwrap_or_else(|_| "<exception>".into())
}

pub(super) fn exception(ctx: &Ctx, error: rquickjs::Error) -> String {
    if matches!(error, rquickjs::Error::Exception) {
        describe(ctx, ctx.catch())
    } else {
        error.to_string()
    }
}

fn install<'js>(
    ctx: &Ctx<'js>,
    state: &Rc<State>,
    assets: &[(String, String)],
    files_dir: &Path,
) -> rquickjs::Result<()> {
    let host = Object::new(ctx.clone())?;
    let epoch = Instant::now();
    host.set("arch", std::env::consts::ARCH)?;
    host.set("filesDir", files_dir.to_string_lossy().into_owned())?;
    host.set(
        "cacheDir",
        std::env::var("TMPDIR").unwrap_or_else(|_| files_dir.to_string_lossy().into_owned()),
    )?;
    host.set(
        "now",
        Function::new(ctx.clone(), move || epoch.elapsed().as_secs_f64() * 1000.0)?,
    )?;
    host.set(
        "log",
        Function::new(ctx.clone(), |level: i32, message: String| {
            let priority = match level {
                2 => LOG_ERROR,
                1 => LOG_WARN,
                _ => LOG_INFO,
            };
            log(priority, &message);
        })?,
    )?;
    host.set(
        "env",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| {
            let env = Object::new(ctx)?;
            for (key, value) in std::env::vars() {
                env.set(key, value)?;
            }
            Ok::<_, rquickjs::Error>(env)
        })?,
    )?;
    host.set(
        "exit",
        Function::new(ctx.clone(), |code: i32| -> () { std::process::exit(code) })?,
    )?;

    // The native runtime, through its C ABI.
    host.set(
        "abi",
        Function::new(ctx.clone(), || crate::bridge::tarve_abi_version())?,
    )?;
    {
        let state = state.clone();
        host.set(
            "start",
            Function::new(ctx.clone(), move |payload: TypedArray<'js, u8>| {
                let bytes = bytes_of(&payload);
                // SAFETY: a live buffer of `len` bytes for the duration of the call.
                let code =
                    unsafe { crate::bridge::tarve_start(bytes.as_ptr(), bytes.len() as u32) };
                if code == 0 {
                    state.started.set(true);
                }
                code
            })?,
        )?;
    }
    host.set(
        "send",
        Function::new(ctx.clone(), |payload: TypedArray<'js, u8>| {
            let bytes = bytes_of(&payload);
            // SAFETY: as above.
            unsafe { crate::bridge::tarve_send(bytes.as_ptr(), bytes.len() as u32) }
        })?,
    )?;
    {
        let state = state.clone();
        let buffer = RefCell::new(vec![0_u8; 64 * 1024]);
        host.set(
            "poll",
            Function::new(
                ctx.clone(),
                move |ctx: Ctx<'js>| -> rquickjs::Result<Option<TypedArray<'js, u8>>> {
                    let mut buffer = buffer.borrow_mut();
                    loop {
                        // SAFETY: a writable buffer of its full length.
                        let n = unsafe {
                            crate::bridge::tarve_poll_event(
                                buffer.as_mut_ptr(),
                                buffer.len() as u32,
                            )
                        };
                        if n > 0 {
                            let event = &buffer[..n as usize];
                            if event == APP_CLOSED {
                                state.closed.set(true);
                            }
                            return Ok(Some(TypedArray::new_copy(ctx, event)?));
                        }
                        if n < -1 {
                            let size = n.unsigned_abs() as usize;
                            buffer.resize(size, 0);
                            continue;
                        }
                        return Ok(None);
                    }
                },
            )?,
        )?;
    }
    host.set(
        "lastError",
        Function::new(ctx.clone(), || {
            let mut buffer = vec![0_u8; 8192];
            // SAFETY: a writable buffer of its full length.
            let n = unsafe {
                crate::bridge::tarve_last_error(buffer.as_mut_ptr(), buffer.len() as u32)
            };
            String::from_utf8_lossy(&buffer[..n.max(0) as usize]).into_owned()
        })?,
    )?;
    host.set(
        "openExternal",
        Function::new(ctx.clone(), |target: String| {
            // SAFETY: a live UTF-8 buffer for the duration of the call.
            unsafe { crate::bridge::tarve_open_external(target.as_ptr(), target.len() as u32) }
        })?,
    )?;

    // TextEncoder / TextDecoder.
    host.set(
        "encode",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, text: String| {
            TypedArray::<u8>::new(ctx, text.into_bytes())
        })?,
    )?;
    host.set(
        "decode",
        Function::new(ctx.clone(), |bytes: TypedArray<'js, u8>| {
            String::from_utf8_lossy(bytes_of(&bytes)).into_owned()
        })?,
    )?;

    // Synchronous files (node:fs), as Bun and Node.js offer them.
    host.set(
        "readFile",
        Function::new(
            ctx.clone(),
            |ctx: Ctx<'js>, path: String| match std::fs::read(&path) {
                Ok(bytes) => TypedArray::<u8>::new(ctx, bytes),
                Err(error) => Err(io_error(&ctx, "open", &path, error)),
            },
        )?,
    )?;
    host.set(
        "writeFile",
        Function::new(
            ctx.clone(),
            |ctx: Ctx<'js>, path: String, data: TypedArray<'js, u8>, append: Opt<bool>| {
                use std::io::Write;
                let result = std::fs::OpenOptions::new()
                    .create(true)
                    .write(true)
                    .append(append.0.unwrap_or(false))
                    .truncate(!append.0.unwrap_or(false))
                    .open(&path)
                    .and_then(|mut file| file.write_all(bytes_of(&data)));
                result.map_err(|error| io_error(&ctx, "open", &path, error))
            },
        )?,
    )?;
    host.set(
        "stat",
        Function::new(ctx.clone(), |path: String| {
            let metadata = std::fs::metadata(&path).ok()?;
            let kind = if metadata.is_file() {
                1.0
            } else if metadata.is_dir() {
                2.0
            } else {
                0.0
            };
            let modified = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0.0, |since| since.as_secs_f64() * 1000.0);
            Some(vec![kind, metadata.len() as f64, modified])
        })?,
    )?;
    host.set(
        "mkdir",
        Function::new(
            ctx.clone(),
            |ctx: Ctx<'js>, path: String, recursive: Opt<bool>| {
                let result = if recursive.0.unwrap_or(false) {
                    std::fs::create_dir_all(&path)
                } else {
                    std::fs::create_dir(&path)
                };
                result.map_err(|error| io_error(&ctx, "mkdir", &path, error))
            },
        )?,
    )?;
    host.set(
        "rename",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, from: String, to: String| {
            std::fs::rename(&from, &to).map_err(|error| io_error(&ctx, "rename", &from, error))
        })?,
    )?;
    host.set(
        "copyFile",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, from: String, to: String| {
            std::fs::copy(&from, &to)
                .map(|_| ())
                .map_err(|error| io_error(&ctx, "copyfile", &from, error))
        })?,
    )?;
    host.set(
        "remove",
        Function::new(
            ctx.clone(),
            |ctx: Ctx<'js>, path: String, recursive: Opt<bool>| {
                let target = PathBuf::from(&path);
                let result = match std::fs::symlink_metadata(&target) {
                    Ok(metadata) if metadata.is_dir() => {
                        if recursive.0.unwrap_or(false) {
                            std::fs::remove_dir_all(&target)
                        } else {
                            std::fs::remove_dir(&target)
                        }
                    }
                    Ok(_) => std::fs::remove_file(&target),
                    Err(error) => Err(error),
                };
                result.map_err(|error| io_error(&ctx, "rm", &path, error))
            },
        )?,
    )?;
    host.set(
        "readDir",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, path: String| {
            let entries = std::fs::read_dir(&path)
                .map_err(|error| io_error(&ctx, "scandir", &path, error))?;
            // A trailing "/" marks a directory.
            Ok::<_, rquickjs::Error>(
                entries
                    .filter_map(Result::ok)
                    .map(|entry| {
                        let name = entry.file_name().to_string_lossy().into_owned();
                        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                            format!("{name}/")
                        } else {
                            name
                        }
                    })
                    .collect::<Vec<_>>(),
            )
        })?,
    )?;

    // node:crypto.
    host.set(
        "hash",
        Function::new(
            ctx.clone(),
            |ctx: Ctx<'js>, algorithm: String, data: TypedArray<'js, u8>| {
                let digest = hash(&algorithm, bytes_of(&data)).ok_or_else(|| {
                    Exception::throw_message(
                        &ctx,
                        &format!("Digest method not supported: {algorithm}"),
                    )
                })?;
                TypedArray::<u8>::new(ctx, digest)
            },
        )?,
    )?;
    host.set(
        "random",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, size: usize| {
            use std::io::Read;
            let mut bytes = vec![0_u8; size];
            std::fs::File::open("/dev/urandom")
                .and_then(|mut file| file.read_exact(&mut bytes))
                .map_err(|error| io_error(&ctx, "read", "/dev/urandom", error))?;
            TypedArray::<u8>::new(ctx, bytes)
        })?,
    )?;

    // node:zlib: zlib and gzip streams (PNG, archives), as txiki.js gets them (src/zlib.rs).
    host.set(
        "zlib",
        Function::new(
            ctx.clone(),
            |ctx: Ctx<'js>, op: String, data: TypedArray<'js, u8>, level: Opt<u8>| {
                let input = bytes_of(&data);
                let level = level.0.unwrap_or(crate::zlib::DEFAULT_LEVEL);
                let output = match op.as_str() {
                    "deflate" => Ok(crate::zlib::deflate(input, level)),
                    "inflate" => crate::zlib::inflate(input),
                    "gzip" => Ok(crate::zlib::gzip(input, level)),
                    "gunzip" => crate::zlib::gunzip(input),
                    _ => Err("unknown operation".to_string()),
                }
                .map_err(|message| {
                    Exception::throw_message(&ctx, &format!("zlib {op}: {message}"))
                })?;
                TypedArray::<u8>::new(ctx, output)
            },
        )?,
    )?;

    // fetch: the request runs on its own thread; the loop resolves it (__tarveFetchDone).
    host.set(
        "fetch",
        Function::new(
            ctx.clone(),
            |id: u32,
             method: String,
             url: String,
             headers: Vec<String>,
             body: Option<TypedArray<'js, u8>>| {
                let body = body.map(|body| bytes_of(&body).to_vec());
                start_fetch(id, method, url, headers, body);
            },
        )?,
    )?;

    let files = Object::new(ctx.clone())?;
    for (name, path) in assets {
        files.set(name.as_str(), path.as_str())?;
    }
    let globals = ctx.globals();
    globals.set("__tarveAssets", files)?;
    globals.set("__tarveHost", host)?;
    Ok(())
}

fn hash(algorithm: &str, data: &[u8]) -> Option<Vec<u8>> {
    use sha2::Digest;
    Some(
        match algorithm.to_ascii_lowercase().replace('-', "").as_str() {
            "sha256" => sha2::Sha256::digest(data).to_vec(),
            "sha512" => sha2::Sha512::digest(data).to_vec(),
            "sha384" => sha2::Sha384::digest(data).to_vec(),
            "sha224" => sha2::Sha224::digest(data).to_vec(),
            "sha1" => sha1::Sha1::digest(data).to_vec(),
            "md5" => md5::Md5::digest(data).to_vec(),
            _ => return None,
        },
    )
}
