// The AccessKit bridge is Windows-only; the text/tree accessibility helpers it
// consumes are shared code that is simply unreferenced on other targets.
#![cfg_attr(not(target_os = "windows"), allow(dead_code))]

#[cfg(target_os = "windows")]
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
