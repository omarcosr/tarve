//! Blurred text shadows: record the glyphs a shadow would paint, rasterize
//! them into a coverage mask with swash, blur it on the CPU and hand the
//! result to any renderer as an image.

use std::hash::{Hash, Hasher};

use swash::{
    FontRef, GlyphId,
    scale::{Render, ScaleContext, Source},
    zeno::{Format, Vector},
};
use vello::{
    kurbo::{Affine, Point, Rect, Shape, Stroke},
    peniko::{Blob, Color, Fill, FontData, ImageAlphaType, ImageData, ImageFormat},
};

use crate::paint::{PaintGlyph, PaintGradient, PaintTarget};

/// What fills the rasterized glyph coverage.
pub(crate) enum Ink<'a> {
    Solid(Color),
    /// `device_to_local` maps device pixels back to the gradient's space.
    Gradient {
        gradient: &'a PaintGradient,
        device_to_local: Affine,
    },
}

/// Largest mask the blur will allocate (pixels); bigger shadows are skipped.
const MAX_PIXELS: usize = 16 * 1024 * 1024;

struct GlyphRun {
    font: FontData,
    font_size: f32,
    coords: Vec<i16>,
    transform: Affine,
    glyphs: Vec<PaintGlyph>,
}

/// A paint target that only remembers glyph runs and filled rectangles
/// (underlines, strikethroughs) in device space.
#[derive(Default)]
pub(crate) struct ShadowRecorder {
    runs: Vec<GlyphRun>,
    rects: Vec<Rect>,
}

impl ShadowRecorder {
    /// Whole-pixel device origin the mask is rasterized against, so moving
    /// text by whole pixels reuses the cached image.
    pub(crate) fn base(&self) -> Option<(f64, f64)> {
        let translation = self
            .runs
            .first()
            .map(|run| run.transform.translation())
            .or_else(|| self.rects.first().map(|rect| rect.origin().to_vec2()))?;
        Some((translation.x.floor(), translation.y.floor()))
    }

    pub(crate) fn signature(&self, base: (f64, f64), sigma: f64, color: Color) -> u64 {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        let bits = |value: f64, hasher: &mut std::collections::hash_map::DefaultHasher| {
            value.to_bits().hash(hasher);
        };
        for run in &self.runs {
            run.font.data.id().hash(&mut hasher);
            run.font.index.hash(&mut hasher);
            run.font_size.to_bits().hash(&mut hasher);
            run.coords.hash(&mut hasher);
            let coeffs = run.transform.as_coeffs();
            for coeff in &coeffs[..4] {
                bits(*coeff, &mut hasher);
            }
            bits(coeffs[4] - base.0, &mut hasher);
            bits(coeffs[5] - base.1, &mut hasher);
            for glyph in &run.glyphs {
                glyph.id.hash(&mut hasher);
                glyph.x.to_bits().hash(&mut hasher);
                glyph.y.to_bits().hash(&mut hasher);
            }
        }
        for rect in &self.rects {
            for value in [
                rect.x0 - base.0,
                rect.y0 - base.1,
                rect.x1 - base.0,
                rect.y1 - base.1,
            ] {
                bits(value, &mut hasher);
            }
        }
        bits(sigma, &mut hasher);
        color.to_rgba8().to_u32().hash(&mut hasher);
        hasher.finish()
    }
}

impl PaintTarget for ShadowRecorder {
    fn fill<S: Shape>(&mut self, _: Fill, transform: Affine, _: Color, shape: &S) {
        self.rects
            .push(transform.transform_rect_bbox(shape.bounding_box()));
    }

    fn stroke<S: Shape>(&mut self, _: &Stroke, _: Affine, _: Color, _: &S) {}

    fn push_clip<S: Shape>(&mut self, _: Fill, _: Affine, _: &S) {}

    fn push_opacity<S: Shape>(&mut self, _: f32, _: Affine, _: &S) {}

    fn pop_layer(&mut self) {}

    fn box_shadow(&mut self, _: Affine, _: Rect, _: Rect, _: Color, _: f64, _: f64, _: bool) {}

    fn draw_image(&mut self, _: &str, _: &ImageData, _: Affine) {}

    fn draw_glyphs(
        &mut self,
        font: &FontData,
        font_size: f32,
        normalized_coords: &[i16],
        transform: Affine,
        _: Color,
        glyphs: &[PaintGlyph],
    ) {
        self.runs.push(GlyphRun {
            font: font.clone(),
            font_size,
            coords: normalized_coords.to_vec(),
            transform,
            glyphs: glyphs.to_vec(),
        });
    }
}

struct Coverage {
    x: i32,
    y: i32,
    width: usize,
    height: usize,
    data: Vec<u8>,
}

/// Rasterizes and blurs the recorded shadow. Returns the image and its
/// device-pixel offset from `base`.
pub(crate) fn rasterize(
    context: &mut ScaleContext,
    recorder: &ShadowRecorder,
    base: (f64, f64),
    sigma: f64,
    ink: Ink<'_>,
) -> Option<(ImageData, (f64, f64))> {
    let mut pieces = Vec::new();
    for run in &recorder.runs {
        let scale = run.transform.as_coeffs()[0].abs();
        let size = (f64::from(run.font_size) * scale) as f32;
        let Some(font) = FontRef::from_index(run.font.data.data(), run.font.index as usize) else {
            continue;
        };
        let mut scaler = context
            .builder(font)
            .size(size.max(1.0))
            .hint(false)
            .normalized_coords(&run.coords)
            .build();
        for glyph in &run.glyphs {
            let point = run.transform * Point::new(f64::from(glyph.x), f64::from(glyph.y));
            let (x, y) = (point.x - base.0, point.y - base.1);
            let (whole_x, whole_y) = (x.floor(), y.floor());
            let Some(image) = Render::new(&[Source::Outline])
                .format(Format::Alpha)
                .offset(Vector::new((x - whole_x) as f32, (y - whole_y) as f32))
                .render(&mut scaler, glyph.id as GlyphId)
            else {
                continue;
            };
            if image.placement.width == 0 || image.placement.height == 0 {
                continue;
            }
            pieces.push(Coverage {
                x: whole_x as i32 + image.placement.left,
                y: whole_y as i32 - image.placement.top,
                width: image.placement.width as usize,
                height: image.placement.height as usize,
                data: image.data,
            });
        }
    }
    for rect in &recorder.rects {
        let x0 = (rect.x0 - base.0).floor();
        let y0 = (rect.y0 - base.1).floor();
        let width = ((rect.x1 - base.0).ceil() - x0).max(0.0) as usize;
        let height = ((rect.y1 - base.1).ceil() - y0).max(0.0) as usize;
        if width > 0 && height > 0 && width * height <= MAX_PIXELS {
            pieces.push(Coverage {
                x: x0 as i32,
                y: y0 as i32,
                width,
                height,
                data: vec![255; width * height],
            });
        }
    }
    let left = pieces.iter().map(|piece| piece.x).min()?;
    let top = pieces.iter().map(|piece| piece.y).min()?;
    let right = pieces
        .iter()
        .map(|piece| piece.x + piece.width as i32)
        .max()?;
    let bottom = pieces
        .iter()
        .map(|piece| piece.y + piece.height as i32)
        .max()?;
    let pad = (sigma * 3.0).ceil() as i32 + 1;
    let (origin_x, origin_y) = (left - pad, top - pad);
    let width = (right - left + 2 * pad) as usize;
    let height = (bottom - top + 2 * pad) as usize;
    if width * height > MAX_PIXELS {
        return None;
    }
    let mut mask = vec![0.0_f32; width * height];
    for piece in &pieces {
        for row in 0..piece.height {
            let y = (piece.y - origin_y) as usize + row;
            let start = y * width + (piece.x - origin_x) as usize;
            for (column, coverage) in piece.data[row * piece.width..(row + 1) * piece.width]
                .iter()
                .enumerate()
            {
                let cell = &mut mask[start + column];
                *cell = (*cell + f32::from(*coverage) / 255.0).min(1.0);
            }
        }
    }
    gaussian_blur(&mut mask, width, height, sigma);
    let mut pixels = Vec::with_capacity(width * height * 4);
    for (index, coverage) in mask.into_iter().enumerate() {
        let rgba = match &ink {
            Ink::Solid(color) => color.to_rgba8(),
            Ink::Gradient {
                gradient,
                device_to_local,
            } => {
                let device = Point::new(
                    base.0 + f64::from(origin_x) + (index % width) as f64 + 0.5,
                    base.1 + f64::from(origin_y) + (index / width) as f64 + 0.5,
                );
                gradient.sample(*device_to_local * device).to_rgba8()
            }
        };
        pixels.extend_from_slice(&[
            rgba.r,
            rgba.g,
            rgba.b,
            (coverage.clamp(0.0, 1.0) * f32::from(rgba.a)).round() as u8,
        ]);
    }
    Some((
        ImageData {
            data: Blob::new(std::sync::Arc::new(pixels)),
            format: ImageFormat::Rgba8,
            alpha_type: ImageAlphaType::Alpha,
            width: width as u32,
            height: height as u32,
        },
        (f64::from(origin_x), f64::from(origin_y)),
    ))
}

/// Three box blurs approximate a gaussian (Kovesi's box sizes).
pub(crate) fn gaussian_blur(mask: &mut [f32], width: usize, height: usize, sigma: f64) {
    if sigma <= 0.0 {
        return;
    }
    let passes = 3.0;
    let ideal = (12.0 * sigma * sigma / passes + 1.0).sqrt();
    let mut lower = ideal.floor() as i64;
    if lower % 2 == 0 {
        lower -= 1;
    }
    let lower = lower.max(1);
    let upper = lower + 2;
    let lower_f = lower as f64;
    let count = ((12.0 * sigma * sigma
        - passes * lower_f * lower_f
        - 4.0 * passes * lower_f
        - 3.0 * passes)
        / (-4.0 * lower_f - 4.0))
        .round() as i64;
    let mut scratch = vec![0.0_f32; mask.len()];
    for pass in 0..3 {
        let size = if pass < count { lower } else { upper };
        let radius = ((size - 1) / 2) as usize;
        if radius == 0 {
            continue;
        }
        box_blur(mask, &mut scratch, width, height, radius, true);
        box_blur(&mut scratch, mask, width, height, radius, false);
    }
}

fn box_blur(
    source: &mut [f32],
    target: &mut [f32],
    width: usize,
    height: usize,
    radius: usize,
    horizontal: bool,
) {
    let (lines, length, step, stride) = if horizontal {
        (height, width, 1, width)
    } else {
        (width, height, width, 1)
    };
    let scale = 1.0 / (2 * radius + 1) as f32;
    for line in 0..lines {
        let start = line * stride;
        let at = |index: usize| start + index * step;
        let mut sum: f32 = (0..=radius.min(length - 1))
            .map(|index| source[at(index)])
            .sum();
        for index in 0..length {
            target[at(index)] = sum * scale;
            if index + radius + 1 < length {
                sum += source[at(index + radius + 1)];
            }
            if index >= radius {
                sum -= source[at(index - radius)];
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::gaussian_blur;

    #[test]
    fn box_blurs_approximate_a_gaussian_and_keep_mass() {
        let size = 61;
        let mut mask = vec![0.0_f32; size * size];
        mask[30 * size + 30] = 1.0;
        gaussian_blur(&mut mask, size, size, 4.0);
        let total: f32 = mask.iter().sum();
        assert!((total - 1.0).abs() < 1e-3, "{total}");
        let peak = mask[30 * size + 30];
        let expected = 1.0 / (2.0 * std::f32::consts::PI * 16.0);
        assert!(
            (peak - expected).abs() / expected < 0.1,
            "{peak} vs {expected}"
        );
        let at = |x: usize, y: usize| mask[y * size + x];
        assert!((at(26, 30) - at(34, 30)).abs() < 1e-6 && (at(30, 26) - at(26, 30)).abs() < 1e-6);
        assert!(at(26, 30) < peak && at(30 + 13, 30) < peak * 0.01);
    }
}
