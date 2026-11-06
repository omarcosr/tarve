//! Windows: the library loads the system DLLs of the GPU, accessibility and shell code only when
//! it first calls them (delay loading). Loading the library is on the path to the first frame;
//! the GPU device is created on another thread (d3d11::prewarm) and the CPU renderer draws the
//! first frames, so d3d11, dxgi and dcomp load there instead of in the app's `dlopen`.
fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let windows = std::env::var("CARGO_CFG_TARGET_OS").is_ok_and(|os| os == "windows");
    let msvc = std::env::var("CARGO_CFG_TARGET_ENV").is_ok_and(|env| env == "msvc");
    if !(windows && msvc) || std::env::var_os("TARVE_NO_DELAYLOAD").is_some() {
        return;
    }
    for dll in [
        "d3d11.dll",
        "dxgi.dll",
        "dcomp.dll",
        "uiautomationcore.dll",
        "oleaut32.dll",
        "shell32.dll",
    ] {
        println!("cargo:rustc-cdylib-link-arg=/DELAYLOAD:{dll}");
    }
    println!("cargo:rustc-cdylib-link-arg=delayimp.lib");
}
