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
mod svg;
mod syntax;
#[cfg(test)]
mod tests;
mod text;
mod tree;

#[cfg(feature = "mimalloc")]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;
