//! Glass on the CPU renderer, composited straight into the frame: what lies before the first
//! glass box is rasterized, each surface is shaded from those pixels (read at the plan's lower
//! resolution, blurred, bent, tinted, lit) and blended in at the device's resolution, and what
//! comes after is rasterized on its own and laid over.
use super::{GlassPlan, GlassSurface, rim_light, shade};
use crate::cpu_display::{DisplayList, ShadowCache};
use rayon::prelude::*;
use vello::kurbo::Rect;
use vello::peniko::Color;
use vello_cpu::{PixmapMut, RenderContext, Resources};

/// The last frame's backdrop with its glass composited, and what it was drawn from. A frame
/// whose ops before the first glass box, glass and background are those of the last one gets
/// the same pixels: they are copied instead of drawn and shaded again (a slider dragged on a
/// glass card changes only what is painted over the glass). Per raster thread.
struct GlassBackdrop {
    ops: Vec<(u64, Rect)>,
    plan: GlassPlan,
    size: (u32, u32),
    under: [u8; 4],
    opaque: bool,
    pixels: Vec<u8>,
}

thread_local! {
    static BACKDROP: std::cell::RefCell<Option<GlassBackdrop>> = const { std::cell::RefCell::new(None) };
}

/// Forgets the cached backdrop (tests and the probe measure the uncached path with it).
#[cfg(test)]
pub(crate) fn forget_backdrop() {
    BACKDROP.with(|cell| cell.borrow_mut().take());
}

#[cfg(test)]
thread_local! {
    static REUSED: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Frames on this thread that reused the cached backdrop.
#[cfg(test)]
pub(crate) fn reused_backdrops() -> usize {
    REUSED.with(std::cell::Cell::get)
}

/// Rasterizes a whole frame with glass into `bytes` (premultiplied RGBA, `width` Ã— `height`).
/// False, with nothing drawn, when the frame has no glass on screen.
#[allow(clippy::too_many_arguments)]
pub(crate) fn rasterize(
    context: &mut RenderContext,
    resources: &mut Resources,
    list: &DisplayList,
    bytes: &mut [u8],
    (width, height): (u16, u16),
    mut shadows: Option<&mut ShadowCache>,
    background: Color,
    opaque: bool,
    device_scale: f64,
    scratch: &mut Vec<u8>,
) -> bool {
    if !list.has_glass() {
        BACKDROP.with(|cell| cell.borrow_mut().take());
        return false;
    }
    let size = (u32::from(width), u32::from(height));
    let Some(plan) = list.glass_plan(size, super::cpu_scale(device_scale)) else {
        BACKDROP.with(|cell| cell.borrow_mut().take());
        return false;
    };
    let frame = Rect::new(0.0, 0.0, f64::from(width), f64::from(height));
    let rgba = background.to_rgba8();
    let under8 = [rgba.r, rgba.g, rgba.b, rgba.a];
    let mut ops = Vec::new();
    list.backdrop_ops(&mut ops);
    let reused = BACKDROP.with(|cell| {
        let cached = cell.borrow();
        let Some(cached) = cached.as_ref().filter(|cached| {
            cached.size == size
                && cached.opaque == opaque
                && cached.under == under8
                && cached.pixels.len() == bytes.len()
                && cached.ops == ops
                && cached.plan == plan
        }) else {
            return false;
        };
        bytes.copy_from_slice(&cached.pixels);
        #[cfg(test)]
        REUSED.with(|count| count.set(count.get() + 1));
        true
    });
    if !reused {
        context.reset_and_resize(width, height);
        if opaque {
            context.set_transform(vello::kurbo::Affine::IDENTITY);
            context.set_paint(background.with_alpha(1.0));
            context.fill_rect(&frame);
        }
        list.replay_around_glass(context, resources, frame, shadows.as_deref_mut(), true);
        context.flush();
        if let Some(pixmap) = PixmapMut::new(width, height, bytes) {
            context.render(pixmap, resources);
        }
        let under = [rgba.r, rgba.g, rgba.b].map(|c| f32::from(c) / 255.0);
        for surface in &plan.surfaces {
            composite_surface(&plan, surface, bytes, size, under);
        }
        BACKDROP.with(|cell| {
            let mut cell = cell.borrow_mut();
            let mut pixels = cell.take().map(|old| old.pixels).unwrap_or_default();
            pixels.clear();
            pixels.extend_from_slice(bytes);
            *cell = Some(GlassBackdrop {
                ops,
                plan,
                size,
                under: under8,
                opaque,
                pixels,
            });
        });
    }
    context.reset_and_resize(width, height);
    if !list.replay_around_glass(context, resources, frame, shadows, false) {
        return true;
    }
    context.flush();
    scratch.clear();
    scratch.resize(bytes.len(), 0);
    if let Some(pixmap) = PixmapMut::new(width, height, scratch) {
        context.render(pixmap, resources);
    }
    blend_over(bytes, scratch, usize::from(width) * 4);
    true
}

/// Whether the cached backdrop is this frame's: its ops before the first glass box, glass,
/// size and background are those it was drawn from. Then a region of the frame can be drawn
/// alone (`rasterize_region`): what changed lies over the glass.
pub(crate) fn backdrop_reusable(
    list: &DisplayList,
    size: (u32, u32),
    background: Color,
    opaque: bool,
    device_scale: f64,
) -> bool {
    if !list.has_glass() {
        return false;
    }
    let Some(plan) = list.glass_plan(size, super::cpu_scale(device_scale)) else {
        return false;
    };
    let rgba = background.to_rgba8();
    let mut ops = Vec::new();
    list.backdrop_ops(&mut ops);
    BACKDROP.with(|cell| {
        cell.borrow().as_ref().is_some_and(|cached| {
            cached.size == size
                && cached.opaque == opaque
                && cached.under == [rgba.r, rgba.g, rgba.b, rgba.a]
                && cached.ops == ops
                && cached.plan == plan
        })
    })
}

/// Draws `raster` (device pixels inside the frame) of a frame whose backdrop is cached
/// (`backdrop_reusable`) into `out` (premultiplied RGBA, the raster's size): the cached
/// backdrop's pixels there with what is painted over the glass laid on them, as `rasterize`
/// draws them for the whole frame. False, with nothing drawn, without a cached backdrop.
pub(crate) fn rasterize_region(
    context: &mut RenderContext,
    resources: &mut Resources,
    list: &DisplayList,
    out: &mut Vec<u8>,
    raster: Rect,
    shadows: Option<&mut ShadowCache>,
) -> bool {
    let (x0, y0) = (raster.x0 as usize, raster.y0 as usize);
    let (width, height) = (raster.width() as usize, raster.height() as usize);
    let copied = BACKDROP.with(|cell| {
        let cached = cell.borrow();
        let Some(cached) = cached.as_ref() else {
            return false;
        };
        let frame_row = cached.size.0 as usize * 4;
        if x0 + width > cached.size.0 as usize || y0 + height > cached.size.1 as usize {
            return false;
        }
        out.clear();
        out.reserve(width * height * 4);
        for y in y0..y0 + height {
            out.extend_from_slice(
                &cached.pixels[y * frame_row + x0 * 4..y * frame_row + (x0 + width) * 4],
            );
        }
        true
    });
    if !copied {
        return false;
    }
    context.reset_and_resize(width as u16, height as u16);
    if !list.replay_around_glass(context, resources, raster, shadows, false) {
        return true;
    }
    context.flush();
    OVER.with(|scratch| {
        let mut scratch = scratch.borrow_mut();
        scratch.clear();
        scratch.resize(out.len(), 0);
        if let Some(pixmap) = PixmapMut::new(width as u16, height as u16, &mut scratch) {
            context.render(pixmap, resources);
        }
        blend_over(out, &scratch, width * 4);
    });
    true
}

thread_local! {
    /// What `rasterize_region` paints over the glass, before it is blended in.
    static OVER: std::cell::RefCell<Vec<u8>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Lays premultiplied `over` on `bytes` (same size, `row` bytes a row).
fn blend_over(bytes: &mut [u8], over: &[u8], row: usize) {
    let scratch = over;
    par_rows(bytes, row, |y, line| {
        let over = &scratch[y * row..(y + 1) * row];
        for (dst, src) in line
            .as_chunks_mut::<4>()
            .0
            .iter_mut()
            .zip(over.as_chunks::<4>().0)
        {
            match src[3] {
                0 => {}
                255 => dst.copy_from_slice(src),
                a => {
                    let keep = u16::from(255 - a);
                    for c in 0..4 {
                        dst[c] = (u16::from(src[c]) + (u16::from(dst[c]) * keep + 127) / 255)
                            .min(255) as u8;
                    }
                }
            }
        }
    });
}

/// Runs `row` for every row of `out` (`width` items each) on rayon's pool: its threads
/// are kept, where starting threads for every stage of every surface cost more than a small
/// surface's rows. Each row is computed alone, so the result does not depend on the split.
fn par_rows<T: Send>(out: &mut [T], width: usize, row: impl Fn(usize, &mut [T]) + Sync) {
    if width == 0 || out.is_empty() {
        return;
    }
    out.par_chunks_mut(width)
        .enumerate()
        .for_each(|(y, line)| row(y, line));
}

/// Shades `surface` from the pixels already in `bytes` and blends it in.
fn composite_surface(
    plan: &GlassPlan,
    surface: &GlassSurface,
    bytes: &mut [u8],
    size: (u32, u32),
    under: [f32; 3],
) {
    let k = plan.k as f32;
    let (fw, fh) = (size.0 as usize, size.1 as usize);
    let w = (surface.slot[2] - surface.slot[0]) as usize;
    let h = (surface.slot[3] - surface.slot[1]) as usize;
    let (rx, ry) = (surface.reach.x0 as f32, surface.reach.y0 as f32);
    // The backdrop at the plan's resolution: each low pixel averages four device pixels.
    let mut low = vec![[0.0_f32; 3]; w * h];
    {
        let source: &[u8] = bytes;
        let read = |x: f32, y: f32| {
            let (x, y) = ((x as usize).min(fw - 1), (y as usize).min(fh - 1));
            let p = &source[(y * fw + x) * 4..][..4];
            let keep = 1.0 - f32::from(p[3]) / 255.0;
            [0, 1, 2].map(|c| f32::from(p[c]) / 255.0 + under[c] * keep)
        };
        let step = 0.25 / k;
        par_rows(&mut low, w, |y, line| {
            for (x, out) in line.iter_mut().enumerate() {
                let (cx, cy) = (rx + (x as f32 + 0.5) / k, ry + (y as f32 + 0.5) / k);
                let mut sum = [0.0; 3];
                for (dx, dy) in [(-step, -step), (step, -step), (-step, step), (step, step)] {
                    let p = read((cx + dx).max(0.0), (cy + dy).max(0.0));
                    for c in 0..3 {
                        sum[c] += p[c] * 0.25;
                    }
                }
                *out = sum;
            }
        });
    }
    blur(&mut low, w, h, surface.params[0] * k);
    let bilinear = |buffer: &[[f32; 3]], q: [f32; 2]| {
        let fx = ((q[0] - rx) * k - 0.5).clamp(0.0, (w - 1) as f32);
        let fy = ((q[1] - ry) * k - 0.5).clamp(0.0, (h - 1) as f32);
        let (x0, y0) = (fx as usize, fy as usize);
        let (x1, y1) = ((x0 + 1).min(w - 1), (y0 + 1).min(h - 1));
        let (tx, ty) = (fx - x0 as f32, fy - y0 as f32);
        [0, 1, 2].map(|c| {
            let top = buffer[y0 * w + x0][c] * (1.0 - tx) + buffer[y0 * w + x1][c] * tx;
            let bottom = buffer[y1 * w + x0][c] * (1.0 - tx) + buffer[y1 * w + x1][c] * tx;
            top * (1.0 - ty) + bottom * ty
        })
    };
    // The glass's colour at the plan's resolution...
    let mut shaded = vec![[0.0_f32; 3]; w * h];
    par_rows(&mut shaded, w, |y, line| {
        for (x, out) in line.iter_mut().enumerate() {
            let device = [rx + (x as f32 + 0.5) / k, ry + (y as f32 + 0.5) / k];
            let [r, g, b, _] = shade(surface, device, k, |q| bilinear(&low, q));
            *out = [r, g, b];
        }
    });
    // ...blended in at the device's, with an exact edge.
    let bounds = surface
        .bounds
        .intersect(Rect::new(0.0, 0.0, fw as f64, fh as f64));
    if bounds.area() <= 0.0 {
        return;
    }
    let (x0, y0) = (bounds.x0.floor() as usize, bounds.y0.floor() as usize);
    let (x1, y1) = (
        (bounds.x1.ceil() as usize).min(fw),
        (bounds.y1.ceil() as usize).min(fh),
    );
    let s0 = surface.shapes[0];
    let inner = [
        s0[0] - s0[2] + s0[4] + 1.0,
        s0[1] - s0[3] + s0[4] + 1.0,
        s0[0] + s0[2] - s0[4] - 1.0,
        s0[1] + s0[3] - s0[4] - 1.0,
    ];
    let opacity = surface.opacity;
    let row = fw * 4;
    let rows = &mut bytes[y0 * row..y1 * row];
    par_rows(rows, row, |y, line| {
        let py = (y0 + y) as f32 + 0.5;
        for x in x0..x1 {
            let p = [x as f32 + 0.5, py];
            let inside = !surface.merged
                && (p[0] > inner[0] && p[0] < inner[2] || p[1] > inner[1] && p[1] < inner[3])
                && (p[0] - s0[0]).abs() < s0[2] - 1.0
                && (p[1] - s0[1]).abs() < s0[3] - 1.0;
            let coverage = if inside {
                1.0
            } else if surface.merged {
                (0.5 - super::sd_glass(surface, [p[0] - s0[0], p[1] - s0[1]])).clamp(0.0, 1.0)
            } else {
                (0.5 - super::sd_round_rect([p[0] - s0[0], p[1] - s0[1]], [s0[2], s0[3]], s0[4]))
                    .clamp(0.0, 1.0)
            };
            let a = coverage * opacity;
            if a <= 0.0 {
                continue;
            }
            let mut color = bilinear(&shaded, p);
            if !inside {
                let rim = rim_light(surface, p);
                color = color.map(|c| c + rim);
            }
            let dst = &mut line[x * 4..x * 4 + 4];
            for c in 0..3 {
                let value = color[c].clamp(0.0, 1.0) * 255.0 * a + f32::from(dst[c]) * (1.0 - a);
                dst[c] = (value + 0.5) as u8;
            }
            dst[3] = (255.0 * a + f32::from(dst[3]) * (1.0 - a) + 0.5) as u8;
        }
    });
}

/// A gaussian of `sigma` pixels, as three box blurs (horizontal and vertical each).
fn blur(pixels: &mut [[f32; 3]], w: usize, h: usize, sigma: f32) {
    if sigma < 0.5 || w == 0 || h == 0 {
        return;
    }
    let radius = ((((12.0 * sigma * sigma / 3.0) + 1.0).sqrt() - 1.0) / 2.0)
        .round()
        .max(1.0) as usize;
    // Rows and columns on the pool; a column is blurred as a row of the transposed buffer.
    // Each line goes through `box_line` as before, so the pixels are the same.
    let mut columns = vec![[0.0_f32; 3]; w * h];
    for _ in 0..3 {
        pixels.par_chunks_mut(w).for_each_init(
            || vec![[0.0_f32; 3]; w],
            |scratch, line| box_line(line, scratch, radius),
        );
        let source: &[[f32; 3]] = pixels;
        columns.par_chunks_mut(h).enumerate().for_each_init(
            || vec![[0.0_f32; 3]; h],
            |scratch, (x, column)| {
                for (y, value) in column.iter_mut().enumerate() {
                    *value = source[y * w + x];
                }
                box_line(column, scratch, radius);
            },
        );
        let columns: &[[f32; 3]] = &columns;
        pixels.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
            for (x, value) in row.iter_mut().enumerate() {
                *value = columns[x * h + y];
            }
        });
    }
}

/// A box blur of one line, its ends repeated past the edge.
fn box_line(line: &mut [[f32; 3]], scratch: &mut [[f32; 3]], radius: usize) {
    let n = line.len();
    let at = |i: isize| line[i.clamp(0, n as isize - 1) as usize];
    let mut sum = [0.0_f32; 3];
    for i in -(radius as isize)..=radius as isize {
        let p = at(i);
        for c in 0..3 {
            sum[c] += p[c];
        }
    }
    let scale = 1.0 / (2 * radius + 1) as f32;
    for (i, out) in scratch.iter_mut().enumerate().take(n) {
        *out = sum.map(|v| v * scale);
        let (add, drop) = (
            at(i as isize + radius as isize + 1),
            at(i as isize - radius as isize),
        );
        for c in 0..3 {
            sum[c] += add[c] - drop[c];
        }
    }
    line.copy_from_slice(scratch);
}
