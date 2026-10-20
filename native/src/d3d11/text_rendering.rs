//! `textRendering`: how the D3D11 renderer rasterizes text. "grayscale" (the
//! default) keeps swash's coverage masks, the same pixels as the CPU and Vello
//! renderers; "cleartype" hands glyphs to DirectWrite for Windows' own subpixel text.

use std::sync::atomic::{AtomicBool, Ordering};

static CLEARTYPE: AtomicBool = AtomicBool::new(false);

/// From the app's `textRendering`; `TARVE_TEXT_RENDERING` overrides it.
pub(crate) fn set_text_rendering(mode: Option<&str>) {
    CLEARTYPE.store(mode == Some("cleartype"), Ordering::Relaxed);
}

/// ClearType asked for, and not turned off in Windows' font smoothing settings.
pub(super) fn cleartype_requested() -> bool {
    let requested = match std::env::var("TARVE_TEXT_RENDERING") {
        Ok(value) => value.trim().eq_ignore_ascii_case("cleartype"),
        Err(_) => CLEARTYPE.load(Ordering::Relaxed),
    };
    requested && system_cleartype()
}

/// The user's choice in "Adjust ClearType text": standard smoothing means grayscale.
fn system_cleartype() -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{
        SPI_GETFONTSMOOTHINGTYPE, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS, SystemParametersInfoW,
    };
    const FE_FONTSMOOTHINGCLEARTYPE: u32 = 2;
    let mut kind = 0_u32;
    let read = unsafe {
        SystemParametersInfoW(
            SPI_GETFONTSMOOTHINGTYPE,
            0,
            Some((&mut kind as *mut u32).cast()),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
    };
    read.is_err() || kind == FE_FONTSMOOTHINGCLEARTYPE
}
