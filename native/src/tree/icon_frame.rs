//! Shell icon frames (`.exe`/`.dll`/`.lnk`) loaded at the size they are drawn.
use super::*;

/// A shell icon frame at `size` px: requested on the image workers (`image` is `None` until it
/// arrives, and stays so when it failed: the natural frame is drawn instead).
pub(super) struct IconFrame {
    size: u32,
    /// The worker request, also the renderer's texture key.
    key: String,
    image: Option<ImageData>,
}

/// Renders a shell icon frame on an image worker (see `remote_image`).
pub(crate) fn decode_icon_frame(path: &str, size: u32) -> Result<DecodedImage, String> {
    let (width, height, rgba) = crate::exe_icon::load_sized(path, size)?;
    rgba_image_data(width, height, rgba, true).map(DecodedImage)
}

/// The loaded `size` frame of the icon at `src`; queues its request the first time.
fn icon_frame<'a>(
    frames: &'a mut HashMap<String, Vec<IconFrame>>,
    requests: &mut Vec<String>,
    src: &str,
    size: u32,
) -> Option<&'a IconFrame> {
    if !frames.contains_key(src) {
        frames.insert(src.to_string(), Vec::new());
    }
    let list = frames.get_mut(src)?;
    let Some(index) = list.iter().position(|frame| frame.size == size) else {
        let key = crate::exe_icon::frame_request(src, size);
        requests.push(key.clone());
        list.push(IconFrame {
            size,
            key,
            image: None,
        });
        return None;
    };
    let frame = &list[index];
    frame.image.is_some().then_some(frame)
}

/// `drawn` (texture key, image, x and y scale), or the frame of a shell icon sized for how it is
/// drawn when it is drawn below its natural frame. The layout keeps the natural size.
pub(super) fn sized_icon<'a>(
    frames: &'a mut HashMap<String, Vec<IconFrame>>,
    requests: &mut Vec<String>,
    (natural, src, scale): (bool, &str, f64),
    drawn: (&'a str, &'a ImageData, f64, f64),
) -> (&'a str, &'a ImageData, f64, f64) {
    let (_, image, fx, fy) = drawn;
    if natural
        && crate::exe_icon::is_icon_path(src)
        && let Some(size) = crate::exe_icon::frame_size(
            scale * (image.width as f64 * fx).max(image.height as f64 * fy),
            image.width.max(image.height),
        )
        && let Some(frame) = icon_frame(frames, requests, src, size)
        && let Some(pixels) = frame.image.as_ref()
    {
        return (
            frame.key.as_str(),
            pixels,
            fx * image.width as f64 / pixels.width as f64,
            fy * image.height as f64 / pixels.height as f64,
        );
    }
    drawn
}

impl Tree {
    /// Stores a sized icon frame from the image workers. A failed frame stays empty and is not
    /// asked for again: the natural one is drawn.
    pub(super) fn finish_icon_frame(&mut self, url: &str, result: Result<DecodedImage, String>) {
        let Some((size, src)) = crate::exe_icon::parse_frame_request(url) else {
            return;
        };
        if let Ok(DecodedImage(image)) = result
            && let Some(frame) = self
                .icon_frames
                .get_mut(src)
                .and_then(|frames| frames.iter_mut().find(|frame| frame.size == size))
        {
            frame.image = Some(image);
            self.dirty.paint = true;
            self.dirty.full_paint = true;
        }
    }
}
