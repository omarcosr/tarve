//! The dialog a packaged app shows when it ends with an error and has no console to print it on.
use crate::bridge::{guard, input_bytes};

/// Shows `message` under `title` in a blocking error dialog with one OK button (Windows: a
/// message box; Linux: the desktop's message dialog through rfd). Needs no running app: the window may
/// already be gone. Returns 0 once dismissed, 1 where there is no such dialog (macOS, Android) or
/// it could not be shown, -1 with tarve_last_error set for input that is not UTF-8.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tarve_fatal_dialog(
    title: *const u8,
    title_len: u32,
    message: *const u8,
    message_len: u32,
) -> i32 {
    guard(|| {
        let title = text(unsafe { input_bytes(title, title_len)? })?;
        let message = text(unsafe { input_bytes(message, message_len)? })?;
        Ok(show(title, message))
    })
}

fn text(bytes: &[u8]) -> Result<&str, String> {
    std::str::from_utf8(bytes).map_err(|error| format!("fatal dialog text: {error}"))
}

/// `MessageBoxW`, not rfd's message dialog: rfd's `common-controls-v6` imports `TaskDialogIndirect`,
/// which only ComCtl32 v6 exports, so the library would fail to load (error 127) in a host
/// executable without a v6 manifest (bun.exe, node.exe, tjs.exe).
#[cfg(target_os = "windows")]
fn show(title: &str, message: &str) -> i32 {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MB_ICONERROR, MB_OK, MB_SETFOREGROUND, MB_TOPMOST, MessageBoxW,
    };
    let wide = |text: &str| -> Vec<u16> {
        text.encode_utf16()
            .map(|unit| if unit == 0 { u16::from(b' ') } else { unit })
            .chain(std::iter::once(0))
            .collect()
    };
    let (title, message) = (wide(title), wide(message));
    // SAFETY: both strings are NUL-terminated UTF-16 that outlive the call; no owner window.
    let shown = unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            message.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR | MB_SETFOREGROUND | MB_TOPMOST,
        )
    };
    if shown == 0 { 1 } else { 0 }
}

#[cfg(target_os = "linux")]
fn show(title: &str, message: &str) -> i32 {
    let shown = rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Error)
        .set_title(title)
        .set_description(message)
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
    // rfd answers Cancel when no dialog program could be started.
    if matches!(shown, rfd::MessageDialogResult::Cancel) {
        1
    } else {
        0
    }
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
fn show(_title: &str, _message: &str) -> i32 {
    1
}
