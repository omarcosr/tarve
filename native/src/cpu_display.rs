//! A recorded CPU frame. The tree paints into a [`CpuRecorder`] instead of the
//! rasterizer; comparing two recordings gives the region whose pixels can differ
//! ([`damage`]), and [`DisplayList::replay`] rasterizes any region of a frame. The
//! CPU renderer redraws only that region of its retained frame.
use std::{
    collections::{HashMap, HashSet, VecDeque},
    hash::{DefaultHasher, Hash, Hasher},
    sync::Arc,
};

use vello::{
    kurbo::{Affine, BezPath, PathEl, Rect, Shape, Stroke},
    peniko::{Color, Fill, FontData, Gradient, ImageData},
};
use vello_cpu::{
    Image as CpuImage, ImageSource as CpuImageSource, Pixmap, RenderContext, Resources,
};

use crate::paint::{
    CpuCachedImage, GlassParams, PaintGlyph, PaintGradient, PaintTarget, cached_cpu_pixmap,
};

enum Paint {
    Solid(Color),
    Gradient(Gradient, Affine),
}

enum Op {
    Fill {
        rule: Fill,
        transform: Affine,
        paint: Paint,
        path: BezPath,
    },
    Stroke {
        stroke: Stroke,
        transform: Affine,
        color: Color,
        path: BezPath,
    },
    Shadow {
        transform: Affine,
        area: Rect,
        rect: Rect,
        color: Color,
        radius: f64,
        std_dev: f64,
        invert: bool,
    },
    PushClip {
        rule: Fill,
        transform: Affine,
        path: BezPath,
        close: usize,
    },
    PushOpacity {
        alpha: f32,
        transform: Affine,
        path: BezPath,
        close: usize,
    },
    Pop,
    Image {
        transform: Affine,
        pixmap: Arc<Pixmap>,
        width: u32,
        height: u32,
    },
    Glyphs {
        font: FontData,
        size: f32,
        coords: Vec<i16>,
        transform: Affine,
        color: Color,
        glyphs: Vec<PaintGlyph>,
    },
}

struct Recorded {
    op: Op,
    hash: u64,
    /// Device pixels the op can change. For a layer: its shape and everything inside it.
    bounds: Rect,
}

#[derive(Default)]
pub(crate) struct DisplayList {
    ops: Vec<Recorded>,
}

/// Everything when bounds cannot be computed (a non-finite transform).
const EVERYWHERE: Rect = Rect::new(-1e9, -1e9, 1e9, 1e9);

fn device(transform: Affine, local: Rect) -> Rect {
    let rect = transform.transform_rect_bbox(local);
    if [rect.x0, rect.y0, rect.x1, rect.y1]
        .iter()
        .all(|value| value.is_finite())
    {
        // Antialiasing reaches one pixel past the geometry.
        rect.inflate(1.0, 1.0)
    } else {
        EVERYWHERE
    }
}

fn hash_affine(hasher: &mut DefaultHasher, transform: Affine) {
    for value in transform.as_coeffs() {
        value.to_bits().hash(hasher);
    }
}

fn hash_color(hasher: &mut DefaultHasher, color: Color) {
    for value in color.components {
        value.to_bits().hash(hasher);
    }
}

fn hash_rect(hasher: &mut DefaultHasher, rect: Rect) {
    for value in [rect.x0, rect.y0, rect.x1, rect.y1] {
        value.to_bits().hash(hasher);
    }
}

fn hash_path(hasher: &mut DefaultHasher, path: &BezPath) {
    for element in path.elements() {
        let points: &[vello::kurbo::Point] = match element {
            PathEl::MoveTo(p) => {
                0u8.hash(hasher);
                std::slice::from_ref(p)
            }
            PathEl::LineTo(p) => {
                1u8.hash(hasher);
                std::slice::from_ref(p)
            }
            PathEl::QuadTo(a, b) => {
                2u8.hash(hasher);
                a.x.to_bits().hash(hasher);
                a.y.to_bits().hash(hasher);
                std::slice::from_ref(b)
            }
            PathEl::CurveTo(a, b, c) => {
                3u8.hash(hasher);
                for p in [a, b] {
                    p.x.to_bits().hash(hasher);
                    p.y.to_bits().hash(hasher);
                }
                std::slice::from_ref(c)
            }
            PathEl::ClosePath => {
                4u8.hash(hasher);
                &[]
            }
        };
        for p in points {
            p.x.to_bits().hash(hasher);
            p.y.to_bits().hash(hasher);
        }
    }
}

/// Records paint commands for one frame.
pub(crate) struct CpuRecorder<'a> {
    ops: Vec<Recorded>,
    open: Vec<usize>,
    images: &'a mut HashMap<String, CpuCachedImage>,
    used_images: HashSet<String>,
}

impl<'a> CpuRecorder<'a> {
    pub(crate) fn new(images: &'a mut HashMap<String, CpuCachedImage>) -> Self {
        Self {
            ops: Vec::new(),
            open: Vec::new(),
            images,
            used_images: HashSet::new(),
        }
    }

    fn push(&mut self, op: Op, hasher: DefaultHasher, bounds: Rect) {
        self.ops.push(Recorded {
            op,
            hash: hasher.finish(),
            bounds,
        });
    }

    pub(crate) fn finish(mut self) -> DisplayList {
        // A layer left open by the painter still closes at the end of the frame.
        while !self.open.is_empty() {
            self.pop_layer();
        }
        self.images.retain(|key, _| self.used_images.contains(key));
        DisplayList { ops: self.ops }
    }

    fn push_layer(&mut self, op: Op, hasher: DefaultHasher, bounds: Rect) {
        self.open.push(self.ops.len());
        self.push(op, hasher, bounds);
    }
}

impl PaintTarget for CpuRecorder<'_> {
    fn fill<S: Shape>(&mut self, fill: Fill, transform: Affine, color: Color, shape: &S) {
        let path = shape.to_path(0.1);
        let mut hasher = DefaultHasher::new();
        (0u8, fill as u8).hash(&mut hasher);
        hash_affine(&mut hasher, transform);
        hash_color(&mut hasher, color);
        hash_path(&mut hasher, &path);
        let bounds = device(transform, path.bounding_box());
        self.push(
            Op::Fill {
                rule: fill,
                transform,
                paint: Paint::Solid(color),
                path,
            },
            hasher,
            bounds,
        );
    }

    fn fill_gradient<S: Shape>(&mut self, transform: Affine, gradient: &PaintGradient, shape: &S) {
        let path = shape.to_path(0.1);
        let (brush, brush_transform) = gradient.brush();
        let mut hasher = DefaultHasher::new();
        1u8.hash(&mut hasher);
        hash_affine(&mut hasher, transform);
        format!("{gradient:?}").hash(&mut hasher);
        hash_path(&mut hasher, &path);
        let bounds = device(transform, path.bounding_box());
        self.push(
            Op::Fill {
                rule: Fill::NonZero,
                transform,
                paint: Paint::Gradient(brush, brush_transform),
                path,
            },
            hasher,
            bounds,
        );
    }

    fn stroke<S: Shape>(&mut self, stroke: &Stroke, transform: Affine, color: Color, shape: &S) {
        let path = shape.to_path(0.1);
        let mut hasher = DefaultHasher::new();
        2u8.hash(&mut hasher);
        hash_affine(&mut hasher, transform);
        hash_color(&mut hasher, color);
        format!("{stroke:?}").hash(&mut hasher);
        hash_path(&mut hasher, &path);
        // Miter joins reach up to miter_limit × half the width past the path.
        let reach = stroke.width * stroke.miter_limit.max(1.0) / 2.0 + 1.0;
        let bounds = device(transform, path.bounding_box().inflate(reach, reach));
        self.push(
            Op::Stroke {
                stroke: stroke.clone(),
                transform,
                color,
                path,
            },
            hasher,
            bounds,
        );
    }

    fn push_clip<S: Shape>(&mut self, fill: Fill, transform: Affine, shape: &S) {
        let path = shape.to_path(0.1);
        let mut hasher = DefaultHasher::new();
        (3u8, fill as u8).hash(&mut hasher);
        hash_affine(&mut hasher, transform);
        hash_path(&mut hasher, &path);
        let bounds = device(transform, path.bounding_box());
        self.push_layer(
            Op::PushClip {
                rule: fill,
                transform,
                path,
                close: 0,
            },
            hasher,
            bounds,
        );
    }

    fn push_opacity<S: Shape>(&mut self, alpha: f32, transform: Affine, shape: &S) {
        let path = shape.to_path(0.1);
        let alpha = alpha.clamp(0.0, 1.0);
        let mut hasher = DefaultHasher::new();
        4u8.hash(&mut hasher);
        alpha.to_bits().hash(&mut hasher);
        hash_affine(&mut hasher, transform);
        hash_path(&mut hasher, &path);
        let bounds = device(transform, path.bounding_box());
        self.push_layer(
            Op::PushOpacity {
                alpha,
                transform,
                path,
                close: 0,
            },
            hasher,
            bounds,
        );
    }

    fn pop_layer(&mut self) {
        let Some(start) = self.open.pop() else { return };
        let close = self.ops.len();
        // A layer clips and fades what it holds: changing it changes all of that.
        let extent = self.ops[start..]
            .iter()
            .fold(self.ops[start].bounds, |all, op| all.union(op.bounds));
        let layer = &mut self.ops[start];
        layer.bounds = extent;
        match &mut layer.op {
            Op::PushClip { close: end, .. } | Op::PushOpacity { close: end, .. } => *end = close,
            _ => {}
        }
        let mut hasher = DefaultHasher::new();
        5u8.hash(&mut hasher);
        self.push(Op::Pop, hasher, Rect::ZERO);
    }

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
    ) {
        let mut hasher = DefaultHasher::new();
        6u8.hash(&mut hasher);
        hash_affine(&mut hasher, transform);
        hash_rect(&mut hasher, area);
        hash_rect(&mut hasher, rect);
        hash_color(&mut hasher, color);
        (radius.to_bits(), std_dev.to_bits(), invert).hash(&mut hasher);
        let bounds = device(transform, area);
        self.push(
            Op::Shadow {
                transform,
                area,
                rect,
                color,
                radius,
                std_dev,
                invert,
            },
            hasher,
            bounds,
        );
    }

    fn draw_image(&mut self, key: &str, image: &ImageData, transform: Affine) {
        let Some(pixmap) = cached_cpu_pixmap(self.images, &mut self.used_images, key, image) else {
            return;
        };
        let mut hasher = DefaultHasher::new();
        7u8.hash(&mut hasher);
        key.hash(&mut hasher);
        (image.data.id(), image.width, image.height).hash(&mut hasher);
        hash_affine(&mut hasher, transform);
        let bounds = device(
            transform,
            Rect::new(0.0, 0.0, f64::from(image.width), f64::from(image.height)),
        );
        self.push(
            Op::Image {
                transform,
                pixmap,
                width: image.width,
                height: image.height,
            },
            hasher,
            bounds,
        );
    }

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
                &vello::kurbo::RoundedRect::from_rect(rect, radius),
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
    ) {
        if glyphs.is_empty() {
            return;
        }
        let mut hasher = DefaultHasher::new();
        8u8.hash(&mut hasher);
        (font.data.id(), font.index, font_size.to_bits()).hash(&mut hasher);
        normalized_coords.hash(&mut hasher);
        hash_affine(&mut hasher, transform);
        hash_color(&mut hasher, color);
        let (mut x0, mut y0, mut x1, mut y1) = (
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        );
        for glyph in glyphs {
            (glyph.id, glyph.x.to_bits(), glyph.y.to_bits()).hash(&mut hasher);
            x0 = x0.min(f64::from(glyph.x));
            x1 = x1.max(f64::from(glyph.x));
            y0 = y0.min(f64::from(glyph.y));
            y1 = y1.max(f64::from(glyph.y));
        }
        // Glyphs sit on their baseline origin: generous room for ascenders, descenders,
        // the last glyph's advance and italic or swash overhang.
        let size = f64::from(font_size.abs());
        let local = Rect::new(x0 - size, y0 - size * 1.5, x1 + size * 2.0, y1 + size);
        let bounds = device(transform, local);
        self.push(
            Op::Glyphs {
                font: font.clone(),
                size: font_size,
                coords: normalized_coords.to_vec(),
                transform,
                color,
                glyphs: glyphs.to_vec(),
            },
            hasher,
            bounds,
        );
    }
}

/// Box shadows rasterized once, reused while they stay where they are. A blurred
/// shadow costs a Gaussian per pixel of its area; a static one is drawn again
/// whenever the frame around it redraws. A shadow is cached the second frame it
/// appears unchanged, so a moving one (new every frame) never pays for a copy.
pub(crate) struct ShadowCache {
    context: RenderContext,
    entries: HashMap<u64, CachedShadow>,
    seen: HashMap<u64, u64>,
    frame: u64,
    bytes: usize,
}

struct CachedShadow {
    pixmap: Arc<Pixmap>,
    x: f64,
    y: f64,
    used: u64,
}

/// The working set it may add; enough for the static shadows of a busy window.
const SHADOW_CACHE_BYTES: usize = 8 * 1024 * 1024;
const SHADOW_MAX_SIDE: f64 = 4096.0;

impl ShadowCache {
    pub(crate) fn new() -> Self {
        Self {
            context: RenderContext::new(1, 1),
            entries: HashMap::new(),
            seen: HashMap::new(),
            frame: 0,
            bytes: 0,
        }
    }

    /// Call once per presented frame: ages entries and forgets shadows not seen lately.
    pub(crate) fn next_frame(&mut self) {
        self.frame += 1;
        let frame = self.frame;
        self.seen.retain(|_, last| frame - *last <= 2);
        let mut bytes = self.bytes;
        self.entries.retain(|_, entry| {
            let keep = frame - entry.used <= 120;
            if !keep {
                bytes -= entry.pixmap.width() as usize * entry.pixmap.height() as usize * 4;
            }
            keep
        });
        self.bytes = bytes;
    }

    #[allow(clippy::too_many_arguments)]
    fn get(
        &mut self,
        key: u64,
        resources: &mut Resources,
        transform: Affine,
        area: Rect,
        rect: Rect,
        color: Color,
        radius: f64,
        std_dev: f64,
        invert: bool,
    ) -> Option<(Arc<Pixmap>, f64, f64)> {
        let frame = self.frame;
        if let Some(entry) = self.entries.get_mut(&key) {
            entry.used = frame;
            return Some((entry.pixmap.clone(), entry.x, entry.y));
        }
        // First sighting: draw directly and remember it; a second one caches it.
        let previous = self.seen.insert(key, frame);
        if previous.is_none_or(|last| last == frame) {
            return None;
        }
        let bounds = transform.transform_rect_bbox(area);
        let (x, y) = (bounds.x0.floor(), bounds.y0.floor());
        let (width, height) = (bounds.x1.ceil() - x, bounds.y1.ceil() - y);
        if !(width >= 1.0 && height >= 1.0 && width <= SHADOW_MAX_SIDE && height <= SHADOW_MAX_SIDE)
        {
            return None;
        }
        let size = width as usize * height as usize * 4;
        if size > SHADOW_CACHE_BYTES / 4 {
            return None;
        }
        while self.bytes + size > SHADOW_CACHE_BYTES {
            let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.used)
                .map(|(key, _)| *key)
            else {
                break;
            };
            if let Some(entry) = self.entries.remove(&oldest) {
                self.bytes -= entry.pixmap.width() as usize * entry.pixmap.height() as usize * 4;
            }
        }
        self.context.reset_and_resize(width as u16, height as u16);
        self.context.set_fill_rule(Fill::NonZero);
        self.context
            .set_transform(Affine::translate((-x, -y)) * transform);
        self.context.push_clip_layer(&area.to_path(0.1));
        self.context.set_paint(color);
        self.context
            .fill_blurred_rounded_rect(&rect, radius as f32, std_dev as f32, invert);
        self.context.pop_layer();
        self.context.flush();
        let mut pixmap = Pixmap::new(width as u16, height as u16);
        self.context.render(&mut pixmap, resources);
        let pixmap = Arc::new(pixmap);
        self.bytes += size;
        self.entries.insert(
            key,
            CachedShadow {
                pixmap: pixmap.clone(),
                x,
                y,
                used: frame,
            },
        );
        Some((pixmap, x, y))
    }
}

impl DisplayList {
    /// Rasterizes the part of the frame inside `region` (device pixels, integer
    /// origin) into `context`, which must already be sized to the region.
    pub(crate) fn replay(
        &self,
        context: &mut RenderContext,
        resources: &mut Resources,
        region: Rect,
        mut shadows: Option<&mut ShadowCache>,
    ) {
        let origin = Affine::translate((-region.x0, -region.y0));
        let mut index = 0;
        while index < self.ops.len() {
            let recorded = &self.ops[index];
            let visible = recorded.bounds.intersect(region).area() > 0.0;
            match &recorded.op {
                Op::PushClip {
                    rule,
                    transform,
                    path,
                    close,
                } => {
                    if !visible {
                        index = close + 1;
                        continue;
                    }
                    context.set_fill_rule(*rule);
                    context.set_transform(origin * *transform);
                    context.push_clip_layer(path);
                }
                Op::PushOpacity {
                    alpha,
                    transform,
                    path,
                    close,
                } => {
                    if !visible {
                        index = close + 1;
                        continue;
                    }
                    context.set_fill_rule(Fill::NonZero);
                    context.set_transform(origin * *transform);
                    context.push_layer(Some(path), None, Some(*alpha), None, None);
                }
                Op::Pop => context.pop_layer(),
                _ if !visible => {}
                Op::Fill {
                    rule,
                    transform,
                    paint,
                    path,
                } => {
                    context.set_fill_rule(*rule);
                    context.set_transform(origin * *transform);
                    match paint {
                        Paint::Solid(color) => context.set_paint(*color),
                        Paint::Gradient(gradient, brush) => {
                            context.set_paint(gradient.clone());
                            context.set_paint_transform(*brush);
                        }
                    }
                    context.fill_path(path);
                    context.set_paint_transform(Affine::IDENTITY);
                }
                Op::Stroke {
                    stroke,
                    transform,
                    color,
                    path,
                } => {
                    context.set_stroke(stroke.clone());
                    context.set_transform(origin * *transform);
                    context.set_paint(*color);
                    context.stroke_path(path);
                }
                Op::Shadow {
                    transform,
                    area,
                    rect,
                    color,
                    radius,
                    std_dev,
                    invert,
                } => {
                    let cached = shadows.as_deref_mut().and_then(|cache| {
                        cache.get(
                            recorded.hash,
                            resources,
                            *transform,
                            *area,
                            *rect,
                            *color,
                            *radius,
                            *std_dev,
                            *invert,
                        )
                    });
                    if let Some((pixmap, x, y)) = cached {
                        // Whole-pixel placement: the cached pixels land unchanged.
                        let (width, height) =
                            (f64::from(pixmap.width()), f64::from(pixmap.height()));
                        context.set_transform(Affine::translate((x - region.x0, y - region.y0)));
                        context.set_paint(CpuImage {
                            image: CpuImageSource::Pixmap(pixmap),
                            sampler: vello_cpu::peniko::ImageSampler::default(),
                        });
                        context.fill_rect(&Rect::new(0.0, 0.0, width, height));
                        index += 1;
                        continue;
                    }
                    context.set_fill_rule(Fill::NonZero);
                    context.set_transform(origin * *transform);
                    context.push_clip_layer(&area.to_path(0.1));
                    context.set_paint(*color);
                    context.fill_blurred_rounded_rect(
                        rect,
                        *radius as f32,
                        *std_dev as f32,
                        *invert,
                    );
                    context.pop_layer();
                }
                Op::Image {
                    transform,
                    pixmap,
                    width,
                    height,
                } => {
                    context.set_transform(origin * *transform);
                    context.set_paint(CpuImage {
                        image: CpuImageSource::Pixmap(pixmap.clone()),
                        sampler: vello_cpu::peniko::ImageSampler::default(),
                    });
                    context.fill_rect(&Rect::new(0.0, 0.0, f64::from(*width), f64::from(*height)));
                }
                Op::Glyphs {
                    font,
                    size,
                    coords,
                    transform,
                    color,
                    glyphs,
                } => {
                    context.set_transform(origin * *transform);
                    context.set_paint(*color);
                    context
                        .glyph_run(resources, font)
                        .font_size(*size)
                        .normalized_coords(coords)
                        .fill_glyphs(glyphs.iter().map(|glyph| vello_cpu::Glyph {
                            id: glyph.id,
                            x: glyph.x,
                            y: glyph.y,
                        }));
                }
            }
            index += 1;
        }
    }
}

/// The device-pixel region whose pixels can differ between two frames; None when
/// the frames paint the same. Ops are matched by content: one that appears,
/// disappears or changes damages where it was and where it is, and one that
/// changes stacking order damages where it is.
pub(crate) fn damage(previous: &DisplayList, next: &DisplayList) -> Option<Rect> {
    let mut available: HashMap<u64, VecDeque<usize>> = HashMap::new();
    for (index, op) in previous.ops.iter().enumerate() {
        available.entry(op.hash).or_default().push_back(index);
    }
    let mut matched = vec![false; previous.ops.len()];
    let mut region: Option<Rect> = None;
    let mut add = |rect: Rect| {
        if rect.area() > 0.0 {
            region = Some(region.map_or(rect, |all| all.union(rect)));
        }
    };
    let mut last = None;
    for op in &next.ops {
        match available.get_mut(&op.hash).and_then(VecDeque::pop_front) {
            Some(index) => {
                matched[index] = true;
                if last.is_some_and(|last| index < last) {
                    add(op.bounds);
                    add(previous.ops[index].bounds);
                }
                last = Some(last.map_or(index, |last: usize| last.max(index)));
            }
            None => add(op.bounds),
        }
    }
    for (index, op) in previous.ops.iter().enumerate() {
        if !matched[index] {
            add(op.bounds);
        }
    }
    region
}
