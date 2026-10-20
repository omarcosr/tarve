// The AccessKit bridge runs on Windows (UIA) and Linux (AT-SPI); the text/tree accessibility helpers it
// consumes are shared code that is simply unreferenced on other targets.
#![cfg_attr(not(any(target_os = "windows", target_os = "linux")), allow(dead_code))]
// A library trimmed to the features an app uses (`tarve build`) leaves helpers of the others unreferenced.
#![cfg_attr(
    not(all(feature = "vello-gpu", feature = "syntax", feature = "markdown", feature = "net", feature = "media")),
    allow(dead_code, unused_imports, unused_variables)
)]

#[cfg(any(target_os = "windows", target_os = "linux"))]
mod accessibility;
#[cfg(not(target_arch = "wasm32"))]
mod bridge;
mod controls;
#[cfg(not(target_arch = "wasm32"))]
mod cpu_display;
#[cfg(target_os = "windows")]
mod d3d11;
#[cfg(target_os = "windows")]
mod d3d11_overlay;
#[cfg(target_os = "windows")]
mod desktop_widget;
#[cfg(target_os = "windows")]
mod gpu_timer;
#[cfg(all(not(target_arch = "wasm32"), feature = "media"))]
mod media;
#[cfg(all(not(target_arch = "wasm32"), not(feature = "media")))]
#[path = "media_off.rs"]
mod media;
#[cfg(not(target_arch = "wasm32"))]
mod menu_bar;
mod paint;
mod protocol;
#[cfg(not(target_arch = "wasm32"))]
mod remote_image;
#[cfg(not(target_arch = "wasm32"))]
mod renderer;
mod rich;
#[cfg(not(target_arch = "wasm32"))]
mod runtime;
mod shadow;
#[cfg(target_os = "windows")]
mod smtc;
#[cfg(not(target_arch = "wasm32"))]
mod stats;
#[cfg(test)]
mod startup_bench;
mod svg;
mod syntax;
#[cfg(test)]
mod tests;
mod text;
#[cfg(not(target_arch = "wasm32"))]
mod tray;
mod tree;
mod video;
// Browser build: the same tree, layout, text and CPU paint, driven from JavaScript.
#[cfg(target_arch = "wasm32")]
mod web;
#[cfg(target_os = "linux")]
mod x11_state;

#[cfg(all(test, not(feature = "mimalloc")))]
pub(crate) mod counting_alloc {
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::sync::atomic::{AtomicIsize, Ordering};
    pub static LIVE: AtomicIsize = AtomicIsize::new(0);
    pub struct Counting;
    unsafe impl GlobalAlloc for Counting {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            LIVE.fetch_add(layout.size() as isize, Ordering::Relaxed);
            unsafe { System.alloc(layout) }
        }
        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            LIVE.fetch_sub(layout.size() as isize, Ordering::Relaxed);
            unsafe { System.dealloc(ptr, layout) }
        }
        unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
            LIVE.fetch_add(size as isize - layout.size() as isize, Ordering::Relaxed);
            unsafe { System.realloc(ptr, layout, size) }
        }
    }
    #[global_allocator]
    static GLOBAL: Counting = Counting;
}
#[cfg(feature = "mimalloc")]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[cfg(feature = "mimalloc")]
unsafe extern "C" {
    fn mi_collect(force: bool);
}

/// Returns the calling thread's free allocator pages to the OS. mimalloc
/// keeps freed pages for reuse, so without this a burst of work (startup, a
/// large update) leaves an idle app at its peak working set.
pub(crate) fn release_free_memory() {
    #[cfg(feature = "mimalloc")]
    // SAFETY: mi_collect only walks and trims mimalloc's own heap state.
    unsafe {
        mi_collect(true);
    }
}

/// Process-wide EcoQoS (Windows): while every window is minimized or hidden
/// and nothing plays, the scheduler may run the process on efficient cores at a
/// low clock. Windows already does this for some background apps; Tarve asks
/// for it explicitly and hands control back to the system when a window returns.
pub(crate) mod power {
    use std::cell::Cell;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static WINDOWS: AtomicUsize = AtomicUsize::new(0);
    static BACKGROUND: AtomicUsize = AtomicUsize::new(0);

    /// One per window: counted while it lives, as background while it says so.
    pub(crate) struct Presence {
        background: Cell<bool>,
    }

    impl Presence {
        pub(crate) fn new() -> Self {
            WINDOWS.fetch_add(1, Ordering::Relaxed);
            sync();
            Self { background: Cell::new(false) }
        }
        pub(crate) fn set_background(&self, background: bool) {
            if self.background.replace(background) == background {
                return;
            }
            if background {
                BACKGROUND.fetch_add(1, Ordering::Relaxed);
            } else {
                BACKGROUND.fetch_sub(1, Ordering::Relaxed);
            }
            sync();
        }
    }

    impl Drop for Presence {
        fn drop(&mut self) {
            if self.background.get() {
                BACKGROUND.fetch_sub(1, Ordering::Relaxed);
            }
            WINDOWS.fetch_sub(1, Ordering::Relaxed);
            sync();
        }
    }

    fn sync() {
        let windows = WINDOWS.load(Ordering::Relaxed);
        set_eco_qos(windows > 0 && BACKGROUND.load(Ordering::Relaxed) >= windows);
    }

    #[cfg(target_os = "windows")]
    fn set_eco_qos(on: bool) {
        #[repr(C)]
        struct ProcessPowerThrottlingState {
            version: u32,
            control_mask: u32,
            state_mask: u32,
        }
        const PROCESS_POWER_THROTTLING: i32 = 4;
        const EXECUTION_SPEED: u32 = 1;
        unsafe extern "system" {
            fn GetCurrentProcess() -> isize;
            fn SetProcessInformation(process: isize, class: i32, information: *const core::ffi::c_void, size: u32) -> i32;
        }
        // On: throttle execution speed. Off: an empty control mask returns the
        // decision to Windows' own heuristics instead of opting out of them.
        let state = ProcessPowerThrottlingState {
            version: 1,
            control_mask: if on { EXECUTION_SPEED } else { 0 },
            state_mask: if on { EXECUTION_SPEED } else { 0 },
        };
        // SAFETY: a valid, correctly sized PROCESS_POWER_THROTTLING_STATE for this process.
        unsafe {
            SetProcessInformation(
                GetCurrentProcess(),
                PROCESS_POWER_THROTTLING,
                (&raw const state).cast(),
                std::mem::size_of::<ProcessPowerThrottlingState>() as u32,
            );
        }
    }

    #[cfg(not(target_os = "windows"))]
    fn set_eco_qos(_on: bool) {}

    #[cfg(all(test, target_os = "windows"))]
    mod tests {
        use super::Presence;

        /// The process's PROCESS_POWER_THROTTLING_STATE control and state masks.
        fn throttling() -> (u32, u32) {
            let mut state = [1_u32, 0, 0];
            unsafe extern "system" {
                fn GetCurrentProcess() -> isize;
                fn GetProcessInformation(process: isize, class: i32, information: *mut core::ffi::c_void, size: u32) -> i32;
            }
            // SAFETY: a correctly sized PROCESS_POWER_THROTTLING_STATE (version 1) for this process.
            let ok = unsafe { GetProcessInformation(GetCurrentProcess(), 4, state.as_mut_ptr().cast(), 12) };
            assert_ne!(ok, 0, "GetProcessInformation(ProcessPowerThrottling) failed");
            (state[1], state[2])
        }

        #[test]
        fn eco_qos_follows_the_windows_in_the_background() {
            let first = Presence::new();
            let second = Presence::new();
            first.set_background(true);
            assert_eq!(throttling(), (0, 0), "one window still in front: no EcoQoS");
            second.set_background(true);
            assert_eq!(throttling(), (1, 1), "every window in the background: EcoQoS");
            first.set_background(false);
            assert_eq!(throttling(), (0, 0), "a window back in front hands control back to Windows");
            drop(first);
            assert_eq!(throttling(), (1, 1), "the remaining window is in the background");
            drop(second);
            assert_eq!(throttling(), (0, 0), "no windows: no EcoQoS");
        }
    }
}

/// Lets Windows take back the pages the process touched once and not since:
/// driver and shader setup, startup parsing. They stay committed and come back
/// from the standby list without disk I/O if touched again; the resident set,
/// what Task Manager shows, drops to what the app actually uses.
/// When it runs is the app's `memoryTrimDelay` (`App::trim_delay`).
pub(crate) fn trim_working_set() {
    #[cfg(target_os = "windows")]
    {
        unsafe extern "system" {
            fn GetCurrentProcess() -> isize;
            fn K32EmptyWorkingSet(process: isize) -> i32;
        }
        // SAFETY: both calls only act on this process's own memory manager state.
        unsafe {
            K32EmptyWorkingSet(GetCurrentProcess());
        }
    }
}
