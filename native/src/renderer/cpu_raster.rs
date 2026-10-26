//! The CPU renderer's redraw: which region to rasterize, and rasterizing it into the frame.
use super::*;

/// A damaged rectangle grown to whole 16-pixel tiles inside the frame, or the whole
/// frame when the damage covers most of it (one pass is then cheaper than two copies).
/// Tile-aligned origins keep the rasterizer's tiling, so pixels match a full redraw.
pub(super) fn cpu_redraw_region(
    damage: vello::kurbo::Rect,
    width: u32,
    height: u32,
) -> vello::kurbo::Rect {
    let full = vello::kurbo::Rect::new(0.0, 0.0, f64::from(width), f64::from(height));
    let x0 = ((damage.x0 / 16.0).floor() * 16.0).clamp(0.0, full.x1);
    let y0 = ((damage.y0 / 16.0).floor() * 16.0).clamp(0.0, full.y1);
    let x1 = ((damage.x1 / 16.0).ceil() * 16.0).clamp(0.0, full.x1);
    let y1 = ((damage.y1 / 16.0).ceil() * 16.0).clamp(0.0, full.y1);
    let region = vello::kurbo::Rect::new(x0, y0, x1, y1);
    if region.area() >= full.area() * 0.6 {
        full
    } else {
        region
    }
}

/// TARVE_CPU_DAMAGE_CHECK=1: after each partial redraw, redraw the whole frame and
/// fail if a pixel differs by more than rounding. For tests; it doubles every frame's work.
#[allow(clippy::too_many_arguments)]
pub(super) fn check_partial_redraw(
    context: &mut CpuRenderContext,
    resources: &mut CpuResources,
    list: &DisplayList,
    frame: &[u32],
    width: usize,
    height: usize,
    region: vello::kurbo::Rect,
    background: vello::peniko::Color,
    alpha: bool,
) -> Result<(), RenderError> {
    let mut expected = vec![0_u32; width * height];
    rasterize_cpu_region(
        context,
        resources,
        list,
        CpuFrame {
            pixels: &mut expected,
            width,
            height,
            alpha,
        },
        &mut Vec::new(),
        None,
        vello::kurbo::Rect::new(0.0, 0.0, width as f64, height as f64),
        background,
        None,
    );
    let mut wrong = 0;
    let (mut x0, mut y0, mut x1, mut y1, mut worst) = (usize::MAX, usize::MAX, 0, 0, 0_i32);
    for (index, (a, b)) in expected.iter().zip(frame).enumerate() {
        // The region is rasterized in its own coordinates: f32 rounding can shift a
        // near-tangent edge pixel by a few steps of 255. A missed damage differs by
        // whole shapes, far more than that.
        let delta = [0, 8, 16]
            .iter()
            .map(|shift| (((a >> shift) & 255) as i32 - ((b >> shift) & 255) as i32).abs())
            .max()
            .unwrap_or(0);
        if delta > 3 {
            wrong += 1;
            let (x, y) = (index % width, index / width);
            (x0, y0, x1, y1) = (x0.min(x), y0.min(y), x1.max(x), y1.max(y));
            worst = worst.max(delta);
        }
    }
    if wrong > 0 {
        return Err(RenderError::Fatal(format!(
            "CPU partial redraw of {region:?} differs from a full redraw in {wrong} pixels within {x0},{y0}..{x1},{y1} (by up to {worst})"
        )));
    }
    Ok(())
}

pub(super) fn cpu_damage_check() -> bool {
    static CHECK: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *CHECK.get_or_init(|| {
        std::env::var_os("TARVE_CPU_DAMAGE_CHECK").is_some_and(|value| value == "1")
    })
}

/// The retained frame: composited pixels packed for softbuffer.
pub(super) struct CpuFrame<'a> {
    pub(super) pixels: &'a mut [u32],
    pub(super) width: usize,
    pub(super) height: usize,
    /// Premultiplied ARGB (a transparent window) instead of opaque XRGB.
    pub(super) alpha: bool,
}

/// Rasterizes `region` (tile-aligned, inside the frame) of `list` into `frame`.
#[allow(clippy::too_many_arguments)]
pub(super) fn rasterize_cpu_region(
    context: &mut CpuRenderContext,
    resources: &mut CpuResources,
    list: &DisplayList,
    frame: CpuFrame<'_>,
    scratch: &mut Vec<u8>,
    shadows: Option<&mut ShadowCache>,
    region: vello::kurbo::Rect,
    color: vello::peniko::Color,
    glass_scale: Option<f64>,
) {
    let (width, height) = (frame.width, frame.height);
    let pack = if frame.alpha {
        pack_premultiplied_for_softbuffer
    } else {
        flatten_rgba_for_softbuffer
    };

    let (x0, y0) = (region.x0 as usize, region.y0 as usize);
    let (region_width, region_height) = (
        (region.x1 - region.x0) as usize,
        (region.y1 - region.y0) as usize,
    );
    if region_width == 0 || region_height == 0 {
        return;
    }
    let full = region_width == width && region_height == height;
    let mut shadows = shadows;
    if full && let Some(scale) = glass_scale {
        let opaque = cfg!(target_os = "android") && !frame.alpha;
        let bytes = bytemuck::cast_slice_mut::<u32, u8>(frame.pixels);
        let size = (width as u16, height as u16);
        if crate::glass::cpu::rasterize(
            context,
            resources,
            list,
            bytes,
            size,
            shadows.as_deref_mut(),
            color,
            opaque,
            scale,
            scratch,
        ) {
            if !opaque {
                pack(frame.pixels, color);
            }
            return;
        }
    }
    // Geometry entering from the left of the viewport accumulates its coverage
    // differently in the first tile column (one step of rounding): rasterize a
    // margin there and keep only the region, so pixels match a full redraw.
    let margin = if full { 0 } else { x0.min(16) };
    let raster =
        vello::kurbo::Rect::new(region.x0 - margin as f64, region.y0, region.x1, region.y1);
    let raster_width = region_width + margin;
    context.reset_and_resize(raster_width as u16, region_height as u16);
    let opaque =
        pixels::fill_opaque_background(context, frame.alpha, color, raster_width, region_height);
    list.replay(context, resources, raster, shadows);
    context.flush();
    if full {
        let bytes = bytemuck::cast_slice_mut::<u32, u8>(frame.pixels);
        if let Some(pixmap) = PixmapMut::new(region_width as u16, region_height as u16, bytes) {
            context.render(pixmap, resources);
        }
        if !opaque {
            pack(frame.pixels, color);
        }
    } else {
        scratch.clear();
        scratch.resize(raster_width * region_height * 4, 0);
        if let Some(pixmap) = PixmapMut::new(raster_width as u16, region_height as u16, scratch) {
            context.render(pixmap, resources);
        }
        for row in 0..region_height {
            let source = &scratch[(row * raster_width + margin) * 4..(row + 1) * raster_width * 4];
            let start = (y0 + row) * width + x0;
            let target = &mut frame.pixels[start..start + region_width];
            for (pixel, rgba) in target.iter_mut().zip(source.as_chunks::<4>().0) {
                *pixel = u32::from_ne_bytes(*rgba);
            }
            if !opaque {
                pack(target, color);
            }
        }
    }
}
