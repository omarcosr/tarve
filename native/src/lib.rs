// The AccessKit bridge runs on Windows (UIA) and Linux (AT-SPI); the text/tree accessibility helpers it
// consumes are shared code that is simply unreferenced on other targets.
#![cfg_attr(not(any(target_os = "windows", target_os = "linux")), allow(dead_code))]

#[cfg(any(target_os = "windows", target_os = "linux"))]
mod accessibility;
#[cfg(not(target_arch = "wasm32"))]
mod bridge;
mod controls;
#[cfg(target_os = "windows")]
mod d3d11;
#[cfg(not(target_arch = "wasm32"))]
mod media;
mod paint;
mod protocol;
#[cfg(not(target_arch = "wasm32"))]
mod renderer;
mod rich;
#[cfg(not(target_arch = "wasm32"))]
mod runtime;
mod shadow;
mod svg;
mod syntax;
#[cfg(test)]
mod tests;
mod text;
#[cfg(not(target_arch = "wasm32"))]
mod tray;
mod tree;
// Browser build: the same tree, layout, text and CPU paint, driven from JavaScript.
#[cfg(target_arch = "wasm32")]
mod web;

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
