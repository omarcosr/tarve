use super::*;

impl Player {
    /// A string the Java side returns (`audioTracks`, `textTracks`, `url`); None when null.
    pub(super) fn string(&self, method: &str) -> Option<String> {
        crate::android::with_env(|env, _| {
            let value = env
                .call_method(self.object.as_obj(), method, "()Ljava/lang/String;", &[])?
                .l()?;
            if value.is_null() {
                return Ok(None);
            }
            let text: String = env.get_string(&JString::from(value))?.into();
            Ok(Some(text))
        })
        .ok()
        .flatten()
    }
}

/// `filename`, as `<audio>`'s: the last path segment of the URL (percent-decoded, without
/// the query) or of a file path.
pub(super) fn filename(src: &str) -> String {
    if !src.contains("://") {
        return src.rsplit('/').next().unwrap_or_default().to_string();
    }
    let path = src.split(['?', '#']).next().unwrap_or_default();
    let name = path.rsplit('/').next().unwrap_or_default().as_bytes();
    let mut out = Vec::with_capacity(name.len());
    let mut at = 0;
    while at < name.len() {
        let hex = name
            .get(at + 1..at + 3)
            .and_then(|hex| u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok());
        if name[at] == b'%'
            && let Some(byte) = hex
        {
            out.push(byte);
            at += 3;
        } else {
            out.push(name[at]);
            at += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub(super) extern "system" fn native_event(
    mut env: JNIEnv,
    _: JClass,
    handle: i64,
    event: JString,
    value: f64,
) {
    let Ok(event) = env.get_string(&event).map(String::from) else {
        return;
    };
    if let Some(shared) = shared(handle) {
        shared
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .events
            .push((event, value));
        wake();
    }
}

/// MediaPlayer's `onTimedText`: the subtitle shown now, empty when none.
pub(super) extern "system" fn native_cue(mut env: JNIEnv, _: JClass, handle: i64, text: JString) {
    let text = if text.is_null() {
        String::new()
    } else {
        env.get_string(&text).map(String::from).unwrap_or_default()
    };
    if let Some(shared) = shared(handle) {
        shared.lock().unwrap_or_else(|p| p.into_inner()).cue = Some(text);
        wake();
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) extern "system" fn native_frame(
    env: JNIEnv,
    _: JClass,
    handle: i64,
    width: i32,
    height: i32,
    y: JByteBuffer,
    u: JByteBuffer,
    v: JByteBuffer,
    y_row: i32,
    uv_row: i32,
    uv_pixel: i32,
) {
    let Some(shared) = shared(handle) else {
        return;
    };
    let plane = |buffer: &JByteBuffer| -> Option<&[u8]> {
        let address = env.get_direct_buffer_address(buffer).ok()?;
        let length = env.get_direct_buffer_capacity(buffer).ok()?;
        // SAFETY: the Image's plane stays mapped until onImageAvailable returns (after this call).
        Some(unsafe { std::slice::from_raw_parts(address, length) })
    };
    let (Some(y), Some(u), Some(v)) = (plane(&y), plane(&u), plane(&v)) else {
        return;
    };
    let source = Yuv {
        width: width.max(0) as usize,
        height: height.max(0) as usize,
        y,
        u,
        v,
        y_row: y_row.max(0) as usize,
        uv_row: uv_row.max(0) as usize,
        uv_pixel: uv_pixel.max(1) as usize,
    };
    if let Some(picture) = source.to_rgba() {
        shared.lock().unwrap_or_else(|p| p.into_inner()).picture = Some(picture);
        wake();
    }
}

/// An RGBA picture from the GPU copy (TarveVideo.GpuCopy), already at most MAX_SIDE.
pub(super) extern "system" fn native_frame_rgba(
    env: JNIEnv,
    _: JClass,
    handle: i64,
    width: i32,
    height: i32,
    rgba: JByteBuffer,
    row: i32,
) {
    let Some(shared) = shared(handle) else {
        return;
    };
    let (Ok(address), Ok(length)) = (
        env.get_direct_buffer_address(&rgba),
        env.get_direct_buffer_capacity(&rgba),
    ) else {
        return;
    };
    // SAFETY: the Image's plane stays mapped until onImageAvailable returns (after this call).
    let source = unsafe { std::slice::from_raw_parts(address, length) };
    if let Some(picture) = copy_rgba(
        source,
        width.max(0) as usize,
        height.max(0) as usize,
        row.max(0) as usize,
    ) {
        shared.lock().unwrap_or_else(|p| p.into_inner()).picture = Some(picture);
        wake();
    }
}

/// Tightly packed opaque RGBA from rows `row` bytes apart.
pub(super) fn copy_rgba(
    source: &[u8],
    width: usize,
    height: usize,
    row: usize,
) -> Option<(u32, u32, Vec<u8>)> {
    let line = width * 4;
    if width == 0 || height == 0 || row < line || source.len() < row * (height - 1) + line {
        return None;
    }
    let mut out = Vec::with_capacity(line * height);
    for y in 0..height {
        out.extend_from_slice(&source[y * row..y * row + line]);
    }
    for pixel in out.as_chunks_mut::<4>().0 {
        pixel[3] = 255;
    }
    Some((width as u32, height as u32, out))
}

/// One YUV 4:2:0 picture as an ImageReader hands it over.
pub(super) struct Yuv<'a> {
    pub(super) width: usize,
    pub(super) height: usize,
    pub(super) y: &'a [u8],
    pub(super) u: &'a [u8],
    pub(super) v: &'a [u8],
    pub(super) y_row: usize,
    pub(super) uv_row: usize,
    pub(super) uv_pixel: usize,
}

impl Yuv<'_> {
    /// RGBA (BT.601, limited range), every `step`th pixel so neither side passes MAX_SIDE.
    pub(super) fn to_rgba(&self) -> Option<(u32, u32, Vec<u8>)> {
        if self.width == 0 || self.height == 0 {
            return None;
        }
        let step = self.width.max(self.height).div_ceil(MAX_SIDE).max(1);
        let (out_w, out_h) = (self.width.div_ceil(step), self.height.div_ceil(step));
        let mut out = vec![255_u8; out_w * out_h * 4];
        for row in 0..out_h {
            let sy = row * step;
            for column in 0..out_w {
                let sx = column * step;
                let luma = i32::from(*self.y.get(sy * self.y_row + sx)?) - 16;
                let chroma = (sy / 2) * self.uv_row + (sx / 2) * self.uv_pixel;
                let cb = i32::from(*self.u.get(chroma)?) - 128;
                let cr = i32::from(*self.v.get(chroma)?) - 128;
                let c = 298 * luma;
                let at = (row * out_w + column) * 4;
                out[at] = ((c + 409 * cr + 128) >> 8).clamp(0, 255) as u8;
                out[at + 1] = ((c - 100 * cb - 208 * cr + 128) >> 8).clamp(0, 255) as u8;
                out[at + 2] = ((c + 516 * cb + 128) >> 8).clamp(0, 255) as u8;
            }
        }
        Some((out_w as u32, out_h as u32, out))
    }
}
