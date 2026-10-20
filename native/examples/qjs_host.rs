//! Prototype: the Tarve native runtime driven by an embedded QuickJS-ng (rquickjs)
//! instead of Bun/Node/txiki. MODE=native starts the window from a saved document
//! with no JS at all (the floor); MODE=qjs evaluates the app bundle and starts the
//! window from what it renders. Prints the process memory after it settles.
use std::time::{Duration, Instant};

/// The runtime is loaded like Bun/Node/txiki load it: the release DLL, by path (TARVE_NATIVE).
struct Native {
    start: unsafe extern "C" fn(*const u8, u32) -> i32,
    send: unsafe extern "C" fn(*const u8, u32) -> i32,
    poll: unsafe extern "C" fn(*mut u8, u32) -> i32,
}
fn native() -> &'static Native {
    static NATIVE: std::sync::OnceLock<Native> = std::sync::OnceLock::new();
    NATIVE.get_or_init(|| {
        unsafe extern "system" {
            fn LoadLibraryW(name: *const u16) -> isize;
            fn GetProcAddress(module: isize, name: *const u8) -> usize;
        }
        let path = std::env::var("TARVE_NATIVE")
            .unwrap_or_else(|_| "native/target/release/tarve_native.dll".into());
        let wide: Vec<u16> = path.encode_utf16().chain([0]).collect();
        let module = unsafe { LoadLibraryW(wide.as_ptr()) };
        assert_ne!(module, 0, "could not load {path}");
        let symbol = |name: &std::ffi::CStr| {
            let address = unsafe { GetProcAddress(module, name.as_ptr().cast()) };
            assert_ne!(address, 0, "{name:?} missing");
            address
        };
        // SAFETY: the C ABI of native/src/bridge.rs.
        unsafe {
            Native {
                start: std::mem::transmute(symbol(c"tarve_start")),
                send: std::mem::transmute(symbol(c"tarve_send")),
                poll: std::mem::transmute(symbol(c"tarve_poll_event")),
            }
        }
    })
}
fn start(json: &str) {
    let code = unsafe { (native().start)(json.as_ptr(), json.len() as u32) };
    assert_eq!(code, 0, "tarve_start failed");
}
fn send(json: &str) {
    unsafe { (native().send)(json.as_ptr(), json.len() as u32) };
}
fn poll(buffer: &mut Vec<u8>) -> Option<String> {
    loop {
        let n = unsafe { (native().poll)(buffer.as_mut_ptr(), buffer.len() as u32) };
        if n > 0 {
            return Some(String::from_utf8_lossy(&buffer[..n as usize]).into_owned());
        }
        if n < -1 {
            buffer.resize((-n) as usize, 0);
            continue;
        }
        return None;
    }
}

fn private_mb() -> (f64, f64) {
    #[repr(C)]
    #[derive(Default)]
    struct Counters {
        cb: u32,
        faults: u32,
        peak_ws: usize,
        ws: usize,
        a: usize,
        b: usize,
        c: usize,
        d: usize,
        pagefile: usize,
        peak_pagefile: usize,
    }
    unsafe extern "system" {
        fn GetCurrentProcess() -> isize;
        fn K32GetProcessMemoryInfo(p: isize, c: *mut Counters, cb: u32) -> i32;
    }
    let mut c = Counters {
        cb: size_of::<Counters>() as u32,
        ..Default::default()
    };
    unsafe { K32GetProcessMemoryInfo(GetCurrentProcess(), &mut c, c.cb) };
    (c.pagefile as f64 / 1048576.0, c.ws as f64 / 1048576.0)
}

fn main() {
    let mode = std::env::var("MODE").unwrap_or_else(|_| "qjs".into());
    let scene = std::env::var("SCENE").unwrap_or_else(|_| "empty".into());
    let settle = Duration::from_millis(
        std::env::var("SETTLE")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(5000),
    );
    let started = Instant::now();
    if mode == "native" {
        let json = std::fs::read_to_string(std::env::var("DOC").expect("DOC=path")).unwrap();
        start(&json);
        std::thread::sleep(settle);
    } else {
        use rquickjs::{Context, Function, Runtime};
        let bundle_path = std::env::var("BUNDLE").expect("BUNDLE=path");
        let bundle = std::fs::read(&bundle_path).unwrap();
        let bytecode = bundle_path.ends_with(".qbc");
        let compile = std::env::var("COMPILE").ok();
        let runtime = Runtime::new().unwrap();
        let context = Context::full(&runtime).unwrap();
        let dump = std::env::var("DUMP").ok();
        context.with(|ctx| {
            let globals = ctx.globals();
            globals.set("__scene", scene.clone()).unwrap();
            globals
                .set("__busy", std::env::var_os("BUSY").is_some())
                .unwrap();
            globals
                .set(
                    "__tarveSend",
                    Function::new(ctx.clone(), |json: String| send(&json)).unwrap(),
                )
                .unwrap();
            globals
                .set(
                    "__log",
                    Function::new(ctx.clone(), |line: String| eprintln!("[js] {line}")).unwrap(),
                )
                .unwrap();
            globals
                .set(
                    "__tarveStart",
                    Function::new(ctx.clone(), move |json: String| {
                        if let Some(path) = &dump {
                            std::fs::write(path, &json).unwrap();
                        }
                        eprintln!("startMs {}", started.elapsed().as_millis());
                        start(&json);
                    })
                    .unwrap(),
                )
                .unwrap();
            if let Some(out) = &compile {
                let module = rquickjs::Module::declare(ctx.clone(), "app", bundle.clone()).unwrap();
                let options = rquickjs::module::WriteOptions {
                    strip_source: true,
                    strip_debug: std::env::var_os("STRIP_DEBUG").is_some(),
                    ..Default::default()
                };
                let bytes = module.write(options).unwrap();
                std::fs::write(out, &bytes).unwrap();
                eprintln!(
                    "bytecode {} KB (source {} KB)",
                    bytes.len() >> 10,
                    bundle.len() >> 10
                );
                std::process::exit(0);
            }
            let result = if bytecode {
                // SAFETY: bytecode this same QuickJS build wrote (COMPILE=...).
                unsafe { rquickjs::Module::load(ctx.clone(), &bundle) }
                    .and_then(|module| module.eval())
                    .map(|_| ())
            } else {
                ctx.eval::<(), _>(bundle)
            };
            if let Err(error) = result {
                let detail: String = ctx
                    .catch()
                    .as_exception()
                    .map(|e| format!("{:?} {:?}", e.message(), e.stack()))
                    .unwrap_or_default();
                panic!("bundle failed: {error} {detail}");
            }
        });
        // Event loop: promise jobs and the polyfill's timers, until the app settles.
        // Prototype pump: a production host would block on the wake pipe instead of polling.
        let mut buffer = vec![0_u8; 64 * 1024];
        while started.elapsed() < settle {
            let mut worked = false;
            context.with(|ctx| {
                if let Ok(deliver) = ctx.globals().get::<_, Function>("__tarveEvent") {
                    while let Some(event) = poll(&mut buffer) {
                        worked = true;
                        if deliver.call::<_, ()>((event,)).is_err() {
                            let detail = ctx
                                .catch()
                                .as_exception()
                                .map(|e| format!("{:?} {:?}", e.message(), e.stack()))
                                .unwrap_or_default();
                            eprintln!("[event error] {detail}");
                        }
                    }
                }
                let _: rquickjs::Result<i32> = ctx
                    .globals()
                    .get::<_, Function>("__tick")
                    .and_then(|f| f.call(()));
            });
            while runtime.is_job_pending() {
                worked = true;
                let _ = runtime.execute_pending_job();
            }
            if !worked {
                std::thread::sleep(Duration::from_millis(2));
            }
        }
        runtime.run_gc();
        let usage = runtime.memory_usage();
        eprintln!(
            "quickjs malloc {:.1} MB in {} blocks",
            usage.malloc_size as f64 / 1048576.0,
            usage.malloc_count
        );
    }
    let (private, ws) = private_mb();
    println!(
        "{{\"mode\":\"{mode}\",\"scene\":\"{scene}\",\"privateMb\":{private:.1},\"wsMb\":{ws:.1}}}"
    );
    std::process::exit(0);
}
