//! The app's vote for the display's refresh rate. A phone whose display runs at 120 Hz drops to
//! 60 Hz for an app that does not ask, unless touch boosts it; and a 120 Hz display drawing a
//! renderer that cannot keep up judders more than a steady 60. While frames follow each other
//! (scrolling, a fling, an animation) the GPU renderer asks for the display's highest rate and
//! the CPU renderer for 60 Hz; once frames stop, the vote is withdrawn so the display may idle.
use std::ffi::c_void;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};

/// Two frames closer than this are part of one motion.
const CONTINUOUS: Duration = Duration::from_millis(50);
/// The vote is withdrawn this long after the last frame.
const IDLE: Duration = Duration::from_millis(800);

type SetFrameRate = unsafe extern "C" fn(*mut c_void, f32, i8) -> i32;

/// `ANativeWindow_setFrameRate` (API 30); None on older systems.
fn set_frame_rate() -> Option<SetFrameRate> {
    static FUNCTION: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    let address = *FUNCTION.get_or_init(|| {
        super::perf_hint::libandroid_symbol(c"ANativeWindow_setFrameRate").unwrap_or(0)
    });
    // SAFETY: a non-null address of ANativeWindow_setFrameRate has this signature.
    (address != 0).then(|| unsafe { std::mem::transmute::<usize, SetFrameRate>(address) })
}

struct Vote {
    last_frame: Option<Instant>,
    /// The rate asked for; 0 when there is no vote.
    voted: f32,
}

static VOTE: Mutex<Vote> = Mutex::new(Vote {
    last_frame: None,
    voted: 0.0,
});

fn vote(window: &winit::window::Window, rate: f32) {
    let Some(set) = set_frame_rate() else {
        return;
    };
    let Ok(handle) = window.window_handle() else {
        return;
    };
    if let RawWindowHandle::AndroidNdk(handle) = handle.as_raw() {
        // ANATIVEWINDOW_FRAME_RATE_COMPATIBILITY_DEFAULT; 0 Hz withdraws the vote.
        // SAFETY: the window is live while winit's handle is.
        unsafe { set(handle.a_native_window.as_ptr(), rate, 0) };
    }
}

/// What the GPU renderer asks for during a motion: the display picks its nearest rate (90 or
/// 120 Hz on most phones that have more than 60), and stays at 60 where that is all it has.
const HIGH_RATE: f32 = 120.0;

/// A frame was presented: during a motion, vote for the rate the renderer can hold.
pub(crate) fn frame_presented(window: &winit::window::Window, gpu: bool) {
    let now = Instant::now();
    let mut state = VOTE.lock().unwrap_or_else(|p| p.into_inner());
    let continuous = state
        .last_frame
        .is_some_and(|last| now.duration_since(last) < CONTINUOUS);
    state.last_frame = Some(now);
    if !continuous {
        return;
    }
    let rate = if gpu { HIGH_RATE } else { 60.0 };
    if state.voted != rate {
        state.voted = rate;
        drop(state);
        vote(window, rate);
    }
}

/// A finger landed: vote at once, so the first frames of a scroll already run at the high rate
/// (the vote follows frames otherwise, and is withdrawn after IDLE if none come).
pub(crate) fn touch_started(window: &winit::window::Window, gpu: bool) {
    let rate = if gpu { HIGH_RATE } else { 60.0 };
    let mut state = VOTE.lock().unwrap_or_else(|p| p.into_inner());
    state.last_frame = Some(Instant::now());
    if state.voted != rate {
        state.voted = rate;
        drop(state);
        vote(window, rate);
    }
}

/// A frame's budget: one vsync at the rate voted for, else at 60 Hz.
pub(crate) fn budget_nanos() -> i64 {
    let voted = VOTE.lock().unwrap_or_else(|p| p.into_inner()).voted;
    (1e9 / f64::from(if voted > 0.0 { voted } else { 60.0 })) as i64
}

/// When the vote must be reviewed next (None without a vote).
pub(crate) fn deadline() -> Option<Instant> {
    let state = VOTE.lock().unwrap_or_else(|p| p.into_inner());
    (state.voted != 0.0).then(|| state.last_frame.map(|last| last + IDLE))?
}

/// Withdraws the vote once frames have stopped.
pub(crate) fn settle(window: &winit::window::Window) {
    let mut state = VOTE.lock().unwrap_or_else(|p| p.into_inner());
    let idle = state.last_frame.is_none_or(|last| last.elapsed() >= IDLE);
    if state.voted != 0.0 && idle {
        state.voted = 0.0;
        drop(state);
        vote(window, 0.0);
    }
}
