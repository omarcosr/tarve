//! The CPU renderer's window surface on Android, in place of softbuffer's. Softbuffer allocates a
//! frame-sized buffer for every frame, reports every buffer as new (so each frame is rasterized
//! whole, even for a blinking caret) and swizzles every pixel on present. Here the retained
//! frame is kept in the window buffer's byte order (RGBX) and only what changed is copied into
//! the locked window buffer: Android fills the rest from the previous frame.
use ndk::hardware_buffer_format::HardwareBufferFormat;
use ndk::native_window::{NativeWindow, Rect};
use std::num::NonZeroU32;
use std::ops::{Deref, DerefMut};
use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};

pub(crate) struct CpuSurface {
    window: NativeWindow,
    /// The retained frame, one `u32` per pixel holding R, G, B, A in memory order.
    frame: Vec<u32>,
    width: u32,
    height: u32,
    /// `frame` holds the last presented frame.
    presented: bool,
}

impl CpuSurface {
    pub(crate) fn new(window: &winit::window::Window) -> Result<Self, String> {
        let handle = window.window_handle().map_err(|error| error.to_string())?;
        let RawWindowHandle::AndroidNdk(handle) = handle.as_raw() else {
            return Err("not an Android window".into());
        };
        // SAFETY: winit's handle points at the live ANativeWindow; clone_from_ptr acquires it.
        let window = unsafe { NativeWindow::clone_from_ptr(handle.a_native_window.cast()) };
        Ok(Self {
            window,
            frame: Vec::new(),
            width: 0,
            height: 0,
            presented: false,
        })
    }

    pub(crate) fn resize(&mut self, width: NonZeroU32, height: NonZeroU32) -> Result<(), String> {
        let (width, height) = (width.get(), height.get());
        if (width, height) == (self.width, self.height) {
            return Ok(());
        }
        let (Ok(w), Ok(h)) = (i32::try_from(width), i32::try_from(height)) else {
            return Err(format!("size {width}x{height} out of range"));
        };
        self.window
            .set_buffers_geometry(w, h, Some(HardwareBufferFormat::R8G8B8X8_UNORM))
            .map_err(|error| error.to_string())?;
        self.width = width;
        self.height = height;
        self.frame = vec![0; width as usize * height as usize];
        self.presented = false;
        Ok(())
    }

    pub(crate) fn buffer_mut(&mut self) -> Result<CpuBuffer<'_>, String> {
        Ok(CpuBuffer { surface: self })
    }

    /// Copies `region` (the whole frame when None) into the window and posts it.
    fn post(&mut self, region: Option<softbuffer::Rect>) -> Result<(), String> {
        let (width, height) = (self.width as i32, self.height as i32);
        let mut dirty = match region {
            Some(rect) if self.presented => Rect {
                left: rect.x as i32,
                top: rect.y as i32,
                right: (rect.x + rect.width.get()) as i32,
                bottom: (rect.y + rect.height.get()) as i32,
            },
            _ => Rect {
                left: 0,
                top: 0,
                right: width,
                bottom: height,
            },
        };
        let mut buffer = self
            .window
            .lock(Some(&mut dirty))
            .map_err(|error| error.to_string())?;
        if buffer.width() != self.width as usize || buffer.height() != self.height as usize {
            return Err(format!(
                "window buffer is {}x{}, expected {width}x{height}",
                buffer.width(),
                buffer.height()
            ));
        }
        // Android widens the bounds to what it could not fill from the previous frame.
        let left = dirty.left.clamp(0, width) as usize;
        let right = dirty.right.clamp(0, width) as usize;
        let top = dirty.top.clamp(0, height) as usize;
        let bottom = dirty.bottom.clamp(0, height) as usize;
        let stride = buffer.stride();
        let bits = buffer.bits().cast::<u32>();
        for y in top..bottom {
            let source =
                &self.frame[y * self.width as usize + left..y * self.width as usize + right];
            // SAFETY: the locked buffer holds `stride * height` 32-bit pixels and
            // `left..right` lies within its `width <= stride` visible ones.
            unsafe {
                std::ptr::copy_nonoverlapping(
                    source.as_ptr(),
                    bits.add(y * stride + left),
                    source.len(),
                );
            }
        }
        drop(buffer);
        self.presented = true;
        Ok(())
    }
}

pub(crate) struct CpuBuffer<'a> {
    surface: &'a mut CpuSurface,
}

impl CpuBuffer<'_> {
    /// 1 when the buffer holds the last presented frame, 0 when it must be drawn whole.
    pub(crate) fn age(&self) -> u8 {
        u8::from(self.surface.presented)
    }

    pub(crate) fn present(self) -> Result<(), String> {
        self.surface.post(None)
    }

    pub(crate) fn present_with_damage(self, damage: &[softbuffer::Rect]) -> Result<(), String> {
        self.surface.post(damage.first().copied())
    }
}

impl Deref for CpuBuffer<'_> {
    type Target = [u32];
    fn deref(&self) -> &[u32] {
        &self.surface.frame
    }
}

impl DerefMut for CpuBuffer<'_> {
    fn deref_mut(&mut self) -> &mut [u32] {
        &mut self.surface.frame
    }
}
