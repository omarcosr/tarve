//! The pixels of an icon a message carries (a tray icon's NOTIFYICONDATA hIcon, SetOverlayIcon's
//! badge), read on the window's thread before the sender gets its answer: the sender destroys its
//! icon as soon as Shell_NotifyIcon or SetOverlayIcon returns, so JavaScript could not read it later.
use std::{ffi::c_void, mem::size_of, ptr};
use windows_sys::Win32::{
    Graphics::Gdi::{
        BI_RGB, BITMAP, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, DeleteObject, GetDC,
        GetDIBits, GetObjectW, HBITMAP, HDC, ReleaseDC,
    },
    UI::WindowsAndMessaging::{GetIconInfo, HICON, ICONINFO},
};

/// The largest icon side read: its RGBA fits one threadsafe record (64 KiB).
pub(crate) const MAX_SIDE: i32 = 128;

/// `icon` as straight-alpha RGBA, top row first: (width, height, bytes). None when the handle is
/// not an icon (any more) or a side is over [`MAX_SIDE`].
pub(crate) fn rgba(icon: HICON) -> Option<(u32, u32, Vec<u8>)> {
    if icon.is_null() {
        return None;
    }
    // SAFETY: a zeroed ICONINFO is valid output space; GetIconInfo checks the handle.
    let mut info: ICONINFO = unsafe { std::mem::zeroed() };
    if unsafe { GetIconInfo(icon, &mut info) } == 0 {
        return None;
    }
    // SAFETY: the bitmaps GetIconInfo made for this call, deleted below.
    let pixels = unsafe { read(info.hbmMask, info.hbmColor) };
    unsafe {
        if !info.hbmMask.is_null() {
            DeleteObject(info.hbmMask);
        }
        if !info.hbmColor.is_null() {
            DeleteObject(info.hbmColor);
        }
    }
    pixels
}

/// # Safety
/// `mask` and `color` are an icon's bitmaps (`color` null for a monochrome icon, whose mask then
/// holds the AND mask above the XOR image).
unsafe fn read(mask: HBITMAP, color: HBITMAP) -> Option<(u32, u32, Vec<u8>)> {
    let source = if color.is_null() { mask } else { color };
    if source.is_null() {
        return None;
    }
    let mut bitmap: BITMAP = unsafe { std::mem::zeroed() };
    let described = unsafe {
        GetObjectW(
            source,
            size_of::<BITMAP>() as i32,
            (&mut bitmap as *mut BITMAP).cast::<c_void>(),
        )
    };
    let width = bitmap.bmWidth;
    let height = if color.is_null() {
        bitmap.bmHeight / 2
    } else {
        bitmap.bmHeight
    };
    if described == 0 || width <= 0 || height <= 0 || width > MAX_SIDE || height > MAX_SIDE {
        return None;
    }
    let dc = unsafe { GetDC(ptr::null_mut()) };
    if dc.is_null() {
        return None;
    }
    let area = width as usize * height as usize * 4;
    let mask_pixels = if mask.is_null() {
        None
    } else {
        let rows = if color.is_null() { height * 2 } else { height };
        unsafe { pixels(dc, mask, width, rows) }
    };
    let color_pixels = if color.is_null() {
        mask_pixels.as_ref().map(|pixels| pixels[area..].to_vec())
    } else {
        unsafe { pixels(dc, color, width, height) }
    };
    unsafe { ReleaseDC(ptr::null_mut(), dc) };
    let color_pixels = color_pixels?;
    // Icons without an alpha channel (old 24 bpp ones) come back with alpha 0 everywhere: their
    // mask says what is transparent.
    let alpha = color_pixels
        .as_chunks::<4>()
        .0
        .iter()
        .any(|pixel| pixel[3] != 0);
    let mut out = vec![0u8; area];
    for (index, (to, from)) in out
        .as_chunks_mut::<4>()
        .0
        .iter_mut()
        .zip(color_pixels.as_chunks::<4>().0)
        .enumerate()
    {
        to[0] = from[2];
        to[1] = from[1];
        to[2] = from[0];
        to[3] = if alpha {
            from[3]
        } else if mask_pixels
            .as_ref()
            .is_some_and(|mask| mask[index * 4] != 0)
        {
            0
        } else {
            255
        };
    }
    Some((width as u32, height as u32, out))
}

/// A bitmap's pixels as 32 bpp BGRA, top row first.
///
/// # Safety
/// `bitmap` is a live bitmap of at least `height` rows, not selected into a DC.
unsafe fn pixels(dc: HDC, bitmap: HBITMAP, width: i32, height: i32) -> Option<Vec<u8>> {
    // SAFETY: a zeroed BITMAPINFO is valid; its header is set below.
    let mut info: BITMAPINFO = unsafe { std::mem::zeroed() };
    info.bmiHeader.biSize = size_of::<BITMAPINFOHEADER>() as u32;
    info.bmiHeader.biWidth = width;
    info.bmiHeader.biHeight = -height;
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    info.bmiHeader.biCompression = BI_RGB;
    let mut bytes = vec![0u8; width as usize * height as usize * 4];
    let lines = unsafe {
        GetDIBits(
            dc,
            bitmap,
            0,
            height as u32,
            bytes.as_mut_ptr().cast::<c_void>(),
            &mut info,
            DIB_RGB_COLORS,
        )
    };
    (lines == height).then_some(bytes)
}
