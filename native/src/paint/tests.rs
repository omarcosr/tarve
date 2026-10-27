use super::*;
use crate::{
    protocol::Node,
    text::{TextDrawArea, TextEngine},
};
use vello::kurbo::{Affine, Rect};

#[test]
fn cpu_target_rasterizes_shared_paint_commands() {
    let mut context = RenderContext::new(16, 16);
    let mut resources = Resources::new();
    let mut images = HashMap::new();
    {
        let mut target = CpuPaintTarget::new(&mut context, &mut resources, &mut images);
        target.fill(
            Fill::NonZero,
            Affine::IDENTITY,
            Color::from_rgb8(255, 0, 0),
            &Rect::new(2.0, 2.0, 14.0, 14.0),
        );
    }
    context.flush();
    let mut pixmap = Pixmap::new(16, 16);
    context.render(&mut pixmap, &mut resources);

    let center = pixmap.data()[8 * 16 + 8];
    assert_eq!(center.to_u8_array(), [255, 0, 0, 255]);
    assert_eq!(pixmap.data()[0].to_u8_array(), [0, 0, 0, 0]);
}

/// Renders `gradient` over a 64×64 box on the CPU and returns the worst
/// channel difference from `PaintGradient::sample`, skipping pixels next
/// to hard stops and the centre (where the colour is undefined).
fn conic_cpu_error(gradient: &PaintGradient) -> u8 {
    let mut context = RenderContext::new(64, 64);
    let mut resources = Resources::new();
    let mut images = HashMap::new();
    {
        let mut target = CpuPaintTarget::new(&mut context, &mut resources, &mut images);
        target.fill_gradient(Affine::IDENTITY, gradient, &Rect::new(0.0, 0.0, 64.0, 64.0));
        target.finish();
    }
    context.flush();
    let mut pixmap = Pixmap::new(64, 64);
    context.render(&mut pixmap, &mut resources);
    let GradientGeometry::Conic { center, .. } = gradient.geometry else {
        unreachable!()
    };
    let mut worst = 0;
    for y in 0..64 {
        for x in 0..64 {
            let point = Point::new(x as f64 + 0.5, y as f64 + 0.5);
            if (point - center).hypot() < 6.0 {
                continue;
            }
            let around = [(-1.5, 0.0), (1.5, 0.0), (0.0, -1.5), (0.0, 1.5)].map(|(dx, dy)| {
                gradient
                    .sample(Point::new(point.x + dx, point.y + dy))
                    .to_rgba8()
            });
            let expected = gradient.sample(point).to_rgba8();
            let steep = around.iter().any(|near| {
                [
                    near.r.abs_diff(expected.r),
                    near.g.abs_diff(expected.g),
                    near.b.abs_diff(expected.b),
                ]
                .into_iter()
                .max()
                .unwrap()
                    > 24
            });
            if steep {
                continue;
            }
            let actual = pixmap.data()[y * 64 + x].to_u8_array();
            let error = [expected.r, expected.g, expected.b]
                .iter()
                .zip(actual)
                .map(|(e, a)| e.abs_diff(a))
                .max()
                .unwrap();
            worst = worst.max(error);
        }
    }
    worst
}

#[test]
fn conic_gradients_rasterize_like_their_css_sample() {
    let red = Color::from_rgb8(255, 0, 0);
    let blue = Color::from_rgb8(0, 0, 255);
    let green = Color::from_rgb8(0, 160, 0);
    let plain = PaintGradient {
        geometry: GradientGeometry::Conic {
            center: Point::new(20.0, 36.0),
            from: 30f64.to_radians(),
            start: 0.0,
            end: 1.0,
        },
        stops: vec![(0.0, red), (0.5, blue), (0.5, green), (1.0, red)],
        repeat: false,
    };
    // CSS: 0 points up and turns clockwise, so straight right of the
    // centre is 90° - 30° = a sixth of a turn into the red→blue ramp.
    let right = plain.sample(Point::new(60.0, 36.0)).to_rgba8();
    assert!(right.r > right.b && right.b > 60, "{right:?}");
    assert!(conic_cpu_error(&plain) <= 6, "{}", conic_cpu_error(&plain));
    let repeating = PaintGradient {
        geometry: GradientGeometry::Conic {
            center: Point::new(32.0, 32.0),
            from: 0.0,
            start: 0.0,
            end: 0.25,
        },
        stops: vec![(0.0, red), (1.0, blue)],
        repeat: true,
    };
    assert!(
        conic_cpu_error(&repeating) <= 6,
        "{}",
        conic_cpu_error(&repeating)
    );
}

#[test]
fn cpu_image_cache_replaces_changed_pixels_and_evicts_unused_keys() {
    let image = |rgba: [u8; 4]| ImageData {
        data: Blob::new(Arc::new(rgba.repeat(4))),
        format: ImageFormat::Rgba8,
        alpha_type: ImageAlphaType::Alpha,
        width: 2,
        height: 2,
    };
    let first = image([255, 0, 0, 255]);
    let second = image([0, 255, 0, 255]);
    let unused = image([0, 0, 255, 255]);
    let mut context = RenderContext::new(8, 8);
    let mut resources = Resources::new();
    let mut images = HashMap::new();

    {
        let mut target = CpuPaintTarget::new(&mut context, &mut resources, &mut images);
        target.draw_image("same", &first, Affine::IDENTITY);
        target.draw_image("unused", &unused, Affine::IDENTITY);
        target.finish();
    }
    assert_eq!(images.len(), 2);
    let first_id = images["same"].data.id();

    {
        let mut target = CpuPaintTarget::new(&mut context, &mut resources, &mut images);
        target.draw_image("same", &second, Affine::IDENTITY);
        target.finish();
    }
    assert_eq!(images.len(), 1);
    assert_eq!(images["same"].data.id(), second.data.id());
    assert_ne!(images["same"].data.id(), first_id);
    assert!(!images.contains_key("unused"));
}

#[test]
fn cpu_target_rasterizes_default_ui_digits_at_stats_weights() {
    for weight in [400.0, 500.0, 650.0] {
        let node: Node = serde_json::from_value(serde_json::json!({
            "id": format!("digits-{weight}"),
            "kind": "text",
            "text": "0123456789",
            "style": {
                "fontFamily": "system-ui",
                "fontSize": 27,
                "fontWeight": weight,
                "lineHeight": 1.5
            }
        }))
        .unwrap();
        let mut text = TextEngine::new();
        text.prepare(&node);

        let mut context = RenderContext::new(256, 64);
        let mut resources = Resources::new();
        let mut images = HashMap::new();
        {
            let mut target = CpuPaintTarget::new(&mut context, &mut resources, &mut images);
            text.draw(
                &mut target,
                &node,
                TextDrawArea {
                    origin: (2.0, 2.0),
                    width: 252.0,
                    visible_y: (0.0, 64.0),
                    scroll_x: 0.0,
                },
                Color::from_rgb8(20, 20, 20),
                1.0,
            );
            target.finish();
        }
        context.flush();
        let mut pixmap = Pixmap::new(256, 64);
        context.render(&mut pixmap, &mut resources);
        let painted = pixmap
            .data()
            .iter()
            .filter(|pixel| pixel.to_u8_array()[3] != 0)
            .count();
        assert!(
            painted > 100,
            "default UI digits must rasterize through the CPU renderer at weight {weight}; got {painted} painted pixels"
        );
    }
}
