use vello::{
    Scene,
    kurbo::{Affine, BezPath, Circle, Rect, Stroke},
    peniko::Color,
};

pub fn draw(scene: &mut Scene, name: &str, rect: Rect, color: Color, width: f64, scale: f64) {
    let transform = Affine::scale(scale)
        * Affine::translate((rect.x0, rect.y0))
        * Affine::scale_non_uniform(rect.width() / 16.0, rect.height() / 16.0);
    let stroke = Stroke::new(width);
    let mut path = BezPath::new();
    let lines: &[&[(f64, f64)]] = match name {
        "check" => &[&[(3.0, 8.0), (6.5, 11.5), (13.0, 4.5)]],
        "x" => &[&[(4.0, 4.0), (12.0, 12.0)], &[(12.0, 4.0), (4.0, 12.0)]],
        "plus" => &[&[(3.0, 8.0), (13.0, 8.0)], &[(8.0, 3.0), (8.0, 13.0)]],
        "minus" => &[&[(3.0, 8.0), (13.0, 8.0)]],
        "chevron-down" => &[&[(4.0, 6.0), (8.0, 10.0), (12.0, 6.0)]],
        "chevron-up" => &[&[(4.0, 10.0), (8.0, 6.0), (12.0, 10.0)]],
        "chevron-right" => &[&[(6.0, 4.0), (10.0, 8.0), (6.0, 12.0)]],
        "chevron-left" => &[&[(10.0, 4.0), (6.0, 8.0), (10.0, 12.0)]],
        "search" => {
            scene.stroke(
                &stroke,
                transform,
                color,
                None,
                &Circle::new((7.0, 7.0), 4.5),
            );
            &[&[(10.5, 10.5), (14.0, 14.0)]]
        }
        "info" => {
            scene.stroke(
                &stroke,
                transform,
                color,
                None,
                &Circle::new((8.0, 8.0), 6.0),
            );
            &[&[(8.0, 7.0), (8.0, 11.5)], &[(8.0, 4.0), (8.0, 5.0)]]
        }
        _ => &[],
    };
    for points in lines {
        path.move_to(points[0]);
        for point in &points[1..] {
            path.line_to(*point);
        }
    }
    scene.stroke(&stroke, transform, color, None, &path);
}
