//! The CPU renderer's pixels flattened over the window background and packed for its surface.

pub(super) fn flatten_rgba_bytes(pixels: &mut [u8], background: vello::peniko::Color) {
    let background = background.to_rgba8();
    for pixel in pixels.as_chunks_mut::<4>().0 {
        let alpha = u16::from(pixel[3]);
        let inverse = 255_u16.saturating_sub(alpha);
        pixel[0] =
            (u16::from(pixel[0]) + (u16::from(background.r) * inverse + 127) / 255).min(255) as u8;
        pixel[1] =
            (u16::from(pixel[1]) + (u16::from(background.g) * inverse + 127) / 255).min(255) as u8;
        pixel[2] =
            (u16::from(pixel[2]) + (u16::from(background.b) * inverse + 127) / 255).min(255) as u8;
        pixel[3] = 255;
    }
}

pub(super) fn flatten_rgba_for_softbuffer(pixels: &mut [u32], background: vello::peniko::Color) {
    let background = background.to_rgba8();
    // Android's window buffer takes R, G, B, X in memory order (android/cpu_surface.rs); the
    // other softbuffer backends take 0RGB words.
    let pack = |r: u32, g: u32, b: u32| {
        if cfg!(target_os = "android") {
            r | (g << 8) | (b << 16) | (255 << 24)
        } else {
            b | (g << 8) | (r << 16)
        }
    };
    let under = pack(
        u32::from(background.r),
        u32::from(background.g),
        u32::from(background.b),
    );
    for pixel in pixels {
        let [r, g, b, a] = pixel.to_ne_bytes();
        // Most of a UI is opaque or bare background: no blending for those.
        *pixel = match a {
            255 if cfg!(target_os = "android") => continue,
            255 => pack(u32::from(r), u32::from(g), u32::from(b)),
            0 if (r, g, b) == (0, 0, 0) => under,
            _ => {
                let inverse = 255_u16 - u16::from(a);
                let over = |channel: u8, under: u8| {
                    (u16::from(channel) + (u16::from(under) * inverse + 127) / 255).min(255) as u32
                };
                pack(
                    over(r, background.r),
                    over(g, background.g),
                    over(b, background.b),
                )
            }
        };
    }
}

/// Premultiplied ARGB for a window that composes alpha: the frame's premultiplied
/// pixels over the (possibly translucent) background.
pub(super) fn pack_premultiplied_for_softbuffer(
    pixels: &mut [u32],
    background: vello::peniko::Color,
) {
    let background = background.to_rgba8();
    let premultiply = |channel: u8| (u16::from(channel) * u16::from(background.a) + 127) / 255;
    let under = [
        premultiply(background.r),
        premultiply(background.g),
        premultiply(background.b),
        u16::from(background.a),
    ];
    for pixel in pixels {
        let [r, g, b, a] = pixel.to_ne_bytes();
        let inverse = 255_u16.saturating_sub(u16::from(a));
        let over = |channel: u8, under: u16| {
            (u16::from(channel) + (under * inverse + 127) / 255).min(255) as u32
        };
        let (first, third) = if cfg!(target_os = "android") {
            (over(r, under[0]), over(b, under[2]))
        } else {
            (over(b, under[2]), over(r, under[0]))
        };
        *pixel = first | (over(g, under[1]) << 8) | (third << 16) | (over(a, under[3]) << 24);
    }
}

/// Android's window buffer takes the rasterizer's R, G, B, A bytes as they are: drawn over the
/// opaque background, a frame needs no pass to flatten and reorder it. Paints that background
/// and returns true where it applies.
pub(super) fn fill_opaque_background(
    context: &mut vello_cpu::RenderContext,
    alpha: bool,
    color: vello::peniko::Color,
    width: usize,
    height: usize,
) -> bool {
    let opaque = cfg!(target_os = "android") && !alpha;
    if opaque {
        context.set_paint(color.with_alpha(1.0));
        context.fill_rect(&vello::kurbo::Rect::new(
            0.0,
            0.0,
            width as f64,
            height as f64,
        ));
    }
    opaque
}
