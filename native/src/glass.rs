//! Liquid glass on the renderers that draw the whole frame at once (Vello on the GPU, the CPU
//! renderer): what was painted before the first glass box is drawn again at a lower resolution
//! (the backdrop), each glass surface is shaded from it into an atlas (blurred, bent at the
//! rounded edge, saturated, tinted, lit), and the frame draws the atlas where the glass is.
//! The D3D11 renderer reads its own render target instead (d3d11.rs); the shading here follows
//! its shader (shaders/ui.hlsl, `glassShade`) so every renderer shows the same glass.
//!
//! The backdrop of every glass box is the frame up to the first one: content painted between
//! two glass boxes does not show through the later one.
use crate::paint::GlassParams;
use vello::kurbo::{Affine, Rect};
use vello::peniko::Color;

#[cfg(not(target_arch = "wasm32"))]
pub(crate) mod cpu;
mod scene;
pub(crate) use scene::{GlassFrame, paint_scene};

/// Shapes one merged surface fuses (as the D3D11 renderer).
pub(crate) const MAX_SHAPES: usize = 8;

/// One `glass` paint call, in device pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct GlassCall {
    pub center: [f32; 2],
    pub half: [f32; 2],
    pub radius: f32,
    /// Straight RGBA.
    pub tint: [f32; 4],
    /// The opacity of the layers around the call (fading merged shapes shrink away).
    pub opacity: f32,
    /// Blur sigma, saturation, refraction, highlight, magnify (lengths in device pixels).
    pub params: [f32; 5],
    pub merge: u64,
    pub blend: f32,
}

impl GlassCall {
    pub(crate) fn new(
        transform: Affine,
        rect: Rect,
        radius: f64,
        tint: Color,
        glass: &GlassParams,
        opacity: f32,
    ) -> Option<Self> {
        let c = transform.as_coeffs();
        let (scale_x, scale_y) = (c[0].hypot(c[1]), c[2].hypot(c[3]));
        let scale = (scale_x * scale_y).sqrt() as f32;
        let center = transform * rect.center();
        let half = [
            (rect.width() * scale_x / 2.0) as f32,
            (rect.height() * scale_y / 2.0) as f32,
        ];
        if !(half[0] > 0.0 && half[1] > 0.0 && center.x.is_finite() && center.y.is_finite()) {
            return None;
        }
        Some(Self {
            center: [center.x as f32, center.y as f32],
            half,
            radius: ((radius as f32) * scale).min(half[0].min(half[1])).max(0.0),
            tint: tint.components,
            opacity: opacity.clamp(0.0, 1.0),
            params: [
                (glass.blur * scale / 2.0).clamp(0.0, 32.0).max(0.01),
                glass.saturate.clamp(0.0, 4.0),
                (glass.refraction * scale).clamp(0.0, 48.0),
                glass.highlight.clamp(0.0, 1.0),
                glass.magnify.clamp(0.0, 0.3),
            ],
            merge: glass.merge,
            blend: (glass.blend * scale).clamp(0.0, 256.0),
        })
    }

    /// Device pixels the call can change: its box, the bridge to merged neighbours, and what
    /// its lens and blur read around it.
    pub(crate) fn reach(&self) -> Rect {
        let [cx, cy] = self.center.map(f64::from);
        let [hx, hy] = self.half.map(f64::from);
        let grow = f64::from(self.extent() + self.backdrop_margin());
        Rect::new(cx - hx, cy - hy, cx + hx, cy + hy).inflate(grow, grow)
    }

    fn extent(&self) -> f32 {
        1.0 + if self.merge == 0 { 0.0 } else { self.blend }
    }

    fn backdrop_margin(&self) -> f32 {
        self.params[2].ceil() + (self.params[0] * 3.0).ceil() + 2.0
    }
}

/// One glass surface: a box, or the boxes that share a merge key.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct GlassSurface {
    /// Centre x, y, half width, half height, corner radius, opacity relative to the first.
    pub shapes: Vec<[f32; 6]>,
    pub tint: [f32; 4],
    pub params: [f32; 5],
    pub blend: f32,
    pub merged: bool,
    /// The opacity of the layers around its first box (the CPU composites it itself).
    pub opacity: f32,
    /// Device pixels the surface paints.
    pub bounds: Rect,
    /// Device pixels its backdrop is read from (on the backdrop's pixel grid).
    pub reach: Rect,
    /// Its texels in the atlas (`reach` at the plan's scale), padding excluded.
    pub slot: [u32; 4],
}

impl GlassSurface {
    /// Maps the atlas's texels onto the device pixels they shade.
    pub(crate) fn atlas_transform(&self, k: f64) -> Affine {
        Affine::translate((self.reach.x0, self.reach.y0))
            * Affine::scale(1.0 / k)
            * Affine::translate((-f64::from(self.slot[0]), -f64::from(self.slot[1])))
    }
}

/// Where a frame's glass is drawn from.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct GlassPlan {
    pub surfaces: Vec<GlassSurface>,
    /// Per call: the surface it draws (its first member), or None.
    pub first_of: Vec<Option<usize>>,
    /// Backdrop and atlas pixels per device pixel.
    pub k: f64,
    /// Device pixels of the backdrop (whole pixels, inside the frame).
    pub region: Rect,
    pub atlas: (u32, u32),
}

impl GlassPlan {
    pub(crate) fn backdrop_size(&self) -> (u32, u32) {
        (
            ((self.region.width() * self.k).ceil() as u32).max(1),
            ((self.region.height() * self.k).ceil() as u32).max(1),
        )
    }

    /// Maps the device frame onto the backdrop's pixels.
    pub(crate) fn backdrop_transform(&self) -> Affine {
        Affine::scale(self.k) * Affine::translate((-self.region.x0, -self.region.y0))
    }
}

/// Backdrop pixels per device pixel on the GPU: one per CSS px (the blur and the lens hide
/// finer detail), at least a third of the device's resolution.
pub(crate) fn gpu_scale(device_scale: f64) -> f64 {
    (1.0 / device_scale.max(0.01)).clamp(0.34, 1.0)
}

/// The CPU renderer shades a quarter as many pixels.
pub(crate) fn cpu_scale(device_scale: f64) -> f64 {
    gpu_scale(device_scale) * 0.5
}

/// Groups `calls` into surfaces and lays them out in the atlas.
pub(crate) fn plan(calls: &[GlassCall], frame: (u32, u32), k: f64) -> Option<GlassPlan> {
    let screen = Rect::new(0.0, 0.0, f64::from(frame.0), f64::from(frame.1));
    // Each surface with its merge key and its first box's opacity.
    let mut surfaces: Vec<(GlassSurface, u64, f32)> = Vec::new();
    let mut first_of = vec![None; calls.len()];
    for (index, call) in calls.iter().enumerate() {
        let shape = |opacity_base: f32| {
            [
                call.center[0],
                call.center[1],
                call.half[0],
                call.half[1],
                call.radius,
                if opacity_base > 0.0 {
                    (call.opacity / opacity_base).min(1.0)
                } else {
                    1.0
                },
            ]
        };
        let reach = call.reach();
        let bounds = reach.inflate(
            -f64::from(call.backdrop_margin()),
            -f64::from(call.backdrop_margin()),
        );
        if call.merge != 0
            && let Some((surface, _, base)) = surfaces
                .iter_mut()
                .find(|(s, key, _)| *key == call.merge && s.shapes.len() < MAX_SHAPES)
        {
            let base = *base;
            surface.shapes.push(shape(base));
            surface.bounds = surface.bounds.union(bounds);
            surface.reach = surface.reach.union(reach);
            continue;
        }
        first_of[index] = Some(surfaces.len());
        surfaces.push((
            GlassSurface {
                shapes: vec![shape(call.opacity)],
                tint: call.tint,
                params: call.params,
                blend: call.blend,
                merged: call.merge != 0,
                opacity: call.opacity,
                bounds,
                reach,
                slot: [0; 4],
            },
            call.merge,
            call.opacity,
        ));
    }
    let mut surfaces: Vec<GlassSurface> = surfaces.into_iter().map(|(s, _, _)| s).collect();
    for surface in &mut surfaces {
        surface.merged = surface.shapes.len() > 1;
    }
    let region = surfaces
        .iter()
        .map(|s| s.reach.intersect(screen))
        .filter(|r| r.area() > 0.0)
        .reduce(|a, b| a.union(b))?;
    let region = Rect::new(
        region.x0.floor(),
        region.y0.floor(),
        region.x1.ceil(),
        region.y1.ceil(),
    );
    // Shelf packing, one texel of transparent padding round every slot.
    let widest = surfaces
        .iter()
        .map(|s| (s.reach.intersect(screen).width() * k).ceil() as u32 + 2)
        .max()
        .unwrap_or(1);
    let row_width = widest.max((f64::from(frame.0) * k).ceil() as u32);
    let (mut x, mut y, mut row, mut used) = (0_u32, 0_u32, 0_u32, 0_u32);
    let mut kept = Vec::with_capacity(surfaces.len());
    let mut index_of = vec![None; surfaces.len()];
    for (index, mut surface) in surfaces.into_iter().enumerate() {
        let reach = surface.reach.intersect(screen);
        if reach.area() <= 0.0 {
            continue;
        }
        // On the backdrop's pixel grid, so CPU copies are whole pixels.
        let snap = |v: f64, origin: f64, up: bool| {
            let t = (v - origin) * k;
            origin + if up { t.ceil() } else { t.floor() } / k
        };
        surface.reach = Rect::new(
            snap(reach.x0, region.x0, false),
            snap(reach.y0, region.y0, false),
            snap(reach.x1, region.x0, true).min(region.x1),
            snap(reach.y1, region.y0, true).min(region.y1),
        );
        let w = ((surface.reach.width() * k).round() as u32).max(1);
        let h = ((surface.reach.height() * k).round() as u32).max(1);
        if x + w + 2 > row_width && x > 0 {
            y += row;
            x = 0;
            row = 0;
        }
        surface.slot = [x + 1, y + 1, x + 1 + w, y + 1 + h];
        x += w + 2;
        row = row.max(h + 2);
        used = used.max(x);
        index_of[index] = Some(kept.len());
        kept.push(surface);
    }
    if kept.is_empty() {
        return None;
    }
    let first_of = first_of
        .into_iter()
        .map(|surface| surface.and_then(|s| index_of[s]))
        .collect();
    // Rounded up, so a surface that grows a little keeps the atlas (and its textures).
    let round = |v: u32| v.max(1).next_multiple_of(64);
    Some(GlassPlan {
        surfaces: kept,
        first_of,
        k,
        region,
        atlas: (round(used), round(y + row)),
    })
}

pub(crate) fn sd_round_rect(p: [f32; 2], half: [f32; 2], radius: f32) -> f32 {
    let r = radius.min(half[0].min(half[1])).max(0.0);
    let d = [p[0].abs() - half[0] + r, p[1].abs() - half[1] + r];
    d[0].max(d[1]).min(0.0) + d[0].max(0.0).hypot(d[1].max(0.0)) - r
}

/// Distance to the surface, relative to its first shape's centre (smooth union of its shapes).
pub(crate) fn sd_glass(surface: &GlassSurface, p: [f32; 2]) -> f32 {
    let s0 = surface.shapes[0];
    let mut d = sd_round_rect(p, [s0[2], s0[3]], s0[4]);
    let k = surface.blend.max(1e-3);
    for s in &surface.shapes[1..] {
        let q = [p[0] - (s[0] - s0[0]), p[1] - (s[1] - s0[1])];
        let ds = sd_round_rect(q, [s[2], s[3]], s[4]) + (1.0 - s[5]) * (s[2].max(s[3]) + k) * 1.05;
        let h = (k - (d - ds).abs()).max(0.0) / k;
        d = d.min(ds) - h * h * k * 0.25;
    }
    d
}

/// The glass at device pixel `p` (straight RGBA): `backdrop` reads the blurred backdrop at a
/// device position. `k` is the atlas's resolution, for the coverage of a merged surface's edge
/// (a single box is clipped to its exact shape where it is drawn).
pub(crate) fn shade(
    surface: &GlassSurface,
    p: [f32; 2],
    k: f32,
    backdrop: impl Fn([f32; 2]) -> [f32; 3],
) -> [f32; 4] {
    let s0 = surface.shapes[0];
    let [_, saturate, refraction, highlight, magnify] = surface.params;
    let uv = [p[0] - s0[0], p[1] - s0[1]];
    let sd = sd_glass(surface, uv);
    let gx = sd_glass(surface, [uv[0] + 1.0, uv[1]]) - sd_glass(surface, [uv[0] - 1.0, uv[1]]);
    let gy = sd_glass(surface, [uv[0], uv[1] + 1.0]) - sd_glass(surface, [uv[0], uv[1] - 1.0]);
    let len = gx.hypot(gy).max(1e-4);
    let n = [gx / len, gy / len];
    let band = s0[4].max(10.0).min(s0[2].min(s0[3])).max(1.0);
    let t = (1.0 + sd / band).clamp(0.0, 1.0);
    let curve = 1.0 - (1.0 - t * t).max(0.0).sqrt();
    let q = [
        s0[0] + uv[0] * (1.0 - magnify),
        s0[1] + uv[1] * (1.0 - magnify),
    ];
    let bend = [n[0] * refraction * curve, n[1] * refraction * curve];
    let at = |f: f32| backdrop([q[0] + bend[0] * f, q[1] + bend[1] * f]);
    let mut c = [
        at(1.0 + 0.05 * curve)[0],
        at(1.0)[1],
        at(1.0 - 0.05 * curve)[2],
    ];
    let luma = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    let tint = surface.tint;
    for (channel, tinted) in c.iter_mut().zip(tint) {
        let saturated = luma + (*channel - luma) * saturate;
        *channel = saturated * (1.0 - tint[3]) + tinted * tint[3];
    }
    let facing = (n[0] * -0.55 + n[1] * -0.83).clamp(0.0, 1.0);
    let fresnel = curve.powf(2.5);
    let reflect = highlight * fresnel * (0.10 + 0.55 * facing * facing);
    let rim = (1.0 - (sd + 1.0).abs() / 1.25).clamp(0.0, 1.0) * highlight * (0.30 + 0.70 * facing);
    let far_face = (1.0 - (sd + 3.0).abs() / 1.5).clamp(0.0, 1.0) * highlight * 0.08;
    let u = [uv[0] / s0[2] + 0.35, uv[1] / s0[3] + 0.75];
    let sheen = (1.0 - u[0].hypot(u[1]) / 1.1).clamp(0.0, 1.0);
    let light = reflect + rim - far_face + highlight * 0.10 * sheen * sheen;
    let edge = if surface.merged { 0.5 } else { 1.5 };
    [
        (c[0] + light).clamp(0.0, 1.0),
        (c[1] + light).clamp(0.0, 1.0),
        (c[2] + light).clamp(0.0, 1.0),
        (edge - sd * k).clamp(0.0, 1.0),
    ]
}

#[cfg(test)]
mod tests;
