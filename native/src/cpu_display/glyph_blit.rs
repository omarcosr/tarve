//! Glyphs drawn from cached coverage masks: vello_cpu fills every glyph's outline again each
//! frame (flattening, tiling and strip rendering per glyph), over half the raster time of a
//! frame of many short texts. A glyph run that nothing drawn after it overlaps, outside any
//! layer, is instead skipped by the replay and blended into the rendered pixels afterwards
//! from a mask rasterized once per glyph, size and quarter-pixel offset. Anything else (a
//! colour glyph, a rotated run, a run under a later box or inside a clip) stays with vello_cpu.
use super::*;

/// One glyph's coverage, placed relative to its baseline origin.
struct Mask {
    left: i32,
    top: i32,
    width: usize,
    height: usize,
    coverage: Vec<u8>,
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct MaskKey {
    font: u64,
    index: u32,
    size: u32,
    scale: u64,
    coords: Vec<i16>,
    glyph: u32,
    quarter: u8,
}

/// The masks, kept across frames (`None`: a colour glyph, which vello_cpu draws).
pub(crate) struct GlyphMasks {
    masks: HashMap<MaskKey, Option<Arc<Mask>>>,
    resources: Resources,
    pixels: Vec<u8>,
}

impl Default for GlyphMasks {
    fn default() -> Self {
        Self::new()
    }
}

impl GlyphMasks {
    pub(crate) fn new() -> Self {
        Self {
            masks: HashMap::new(),
            resources: Resources::new(),
            pixels: Vec::new(),
        }
    }

    fn mask(
        &mut self,
        font: &FontData,
        size: f32,
        scale: f64,
        coords: &[i16],
        glyph: u32,
        quarter: u8,
    ) -> Option<Arc<Mask>> {
        let key = MaskKey {
            font: font.data.id(),
            index: font.index,
            size: size.to_bits(),
            scale: scale.to_bits(),
            coords: coords.to_vec(),
            glyph,
            quarter,
        };
        if let Some(mask) = self.masks.get(&key) {
            return mask.clone();
        }
        let mask = self
            .rasterize(font, size, scale, coords, glyph, quarter)
            .map(Arc::new);
        // A cache of a few thousand glyphs at a few sizes: start over past that.
        if self.masks.len() > 16_384 {
            self.masks.clear();
        }
        self.masks.insert(key, mask.clone());
        mask
    }

    fn rasterize(
        &mut self,
        font: &FontData,
        size: f32,
        scale: f64,
        coords: &[i16],
        glyph: u32,
        quarter: u8,
    ) -> Option<Mask> {
        let pixels = f64::from(size.abs()) * scale;
        if !pixels.is_finite() || pixels > 256.0 {
            return None;
        }
        let pad = (pixels * 1.5).ceil() + 8.0;
        let (width, height) = (
            (pixels * 4.0).ceil() + 2.0 * pad,
            (pixels * 3.0).ceil() + 2.0 * pad,
        );
        let (width, height) = (width as u16, height as u16);
        let origin = (pad + f64::from(quarter) * 0.25, (pixels * 2.0).ceil() + pad);
        let settings = vello_cpu::RenderSettings {
            num_threads: 0,
            ..Default::default()
        };
        let mut context = RenderContext::new_with(width, height, settings);
        context.set_transform(Affine::translate(origin) * Affine::scale(scale));
        context.set_paint(Color::WHITE);
        context
            .glyph_run(&mut self.resources, font)
            .font_size(size)
            .normalized_coords(coords)
            .fill_glyphs(std::iter::once(vello_cpu::Glyph {
                id: glyph,
                x: 0.0,
                y: 0.0,
            }));
        context.flush();
        let (w, h) = (usize::from(width), usize::from(height));
        self.pixels.clear();
        self.pixels.resize(w * h * 4, 0);
        let pixmap = vello_cpu::PixmapMut::new(width, height, &mut self.pixels)?;
        context.render(pixmap, &mut self.resources);
        let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0, 0);
        for (index, pixel) in self.pixels.as_chunks::<4>().0.iter().enumerate() {
            let [r, g, b, a] = *pixel;
            if a == 0 {
                continue;
            }
            // White paint gives grey premultiplied pixels: anything else has its own colours.
            if r.abs_diff(a) > 1 || g.abs_diff(a) > 1 || b.abs_diff(a) > 1 {
                return None;
            }
            let (x, y) = (index % w, index / w);
            (x0, y0, x1, y1) = (x0.min(x), y0.min(y), x1.max(x + 1), y1.max(y + 1));
        }
        if x0 >= x1 {
            return Some(Mask {
                left: 0,
                top: 0,
                width: 0,
                height: 0,
                coverage: Vec::new(),
            });
        }
        // A glyph reaching the canvas edge may be cut: vello_cpu draws it.
        if x0 == 0 || y0 == 0 || x1 == w || y1 == h {
            return None;
        }
        let mut coverage = Vec::with_capacity((x1 - x0) * (y1 - y0));
        for y in y0..y1 {
            coverage.extend((x0..x1).map(|x| self.pixels[(y * w + x) * 4 + 3]));
        }
        Some(Mask {
            left: x0 as i32 - pad as i32,
            top: y0 as i32 - origin.1 as i32,
            width: x1 - x0,
            height: y1 - y0,
            coverage,
        })
    }
}

/// A glyph placed in the frame: its mask and the device pixel of its origin.
struct Placed {
    mask: Arc<Mask>,
    x: i32,
    y: i32,
}

/// A run to blend in: its ink, its colour and its glyphs.
type PlacedRun = (Rect, [u8; 4], Vec<Placed>);

/// Glyph runs taken out of a replay, in paint order, to blend in after it.
pub(crate) struct GlyphBlits {
    skip: Vec<bool>,
    runs: Vec<([u8; 4], Vec<Placed>)>,
}

impl GlyphBlits {
    /// Ops the replay leaves out (indexed like the list's ops).
    pub(crate) fn skip(&self) -> &[bool] {
        &self.skip
    }

    /// Blends the runs into `pixels`, premultiplied RGBA covering `area` of the frame.
    pub(crate) fn blend(&self, pixels: &mut [u8], area: Rect) {
        let (ax, ay) = (area.x0 as i32, area.y0 as i32);
        let (width, height) = ((area.x1 - area.x0) as i32, (area.y1 - area.y0) as i32);
        for (color, glyphs) in &self.runs {
            let [r, g, b, a] = color.map(u32::from);
            for placed in glyphs {
                let mask = &placed.mask;
                let (gx, gy) = (placed.x + mask.left - ax, placed.y + mask.top - ay);
                let (x0, x1) = (gx.max(0), (gx + mask.width as i32).min(width));
                let (y0, y1) = (gy.max(0), (gy + mask.height as i32).min(height));
                for y in y0..y1 {
                    let row = (y - gy) as usize * mask.width;
                    for x in x0..x1 {
                        let cover = u32::from(mask.coverage[row + (x - gx) as usize]);
                        if cover == 0 {
                            continue;
                        }
                        let alpha = (cover * a + 127) / 255;
                        let index = (y as usize * width as usize + x as usize) * 4;
                        let pixel = &mut pixels[index..index + 4];
                        let inverse = 255 - alpha;
                        for (channel, source) in pixel[..3].iter_mut().zip([r, g, b]) {
                            *channel = ((source * alpha + u32::from(*channel) * inverse + 127)
                                / 255) as u8;
                        }
                        pixel[3] =
                            (alpha + (u32::from(pixel[3]) * inverse + 127) / 255).min(255) as u8;
                    }
                }
            }
        }
    }
}

/// A uniform grid of the boxes drawn after an op, to find what overlaps it.
struct Grid {
    origin: (f64, f64),
    columns: usize,
    rows: usize,
    cells: Vec<Vec<Rect>>,
}

const CELL: f64 = 32.0;

impl Grid {
    fn new(area: Rect) -> Self {
        let columns = ((area.width() / CELL).ceil() as usize).max(1);
        let rows = ((area.height() / CELL).ceil() as usize).max(1);
        Self {
            origin: (area.x0, area.y0),
            columns,
            rows,
            cells: vec![Vec::new(); columns * rows],
        }
    }

    fn span(&self, rect: Rect) -> Option<(usize, usize, usize, usize)> {
        let to = |value: f64, origin: f64, count: usize| {
            (((value - origin) / CELL).floor()).clamp(0.0, count as f64 - 1.0) as usize
        };
        if rect.x1 <= rect.x0 || rect.y1 <= rect.y0 {
            return None;
        }
        Some((
            to(rect.x0, self.origin.0, self.columns),
            to(rect.y0, self.origin.1, self.rows),
            to(rect.x1, self.origin.0, self.columns),
            to(rect.y1, self.origin.1, self.rows),
        ))
    }

    fn insert(&mut self, rect: Rect) {
        if let Some((x0, y0, x1, y1)) = self.span(rect) {
            for y in y0..=y1 {
                for x in x0..=x1 {
                    self.cells[y * self.columns + x].push(rect);
                }
            }
        }
    }

    fn overlaps(&self, rect: Rect) -> bool {
        let Some((x0, y0, x1, y1)) = self.span(rect) else {
            return false;
        };
        (y0..=y1).any(|y| {
            (x0..=x1).any(|x| {
                self.cells[y * self.columns + x]
                    .iter()
                    .any(|other| other.intersect(rect).area() > 0.0)
            })
        })
    }
}

impl DisplayList {
    /// The glyph runs inside `region` that can be blended in after the replay.
    pub(crate) fn plan_glyph_blits(&self, region: Rect, masks: &mut GlyphMasks) -> GlyphBlits {
        let mut skip = vec![false; self.ops.len()];
        let mut placed: Vec<Option<PlacedRun>> = Vec::new();
        placed.resize_with(self.ops.len(), || None);
        let mut depth = 0_usize;
        for (index, recorded) in self.ops.iter().enumerate() {
            match &recorded.op {
                Op::PushClip { .. } | Op::PushOpacity { .. } | Op::PushMask { .. } => depth += 1,
                Op::Pop => depth = depth.saturating_sub(1),
                Op::Glyphs {
                    font,
                    size,
                    coords,
                    transform,
                    color,
                    glyphs,
                } if depth == 0 && recorded.bounds.intersect(region).area() > 0.0 => {
                    let [a, b, c, d, e, f] = transform.as_coeffs();
                    if b != 0.0 || c != 0.0 || a != d || a <= 0.0 {
                        continue;
                    }
                    let mut run = Vec::with_capacity(glyphs.len());
                    let mut ink = Rect::new(f64::MAX, f64::MAX, f64::MIN, f64::MIN);
                    let mut ok = true;
                    for glyph in glyphs {
                        let x = e + a * f64::from(glyph.x);
                        let y = (d * f64::from(glyph.y) + f).round();
                        let mut whole = x.floor();
                        let mut quarter = ((x - whole) * 4.0).round() as u8;
                        if quarter == 4 {
                            whole += 1.0;
                            quarter = 0;
                        }
                        let Some(mask) = masks.mask(font, *size, a, coords, glyph.id, quarter)
                        else {
                            ok = false;
                            break;
                        };
                        let (x, y) = (whole as i32, y as i32);
                        if mask.width > 0 {
                            ink = ink.union(Rect::new(
                                f64::from(x + mask.left),
                                f64::from(y + mask.top),
                                f64::from(x + mask.left + mask.width as i32),
                                f64::from(y + mask.top + mask.height as i32),
                            ));
                        }
                        run.push(Placed { mask, x, y });
                    }
                    if ok {
                        let rgba = color.to_rgba8().to_u8_array();
                        placed[index] = Some((ink, rgba, run));
                    }
                }
                _ => {}
            }
        }
        // From the last op back: a run is blended in only when nothing drawn after it (and
        // not itself blended in) overlaps its ink.
        let mut later = Grid::new(region);
        for index in (0..self.ops.len()).rev() {
            let recorded = &self.ops[index];
            if let Some((ink, _, _)) = &placed[index] {
                if !later.overlaps(*ink) {
                    skip[index] = true;
                    continue;
                }
                placed[index] = None;
            }
            match &recorded.op {
                Op::PushClip { .. } | Op::Pop => {}
                _ => {
                    let bounds = recorded.bounds.intersect(region);
                    if bounds.area() > 0.0 {
                        later.insert(bounds);
                    }
                }
            }
        }
        let runs = placed
            .into_iter()
            .flatten()
            .map(|(_, color, run)| (color, run))
            .collect();
        GlyphBlits { skip, runs }
    }
}
