//! Android's performance hints (ADPF, API 33): the window's thread tells the scheduler how long
//! each frame took against its vsync budget. Without them a frame's work starts on a slow core at
//! a low clock and the scheduler only ramps up after frames were already late; with them it
//! boosts the thread when frames run long and lets it idle when they are short. The session spans
//! the window's thread and the app's JS thread, and a touch tells it (API 35) that work is coming.
use std::ffi::{c_char, c_void};
use std::sync::Mutex;

type GetManager = unsafe extern "C" fn() -> *mut c_void;
type CreateSession = unsafe extern "C" fn(*mut c_void, *const i32, usize, i64) -> *mut c_void;
type Report = unsafe extern "C" fn(*mut c_void, i64) -> i32;
type UpdateTarget = unsafe extern "C" fn(*mut c_void, i64) -> i32;
type NotifyWorkloadIncrease = unsafe extern "C" fn(*mut c_void, bool, bool, *const c_char) -> i32;

unsafe extern "C" {
    fn dlopen(name: *const c_char, flags: i32) -> *mut c_void;
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    fn gettid() -> i32;
}

struct Session {
    session: usize,
    report: Report,
    update_target: UpdateTarget,
    target_nanos: i64,
    notify_increase: Option<NotifyWorkloadIncrease>,
}

/// Threads besides the window's that frames wait on (the JS app's), joined to the session.
static THREADS: Mutex<Vec<i32>> = Mutex::new(Vec::new());

/// The calling thread does work frames wait on: the session (opened at the first frame) spans it.
pub(crate) fn register_current_thread() {
    // SAFETY: gettid has no preconditions.
    let tid = unsafe { gettid() };
    THREADS.lock().unwrap_or_else(|p| p.into_inner()).push(tid);
}

/// None until the first frame; Some(None) where the system offers no hints.
static SESSION: Mutex<Option<Option<Session>>> = Mutex::new(None);

/// The address of a libandroid function newer than the oldest system Tarve runs on (API 26).
pub(crate) fn libandroid_symbol(name: &std::ffi::CStr) -> Option<usize> {
    static LIBRARY: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    // SAFETY: libandroid is already loaded (vsync.rs links it); RTLD_NOW is 2 on Android.
    let library = *LIBRARY.get_or_init(|| unsafe { dlopen(c"libandroid.so".as_ptr(), 2) as usize });
    if library == 0 {
        return None;
    }
    // SAFETY: a symbol lookup in an open library.
    let address = unsafe { dlsym(library as *mut c_void, name.as_ptr()) } as usize;
    (address != 0).then_some(address)
}

fn symbol(name: &std::ffi::CStr) -> Option<usize> {
    libandroid_symbol(name)
}

fn open(target_nanos: i64) -> Option<Session> {
    // SAFETY: each address is the named NDK function, whose signature the types above match.
    unsafe {
        let get_manager: GetManager = std::mem::transmute(symbol(c"APerformanceHint_getManager")?);
        let create: CreateSession = std::mem::transmute(symbol(c"APerformanceHint_createSession")?);
        let report: Report =
            std::mem::transmute(symbol(c"APerformanceHint_reportActualWorkDuration")?);
        let update_target: UpdateTarget =
            std::mem::transmute(symbol(c"APerformanceHint_updateTargetWorkDuration")?);
        let manager = get_manager();
        if manager.is_null() {
            return None;
        }
        let mut tids = vec![gettid()];
        for tid in THREADS.lock().unwrap_or_else(|p| p.into_inner()).iter() {
            if !tids.contains(tid) {
                tids.push(*tid);
            }
        }
        let mut session = create(manager, tids.as_ptr(), tids.len(), target_nanos);
        if session.is_null() && tids.len() > 1 {
            session = create(manager, tids.as_ptr(), 1, target_nanos);
        }
        let notify_increase = symbol(c"APerformanceHint_notifyWorkloadIncrease")
            .map(|address| std::mem::transmute::<usize, NotifyWorkloadIncrease>(address));
        (!session.is_null()).then_some(Session {
            session: session as usize,
            report,
            update_target,
            target_nanos,
            notify_increase,
        })
    }
}

/// A frame's work took `nanos` against a budget of `target_nanos` (one vsync).
pub(crate) fn frame_done(nanos: i64, target_nanos: i64) {
    let mut state = SESSION.lock().unwrap_or_else(|p| p.into_inner());
    let session = state.get_or_insert_with(|| open(target_nanos));
    let Some(session) = session else {
        return;
    };
    // SAFETY: the session stays open for the process's life.
    unsafe {
        if session.target_nanos != target_nanos {
            session.target_nanos = target_nanos;
            (session.update_target)(session.session as *mut c_void, target_nanos);
        }
        (session.report)(session.session as *mut c_void, nanos.max(1));
    }
}

/// Input arrived that will make the next frames heavier (a touch): boost before they are late.
pub(crate) fn workload_increase() {
    let state = SESSION.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(Some(session)) = state.as_ref()
        && let Some(notify) = session.notify_increase
    {
        // SAFETY: the session stays open for the process's life; the name is NUL-terminated.
        unsafe {
            notify(
                session.session as *mut c_void,
                true,
                true,
                c"touch".as_ptr(),
            )
        };
    }
}
