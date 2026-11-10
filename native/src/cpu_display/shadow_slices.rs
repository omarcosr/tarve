//! Box shadows drawn from nine slices of a small prototype. Along an edge of a blurred
//! rounded box, away from its corners, the shadow does not change: its pixels there are
//! one column (or row) repeated. The prototype is the shadow of the box with those middles
//! cut to one pixel; it is drawn once and stretched back, so every box of the same radius,
//! blur and colour (a grid of cards, one card moving) shares it, whatever its size or place.
use super::*;
use vello::peniko::ImageQuality;

/// A prototype and how its columns and rows map to the frame.
pub(super) struct ShadowSlices {
    pixmap: Arc<Pixmap>,
    /// Which of the 3×3 slices hold any ink (an inset shadow's middle holds none).
    inked: [[bool; 3]; 3],
    pub(super) used: u64,
}

/// One axis: the frame's pixels [start, end) with [cut, cut + stretch) drawn from the one
/// prototype pixel at `cut - start`.
#[derive(Clone, Copy)]
struct Axis {
    start: i64,
    end: i64,
    cut: i64,
    stretch: i64,
}

impl ShadowSlices {
    pub(super) fn bytes(&self) -> usize {
        self.pixmap.width() as usize * self.pixmap.height() as usize * 4
    }
}

impl Axis {
    /// The slices along a box `[lo, hi]` clipped to `[area_lo, area_hi]`, with `reach` the
    /// distance from an edge within which the shadow still changes along it.
    fn new(lo: f64, hi: f64, area_lo: f64, area_hi: f64, reach: f64) -> Option<Self> {
        let start = area_lo.floor() as i64;
        let end = area_hi.ceil() as i64;
        let cut = (lo + reach).ceil() as i64;
        let cut_end = (hi - reach).floor() as i64;
        // Worth it from a few repeated pixels; the area's own edges stay out of the middle.
        if cut_end - cut < 4 || (cut as f64) < area_lo || cut_end as f64 > area_hi {
            return None;
        }
        Some(Self {
            start,
            end,
            cut,
            stretch: cut_end - cut,
        })
    }
    /// Frame coordinate to prototype coordinate.
    fn shrink(self, value: f64) -> f64 {
        if value >= (self.cut + self.stretch) as f64 {
            value - (self.stretch - 1) as f64
        } else {
            value
        }
    }
    fn proto_len(self) -> i64 {
        self.end - self.start - (self.stretch - 1)
    }
    /// (frame start, frame length, prototype start, prototype length) of each slice.
    fn slices(self) -> [(i64, i64, i64, i64); 3] {
        let head = self.cut - self.start;
        [
            (self.start, head, 0, head),
            (self.cut, self.stretch, head, 1),
            (
                self.cut + self.stretch,
                self.end - self.cut - self.stretch,
                head + 1,
                self.end - self.cut - self.stretch,
            ),
        ]
    }
}

fn quantize(hasher: &mut DefaultHasher, value: f64) {
    ((value * 256.0).round() as i64).hash(hasher);
}

impl ShadowCache {
    /// Draws the shadow from its slices; false (nothing drawn) when it cannot be sliced:
    /// a rotated or skewed transform, a box too small to have a middle, a huge prototype.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn draw_sliced(
        &mut self,
        context: &mut RenderContext,
        resources: &mut Resources,
        region: Rect,
        transform: Affine,
        area: Rect,
        rect: Rect,
        color: Color,
        radius: f64,
        std_dev: f64,
        invert: bool,
    ) -> bool {
        let [a, b, c, d, _, _] = transform.as_coeffs();
        if b != 0.0 || c != 0.0 || a <= 0.0 || (a - d).abs() > 1e-9 {
            return false;
        }
        let (rect, area) = (
            transform.transform_rect_bbox(rect),
            transform.transform_rect_bbox(area),
        );
        let (radius, std_dev) = (radius * a, std_dev * a);
        let reach = radius.min(rect.width().min(rect.height()) / 2.0) + std_dev * 3.5 + 1.0;
        let (Some(x), Some(y)) = (
            Axis::new(rect.x0, rect.x1, area.x0, area.x1, reach),
            Axis::new(rect.y0, rect.y1, area.y0, area.y1, reach),
        ) else {
            return false;
        };
        let (width, height) = (x.proto_len(), y.proto_len());
        if width <= 0
            || height <= 0
            || width as f64 > SHADOW_MAX_SIDE
            || height as f64 > SHADOW_MAX_SIDE
        {
            return false;
        }
        // The prototype in its own pixels: what it looks like, not where it is.
        let local = |r: Rect| {
            Rect::new(
                x.shrink(r.x0) - x.start as f64,
                y.shrink(r.y0) - y.start as f64,
                x.shrink(r.x1) - x.start as f64,
                y.shrink(r.y1) - y.start as f64,
            )
        };
        let (proto_rect, proto_area) = (local(rect), local(area));
        let mut hasher = DefaultHasher::new();
        for value in [
            proto_rect.x0,
            proto_rect.y0,
            proto_rect.x1,
            proto_rect.y1,
            proto_area.x0,
            proto_area.y0,
            proto_area.x1,
            proto_area.y1,
            radius,
            std_dev,
        ] {
            quantize(&mut hasher, value);
        }
        (width, height, invert).hash(&mut hasher);
        color.to_rgba8().to_u32().hash(&mut hasher);
        let key = hasher.finish();
        let frame = self.frame;
        if !self.slices.contains_key(&key) {
            let size = width as usize * height as usize * 4;
            if size > SHADOW_CACHE_BYTES / 4 {
                return false;
            }
            self.make_room(size);
            self.context.reset_and_resize(width as u16, height as u16);
            self.context.set_fill_rule(Fill::NonZero);
            self.context.set_transform(Affine::IDENTITY);
            self.context.push_clip_layer(&proto_area.to_path(0.1));
            self.context.set_paint(color);
            self.context.fill_blurred_rounded_rect(
                &proto_rect,
                radius as f32,
                std_dev as f32,
                invert,
            );
            self.context.pop_layer();
            self.context.flush();
            let mut pixmap = Pixmap::new(width as u16, height as u16);
            self.context.render(&mut pixmap, resources);
            let mut inked = [[false; 3]; 3];
            let data = pixmap.data_as_u8_slice();
            for (row, &(_, rows, top, len_y)) in y.slices().iter().enumerate() {
                for (column, &(_, columns, left, len_x)) in x.slices().iter().enumerate() {
                    inked[row][column] = rows > 0
                        && columns > 0
                        && (top..top + len_y).any(|py| {
                            (left..left + len_x)
                                .any(|px| data[((py * width + px) * 4 + 3) as usize] != 0)
                        });
                }
            }
            self.bytes += size;
            self.slices.insert(
                key,
                ShadowSlices {
                    pixmap: Arc::new(pixmap),
                    inked,
                    used: frame,
                },
            );
        }
        let entry = self.slices.get_mut(&key).expect("inserted above");
        entry.used = frame;
        let sampler = vello_cpu::peniko::ImageSampler::default().with_quality(ImageQuality::Low);
        for (row, &(frame_y, rows, top, len_y)) in y.slices().iter().enumerate() {
            for (column, &(frame_x, columns, left, len_x)) in x.slices().iter().enumerate() {
                if !entry.inked[row][column] {
                    continue;
                }
                let (scale_x, scale_y) =
                    (columns as f64 / len_x as f64, rows as f64 / len_y as f64);
                context.set_transform(Affine::translate((
                    frame_x as f64 - region.x0,
                    frame_y as f64 - region.y0,
                )));
                context.set_paint(CpuImage {
                    image: CpuImageSource::Pixmap(entry.pixmap.clone()),
                    sampler,
                });
                context.set_paint_transform(
                    Affine::scale_non_uniform(scale_x, scale_y)
                        * Affine::translate((-left as f64, -top as f64)),
                );
                context.fill_rect(&Rect::new(0.0, 0.0, columns as f64, rows as f64));
            }
        }
        context.set_paint_transform(Affine::IDENTITY);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[allow(clippy::too_many_arguments)]
    fn direct(
        size: (u16, u16),
        transform: Affine,
        area: Rect,
        rect: Rect,
        color: Color,
        radius: f64,
        std_dev: f64,
        invert: bool,
    ) -> Pixmap {
        let mut context = RenderContext::new(size.0, size.1);
        context.set_transform(transform);
        context.push_clip_layer(&area.to_path(0.1));
        context.set_paint(color);
        context.fill_blurred_rounded_rect(&rect, radius as f32, std_dev as f32, invert);
        context.pop_layer();
        context.flush();
        let mut pixmap = Pixmap::new(size.0, size.1);
        context.render(&mut pixmap, &mut Resources::new());
        pixmap
    }

    #[test]
    fn a_sliced_shadow_paints_what_the_whole_shadow_paints() {
        let size = (420u16, 360u16);
        let mut cache = ShadowCache::new();
        // (scale, offset, rect, radius, blur, inset)
        let cases = [
            (
                1.0,
                (0.0, 0.0),
                Rect::new(40.0, 50.0, 300.0, 260.0),
                28.0,
                15.0,
                false,
            ),
            (
                1.25,
                (0.3, 0.6),
                Rect::new(30.2, 40.7, 260.5, 230.1),
                28.0,
                15.0,
                false,
            ),
            (
                1.25,
                (0.0, 0.0),
                Rect::new(30.0, 40.0, 260.0, 230.0),
                22.0,
                0.5,
                true,
            ),
            (
                1.5,
                (0.4, 0.0),
                Rect::new(20.0, 20.0, 240.0, 200.0),
                0.0,
                3.0,
                false,
            ),
        ];
        for (scale, offset, rect, radius, std_dev, invert) in cases {
            let transform = Affine::translate(offset) * Affine::scale(scale);
            let reach = std_dev * 3.5 + 2.0;
            let area = if invert {
                rect
            } else {
                rect.inflate(reach, reach) + Vec2::new(0.0, 4.0)
            };
            let color = Color::from_rgba8(20, 30, 60, 120);
            let expected = direct(size, transform, area, rect, color, radius, std_dev, invert);
            let mut context = RenderContext::new(size.0, size.1);
            let region = Rect::new(0.0, 0.0, f64::from(size.0), f64::from(size.1));
            assert!(
                cache.draw_sliced(
                    &mut context,
                    &mut Resources::new(),
                    region,
                    transform,
                    area,
                    rect,
                    color,
                    radius,
                    std_dev,
                    invert
                ),
                "sliced {rect:?}"
            );
            context.flush();
            let mut got = Pixmap::new(size.0, size.1);
            context.render(&mut got, &mut Resources::new());
            let worst = expected
                .data_as_u8_slice()
                .iter()
                .zip(got.data_as_u8_slice())
                .map(|(a, b)| a.abs_diff(*b))
                .max()
                .unwrap();
            assert!(
                worst <= 2,
                "{rect:?} scale {scale} inset {invert}: off by {worst}"
            );
        }
        // A rotated shadow, or one too small for a middle, is left to the whole draw.
        let mut context = RenderContext::new(size.0, size.1);
        let region = Rect::new(0.0, 0.0, f64::from(size.0), f64::from(size.1));
        let small = Rect::new(10.0, 10.0, 40.0, 40.0);
        assert!(!cache.draw_sliced(
            &mut context,
            &mut Resources::new(),
            region,
            Affine::IDENTITY,
            small.inflate(30.0, 30.0),
            small,
            Color::BLACK,
            12.0,
            6.0,
            false
        ));
        assert!(!cache.draw_sliced(
            &mut context,
            &mut Resources::new(),
            region,
            Affine::rotate(0.2),
            Rect::new(0.0, 0.0, 400.0, 300.0),
            Rect::new(40.0, 40.0, 300.0, 260.0),
            Color::BLACK,
            12.0,
            6.0,
            false
        ));
    }
}
