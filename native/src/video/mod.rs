//! `<video>`: the platform's own decoder plays the file or stream, picture and
//! sound kept in sync by it, and hands decoded pictures to the renderer.
//!
//! - Windows, D3D11 renderer: Media Foundation's Source Reader decodes on the
//!   GPU into NV12 textures on the renderer's device; the pixel shader samples
//!   them and converts to RGB while drawing the frame. No conversion pass, no
//!   copy, no extra library; the sound plays through the app's audio mix and
//!   the pictures follow its clock. In a visible window a video gets its own
//!   composition layer (`d3d11_overlay`): new pictures repaint no UI.
//! - Windows, CPU and wgpu renderers: Media Foundation's Media Engine scales and
//!   converts each picture on the GPU, read back at the size it is shown.
//! - Linux: GStreamer (`playbin`, loaded at run time) decodes and plays the
//!   sound; RGBA pictures are handed over in memory (`linux`).
//! - Other platforms: not yet (AVFoundation on macOS); a `<video>` reports an
//!   `error` event and lays out as an empty box.
//!
//! Commands and events are the HTMLMediaElement ones `<audio>` uses (load,
//! play, pause, seek, volume, muted, loop; loadedmetadata, play, pause,
//! timeupdate, seeked, ended, error), plus `videoWidth`/`videoHeight`.

use vello::peniko::ImageData;

#[cfg(all(target_os = "windows", feature = "media"))]
mod windows;
#[cfg(all(target_os = "windows", feature = "media"))]
mod windows_reader;
#[cfg(all(target_os = "windows", feature = "media"))]
mod windows_shared;
#[cfg(all(target_os = "windows", feature = "media"))]
mod windows_stream;
#[cfg(all(target_os = "windows", feature = "media"))]
pub(crate) use windows::Videos;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub(crate) use linux::Videos;

#[cfg(not(any(all(target_os = "windows", feature = "media"), target_os = "linux")))]
mod unsupported;
// The browser build has no runtime to play videos in.
#[cfg(not(any(all(target_os = "windows", feature = "media"), target_os = "linux")))]
#[cfg_attr(target_arch = "wasm32", allow(unused_imports))]
pub(crate) use unsupported::Videos;

/// The current picture of a `<video>`, as the tree paints it.
#[derive(Clone, Debug)]
pub(crate) struct VideoFrame {
    pub width: u32,
    pub height: u32,
    /// A new number per picture: cached tiles that show the video must repaint.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub generation: u64,
    /// The picture in memory, for renderers that cannot sample the decoder's
    /// texture (the CPU and wgpu renderers). `None` on D3D11, which draws the texture.
    /// Scaled by the decoder to the size it is shown at, so no larger than needed.
    pub pixels: Option<ImageData>,
}

impl VideoFrame {
    /// `transform` maps the video's own pixels; the copy in memory may be smaller.
    pub(crate) fn pixel_transform(&self, transform: vello::kurbo::Affine) -> vello::kurbo::Affine {
        match &self.pixels {
            Some(pixels) if pixels.width != self.width || pixels.height != self.height => {
                transform
                    * vello::kurbo::Affine::scale_non_uniform(
                        f64::from(self.width) / f64::from(pixels.width.max(1)),
                        f64::from(self.height) / f64::from(pixels.height.max(1)),
                    )
            }
            _ => transform,
        }
    }
}

/// What a `load` asks for.
pub(crate) struct VideoLoad<'a> {
    pub src: &'a str,
    pub looped: bool,
    pub muted: bool,
    pub volume: f32,
}

pub(crate) fn media_error(id: &str, message: impl Into<String>) -> serde_json::Value {
    serde_json::json!({"type":"media", "id":id, "event":"error", "message":message.into()})
}
