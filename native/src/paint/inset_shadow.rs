//! Inset shadows on a Vello scene.
use super::*;
use vello::peniko::{BlendMode, Compose, Mix};

/// Floods `area` with `color` and erases the blurred `rect` out of it, along the edges only:
/// nothing shows 3.5 sigma inside, and a GPU layer costs every pixel it covers.
pub(super) fn draw(
    scene: &mut Scene,
    transform: Affine,
    area: Rect,
    rect: Rect,
    color: Color,
    radius: f64,
    std_dev: f64,
) {
    let (reach, mut band) = (std_dev * 3.5, area.to_path(0.1));
    let hole = rect.inflate(-reach, -reach).intersect(area);
    if hole.width() > 0.0 && hole.height() > 0.0 {
        band.extend(RoundedRect::from_rect(hole, (radius - reach).max(0.0)).path_elements(0.1));
    }
    scene.push_layer(Fill::EvenOdd, BlendMode::default(), 1.0, transform, &band);
    scene.fill(Fill::EvenOdd, transform, color, None, &band);
    scene.push_layer(
        Fill::EvenOdd,
        BlendMode::new(Mix::Normal, Compose::DestOut),
        1.0,
        transform,
        &band,
    );
    scene.draw_blurred_rounded_rect_in(&area, transform, rect, Color::BLACK, radius, std_dev);
    scene.pop_layer();
    scene.pop_layer();
}
