//! The Vello side of glass: a probe that finds the frame's glass before it is painted, and a
//! target that paints the frame into its scene and, until the first glass box, the backdrop.
use super::{GlassCall, GlassPlan};
use crate::paint::{GlassParams, PaintGlyph, PaintGradient, PaintTarget};
use std::hash::{Hash, Hasher};
use vello::Scene;
use vello::kurbo::PathEl;
use vello::kurbo::{Affine, Rect, RoundedRect, Shape, Stroke};
use vello::peniko::{
    Blob, Color, Fill, FontData, ImageAlphaType, ImageBrush, ImageData, ImageFormat,
};

/// The glass of a frame drawn by Vello: the backdrop scene and what is shaded from it.
pub(crate) struct GlassFrame {
    pub plan: GlassPlan,
    /// What was painted before the first glass box, at the plan's scale over its region.
    pub base: Scene,
    /// The atlas as the frame scene draws it; the renderer supplies its pixels.
    pub image: ImageData,
    /// Identifies what `base` paints: an unchanged backdrop is not drawn and blurred again.
    pub base_hash: u64,
}

fn hash_affine(hasher: &mut impl Hasher, transform: Affine) {
    for value in transform.as_coeffs() {
        value.to_bits().hash(hasher);
    }
}

fn hash_color(hasher: &mut impl Hasher, color: Color) {
    for value in color.components {
        value.to_bits().hash(hasher);
    }
}

fn hash_shape(hasher: &mut impl Hasher, shape: &impl Shape) {
    for element in shape.path_elements(0.1) {
        std::mem::discriminant(&element).hash(hasher);
        let points: &[vello::kurbo::Point] = match &element {
            PathEl::MoveTo(p) | PathEl::LineTo(p) => &[*p],
            PathEl::QuadTo(a, b) => &[*a, *b],
            PathEl::CurveTo(a, b, c) => &[*a, *b, *c],
            PathEl::ClosePath => &[],
        };
        for p in points {
            p.x.to_bits().hash(hasher);
            p.y.to_bits().hash(hasher);
        }
    }
}

/// The atlas image of a size. Vello finds an image's pixels by its blob, so one blob per size
/// is reused from frame to frame.
fn atlas_image(width: u32, height: u32) -> ImageData {
    static LAST: std::sync::Mutex<Option<ImageData>> = std::sync::Mutex::new(None);
    let mut last = LAST.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(image) = last.as_ref()
        && (image.width, image.height) == (width, height)
    {
        return image.clone();
    }
    let image = ImageData {
        data: Blob::new(std::sync::Arc::new([0_u8; 0])),
        format: ImageFormat::Rgba8,
        alpha_type: ImageAlphaType::Alpha,
        width,
        height,
    };
    *last = Some(image.clone());
    image
}

/// The opacity of the layers around a paint call.
#[derive(Default)]
struct Opacity(Vec<f32>);

impl Opacity {
    fn current(&self) -> f32 {
        self.0.last().copied().unwrap_or(1.0)
    }
    fn push(&mut self, alpha: f32) {
        let next = self.current() * alpha;
        self.0.push(next);
    }
    fn pop(&mut self) {
        self.0.pop();
    }
}

/// Finds a frame's glass calls; paints nothing.
#[derive(Default)]
pub(crate) struct GlassProbe {
    pub calls: Vec<GlassCall>,
    opacity: Opacity,
}

impl PaintTarget for GlassProbe {
    fn fill<S: Shape>(&mut self, _: Fill, _: Affine, _: Color, _: &S) {}
    fn fill_gradient<S: Shape>(&mut self, _: Affine, _: &PaintGradient, _: &S) {}
    fn stroke<S: Shape>(&mut self, _: &Stroke, _: Affine, _: Color, _: &S) {}
    fn fill_ring(&mut self, _: Affine, _: &RoundedRect, _: [f64; 4], _: Color) {}
    fn push_clip<S: Shape>(&mut self, _: Fill, _: Affine, _: &S) {
        self.opacity.push(1.0);
    }
    fn push_opacity<S: Shape>(&mut self, alpha: f32, _: Affine, _: &S) {
        self.opacity.push(alpha);
    }
    fn pop_layer(&mut self) {
        self.opacity.pop();
    }
    fn box_shadow(&mut self, _: Affine, _: Rect, _: Rect, _: Color, _: f64, _: f64, _: bool) {}
    fn draw_image(&mut self, _: &str, _: &ImageData, _: Affine) {}
    fn draw_video(&mut self, _: &str, _: &crate::video::VideoFrame, _: Affine) {}
    fn glass(
        &mut self,
        transform: Affine,
        rect: Rect,
        radius: f64,
        tint: Color,
        glass: &GlassParams,
    ) {
        if let Some(call) =
            GlassCall::new(transform, rect, radius, tint, glass, self.opacity.current())
        {
            self.calls.push(call);
        }
    }
    fn draw_glyphs(
        &mut self,
        _: &FontData,
        _: f32,
        _: &[i16],
        _: Affine,
        _: Color,
        _: &[PaintGlyph],
    ) {
    }
}

/// Paints the frame into `full` and, until the first glass box, the backdrop into `base`.
pub(crate) struct GlassScene {
    full: Scene,
    plan: Option<GlassPlan>,
    base: Option<Scene>,
    base_transform: Affine,
    base_depth: usize,
    base_hash: std::hash::DefaultHasher,
    opacity: Opacity,
    /// Glass calls painted so far.
    pub calls: usize,
}

impl GlassScene {
    pub(crate) fn new(plan: Option<GlassPlan>) -> Self {
        let base_transform = plan
            .as_ref()
            .map_or(Affine::IDENTITY, GlassPlan::backdrop_transform);
        Self {
            full: Scene::new(),
            base: plan.is_some().then(Scene::new),
            plan,
            base_transform,
            base_depth: 0,
            base_hash: std::hash::DefaultHasher::new(),
            opacity: Opacity::default(),
            calls: 0,
        }
    }

    pub(crate) fn finish(mut self) -> (Scene, Option<GlassFrame>) {
        self.close_base();
        let frame = match (self.plan, self.base) {
            (Some(plan), Some(base)) => {
                let image = atlas_image(plan.atlas.0, plan.atlas.1);
                let base_hash = self.base_hash.finish();
                Some(GlassFrame {
                    plan,
                    base,
                    image,
                    base_hash,
                })
            }
            _ => None,
        };
        (self.full, frame)
    }

    fn close_base(&mut self) {
        if let Some(base) = &mut self.base {
            for _ in 0..self.base_depth {
                PaintTarget::pop_layer(base);
            }
            self.base_depth = 0;
        }
    }

    /// Hashes what is about to be painted into the backdrop.
    fn note(&mut self, tag: u8, hash: impl FnOnce(&mut std::hash::DefaultHasher)) {
        if self.calls == 0 && self.base.is_some() {
            tag.hash(&mut self.base_hash);
            hash(&mut self.base_hash);
        }
    }

    /// Runs `paint` on the frame and, while the backdrop is open, on it under its transform.
    fn both(&mut self, mut paint: impl FnMut(&mut Scene, Affine)) {
        paint(&mut self.full, Affine::IDENTITY);
        if self.calls == 0
            && let Some(base) = &mut self.base
        {
            paint(base, self.base_transform);
        }
    }
}

impl PaintTarget for GlassScene {
    fn fill<S: Shape>(&mut self, fill: Fill, transform: Affine, color: Color, shape: &S) {
        self.note(1, |h| {
            (fill as u8).hash(h);
            hash_affine(h, transform);
            hash_color(h, color);
            hash_shape(h, shape);
        });
        self.both(|scene, t| PaintTarget::fill(scene, fill, t * transform, color, shape));
    }
    fn fill_gradient<S: Shape>(&mut self, transform: Affine, gradient: &PaintGradient, shape: &S) {
        self.note(2, |h| {
            hash_affine(h, transform);
            format!("{gradient:?}").hash(h);
            hash_shape(h, shape);
        });
        self.both(|scene, t| PaintTarget::fill_gradient(scene, t * transform, gradient, shape));
    }
    fn stroke<S: Shape>(&mut self, stroke: &Stroke, transform: Affine, color: Color, shape: &S) {
        self.note(3, |h| {
            stroke.width.to_bits().hash(h);
            hash_affine(h, transform);
            hash_color(h, color);
            hash_shape(h, shape);
        });
        self.both(|scene, t| PaintTarget::stroke(scene, stroke, t * transform, color, shape));
    }
    fn fill_ring(
        &mut self,
        transform: Affine,
        outer: &RoundedRect,
        widths: [f64; 4],
        color: Color,
    ) {
        self.note(4, |h| {
            hash_affine(h, transform);
            hash_shape(h, outer);
            widths.map(f64::to_bits).hash(h);
            hash_color(h, color);
        });
        self.both(|scene, t| PaintTarget::fill_ring(scene, t * transform, outer, widths, color));
    }
    fn push_clip<S: Shape>(&mut self, fill: Fill, transform: Affine, shape: &S) {
        self.opacity.push(1.0);
        if self.calls == 0 && self.base.is_some() {
            self.base_depth += 1;
        }
        self.note(5, |h| {
            (fill as u8).hash(h);
            hash_affine(h, transform);
            hash_shape(h, shape);
        });
        self.both(|scene, t| PaintTarget::push_clip(scene, fill, t * transform, shape));
    }
    fn push_opacity<S: Shape>(&mut self, alpha: f32, transform: Affine, shape: &S) {
        self.opacity.push(alpha);
        if self.calls == 0 && self.base.is_some() {
            self.base_depth += 1;
        }
        self.note(6, |h| {
            alpha.to_bits().hash(h);
            hash_affine(h, transform);
            hash_shape(h, shape);
        });
        self.both(|scene, t| PaintTarget::push_opacity(scene, alpha, t * transform, shape));
    }
    fn pop_layer(&mut self) {
        self.opacity.pop();
        if self.calls == 0 && self.base.is_some() {
            self.base_depth = self.base_depth.saturating_sub(1);
        }
        self.note(7, |_| {});
        self.both(|scene, _| PaintTarget::pop_layer(scene));
    }
    fn push_mask(&mut self, transform: Affine, rect: Rect, mask: &PaintGradient) {
        self.opacity.push(1.0);
        if self.calls == 0 && self.base.is_some() {
            self.base_depth += 1;
        }
        self.note(15, |h| {
            hash_affine(h, transform);
            hash_shape(h, &rect);
            format!("{mask:?}").hash(h);
        });
        self.both(|scene, t| PaintTarget::push_mask(scene, t * transform, rect, mask));
    }
    fn pop_mask(&mut self, transform: Affine, rect: Rect, mask: &PaintGradient) {
        self.opacity.pop();
        if self.calls == 0 && self.base.is_some() {
            self.base_depth = self.base_depth.saturating_sub(1);
        }
        self.note(16, |_| {});
        self.both(|scene, t| PaintTarget::pop_mask(scene, t * transform, rect, mask));
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
        self.note(8, |h| {
            hash_affine(h, transform);
            hash_shape(h, &area);
            hash_shape(h, &rect);
            hash_color(h, color);
            [radius, std_dev].map(f64::to_bits).hash(h);
            invert.hash(h);
        });
        self.both(|scene, t| {
            PaintTarget::box_shadow(
                scene,
                t * transform,
                area,
                rect,
                color,
                radius,
                std_dev,
                invert,
            );
        });
    }
    fn draw_image(&mut self, key: &str, image: &ImageData, transform: Affine) {
        self.note(9, |h| {
            key.hash(h);
            image.data.id().hash(h);
            hash_affine(h, transform);
        });
        self.both(|scene, t| PaintTarget::draw_image(scene, key, image, t * transform));
    }
    fn draw_video(&mut self, id: &str, frame: &crate::video::VideoFrame, transform: Affine) {
        // A video's pictures change on their own: the backdrop is drawn again every frame.
        self.note(10, |h| std::time::Instant::now().hash(h));
        self.both(|scene, t| PaintTarget::draw_video(scene, id, frame, t * transform));
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
        self.note(11, |h| {
            font.data.id().hash(h);
            font.index.hash(h);
            font_size.to_bits().hash(h);
            normalized_coords.hash(h);
            hash_affine(h, transform);
            hash_color(h, color);
            for glyph in glyphs {
                (glyph.id, glyph.x.to_bits(), glyph.y.to_bits()).hash(h);
            }
        });
        self.both(|scene, t| {
            PaintTarget::draw_glyphs(
                scene,
                font,
                font_size,
                normalized_coords,
                t * transform,
                color,
                glyphs,
            );
        });
    }
    fn glass(
        &mut self,
        transform: Affine,
        rect: Rect,
        radius: f64,
        tint: Color,
        glass: &GlassParams,
    ) {
        let index = self.calls;
        self.calls += 1;
        if index == 0 {
            self.close_base();
        }
        let call = GlassCall::new(transform, rect, radius, tint, glass, self.opacity.current());
        let Some(plan) = &self.plan else {
            PaintTarget::glass(&mut self.full, transform, rect, radius, tint, glass);
            return;
        };
        if call.is_none() {
            return;
        }
        // The probe saw the same calls in the same order; an index past them paints the tint.
        let Some(entry) = plan.first_of.get(index) else {
            PaintTarget::glass(&mut self.full, transform, rect, radius, tint, glass);
            return;
        };
        let Some(surface) = entry.map(|s| &plan.surfaces[s]) else {
            return;
        };
        let image = atlas_image(plan.atlas.0, plan.atlas.1);
        let slot = Rect::new(
            f64::from(surface.slot[0]),
            f64::from(surface.slot[1]),
            f64::from(surface.slot[2]),
            f64::from(surface.slot[3]),
        );
        let to_device = surface.atlas_transform(plan.k);
        let area = to_device
            .transform_rect_bbox(slot)
            .intersect(surface.bounds);
        let s0 = surface.shapes[0];
        let brush = ImageBrush::new(image);
        if surface.merged {
            self.full.fill(
                Fill::NonZero,
                Affine::IDENTITY,
                &brush,
                Some(to_device),
                &area,
            );
        } else {
            let shape = RoundedRect::new(
                f64::from(s0[0] - s0[2]),
                f64::from(s0[1] - s0[3]),
                f64::from(s0[0] + s0[2]),
                f64::from(s0[1] + s0[3]),
                f64::from(s0[4]),
            );
            self.full.fill(
                Fill::NonZero,
                Affine::IDENTITY,
                &brush,
                Some(to_device),
                &shape,
            );
        }
    }
}

/// Paints `tree` into a Vello scene with its glass. `seen` remembers whether the last frame
/// had glass: only then is the frame probed first (a frame that finds glass unannounced is
/// painted again).
pub(crate) fn paint_scene(
    tree: &mut crate::tree::Tree,
    scale: f64,
    size: (u32, u32),
    seen: &mut bool,
) -> (Scene, Option<GlassFrame>) {
    // TARVE_GLASS=0 (Android: `setprop debug.tarve.glass 0`) paints glass as its tint only.
    static OFF: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    let off = *OFF.get_or_init(|| std::env::var_os("TARVE_GLASS").is_some_and(|v| v == "0"));
    let plan = if *seen && !off {
        let paints = tree.paints;
        let mut probe = GlassProbe::default();
        tree.paint(scale, &mut probe);
        tree.paints = paints;
        *seen = !probe.calls.is_empty();
        super::plan(&probe.calls, size, super::gpu_scale(scale))
    } else {
        None
    };
    let probed = *seen;
    let mut target = GlassScene::new(plan);
    tree.paint(scale, &mut target);
    if target.calls > 0 && !probed && !off {
        *seen = true;
        return paint_scene(tree, scale, size, seen);
    }
    *seen = target.calls > 0;
    target.finish()
}
