//! Frames on the display's vsync (AChoreographer), as Android's own views draw: drawing as soon
//! as input arrives renders some vsyncs twice and others not at all, and scrolling judders.
//! Motion is timed at the vsync too (as Choreographer.frameTimeNanos is), so an animation steps
//! by whole frame intervals however late the callback was dispatched.
use std::ffi::{c_long, c_void};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use winit::window::Window;

#[link(name = "android")]
unsafe extern "C" {
    fn AChoreographer_getInstance() -> *mut c_void;
    fn AChoreographer_postFrameCallback(
        choreographer: *mut c_void,
        callback: extern "C" fn(c_long, *mut c_void),
        data: *mut c_void,
    );
}

#[repr(C)]
struct Timespec {
    seconds: i64,
    nanos: c_long,
}

unsafe extern "C" {
    fn clock_gettime(clock: i32, time: *mut Timespec) -> i32;
}

type FrameCallback64 = extern "C" fn(i64, *mut c_void);
type PostFrameCallback64 = unsafe extern "C" fn(*mut c_void, FrameCallback64, *mut c_void);

/// `AChoreographer_postFrameCallback64` (API 29): the vsync time stays 64-bit everywhere.
fn post_frame_callback64() -> Option<PostFrameCallback64> {
    static FUNCTION: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    let address = *FUNCTION.get_or_init(|| {
        super::perf_hint::libandroid_symbol(c"AChoreographer_postFrameCallback64").unwrap_or(0)
    });
    // SAFETY: a non-null address of AChoreographer_postFrameCallback64 has this signature.
    (address != 0).then(|| unsafe { std::mem::transmute::<usize, PostFrameCallback64>(address) })
}

/// The window to redraw at the next vsync; Some while a callback is posted.
static WAITING: Mutex<Option<Weak<Window>>> = Mutex::new(None);
/// CLOCK_MONOTONIC nanoseconds of the last vsync a frame was drawn for; 0 before the first.
static VSYNC_NANOS: AtomicI64 = AtomicI64::new(0);

fn waiting() -> std::sync::MutexGuard<'static, Option<Weak<Window>>> {
    WAITING.lock().unwrap_or_else(|p| p.into_inner())
}

// `long` is 64-bit on the ABIs shipped today, 32-bit on armeabi-v7a.
#[allow(clippy::useless_conversion)]
fn monotonic_nanos() -> i64 {
    let mut time = Timespec {
        seconds: 0,
        nanos: 0,
    };
    // SAFETY: CLOCK_MONOTONIC (1) into a live timespec; the clock Choreographer's times use.
    unsafe { clock_gettime(1, &mut time) };
    time.seconds * 1_000_000_000 + i64::from(time.nanos)
}

fn vsync(frame_time_nanos: i64) {
    VSYNC_NANOS.store(frame_time_nanos, Ordering::Relaxed);
    let window = waiting().take().and_then(|window| window.upgrade());
    if let Some(window) = window {
        window.request_redraw();
    }
}

#[allow(clippy::useless_conversion)]
extern "C" fn frame(frame_time_nanos: c_long, _: *mut c_void) {
    vsync(i64::from(frame_time_nanos));
}

extern "C" fn frame64(frame_time_nanos: i64, _: *mut c_void) {
    vsync(frame_time_nanos);
}

/// How long ago the current frame's vsync was, while that is under one frame at 30 Hz
/// (None before the first vsync, or once frames have stopped following it).
pub(crate) fn frame_age() -> Option<Duration> {
    let vsync = VSYNC_NANOS.load(Ordering::Relaxed);
    if vsync == 0 {
        return None;
    }
    let age = monotonic_nanos() - vsync;
    (0..33_000_000)
        .contains(&age)
        .then(|| Duration::from_nanos(age as u64))
}

/// Redraws `window` at the next vsync (the event loop's thread, which owns the looper).
pub(crate) fn request_redraw(window: &Arc<Window>) {
    let posted = waiting().replace(Arc::downgrade(window)).is_some();
    if posted {
        return;
    }
    let choreographer = unsafe { AChoreographer_getInstance() };
    if choreographer.is_null() {
        waiting().take();
        window.request_redraw();
        return;
    }
    // SAFETY: the looper thread's choreographer; the callbacks ignore their data pointer.
    unsafe {
        match post_frame_callback64() {
            Some(post) => post(choreographer, frame64, std::ptr::null_mut()),
            None => AChoreographer_postFrameCallback(choreographer, frame, std::ptr::null_mut()),
        }
    }
}
