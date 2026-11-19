//! Aero Peek (`peekWindow` in @tarve/core, Windows): what the taskbar does while the pointer rests
//! on a thumbnail. Windows documents no API for it; the taskbar calls dwmapi's export 113
//! (DwmpActivateLivePreview), as every taskbar replacement does. The documented DWM calls
//! (thumbnails, window attributes) are made from JavaScript.
use std::sync::OnceLock;
use windows_sys::Win32::{
    Foundation::HWND,
    System::LibraryLoader::{GetProcAddress, LoadLibraryW},
};

/// DwmpActivateLivePreview(peekOn, hwndTarget, hwndKeep, peekType, extra).
type LivePreview = unsafe extern "system" fn(i32, HWND, HWND, u32, usize) -> i32;
/// LP_PEEK_TYPE "taskbar thumbnail": the target shows in place, the rest fades to glass outlines.
const PEEK_WINDOW: u32 = 1;

fn live_preview() -> Option<LivePreview> {
    static FOUND: OnceLock<Option<usize>> = OnceLock::new();
    let address = *FOUND.get_or_init(|| {
        let name: Vec<u16> = "dwmapi.dll".encode_utf16().chain([0]).collect();
        // SAFETY: a NUL-terminated system library name; the module stays loaded for the process.
        unsafe {
            let module = LoadLibraryW(name.as_ptr());
            if module.is_null() {
                return None;
            }
            // An ordinal, not a name: the low word of the "name" pointer.
            GetProcAddress(module, 113usize as *const u8).map(|function| function as usize)
        }
    });
    // SAFETY: export 113 of dwmapi has had this signature since Windows 7.
    address.map(|address| unsafe { std::mem::transmute::<usize, LivePreview>(address) })
}

/// Peeks at `target` (`keep`, 0 for none, stays visible above it), or ends the peek (`target` 0).
pub(crate) fn peek(target: u64, keep: u64) -> Result<(), String> {
    let preview = live_preview()
        .ok_or("Aero Peek is not available: dwmapi.dll has no DwmpActivateLivePreview")?;
    // SAFETY: window handles DWM checks itself; 0 ends the peek.
    unsafe {
        preview(
            i32::from(target != 0),
            target as usize as HWND,
            keep as usize as HWND,
            PEEK_WINDOW,
            0,
        );
    }
    Ok(())
}
