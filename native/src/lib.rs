// The AccessKit bridge runs on Windows (UIA) and Linux (AT-SPI); the text/tree accessibility helpers it
// consumes are shared code that is simply unreferenced on other targets.
#![cfg_attr(not(any(target_os = "windows", target_os = "linux")), allow(dead_code))]

#[cfg(any(target_os = "windows", target_os = "linux"))]
mod accessibility;
mod bridge;
mod controls;
#[cfg(target_os = "windows")]
mod d3d11;
mod paint;
mod protocol;
mod renderer;
mod rich;
mod runtime;
mod shadow;
mod svg;
mod syntax;
#[cfg(test)]
mod tests;
mod text;
mod tree;

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
