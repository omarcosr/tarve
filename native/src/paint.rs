use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use vello::kurbo::Point;
use vello::{
    Glyph, Scene,
    kurbo::{Affine, Rect, Shape, Stroke},
    peniko::{
        BlendMode, Blob, Color, ColorStop, Compose, Extend, Fill, FontData, Gradient,
        ImageAlphaType, ImageBrush, ImageData, ImageFormat, Mix, color::DynamicColor,
    },
};

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum GradientGeometry {
    /// Offsets 0 and 1 sit at `start` and `end`.
    Linear { start: Point, end: Point },
    /// Ellipse radii for a ray of 1; offsets 0 and 1 sit at the `start` and
    /// `end` multiples of those radii.
    Radial {
        center: Point,
        radius_x: f64,
        radius_y: f64,
        start: f64,
        end: f64,
    },
    /// CSS conic: `from` in radians (0 points up, clockwise). The angle's
    /// fraction of a turn past `from` maps offsets 0 and 1 to `start` and
    /// `end`.
    Conic {
        center: Point,
        from: f64,
        start: f64,
        end: f64,
    },
}

/// Fraction of a turn (0..1) of `point` around `center`, clockwise from
/// `from` (radians, 0 pointing up) in y-down coordinates, as CSS conics.
pub(crate) fn conic_turn(center: Point, from: f64, point: Point) -> f64 {
    let angle = (point.x - center.x).atan2(center.y - point.y);
    ((angle - from) / std::f64::consts::TAU).rem_euclid(1.0)
}

/// A CSS gradient resolved to local coordinates; stop offsets are sorted and
/// within 0..=1. `repeat` tiles the 0..1 pattern (repeating-*-gradient).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct PaintGradient {
    pub geometry: GradientGeometry,
    pub stops: Vec<(f32, Color)>,
    pub repeat: bool,
}

impl PaintGradient {
    /// Colour at `point` (same coordinates as the geometry), interpolated
    /// in straight alpha like the D3D11 bands.
    pub(crate) fn sample(&self, point: Point) -> Color {
        let Some(first) = self.stops.first() else {
            return Color::TRANSPARENT;
        };
        let t = match self.geometry {
            GradientGeometry::Linear { start, end } => {
                let axis = end - start;
                (point - start).dot(axis) / axis.hypot2().max(1e-12)
            }
            GradientGeometry::Radial {
                center,
                radius_x,
                radius_y,
                start,
                end,
            } => {
                let distance = ((point.x - center.x) / radius_x.max(1e-6))
                    .hypot((point.y - center.y) / radius_y.max(1e-6));
                (distance - start) / (end - start).max(1e-9)
            }
            GradientGeometry::Conic {
                center,
                from,
                start,
                end,
            } => (conic_turn(center, from, point) - start) / (end - start).max(1e-9),
        };
        let t = if self.repeat {
            t - t.floor()
        } else {
            t.clamp(0.0, 1.0)
        } as f32;
        let index = self.stops.partition_point(|stop| stop.0 <= t);
        if index == 0 {
            return first.1;
        }
        let Some(&(end_offset, end_color)) = self.stops.get(index) else {
            return self.stops[self.stops.len() - 1].1;
        };
        let (start_offset, start_color) = self.stops[index - 1];
        let amount = if end_offset > start_offset {
            (t - start_offset) / (end_offset - start_offset)
        } else {
            1.0
        };
        let mut out = [0.0_f32; 4];
        for (channel, value) in out.iter_mut().enumerate() {
            *value = start_color.components[channel]
                + (end_color.components[channel] - start_color.components[channel]) * amount;
        }
        Color::new(out)
    }

    /// Peniko brush plus its brush transform: radial ellipses scale circles.
    pub(crate) fn brush(&self) -> (Gradient, Affine) {
        let stops: Vec<ColorStop> = self
            .stops
            .iter()
            .map(|(offset, color)| ColorStop {
                offset: *offset,
                color: DynamicColor::from_alpha_color(*color),
            })
            .collect();
        let (mut gradient, transform) = match self.geometry {
            GradientGeometry::Linear { start, end } => (
                Gradient::new_linear(start, end).with_stops(stops.as_slice()),
                Affine::IDENTITY,
            ),
            GradientGeometry::Radial {
                center,
                radius_x,
                radius_y,
                start,
                end,
            } => (
                if start <= 0.0 {
                    Gradient::new_radial(Point::ZERO, end as f32)
                } else {
                    Gradient::new_two_point_radial(
                        Point::ZERO,
                        start as f32,
                        Point::ZERO,
                        end as f32,
                    )
                }
                .with_stops(stops.as_slice()),
                Affine::translate(center.to_vec2())
                    * Affine::scale_non_uniform(radius_x.max(1e-6), radius_y.max(1e-6)),
            ),
            // Peniko sweeps measure from +x; rotating the brush puts angle 0
            // at `from`, so its 0..2π sweep is the CSS turn.
            GradientGeometry::Conic {
                center,
                from,
                start,
                end,
            } => (
                Gradient::new_sweep(
                    Point::ZERO,
                    (start * std::f64::consts::TAU) as f32,
                    (end * std::f64::consts::TAU).max(start * std::f64::consts::TAU + 1e-6) as f32,
                )
                .with_stops(stops.as_slice()),
                Affine::translate(center.to_vec2())
                    * Affine::rotate(from - std::f64::consts::FRAC_PI_2),
            ),
        };
        gradient.extend = if self.repeat {
            Extend::Repeat
        } else {
            Extend::Pad
        };
        (gradient, transform)
    }
}

use vello_cpu::{
    Image as CpuImage, ImageSource as CpuImageSource, Pixmap, RenderContext, Resources,
    color::PremulRgba8,
};

#[derive(Clone, Copy)]
pub(crate) struct PaintGlyph {
    pub id: u32,
    pub x: f32,
    pub y: f32,
}

pub(crate) trait PaintTarget {
    fn fill<S: Shape>(&mut self, fill: Fill, transform: Affine, color: Color, shape: &S);
    /// Fills `shape` with a gradient. Targets without gradient support paint
    /// the first stop.
    fn fill_gradient<S: Shape>(&mut self, transform: Affine, gradient: &PaintGradient, shape: &S) {
        if let Some((_, color)) = gradient.stops.first() {
            self.fill(Fill::NonZero, transform, *color, shape);
        }
    }
    fn stroke<S: Shape>(&mut self, stroke: &Stroke, transform: Affine, color: Color, shape: &S);
    fn push_clip<S: Shape>(&mut self, fill: Fill, transform: Affine, shape: &S);
    fn push_opacity<S: Shape>(&mut self, alpha: f32, transform: Affine, shape: &S);
    fn pop_layer(&mut self);
    /// Pre-multiplies `transform` onto everything painted until
    /// `pop_transform`. Only [`TransformTarget`] implements it.
    fn push_transform(&mut self, _transform: Affine) {}
    fn pop_transform(&mut self) {}
    /// Gaussian-blurred rounded rectangle limited to `area`. With `invert`,
    /// paints `1 - coverage` over `area` (inset shadows); callers clip it.
    #[allow(clippy::too_many_arguments)]
    fn box_shadow(
        &mut self,
        transform: Affine,
        area: Rect,
        rect: Rect,
        color: Color,
        radius: f64,
        std_dev: f64,
        invert: bool,
    );
    fn draw_image(&mut self, key: &str, image: &ImageData, transform: Affine);
    fn draw_glyphs(
        &mut self,
        font: &FontData,
        font_size: f32,
        normalized_coords: &[i16],
        transform: Affine,
        color: Color,
        glyphs: &[PaintGlyph],
    );
}

/// Wraps any target with a stack of node transforms (CSS `transform`), so
/// text, SVG, images and shadows in a transformed subtree follow it without
/// every paint helper threading an extra matrix.
pub(crate) struct TransformTarget<'a, P: PaintTarget> {
    inner: &'a mut P,
    stack: Vec<Affine>,
}

impl<'a, P: PaintTarget> TransformTarget<'a, P> {
    pub(crate) fn new(inner: &'a mut P) -> Self {
        Self {
            inner,
            stack: Vec::new(),
        }
    }

    fn map(&self, transform: Affine) -> Affine {
        self.stack
            .last()
            .map_or(transform, |outer| *outer * transform)
    }
}

impl<P: PaintTarget> PaintTarget for TransformTarget<'_, P> {
    fn fill<S: Shape>(&mut self, fill: Fill, transform: Affine, color: Color, shape: &S) {
        self.inner.fill(fill, self.map(transform), color, shape);
    }

    fn fill_gradient<S: Shape>(&mut self, transform: Affine, gradient: &PaintGradient, shape: &S) {
        self.inner
            .fill_gradient(self.map(transform), gradient, shape);
    }

    fn stroke<S: Shape>(&mut self, stroke: &Stroke, transform: Affine, color: Color, shape: &S) {
        self.inner.stroke(stroke, self.map(transform), color, shape);
    }

    fn push_clip<S: Shape>(&mut self, fill: Fill, transform: Affine, shape: &S) {
        self.inner.push_clip(fill, self.map(transform), shape);
    }

    fn push_opacity<S: Shape>(&mut self, alpha: f32, transform: Affine, shape: &S) {
        self.inner.push_opacity(alpha, self.map(transform), shape);
    }

    fn pop_layer(&mut self) {
        self.inner.pop_layer();
    }

    fn push_transform(&mut self, transform: Affine) {
        let next = self.map(transform);
        self.stack.push(next);
    }

    fn pop_transform(&mut self) {
        self.stack.pop();
    }

    fn box_shadow(
        &mut self,
        transform: Affine,
        area: Rect,
        rect: Rect,
        color: Color,
        radius: f64,
        std_dev: f64,
        invert: bool,
    ) {
        self.inner.box_shadow(
            self.map(transform),
            area,
            rect,
            color,
            radius,
            std_dev,
            invert,
        );
    }

    fn draw_image(&mut self, key: &str, image: &ImageData, transform: Affine) {
        self.inner.draw_image(key, image, self.map(transform));
    }

    fn draw_glyphs(
        &mut self,
        font: &FontData,
        font_size: f32,
        normalized_coords: &[i16],
        transform: Affine,
        color: Color,
        glyphs: &[PaintGlyph],
    ) {
        self.inner.draw_glyphs(
            font,
            font_size,
            normalized_coords,
            self.map(transform),
            color,
            glyphs,
        );
    }
}

impl PaintTarget for Scene {
    fn fill<S: Shape>(&mut self, fill: Fill, transform: Affine, color: Color, shape: &S) {
        self.fill(fill, transform, color, None, shape);
    }

    fn fill_gradient<S: Shape>(&mut self, transform: Affine, gradient: &PaintGradient, shape: &S) {
        let (brush, brush_transform) = gradient.brush();
        self.fill(
            Fill::NonZero,
            transform,
            &brush,
            Some(brush_transform),
            shape,
        );
    }

    fn box_shadow(
        &mut self,
        transform: Affine,
        area: Rect,
        rect: Rect,
        color: Color,
        radius: f64,
        std_dev: f64,
        invert: bool,
    ) {
        if !invert {
            self.draw_blurred_rounded_rect_in(&area, transform, rect, color, radius, std_dev);
            return;
        }
        // Inset: flood the area, then erase the blurred rectangle out of it.
        self.push_layer(Fill::NonZero, BlendMode::default(), 1.0, transform, &area);
        self.fill(Fill::NonZero, transform, color, None, &area);
        self.push_layer(
            Fill::NonZero,
            BlendMode::new(Mix::Normal, Compose::DestOut),
            1.0,
            transform,
            &area,
        );
        self.draw_blurred_rounded_rect_in(&area, transform, rect, Color::BLACK, radius, std_dev);
        self.pop_layer();
        self.pop_layer();
    }

    fn stroke<S: Shape>(&mut self, stroke: &Stroke, transform: Affine, color: Color, shape: &S) {
        self.stroke(stroke, transform, color, None, shape);
    }

    fn push_clip<S: Shape>(&mut self, fill: Fill, transform: Affine, shape: &S) {
        self.push_clip_layer(fill, transform, shape);
    }

    fn push_opacity<S: Shape>(&mut self, alpha: f32, transform: Affine, shape: &S) {
        self.push_layer(
            Fill::NonZero,
            vello::peniko::BlendMode::default(),
            alpha.clamp(0.0, 1.0),
            transform,
            shape,
        );
    }

    fn pop_layer(&mut self) {
        self.pop_layer();
    }

    fn draw_image(&mut self, _key: &str, image: &ImageData, transform: Affine) {
        self.draw_image(&ImageBrush::new(image.clone()), transform);
    }

    fn draw_glyphs(
        &mut self,
        font: &FontData,
        font_size: f32,
        normalized_coords: &[i16],
        transform: Affine,
        color: Color,
        glyphs: &[PaintGlyph],
    ) {
        self.draw_glyphs(font)
            .font_size(font_size)
            .normalized_coords(normalized_coords)
            .transform(transform)
            .brush(color)
            .draw(
                Fill::NonZero,
                glyphs.iter().map(|glyph| Glyph {
                    id: glyph.id,
                    x: glyph.x,
                    y: glyph.y,
                }),
            );
    }
}

pub(crate) struct CpuCachedImage {
    data: Blob<u8>,
    width: u32,
    height: u32,
    format: ImageFormat,
    alpha_type: ImageAlphaType,
    pixmap: Arc<Pixmap>,
}

impl CpuCachedImage {
    fn matches(&self, image: &ImageData) -> bool {
        self.data.id() == image.data.id()
            && self.width == image.width
            && self.height == image.height
            && self.format == image.format
            && self.alpha_type == image.alpha_type
    }
}

pub(crate) struct CpuPaintTarget<'a> {
    context: &'a mut RenderContext,
    resources: &'a mut Resources,
    images: &'a mut HashMap<String, CpuCachedImage>,
    used_images: HashSet<String>,
}

impl<'a> CpuPaintTarget<'a> {
    pub(crate) fn new(
        context: &'a mut RenderContext,
        resources: &'a mut Resources,
        images: &'a mut HashMap<String, CpuCachedImage>,
    ) -> Self {
        Self {
            context,
            resources,
            images,
            used_images: HashSet::new(),
        }
    }

    fn image_pixmap(image: &ImageData) -> Option<Pixmap> {
        let width = u16::try_from(image.width).ok()?;
        let height = u16::try_from(image.height).ok()?;
        let source = image.data.data();
        if source.len() != usize::from(width) * usize::from(height) * 4 {
            return None;
        }
        let mut pixels = Vec::with_capacity(usize::from(width) * usize::from(height));
        for pixel in source.as_chunks::<4>().0 {
            let (r, g, b, a) = match image.format {
                ImageFormat::Rgba8 => (pixel[0], pixel[1], pixel[2], pixel[3]),
                ImageFormat::Bgra8 => (pixel[2], pixel[1], pixel[0], pixel[3]),
                _ => return None,
            };
            let premultiply =
                |channel: u8| -> u8 { ((u16::from(channel) * u16::from(a) + 127) / 255) as u8 };
            let (r, g, b) = match image.alpha_type {
                vello::peniko::ImageAlphaType::Alpha => {
                    (premultiply(r), premultiply(g), premultiply(b))
                }
                vello::peniko::ImageAlphaType::AlphaPremultiplied => (r, g, b),
            };
            pixels.push(PremulRgba8::from_u8_array([r, g, b, a]));
        }
        Some(Pixmap::from_parts(pixels, width, height))
    }

    pub(crate) fn finish(self) {
        self.images.retain(|key, _| self.used_images.contains(key));
    }
}

impl PaintTarget for CpuPaintTarget<'_> {
    fn fill<S: Shape>(&mut self, fill: Fill, transform: Affine, color: Color, shape: &S) {
        self.context.set_fill_rule(fill);
        self.context.set_transform(transform);
        self.context.set_paint(color);
        self.context.fill_path(&shape.to_path(0.1));
    }

    fn fill_gradient<S: Shape>(&mut self, transform: Affine, gradient: &PaintGradient, shape: &S) {
        let (brush, brush_transform) = gradient.brush();
        self.context.set_fill_rule(Fill::NonZero);
        self.context.set_transform(transform);
        self.context.set_paint(brush);
        self.context.set_paint_transform(brush_transform);
        self.context.fill_path(&shape.to_path(0.1));
        self.context.set_paint_transform(Affine::IDENTITY);
    }

    fn box_shadow(
        &mut self,
        transform: Affine,
        area: Rect,
        rect: Rect,
        color: Color,
        radius: f64,
        std_dev: f64,
        invert: bool,
    ) {
        self.context.set_fill_rule(Fill::NonZero);
        self.context.set_transform(transform);
        self.context.push_clip_layer(&area.to_path(0.1));
        self.context.set_paint(color);
        self.context
            .fill_blurred_rounded_rect(&rect, radius as f32, std_dev as f32, invert);
        self.context.pop_layer();
    }

    fn stroke<S: Shape>(&mut self, stroke: &Stroke, transform: Affine, color: Color, shape: &S) {
        self.context.set_stroke(stroke.clone());
        self.context.set_transform(transform);
        self.context.set_paint(color);
        self.context.stroke_path(&shape.to_path(0.1));
    }

    fn push_clip<S: Shape>(&mut self, fill: Fill, transform: Affine, shape: &S) {
        self.context.set_fill_rule(fill);
        self.context.set_transform(transform);
        self.context.push_clip_layer(&shape.to_path(0.1));
    }

    fn push_opacity<S: Shape>(&mut self, alpha: f32, transform: Affine, shape: &S) {
        self.context.set_fill_rule(Fill::NonZero);
        self.context.set_transform(transform);
        self.context.push_layer(
            Some(&shape.to_path(0.1)),
            None,
            Some(alpha.clamp(0.0, 1.0)),
            None,
            None,
        );
    }

    fn pop_layer(&mut self) {
        self.context.pop_layer();
    }

    fn draw_image(&mut self, key: &str, image: &ImageData, transform: Affine) {
        let stale = self
            .images
            .get(key)
            .is_none_or(|cached| !cached.matches(image));
        if stale {
            let Some(pixmap) = Self::image_pixmap(image) else {
                self.images.remove(key);
                return;
            };
            self.images.insert(
                key.to_string(),
                CpuCachedImage {
                    data: image.data.clone(),
                    width: image.width,
                    height: image.height,
                    format: image.format,
                    alpha_type: image.alpha_type,
                    pixmap: Arc::new(pixmap),
                },
            );
        }
        self.used_images.insert(key.to_string());
        let Some(pixmap) = self.images.get(key).map(|cached| cached.pixmap.clone()) else {
            return;
        };
        self.context.set_transform(transform);
        self.context.set_paint(CpuImage {
            image: CpuImageSource::Pixmap(pixmap),
            sampler: vello_cpu::peniko::ImageSampler::default(),
        });
        self.context.fill_rect(&vello_cpu::kurbo::Rect::new(
            0.0,
            0.0,
            f64::from(image.width),
            f64::from(image.height),
        ));
    }

    fn draw_glyphs(
        &mut self,
        font: &FontData,
        font_size: f32,
        normalized_coords: &[i16],
        transform: Affine,
        color: Color,
        glyphs: &[PaintGlyph],
    ) {
        self.context.set_transform(transform);
        self.context.set_paint(color);
        self.context
            .glyph_run(self.resources, font)
            .font_size(font_size)
            .normalized_coords(normalized_coords)
            .fill_glyphs(glyphs.iter().map(|glyph| vello_cpu::Glyph {
                id: glyph.id,
                x: glyph.x,
                y: glyph.y,
            }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        protocol::Node,
        text::{TextDrawArea, TextEngine},
    };
    use vello::kurbo::{Affine, Rect};

    #[test]
    fn cpu_target_rasterizes_shared_paint_commands() {
        let mut context = RenderContext::new(16, 16);
        let mut resources = Resources::new();
        let mut images = HashMap::new();
        {
            let mut target = CpuPaintTarget::new(&mut context, &mut resources, &mut images);
            target.fill(
                Fill::NonZero,
                Affine::IDENTITY,
                Color::from_rgb8(255, 0, 0),
                &Rect::new(2.0, 2.0, 14.0, 14.0),
            );
        }
        context.flush();
        let mut pixmap = Pixmap::new(16, 16);
        context.render(&mut pixmap, &mut resources);

        let center = pixmap.data()[8 * 16 + 8];
        assert_eq!(center.to_u8_array(), [255, 0, 0, 255]);
        assert_eq!(pixmap.data()[0].to_u8_array(), [0, 0, 0, 0]);
    }

    /// Renders `gradient` over a 64×64 box on the CPU and returns the worst
    /// channel difference from `PaintGradient::sample`, skipping pixels next
    /// to hard stops and the centre (where the colour is undefined).
    fn conic_cpu_error(gradient: &PaintGradient) -> u8 {
        let mut context = RenderContext::new(64, 64);
        let mut resources = Resources::new();
        let mut images = HashMap::new();
        {
            let mut target = CpuPaintTarget::new(&mut context, &mut resources, &mut images);
            target.fill_gradient(Affine::IDENTITY, gradient, &Rect::new(0.0, 0.0, 64.0, 64.0));
            target.finish();
        }
        context.flush();
        let mut pixmap = Pixmap::new(64, 64);
        context.render(&mut pixmap, &mut resources);
        let GradientGeometry::Conic { center, .. } = gradient.geometry else {
            unreachable!()
        };
        let mut worst = 0;
        for y in 0..64 {
            for x in 0..64 {
                let point = Point::new(x as f64 + 0.5, y as f64 + 0.5);
                if (point - center).hypot() < 6.0 {
                    continue;
                }
                let around = [(-1.5, 0.0), (1.5, 0.0), (0.0, -1.5), (0.0, 1.5)].map(|(dx, dy)| {
                    gradient
                        .sample(Point::new(point.x + dx, point.y + dy))
                        .to_rgba8()
                });
                let expected = gradient.sample(point).to_rgba8();
                let steep = around.iter().any(|near| {
                    [
                        near.r.abs_diff(expected.r),
                        near.g.abs_diff(expected.g),
                        near.b.abs_diff(expected.b),
                    ]
                    .into_iter()
                    .max()
                    .unwrap()
                        > 24
                });
                if steep {
                    continue;
                }
                let actual = pixmap.data()[y * 64 + x].to_u8_array();
                let error = [expected.r, expected.g, expected.b]
                    .iter()
                    .zip(actual)
                    .map(|(e, a)| e.abs_diff(a))
                    .max()
                    .unwrap();
                worst = worst.max(error);
            }
        }
        worst
    }

    #[test]
    fn conic_gradients_rasterize_like_their_css_sample() {
        let red = Color::from_rgb8(255, 0, 0);
        let blue = Color::from_rgb8(0, 0, 255);
        let green = Color::from_rgb8(0, 160, 0);
        let plain = PaintGradient {
            geometry: GradientGeometry::Conic {
                center: Point::new(20.0, 36.0),
                from: 30f64.to_radians(),
                start: 0.0,
                end: 1.0,
            },
            stops: vec![(0.0, red), (0.5, blue), (0.5, green), (1.0, red)],
            repeat: false,
        };
        // CSS: 0 points up and turns clockwise, so straight right of the
        // centre is 90° - 30° = a sixth of a turn into the red→blue ramp.
        let right = plain.sample(Point::new(60.0, 36.0)).to_rgba8();
        assert!(right.r > right.b && right.b > 60, "{right:?}");
        assert!(conic_cpu_error(&plain) <= 6, "{}", conic_cpu_error(&plain));
        let repeating = PaintGradient {
            geometry: GradientGeometry::Conic {
                center: Point::new(32.0, 32.0),
                from: 0.0,
                start: 0.0,
                end: 0.25,
            },
            stops: vec![(0.0, red), (1.0, blue)],
            repeat: true,
        };
        assert!(
            conic_cpu_error(&repeating) <= 6,
            "{}",
            conic_cpu_error(&repeating)
        );
    }

    #[test]
    fn cpu_image_cache_replaces_changed_pixels_and_evicts_unused_keys() {
        let image = |rgba: [u8; 4]| ImageData {
            data: Blob::new(Arc::new(rgba.repeat(4))),
            format: ImageFormat::Rgba8,
            alpha_type: ImageAlphaType::Alpha,
            width: 2,
            height: 2,
        };
        let first = image([255, 0, 0, 255]);
        let second = image([0, 255, 0, 255]);
        let unused = image([0, 0, 255, 255]);
        let mut context = RenderContext::new(8, 8);
        let mut resources = Resources::new();
        let mut images = HashMap::new();

        {
            let mut target = CpuPaintTarget::new(&mut context, &mut resources, &mut images);
            target.draw_image("same", &first, Affine::IDENTITY);
            target.draw_image("unused", &unused, Affine::IDENTITY);
            target.finish();
        }
        assert_eq!(images.len(), 2);
        let first_id = images["same"].data.id();

        {
            let mut target = CpuPaintTarget::new(&mut context, &mut resources, &mut images);
            target.draw_image("same", &second, Affine::IDENTITY);
            target.finish();
        }
        assert_eq!(images.len(), 1);
        assert_eq!(images["same"].data.id(), second.data.id());
        assert_ne!(images["same"].data.id(), first_id);
        assert!(!images.contains_key("unused"));
    }

    #[test]
    fn cpu_target_rasterizes_default_ui_digits_at_stats_weights() {
        for weight in [400.0, 500.0, 650.0] {
            let node: Node = serde_json::from_value(serde_json::json!({
                "id": format!("digits-{weight}"),
                "kind": "text",
                "text": "0123456789",
                "style": {
                    "fontFamily": "system-ui",
                    "fontSize": 27,
                    "fontWeight": weight,
                    "lineHeight": 1.5
                }
            }))
            .unwrap();
            let mut text = TextEngine::new();
            text.prepare(&node);

            let mut context = RenderContext::new(256, 64);
            let mut resources = Resources::new();
            let mut images = HashMap::new();
            {
                let mut target = CpuPaintTarget::new(&mut context, &mut resources, &mut images);
                text.draw(
                    &mut target,
                    &node,
                    TextDrawArea {
                        origin: (2.0, 2.0),
                        width: 252.0,
                        visible_y: (0.0, 64.0),
                        scroll_x: 0.0,
                    },
                    Color::from_rgb8(20, 20, 20),
                    1.0,
                );
                target.finish();
            }
            context.flush();
            let mut pixmap = Pixmap::new(256, 64);
            context.render(&mut pixmap, &mut resources);
            let painted = pixmap
                .data()
                .iter()
                .filter(|pixel| pixel.to_u8_array()[3] != 0)
                .count();
            assert!(
                painted > 100,
                "default UI digits must rasterize through the CPU renderer at weight {weight}; got {painted} painted pixels"
            );
        }
    }
}
