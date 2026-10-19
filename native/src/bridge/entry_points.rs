//! C ABI entry points that need no app state.
use super::*;

/// Lets process `pid` take the foreground (Windows `AllowSetForegroundWindow`): a
/// second launch hands its arguments to the first instance, which then brings its
/// window forward. A no-op elsewhere.
#[unsafe(no_mangle)]
pub extern "C" fn tarve_allow_foreground(pid: u32) -> i32 {
    #[cfg(target_os = "windows")]
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow(pid);
    }
    #[cfg(not(target_os = "windows"))]
    let _ = pid;
    0
}

/// Starts what the first frame waits on (the GPU device) before the document is ready:
/// 0 auto, 1 gpu, 2 cpu, as the document's renderer. Optional; tarve_start does it too.
#[unsafe(no_mangle)]
pub extern "C" fn tarve_prewarm(renderer: u32) -> i32 {
    crate::stats::mark_started();
    let preference = match renderer {
        1 => protocol::RendererPreference::Gpu,
        2 => protocol::RendererPreference::Cpu,
        _ => protocol::RendererPreference::Auto,
    };
    crate::renderer::prewarm(preference);
    0
}
