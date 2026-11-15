//! `<Image src="C:\…\app.exe">`: the shell icon of an executable, library or shortcut.
//!
//! The Shell renders the icon (`IShellItemImageFactory::GetImage` with `SIIGBF_ICONONLY`), so a
//! shortcut shows its target's icon (with the arrow overlay Explorer draws) and a file without
//! its own icon shows the generic one. The 256 px jumbo icon is used when the file carries one;
//! the Shell draws a smaller icon unscaled inside the 256 px canvas, so such files get their
//! 48 px (else 32 px) icon instead.

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

/// The file's largest shell icon as premultiplied RGBA: `(width, height, bytes)`.
pub(crate) fn load(path: &str) -> Result<(u32, u32, Vec<u8>), String> {
    let absolute =
        std::path::absolute(path.replace('/', "\\")).map_err(|error| error.to_string())?;
    if !absolute.exists() {
        return Err(format!("file not found: {}", absolute.display()));
    }
    let _com = ComScope::enter();
    let factory: IShellItemImageFactory =
        unsafe { SHCreateItemFromParsingName(&HSTRING::from(absolute.as_os_str()), None) }
            .map_err(|error| format!("shell item for {}: {error}", absolute.display()))?;
    let jumbo = render(&factory, 256)?;
    let extent = opaque_extent(&jumbo);
    if extent > 48 {
        return Ok(jumbo);
    }
    // No 256 px icon: the Shell drew a small one in the canvas's corner.
    render(&factory, if extent > 32 { 48 } else { 32 }).or(Ok(jumbo))
}

fn render(factory: &IShellItemImageFactory, size: i32) -> Result<(u32, u32, Vec<u8>), String> {
    let bitmap = unsafe {
        factory.GetImage(
            SIZE { cx: size, cy: size },
            SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK,
        )
    }
    .map_err(|error| format!("shell icon: {error}"))?;
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
    let opaque = bytes.chunks_exact(4).all(|pixel| pixel[3] == 0);
    for pixel in bytes.chunks_exact_mut(4) {
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
        .chunks_exact(4)
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
        assert!(bytes.chunks_exact(4).any(|pixel| pixel[3] != 0));
    }

    #[test]
    fn exe_icon_rejects_missing_file() {
        assert!(load(r"C:\definitely\missing\app.exe").is_err());
        assert!(!is_icon_path("photo.png"));
    }
}
