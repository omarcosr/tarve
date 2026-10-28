//! Rasterizing a recorded frame, or the part of it before or after its first glass box.
use super::*;

impl DisplayList {
    /// Rasterizes the part of the frame inside `region` (device pixels, integer
    /// origin) into `context`, which must already be sized to the region.
    pub(crate) fn replay(
        &self,
        context: &mut RenderContext,
        resources: &mut Resources,
        region: Rect,
        shadows: Option<&mut ShadowCache>,
    ) {
        let origin = Affine::translate((-region.x0, -region.y0));
        self.replay_ops(
            context,
            resources,
            region,
            origin,
            0..self.ops.len(),
            shadows,
            false,
        );
    }

    /// Rasterizes the ops before the first glass box (`before`) or from it on into a context
    /// the size of the frame; glass ops paint nothing (glass/cpu.rs composites the glass).
    pub(crate) fn replay_around_glass(
        &self,
        context: &mut RenderContext,
        resources: &mut Resources,
        frame: Rect,
        shadows: Option<&mut ShadowCache>,
        before: bool,
    ) -> bool {
        let range = if before {
            0..self.first_glass
        } else {
            self.first_glass..self.ops.len()
        };
        // Nothing to draw (glass boxes only, or nothing on screen): no layers to open either.
        let paints = self.ops[range.clone()].iter().any(|op| {
            !matches!(
                op.op,
                Op::PushClip { .. }
                    | Op::PushOpacity { .. }
                    | Op::PushMask { .. }
                    | Op::Pop
                    | Op::Glass { .. }
            ) && op.bounds.intersect(frame).area() > 0.0
        });
        if !paints {
            return false;
        }
        self.replay_ops(
            context,
            resources,
            frame,
            Affine::IDENTITY,
            range,
            shadows,
            true,
        );
        true
    }

    pub(crate) fn has_glass(&self) -> bool {
        !self.glass.is_empty()
    }

    /// The frame's glass laid out for a frame of `size` at `k` backdrop pixels per pixel.
    pub(crate) fn glass_plan(&self, size: (u32, u32), k: f64) -> Option<GlassPlan> {
        crate::glass::plan(&self.glass, size, k)
    }

    #[allow(clippy::too_many_arguments)]
    fn replay_ops(
        &self,
        context: &mut RenderContext,
        resources: &mut Resources,
        region: Rect,
        origin: Affine,
        range: std::ops::Range<usize>,
        mut shadows: Option<&mut ShadowCache>,
        glass_composited: bool,
    ) {
        let mut depth = 0_usize;
        // Starting inside layers: open the ones that hold the start.
        let mut index = 0;
        while index < range.start.min(self.ops.len()) {
            let recorded = &self.ops[index];
            let visible = recorded.bounds.intersect(region).area() > 0.0;
            match &recorded.op {
                Op::PushClip { close, .. }
                | Op::PushOpacity { close, .. }
                | Op::PushMask { close, .. }
                    if *close < range.start || !visible =>
                {
                    index = close + 1;
                    continue;
                }
                Op::PushClip {
                    rule,
                    transform,
                    path,
                    ..
                } => {
                    context.set_fill_rule(*rule);
                    context.set_transform(origin * *transform);
                    context.push_clip_layer(path);
                    depth += 1;
                }
                Op::PushOpacity {
                    alpha,
                    transform,
                    path,
                    ..
                } => {
                    context.set_fill_rule(Fill::NonZero);
                    context.set_transform(origin * *transform);
                    context.push_layer(Some(path), None, Some(*alpha), None, None);
                    depth += 1;
                }
                Op::PushMask {
                    transform, path, ..
                } => {
                    context.set_fill_rule(Fill::NonZero);
                    context.set_transform(origin * *transform);
                    context.push_layer(Some(path), Some(mask_blend()), None, None, None);
                    depth += 1;
                }
                _ => {}
            }
            index += 1;
        }
        let mut index = range.start;
        while index < range.end.min(self.ops.len()) {
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
                    depth += 1;
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
                    depth += 1;
                }
                Op::PushMask {
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
                    context.push_layer(Some(path), Some(mask_blend()), None, None, None);
                    depth += 1;
                }
                Op::Pop => {
                    context.pop_layer();
                    depth = depth.saturating_sub(1);
                }
                Op::Glass { call, .. } => {
                    if !glass_composited {
                        draw_glass_tint(context, origin, call);
                    }
                }
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
                    // Inset shadows draw only their edges (below): cheaper than a cached image.
                    let cached = shadows
                        .as_deref_mut()
                        .filter(|_| !*invert)
                        .and_then(|cache| {
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
                    context.set_transform(origin * *transform);
                    // An inset shadow shows only along the edges: deeper than 3.5 sigma
                    // inside its rectangle the clip leaves a hole the rasterizer skips.
                    let reach = std_dev * 3.5;
                    let hole = rect.inflate(-reach, -reach).intersect(*area);
                    let mut clip = area.to_path(0.1);
                    if *invert && hole.width() > 0.0 && hole.height() > 0.0 {
                        let corner = (radius - reach).max(0.0);
                        clip.extend(
                            vello::kurbo::RoundedRect::from_rect(hole, corner).path_elements(0.1),
                        );
                        context.set_fill_rule(Fill::EvenOdd);
                    } else {
                        context.set_fill_rule(Fill::NonZero);
                    }
                    context.push_clip_layer(&clip);
                    context.set_fill_rule(Fill::NonZero);
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
                            y: hinted_baseline(*transform, glyph.y),
                        }));
                }
            }
            index += 1;
        }
        // A replay that stops inside a layer (the backdrop) still closes it.
        for _ in 0..depth {
            context.pop_layer();
        }
    }
}

/// A glyph's `y` with its baseline snapped to a whole frame pixel when the run is hinted.
/// Hinting (vello_cpu's default, for a translated uniform scale) snaps the baseline in the
/// context's coordinates with `f64::round`, which takes a half-pixel tie away from zero: a
/// baseline above a redrawn region is negative there and lands a pixel higher than in a
/// full redraw, moving its descenders. Snapped in frame coordinates, every region agrees.
fn hinted_baseline(transform: Affine, y: f32) -> f32 {
    let [a, b, _, d, _, f] = transform.as_coeffs();
    if b != 0.0 || a != d || d <= 0.0 {
        return y;
    }
    let snapped = ((d * f64::from(y) + f).round() - f) / d;
    if snapped.is_finite() {
        snapped as f32
    } else {
        y
    }
}

/// A glass box where the frame's glass is not composited: its tint.
fn draw_glass_tint(context: &mut RenderContext, origin: Affine, call: &GlassCall) {
    let [r, g, b, a] = call.tint;
    if a > 0.0 {
        let [cx, cy] = call.center.map(f64::from);
        let [hx, hy] = call.half.map(f64::from);
        let shape = vello::kurbo::RoundedRect::new(
            cx - hx,
            cy - hy,
            cx + hx,
            cy + hy,
            f64::from(call.radius),
        );
        context.set_transform(origin);
        context.set_paint(Color::new([r, g, b, a]));
        context.set_fill_rule(Fill::NonZero);
        context.fill_path(&shape.to_path(0.1));
    }
}

/// DestIn: a mask layer keeps what lies under it by the alpha it draws.
fn mask_blend() -> vello_cpu::peniko::BlendMode {
    vello_cpu::peniko::BlendMode::new(
        vello_cpu::peniko::Mix::Normal,
        vello_cpu::peniko::Compose::DestIn,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paint::PaintGlyph;

    fn draw(list: &DisplayList, region: Rect) -> Vec<u8> {
        let (width, height) = (region.width() as u16, region.height() as u16);
        let mut context = RenderContext::new(width, height);
        let mut resources = Resources::new();
        list.replay(&mut context, &mut resources, region, None);
        context.flush();
        let mut bytes = vec![0_u8; usize::from(width) * usize::from(height) * 4];
        if let Some(pixmap) = vello_cpu::PixmapMut::new(width, height, &mut bytes) {
            context.render(pixmap, &mut resources);
        }
        bytes
    }

    /// A baseline on a half pixel above a redrawn region (fractional display scales put
    /// text there) must not move a pixel: its descenders show in the region.
    #[test]
    fn descenders_below_a_half_pixel_baseline_match_a_full_redraw() {
        let bytes = include_bytes!("../../../packages/headless/fonts/InterVariable.ttf").to_vec();
        let charmap = swash::FontRef::from_index(&bytes, 0)
            .expect("font")
            .charmap();
        let glyphs: Vec<PaintGlyph> = "gjpqy"
            .chars()
            .enumerate()
            .map(|(index, c)| PaintGlyph {
                id: u32::from(charmap.map(c)),
                x: 4.0 + 14.0 * index as f32,
                y: 30.5,
            })
            .collect();
        let font = FontData::new(vello::peniko::Blob::new(Arc::new(bytes)), 0);
        let list = DisplayList {
            ops: vec![Recorded {
                op: Op::Glyphs {
                    font,
                    size: 20.0,
                    coords: Vec::new(),
                    transform: Affine::IDENTITY,
                    color: Color::BLACK,
                    glyphs,
                },
                hash: 0,
                bounds: EVERYWHERE,
            }],
            ..Default::default()
        };
        let full = draw(&list, Rect::new(0.0, 0.0, 80.0, 64.0));
        let part = draw(&list, Rect::new(0.0, 32.0, 80.0, 64.0));
        assert!(
            part.iter().any(|&byte| byte != 0),
            "descenders reach the region"
        );
        assert!(
            full[32 * 80 * 4..] == part[..],
            "the region matches a full redraw"
        );
    }
}
