use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

mod inset_shadow;

use vello::kurbo::Point;
use vello::{
    Glyph, Scene,
    kurbo::{Affine, Rect, RoundedRect, Shape, Stroke},
    peniko::{
        Blob, Color, ColorStop, Extend, Fill, FontData, Gradient, ImageAlphaType, ImageBrush,
        ImageData, ImageFormat, color::DynamicColor,
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

/// Liquid glass: how the pixels already painted under a box show through it.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) struct GlassParams {
    /// Gaussian blur radius in CSS px (sigma = blur / 2).
    pub blur: f32,
    /// Colour saturation of the blurred backdrop; 1 leaves it.
    pub saturate: f32,
    /// How far in CSS px the backdrop bends along the rounded edge.
    pub refraction: f32,
    /// Brightness 0..1 of the rim, edge reflections and sheen.
    pub highlight: f32,
    /// How much the flat part enlarges the backdrop (0..0.3).
    pub magnify: f32,
    /// Boxes painted in one frame with the same non-zero key fuse like drops of
    /// liquid: one surface whose shapes join smoothly. 0 keeps the box alone.
    pub merge: u64,
    /// How far apart in CSS px two merged boxes start bridging.
    pub blend: f32,
}

/// The padding-box corner radii: CSS shrinks each corner by the adjacent border
/// widths (`[top, right, bottom, left]`), never below zero, so a thick border on
/// one side flattens only the corners it touches.
pub(crate) fn inner_corner_radii(radii: [f64; 4], border: [f64; 4]) -> (f64, f64, f64, f64) {
    let [top, right, bottom, left] = border;
    (
        (radii[0] - top.max(left)).max(0.0),
        (radii[1] - top.max(right)).max(0.0),
        (radii[2] - bottom.max(right)).max(0.0),
        (radii[3] - bottom.max(left)).max(0.0),
    )
}

/// `PaintTarget::outer_box_shadow` through a clip: the shadow's area minus `shape`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn clipped_outer_box_shadow<P: PaintTarget + ?Sized>(
    target: &mut P,
    transform: Affine,
    area: Rect,
    rect: Rect,
    color: Color,
    radius: f64,
    std_dev: f64,
    shape: &RoundedRect,
) {
    let mut outside = area.to_path(0.1);
    outside.extend(shape.to_path(0.1));
    target.push_clip(Fill::EvenOdd, transform, &outside);
    target.box_shadow(transform, area, rect, color, radius, std_dev, false);
    target.pop_layer();
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
    /// A border whose sides differ: the ring between `outer` and `outer` inset by
    /// `widths` (top, right, bottom, left), each inner corner shrunk by its
    /// adjacent widths as CSS does. Painted as one even-odd path by default.
    fn fill_ring(
        &mut self,
        transform: Affine,
        outer: &RoundedRect,
        widths: [f64; 4],
        color: Color,
    ) {
        let rect = outer.rect();
        let [top, right, bottom, left] = widths;
        let inner = Rect::new(
            rect.x0 + left,
            rect.y0 + top,
            (rect.x1 - right).max(rect.x0 + left),
            (rect.y1 - bottom).max(rect.y0 + top),
        );
        let radii = outer.radii();
        let mut ring = outer.to_path(0.1);
        ring.extend(
            RoundedRect::from_rect(
                inner,
                inner_corner_radii(
                    [
                        radii.top_left,
                        radii.top_right,
                        radii.bottom_right,
                        radii.bottom_left,
                    ],
                    widths,
                ),
            )
            .path_elements(0.1),
        );
        self.fill(Fill::EvenOdd, transform, color, &ring);
    }
    fn push_clip<S: Shape>(&mut self, fill: Fill, transform: Affine, shape: &S);
    fn push_opacity<S: Shape>(&mut self, alpha: f32, transform: Affine, shape: &S);
    fn pop_layer(&mut self);
    /// CSS `mask-image` with a gradient: what is painted until `pop_mask` (same
    /// arguments) keeps `mask`'s alpha over `rect` and nothing outside it. Layered
    /// targets composite the mask over the group; targets without layers apply it per draw.
    fn push_mask(&mut self, transform: Affine, rect: Rect, _mask: &PaintGradient) {
        self.push_clip(Fill::NonZero, transform, &rect);
    }
    fn pop_mask(&mut self, _transform: Affine, _rect: Rect, _mask: &PaintGradient) {
        self.pop_layer();
    }
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
    /// An outer shadow: `box_shadow` outside `shape` (the box casting it), which it
    /// never shows through. Renderers that can cut the box out in the shader override it.
    #[allow(clippy::too_many_arguments)]
    fn outer_box_shadow(
        &mut self,
        transform: Affine,
        area: Rect,
        rect: Rect,
        color: Color,
        radius: f64,
        std_dev: f64,
        shape: &RoundedRect,
    ) {
        clipped_outer_box_shadow(self, transform, area, rect, color, radius, std_dev, shape);
    }
    fn draw_image(&mut self, key: &str, image: &ImageData, transform: Affine);
    /// A `<video>` picture with `transform` mapping its pixels into place.
    /// Renderers that sample the decoder's texture (D3D11) draw it directly;
    /// the others draw the copy in memory.
    fn draw_video(&mut self, id: &str, frame: &crate::video::VideoFrame, transform: Affine) {
        if let Some(pixels) = &frame.pixels {
            self.draw_image(
                &format!("video:{id}"),
                pixels,
                frame.pixel_transform(transform),
            );
        }
    }
    /// Liquid glass over `rect`: what was painted under it shows through blurred and
    /// bent at the rounded edge, under `tint`. Targets without a backdrop paint the tint.
    fn glass(
        &mut self,
        transform: Affine,
        rect: Rect,
        radius: f64,
        tint: Color,
        _glass: &GlassParams,
    ) {
        if tint.components[3] > 0.0 {
            self.fill(
                Fill::NonZero,
                transform,
                tint,
                &RoundedRect::from_rect(rect, radius),
            );
        }
    }
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

    fn fill_ring(
        &mut self,
        transform: Affine,
        outer: &RoundedRect,
        widths: [f64; 4],
        color: Color,
    ) {
        self.inner
            .fill_ring(self.map(transform), outer, widths, color);
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

    fn push_mask(&mut self, transform: Affine, rect: Rect, mask: &PaintGradient) {
        self.inner.push_mask(self.map(transform), rect, mask);
    }

    fn pop_mask(&mut self, transform: Affine, rect: Rect, mask: &PaintGradient) {
        self.inner.pop_mask(self.map(transform), rect, mask);
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

    fn outer_box_shadow(
        &mut self,
        transform: Affine,
        area: Rect,
        rect: Rect,
        color: Color,
        radius: f64,
        std_dev: f64,
        shape: &RoundedRect,
    ) {
        self.inner.outer_box_shadow(
            self.map(transform),
            area,
            rect,
            color,
            radius,
            std_dev,
            shape,
        );
    }

    fn draw_image(&mut self, key: &str, image: &ImageData, transform: Affine) {
        self.inner.draw_image(key, image, self.map(transform));
    }

    fn draw_video(&mut self, id: &str, frame: &crate::video::VideoFrame, transform: Affine) {
        self.inner.draw_video(id, frame, self.map(transform));
    }

    fn glass(
        &mut self,
        transform: Affine,
        rect: Rect,
        radius: f64,
        tint: Color,
        glass: &GlassParams,
    ) {
        self.inner
            .glass(self.map(transform), rect, radius, tint, glass);
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
        inset_shadow::draw(self, transform, area, rect, color, radius, std_dev);
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

    fn push_mask(&mut self, transform: Affine, rect: Rect, _mask: &PaintGradient) {
        self.push_layer(
            Fill::NonZero,
            vello::peniko::BlendMode::default(),
            1.0,
            transform,
            &rect,
        );
    }

    fn pop_mask(&mut self, transform: Affine, rect: Rect, mask: &PaintGradient) {
        // DestIn: the group keeps what the mask covers, by its alpha.
        self.push_layer(
            Fill::NonZero,
            vello::peniko::BlendMode::new(
                vello::peniko::Mix::Normal,
                vello::peniko::Compose::DestIn,
            ),
            1.0,
            transform,
            &rect,
        );
        PaintTarget::fill_gradient(self, transform, mask, &rect);
        self.pop_layer();
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

/// Paints straight into the rasterizer (the browser build; native records a [`crate::cpu_display::DisplayList`]).
#[cfg_attr(not(any(test, target_arch = "wasm32")), allow(dead_code))]
pub(crate) struct CpuPaintTarget<'a> {
    context: &'a mut RenderContext,
    resources: &'a mut Resources,
    images: &'a mut HashMap<String, CpuCachedImage>,
    used_images: HashSet<String>,
}

#[cfg_attr(not(any(test, target_arch = "wasm32")), allow(dead_code))]
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

    pub(crate) fn image_pixmap(image: &ImageData) -> Option<Pixmap> {
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

/// The CPU pixmap for an image, converted once per key and data and kept while used.
pub(crate) fn cached_cpu_pixmap(
    images: &mut HashMap<String, CpuCachedImage>,
    used: &mut HashSet<String>,
    key: &str,
    image: &ImageData,
) -> Option<Arc<Pixmap>> {
    let stale = images.get(key).is_none_or(|cached| !cached.matches(image));
    if stale {
        let Some(pixmap) = CpuPaintTarget::image_pixmap(image) else {
            images.remove(key);
            return None;
        };
        images.insert(
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
    used.insert(key.to_string());
    images.get(key).map(|cached| cached.pixmap.clone())
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

    fn push_mask(&mut self, transform: Affine, rect: Rect, _mask: &PaintGradient) {
        self.push_opacity(1.0, transform, &rect);
    }

    fn pop_mask(&mut self, transform: Affine, rect: Rect, mask: &PaintGradient) {
        self.context.set_fill_rule(Fill::NonZero);
        self.context.set_transform(transform);
        self.context.push_layer(
            Some(&rect.to_path(0.1)),
            Some(vello_cpu::peniko::BlendMode::new(
                vello_cpu::peniko::Mix::Normal,
                vello_cpu::peniko::Compose::DestIn,
            )),
            None,
            None,
            None,
        );
        self.fill_gradient(transform, mask, &rect);
        self.context.pop_layer();
        self.context.pop_layer();
    }

    fn draw_image(&mut self, key: &str, image: &ImageData, transform: Affine) {
        let Some(pixmap) = cached_cpu_pixmap(self.images, &mut self.used_images, key, image) else {
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

mod filter;
#[cfg(test)]
mod tests;
#[allow(unused_imports)]
pub(crate) use filter::*;
