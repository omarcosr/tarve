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

use crate::glass::{GlassCall, GlassPlan};
mod glyph_blit;
mod replay;
pub(crate) use glyph_blit::{GlyphBlits, GlyphMasks};

use crate::paint::{
    CpuCachedImage, GlassParams, PaintGlyph, PaintGradient, PaintTarget, cached_cpu_pixmap,
};

enum Paint {
    Solid(Color),
    Gradient(Gradient, Affine),
}

/// What a fill covers: boxes (nearly every fill) kept as they are, other shapes as paths.
/// A rounded box's path is ~400 bytes and costs a flattening to build: kept as a box, the
/// list is smaller and records faster.
enum FillShape {
    Rect(Rect),
    RoundedRect(vello::kurbo::RoundedRect),
    Path(BezPath),
}

impl FillShape {
    fn of<S: Shape>(shape: &S) -> Self {
        if let Some(rect) = shape.as_rect() {
            FillShape::Rect(rect)
        } else if let Some(rounded) = shape.as_rounded_rect() {
            FillShape::RoundedRect(rounded)
        } else {
            FillShape::Path(shape.to_path(0.1))
        }
    }

    fn hash(&self, hasher: &mut DefaultHasher) {
        match self {
            FillShape::Rect(rect) => {
                0u8.hash(hasher);
                hash_rect(hasher, *rect);
            }
            FillShape::RoundedRect(rounded) => {
                1u8.hash(hasher);
                hash_rect(hasher, rounded.rect());
                let radii = rounded.radii();
                for value in [
                    radii.top_left,
                    radii.top_right,
                    radii.bottom_right,
                    radii.bottom_left,
                ] {
                    value.to_bits().hash(hasher);
                }
            }
            FillShape::Path(path) => {
                2u8.hash(hasher);
                hash_path(hasher, path);
            }
        }
    }
}

enum Op {
    Fill {
        rule: Fill,
        transform: Affine,
        paint: Paint,
        path: FillShape,
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
    /// `close`: how many ops after this one its `Pop` is (relative, so a recorded span
    /// can be reused at another position of the next frame).
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
    /// A layer composited with DestIn: what it draws masks the group under it.
    PushMask {
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
    /// A glass box of the frame.
    Glass {
        call: GlassCall,
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
    /// Shared with the frames that reuse them (see `CpuRecorder::cache_begin`).
    ops: Vec<Arc<Recorded>>,
    /// Spans of `ops` a painter recorded under a key, for the next frame to reuse.
    spans: SpanMap,
    /// The frame's glass boxes in paint order, and the op of the first one.
    glass: Vec<GlassCall>,
    first_glass: usize,
}

impl DisplayList {
    /// Recorded commands.
    pub(crate) fn len(&self) -> usize {
        self.ops.len()
    }
}

/// Recorded spans by key. Keys are hashes already: they index the table as they are.
type SpanMap = HashMap<u64, std::ops::Range<usize>, std::hash::BuildHasherDefault<KeyHasher>>;

#[derive(Default)]
struct KeyHasher(u64);

impl Hasher for KeyHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.0 = self.0.rotate_left(8) ^ u64::from(*byte);
        }
    }
    fn write_u64(&mut self, value: u64) {
        self.0 = value;
    }
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
    ops: Vec<Arc<Recorded>>,
    open: Vec<usize>,
    /// The last frame, whose spans this one may reuse.
    previous: Option<&'a DisplayList>,
    spans: SpanMap,
    /// Spans being recorded: key and first op.
    recording: Vec<(u64, usize)>,
    /// One past the last op that cannot be reused (an image, a glass box): spans holding it
    /// are not kept.
    tainted: usize,
    images: &'a mut HashMap<String, CpuCachedImage>,
    used_images: HashSet<String>,
    glass: Vec<GlassCall>,
    /// Opacity of the open layers (a fading merged glass shape shrinks away).
    opacity: Vec<f32>,
}

impl<'a> CpuRecorder<'a> {
    #[cfg(test)]
    pub(crate) fn new(images: &'a mut HashMap<String, CpuCachedImage>) -> Self {
        Self::after(images, None)
    }

    /// A recorder for the frame after `previous`: sized for as many ops, and reusing its
    /// spans whose keys come again.
    pub(crate) fn after(
        images: &'a mut HashMap<String, CpuCachedImage>,
        previous: Option<&'a DisplayList>,
    ) -> Self {
        Self {
            ops: Vec::with_capacity(previous.map_or(0, DisplayList::len)),
            open: Vec::new(),
            previous,
            spans: SpanMap::default(),
            recording: Vec::new(),
            tainted: 0,
            images,
            used_images: HashSet::new(),
            glass: Vec::new(),
            opacity: Vec::new(),
        }
    }

    fn push(&mut self, op: Op, hasher: DefaultHasher, bounds: Rect) {
        self.ops.push(Arc::new(Recorded {
            op,
            hash: hasher.finish(),
            bounds,
        }));
    }

    pub(crate) fn finish(mut self) -> DisplayList {
        // A layer left open by the painter still closes at the end of the frame.
        while !self.open.is_empty() {
            self.pop_layer();
        }
        self.images.retain(|key, _| self.used_images.contains(key));
        let first_glass = self
            .ops
            .iter()
            .position(|op| matches!(op.op, Op::Glass { .. }))
            .unwrap_or(self.ops.len());
        DisplayList {
            ops: self.ops,
            spans: self.spans,
            glass: self.glass,
            first_glass,
        }
    }

    fn push_layer(&mut self, op: Op, hasher: DefaultHasher, bounds: Rect) {
        let alpha = match &op {
            Op::PushOpacity { alpha, .. } => *alpha,
            _ => 1.0,
        };
        self.opacity
            .push(self.opacity.last().copied().unwrap_or(1.0) * alpha);
        self.open.push(self.ops.len());
        self.push(op, hasher, bounds);
    }
}

impl PaintTarget for CpuRecorder<'_> {
    fn fill<S: Shape>(&mut self, fill: Fill, transform: Affine, color: Color, shape: &S) {
        let path = FillShape::of(shape);
        let mut hasher = DefaultHasher::new();
        (0u8, fill as u8).hash(&mut hasher);
        hash_affine(&mut hasher, transform);
        hash_color(&mut hasher, color);
        path.hash(&mut hasher);
        let bounds = device(transform, shape.bounding_box());
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
        let path = FillShape::of(shape);
        let (brush, brush_transform) = gradient.brush();
        let mut hasher = DefaultHasher::new();
        1u8.hash(&mut hasher);
        hash_affine(&mut hasher, transform);
        format!("{gradient:?}").hash(&mut hasher);
        path.hash(&mut hasher);
        let bounds = device(transform, shape.bounding_box());
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
        let bounds = device(transform, shape.bounding_box().inflate(reach, reach));
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
        let bounds = device(transform, shape.bounding_box());
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
        let bounds = device(transform, shape.bounding_box());
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

    fn push_mask(&mut self, transform: Affine, rect: Rect, _mask: &PaintGradient) {
        self.push_opacity(1.0, transform, &rect);
    }

    fn pop_mask(&mut self, transform: Affine, rect: Rect, mask: &PaintGradient) {
        let path = rect.to_path(0.1);
        let mut hasher = DefaultHasher::new();
        11u8.hash(&mut hasher);
        hash_affine(&mut hasher, transform);
        hash_path(&mut hasher, &path);
        let bounds = device(transform, rect);
        self.push_layer(
            Op::PushMask {
                transform,
                path,
                close: 0,
            },
            hasher,
            bounds,
        );
        self.fill_gradient(transform, mask, &rect);
        self.pop_layer();
        self.pop_layer();
    }

    fn pop_layer(&mut self) {
        let Some(start) = self.open.pop() else { return };
        self.opacity.pop();
        let close = self.ops.len() - start;
        // A layer clips and fades what it holds: changing it changes all of that.
        let extent = self.ops[start..]
            .iter()
            .fold(self.ops[start].bounds, |all, op| all.union(op.bounds));
        // Pushed while this layer was open, so not shared yet.
        let layer = Arc::get_mut(&mut self.ops[start]).expect("an open layer is not shared");
        layer.bounds = extent;
        match &mut layer.op {
            Op::PushClip { close: end, .. }
            | Op::PushOpacity { close: end, .. }
            | Op::PushMask { close: end, .. } => *end = close,
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

    fn cache_begin(&mut self, key: u64, reuse: bool) -> bool {
        if reuse
            && let Some(previous) = self.previous
            && let Some(span) = previous.spans.get(&key)
        {
            let start = self.ops.len();
            self.ops.extend(previous.ops[span.clone()].iter().cloned());
            self.spans.insert(key, start..self.ops.len());
            return true;
        }
        self.recording.push((key, self.ops.len()));
        false
    }

    fn cache_end(&mut self) {
        let Some((key, start)) = self.recording.pop() else {
            return;
        };
        // Only a span whose layers close inside it, with nothing that cannot be reused.
        let balanced = self.open.last().is_none_or(|open| *open < start);
        if balanced && self.tainted <= start {
            self.spans.insert(key, start..self.ops.len());
        }
    }

    fn cache_taint(&mut self) {
        self.tainted = self.ops.len() + 1;
    }

    fn draw_image(&mut self, key: &str, image: &ImageData, transform: Affine) {
        self.cache_taint();
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
        glass: &GlassParams,
    ) {
        self.cache_taint();
        let opacity = self.opacity.last().copied().unwrap_or(1.0);
        let Some(call) = GlassCall::new(transform, rect, radius, tint, glass, opacity) else {
            return;
        };
        let mut hasher = DefaultHasher::new();
        11u8.hash(&mut hasher);
        format!("{call:?}").hash(&mut hasher);
        self.glass.push(call);
        // A glass box shows what lies around it: it changes wherever its backdrop can.
        self.push(Op::Glass { call }, hasher, call.reach());
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
            context: crate::paint::single_threaded_context(1, 1),
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
    // A glass box shows what changed under or around it.
    if let Some(changed) = region {
        for op in &next.ops {
            if matches!(op.op, Op::Glass { .. }) && op.bounds.intersect(changed).area() > 0.0 {
                region = region.map(|all| all.union(op.bounds));
            }
        }
    }
    region
}
