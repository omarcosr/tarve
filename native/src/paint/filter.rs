use super::*;

/// CSS `filter` a CPU layer applies: a gaussian blur and a drop shadow, in device pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct FilterSpec {
    /// Standard deviation of `blur()`; 0 for none.
    pub blur: f32,
    /// `drop-shadow(x y blur colour)`: offset, standard deviation and colour.
    pub shadow: Option<(f32, f32, f32, Color)>,
}

impl FilterSpec {
    /// How far past what is painted the filter can draw (device pixels).
    pub(crate) fn reach(&self) -> f64 {
        let shadow = self.shadow.map_or(0.0, |(x, y, sigma, _)| {
            f64::from(x.abs().max(y.abs()) + sigma * 3.0)
        });
        f64::from(self.blur) * 3.0 + shadow + 1.0
    }
}

/// Hashes every paint call instead of drawing: two equal hashes paint the same pixels.
/// A filtered subtree is rasterized again only when its hash changes.
pub(crate) struct PaintHasher(std::collections::hash_map::DefaultHasher);

impl PaintHasher {
    pub(crate) fn new() -> Self {
        Self(std::collections::hash_map::DefaultHasher::new())
    }
    pub(crate) fn finish(&self) -> u64 {
        std::hash::Hasher::finish(&self.0)
    }
    pub(super) fn word(&mut self, tag: u8, values: &[f64]) {
        use std::hash::Hash;
        tag.hash(&mut self.0);
        for value in values {
            value.to_bits().hash(&mut self.0);
        }
    }
    pub(super) fn affine(&mut self, transform: Affine) {
        self.word(0, &transform.as_coeffs());
    }
    pub(super) fn color(&mut self, color: Color) {
        let [r, g, b, a] = color.components;
        self.word(1, &[r.into(), g.into(), b.into(), a.into()]);
    }
    pub(super) fn shape<S: Shape>(&mut self, shape: &S) {
        use vello::kurbo::PathEl;
        for element in shape.path_elements(0.1) {
            match element {
                PathEl::MoveTo(p) => self.word(2, &[p.x, p.y]),
                PathEl::LineTo(p) => self.word(3, &[p.x, p.y]),
                PathEl::QuadTo(a, b) => self.word(4, &[a.x, a.y, b.x, b.y]),
                PathEl::CurveTo(a, b, c) => self.word(5, &[a.x, a.y, b.x, b.y, c.x, c.y]),
                PathEl::ClosePath => self.word(6, &[]),
            }
        }
    }
    pub(super) fn text(&mut self, text: &str) {
        use std::hash::Hash;
        text.hash(&mut self.0);
    }
}

impl PaintTarget for PaintHasher {
    fn fill<S: Shape>(&mut self, fill: Fill, transform: Affine, color: Color, shape: &S) {
        self.word(10, &[f64::from(fill as u8)]);
        self.affine(transform);
        self.color(color);
        self.shape(shape);
    }
    fn fill_gradient<S: Shape>(&mut self, transform: Affine, gradient: &PaintGradient, shape: &S) {
        self.word(11, &[]);
        self.affine(transform);
        self.text(&format!("{gradient:?}"));
        self.shape(shape);
    }
    fn stroke<S: Shape>(&mut self, stroke: &Stroke, transform: Affine, color: Color, shape: &S) {
        self.word(12, &[stroke.width]);
        self.text(&format!("{stroke:?}"));
        self.affine(transform);
        self.color(color);
        self.shape(shape);
    }
    fn push_clip<S: Shape>(&mut self, fill: Fill, transform: Affine, shape: &S) {
        self.word(13, &[f64::from(fill as u8)]);
        self.affine(transform);
        self.shape(shape);
    }
    fn push_opacity<S: Shape>(&mut self, alpha: f32, transform: Affine, shape: &S) {
        self.word(14, &[f64::from(alpha)]);
        self.affine(transform);
        self.shape(shape);
    }
    fn pop_layer(&mut self) {
        self.word(15, &[]);
    }
    fn push_mask(&mut self, transform: Affine, rect: Rect, mask: &PaintGradient) {
        self.word(16, &[rect.x0, rect.y0, rect.x1, rect.y1]);
        self.affine(transform);
        self.text(&format!("{mask:?}"));
    }
    fn pop_mask(&mut self, _transform: Affine, _rect: Rect, _mask: &PaintGradient) {
        self.word(17, &[]);
    }
    fn push_transform(&mut self, transform: Affine) {
        self.word(18, &[]);
        self.affine(transform);
    }
    fn pop_transform(&mut self) {
        self.word(19, &[]);
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
        self.word(
            20,
            &[
                area.x0,
                area.y0,
                area.x1,
                area.y1,
                rect.x0,
                rect.y0,
                rect.x1,
                rect.y1,
                radius,
                std_dev,
                f64::from(u8::from(invert)),
            ],
        );
        self.affine(transform);
        self.color(color);
    }
    fn draw_image(&mut self, key: &str, image: &ImageData, transform: Affine) {
        self.word(
            21,
            &[
                f64::from(image.width),
                f64::from(image.height),
                image.data.id() as f64,
            ],
        );
        self.text(key);
        self.affine(transform);
    }
    fn glass(
        &mut self,
        transform: Affine,
        rect: Rect,
        radius: f64,
        tint: Color,
        glass: &GlassParams,
    ) {
        self.word(22, &[rect.x0, rect.y0, rect.x1, rect.y1, radius]);
        self.text(&format!("{glass:?}"));
        self.affine(transform);
        self.color(tint);
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
        self.word(
            23,
            &[
                font.data.id() as f64,
                f64::from(font.index),
                f64::from(font_size),
            ],
        );
        for coord in normalized_coords {
            self.word(24, &[f64::from(*coord)]);
        }
        self.affine(transform);
        self.color(color);
        for glyph in glyphs {
            self.word(
                25,
                &[f64::from(glyph.id), f64::from(glyph.x), f64::from(glyph.y)],
            );
        }
    }
}

/// What `paint` draws into a `width`×`height` CPU target, through `filter`: RGBA8 pixels,
/// premultiplied. GPU renderers draw a filtered subtree from these as an image.
pub(crate) fn rasterize_filtered(
    width: u16,
    height: u16,
    filter: FilterSpec,
    paint: impl FnOnce(&mut CpuPaintTarget<'_>),
) -> Vec<u8> {
    use vello_common::filter_effects::{EdgeMode, Filter, FilterPrimitive};
    let mut context = RenderContext::new(width, height);
    let mut resources = Resources::new();
    let mut images = HashMap::new();
    let mut layers = 0;
    if filter.blur > 0.0 {
        context.push_layer(
            None,
            None,
            None,
            None,
            Some(Filter::from_primitive(FilterPrimitive::GaussianBlur {
                std_deviation: filter.blur,
                edge_mode: EdgeMode::None,
            })),
        );
        layers += 1;
    }
    if let Some((dx, dy, sigma, color)) = filter.shadow {
        context.push_layer(
            None,
            None,
            None,
            None,
            Some(Filter::from_primitive(FilterPrimitive::DropShadow {
                dx,
                dy,
                std_deviation: sigma,
                color,
                edge_mode: EdgeMode::None,
            })),
        );
        layers += 1;
    }
    {
        let mut target = CpuPaintTarget::new(&mut context, &mut resources, &mut images);
        paint(&mut target);
    }
    for _ in 0..layers {
        context.pop_layer();
    }
    context.flush();
    let mut pixmap = Pixmap::new(width, height);
    context.render(&mut pixmap, &mut resources);
    pixmap.data_as_u8_slice().to_vec()
}
