//! `<Image src="C:\…\app.exe">`: the shell icon of an executable, library or shortcut.
//!
//! The Shell renders the icon (`IShellItemImageFactory::GetImage` with `SIIGBF_ICONONLY`), so a
//! shortcut shows its target's icon (with the arrow overlay Explorer draws) and a file without
//! its own icon shows the generic one. The 256 px jumbo icon is used when the file carries one;
//! the Shell draws a smaller icon unscaled inside the 256 px canvas, so such files get their
//! 48 px (else 32 px) icon instead.
//!
//! That natural frame sizes the layout. Drawn smaller, the GPU would sample it down without
//! mipmaps and alias the edges, so paint asks for a frame at least as large as the displayed
//! physical size ([`frame_size`]), loaded off the UI thread and cached per (path, size).

use std::{ffi::c_void, mem::size_of, path::Path};
use windows::{
    Win32::{
        Foundation::{RPC_E_CHANGED_MODE, SIZE},
        Graphics::Gdi::{
            BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, DIB_RGB_COLORS, DeleteDC,
            DeleteObject, GetDIBits, HBITMAP,
        },
        System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx, CoUninitialize},
        UI::Shell::{
            IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_BIGGERSIZEOK,
            SIIGBF_ICONONLY,
        },
    },
    core::HSTRING,
};

/// Whether `path` names a file whose shell icon `<Image>` shows instead of decoding it.
pub(crate) fn is_icon_path(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            ["exe", "dll", "lnk"]
                .iter()
                .any(|known| extension.eq_ignore_ascii_case(known))
        })
}

/// Frame sizes paint asks for below the natural one: steps of at most 25 %, so the GPU never
/// samples a frame down by more than that, and a resize re-requests only on crossing a step.
const FRAME_SIZES: [u32; 12] = [16, 20, 24, 32, 40, 48, 64, 80, 96, 128, 160, 192];

/// Prefix of a sized-frame request on the image workers: `tarve-icon-frame:<size>:<path>`.
const FRAME_SCHEME: &str = "tarve-icon-frame:";

/// The frame to draw an icon whose natural frame is `natural` px at `drawn` physical px:
/// the smallest step at least as large, or `None` when the natural frame is not larger.
pub(crate) fn frame_size(drawn: f64, natural: u32) -> Option<u32> {
    if !drawn.is_finite() || drawn <= 0.0 {
        return None;
    }
    // A hundredth of a pixel of layout rounding does not ask for the next step.
    let needed = (drawn - 0.01).ceil().max(1.0);
    FRAME_SIZES
        .iter()
        .copied()
        .find(|size| f64::from(*size) >= needed)
        .filter(|size| *size < natural)
}

pub(crate) fn frame_request(path: &str, size: u32) -> String {
    format!("{FRAME_SCHEME}{size}:{path}")
}

/// `(size, path)` of a [`frame_request`].
pub(crate) fn parse_frame_request(request: &str) -> Option<(u32, &str)> {
    let (size, path) = request.strip_prefix(FRAME_SCHEME)?.split_once(':')?;
    Some((size.parse().ok()?, path))
}

/// The shell icon rendered at `size` px (the Shell scales its nearest frame down with
/// filtering) as premultiplied RGBA.
pub(crate) fn load_sized(path: &str, size: u32) -> Result<(u32, u32, Vec<u8>), String> {
    let _com = ComScope::enter();
    render(&shell_item(path)?, size.clamp(1, 256) as i32)
}

fn shell_item(path: &str) -> Result<IShellItemImageFactory, String> {
    let absolute =
        std::path::absolute(path.replace('/', "\\")).map_err(|error| error.to_string())?;
    if !absolute.exists() {
        return Err(format!("file not found: {}", absolute.display()));
    }
    unsafe { SHCreateItemFromParsingName(&HSTRING::from(absolute.as_os_str()), None) }
        .map_err(|error| format!("shell item for {}: {error}", absolute.display()))
}

/// The file's largest shell icon as premultiplied RGBA: `(width, height, bytes)`.
pub(crate) fn load(path: &str) -> Result<(u32, u32, Vec<u8>), String> {
    let _com = ComScope::enter();
    let factory = shell_item(path)?;
    let jumbo = render(&factory, 256)?;
    let extent = opaque_extent(&jumbo);
    if extent > 48 {
        return Ok(jumbo);
    }
    // No 256 px icon: the Shell drew a small one in the canvas's corner.
    render(&factory, if extent > 32 { 48 } else { 32 }).or(Ok(jumbo))
}

fn render(factory: &IShellItemImageFactory, size: i32) -> Result<(u32, u32, Vec<u8>), String> {
    let get = || unsafe {
        factory.GetImage(
            SIZE { cx: size, cy: size },
            SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK,
        )
    };
    let mut result = get();
    // Another thread extracting icons at the same time (the image workers) can leave the
    // Shell's icon cache mid-update: it answers E_PENDING, and a moment later the icon.
    for attempt in 1..=4 {
        match &result {
            Err(error) if error.code() == windows::core::HRESULT(0x8000_000A_u32 as i32) => {
                std::thread::sleep(std::time::Duration::from_millis(2 * attempt));
                result = get();
            }
            _ => break,
        }
    }
    let bitmap = result.map_err(|error| format!("shell icon: {error}"))?;
    let pixels = bitmap_rgba(bitmap);
    unsafe {
        let _ = DeleteObject(bitmap.into());
    }
    pixels
}

/// Reads a 32 bpp shell bitmap (premultiplied BGRA) as top-down premultiplied RGBA.
fn bitmap_rgba(bitmap: HBITMAP) -> Result<(u32, u32, Vec<u8>), String> {
    let dc = unsafe { CreateCompatibleDC(None) };
    if dc.is_invalid() {
        return Err("CreateCompatibleDC failed".into());
    }
    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            ..Default::default()
        },
        ..Default::default()
    };
    // First call: the bitmap's size.
    let sized = unsafe { GetDIBits(dc, bitmap, 0, 0, None, &mut info, DIB_RGB_COLORS) };
    let (width, height) = (
        info.bmiHeader.biWidth,
        info.bmiHeader.biHeight.unsigned_abs() as i32,
    );
    if sized == 0 || width <= 0 || height <= 0 {
        unsafe {
            let _ = DeleteDC(dc);
        }
        return Err("shell icon bitmap has no size".into());
    }
    info.bmiHeader = BITMAPINFOHEADER {
        biSize: size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: width,
        biHeight: -height,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        ..Default::default()
    };
    let mut bytes = vec![0u8; width as usize * height as usize * 4];
    let lines = unsafe {
        GetDIBits(
            dc,
            bitmap,
            0,
            height as u32,
            Some(bytes.as_mut_ptr().cast::<c_void>()),
            &mut info,
            DIB_RGB_COLORS,
        )
    };
    unsafe {
        let _ = DeleteDC(dc);
    }
    if lines != height {
        return Err("GetDIBits failed to read the shell icon".into());
    }
    // Icons without an alpha channel (old 24 bpp ones) come back with alpha 0 everywhere.
    let opaque = bytes.as_chunks::<4>().0.iter().all(|pixel| pixel[3] == 0);
    for pixel in bytes.as_chunks_mut::<4>().0 {
        pixel.swap(0, 2);
        if opaque {
            pixel[3] = 255;
        }
        let alpha = pixel[3];
        for channel in &mut pixel[..3] {
            *channel = (*channel).min(alpha);
        }
    }
    Ok((width as u32, height as u32, bytes))
}

/// Width or height (the larger) of the box holding the icon's visible pixels, from the top left.
fn opaque_extent((width, _, bytes): &(u32, u32, Vec<u8>)) -> u32 {
    bytes
        .as_chunks::<4>()
        .0
        .iter()
        .enumerate()
        .filter(|(_, pixel)| pixel[3] != 0)
        .map(|(index, _)| {
            let index = index as u32;
            (index % width + 1).max(index / width + 1)
        })
        .max()
        .unwrap_or(0)
}

/// COM on this thread for the Shell call; left as found when the thread already chose a model.
struct ComScope(bool);

impl ComScope {
    fn enter() -> Self {
        let result = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        Self(result.is_ok() && result != RPC_E_CHANGED_MODE)
    }
}

impl Drop for ComScope {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exe_icon_notepad_is_square_rgba() {
        let notepad = r"C:\Windows\System32\notepad.exe";
        assert!(is_icon_path(notepad));
        let (width, height, bytes) = load(notepad).expect("notepad icon");
        assert_eq!(width, height);
        assert!(width >= 32);
        assert_eq!(bytes.len(), width as usize * height as usize * 4);
        assert!(bytes.as_chunks::<4>().0.iter().any(|pixel| pixel[3] != 0));
    }

    #[test]
    fn exe_icon_frames_fit_the_displayed_size() {
        assert_eq!(frame_size(32.0, 256), Some(32));
        assert_eq!(frame_size(32.004, 256), Some(32));
        assert_eq!(frame_size(33.0, 256), Some(40));
        assert_eq!(frame_size(48.0 * 1.5, 256), Some(80));
        assert_eq!(
            frame_size(200.0, 256),
            None,
            "the natural frame is the next step"
        );
        assert_eq!(frame_size(48.0, 48), None);
        assert_eq!(frame_size(24.0, 48), Some(24));
        assert_eq!(frame_size(0.0, 256), None);
        assert_eq!(frame_size(f64::NAN, 256), None);
        let request = frame_request(r"C:\Apps\app.lnk", 40);
        assert_eq!(
            parse_frame_request(&request),
            Some((40, r"C:\Apps\app.lnk"))
        );
        assert_eq!(parse_frame_request("https://example.com/a.png"), None);
    }

    #[test]
    fn exe_icon_sized_frame_matches_the_request() {
        let notepad = r"C:\Windows\System32\notepad.exe";
        for size in [24, 40, 96] {
            let (width, height, bytes) = load_sized(notepad, size).expect("sized notepad icon");
            assert_eq!((width, height), (size, size));
            assert!(bytes.as_chunks::<4>().0.iter().any(|pixel| pixel[3] != 0));
        }
    }

    #[test]
    fn exe_icon_rejects_missing_file() {
        assert!(load(r"C:\definitely\missing\app.exe").is_err());
        assert!(load_sized(r"C:\definitely\missing\app.exe", 32).is_err());
        assert!(!is_icon_path("photo.png"));
    }
}
