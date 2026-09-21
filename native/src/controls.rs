use crate::{protocol::Node, tree::color};
use vello::{
    Scene,
    kurbo::{Affine, Circle, Rect, RoundedRect, Stroke},
    peniko::Fill,
};

pub fn slider(scene: &mut Scene, node: &Node, rect: Rect, scale: f64) {
    let Some(control) = &node.control else {
        return;
    };
    let ratio = ((control.value - control.min) / (control.max - control.min)).clamp(0.0, 1.0);
    let vertical = control.orientation == "vertical";
    let inset = 8.0;
    let (track, fill, center) = if vertical {
        let y = rect.y1 - inset - (rect.height() - 2.0 * inset).max(0.0) * ratio;
        let x = rect.center().x;
        (
            Rect::new(x - 2.0, rect.y0 + inset, x + 2.0, rect.y1 - inset),
            Rect::new(x - 2.0, y, x + 2.0, rect.y1 - inset),
            (x, y),
        )
    } else {
        let x = rect.x0 + inset + (rect.width() - 2.0 * inset).max(0.0) * ratio;
        let y = rect.center().y;
        (
            Rect::new(rect.x0 + inset, y - 2.0, rect.x1 - inset, y + 2.0),
            Rect::new(rect.x0 + inset, y - 2.0, x, y + 2.0),
            (x, y),
        )
    };
    let transform = Affine::scale(scale);
    let accent = color(node.string(
        "foreground",
        if node.disabled { "#a1a1aa" } else { "#18181b" },
    ));
    scene.fill(
        Fill::NonZero,
        transform,
        color(node.string("borderColor", "#e4e4e7")),
        None,
        &RoundedRect::from_rect(track, 2.0),
    );
    scene.fill(
        Fill::NonZero,
        transform,
        accent,
        None,
        &RoundedRect::from_rect(fill, 2.0),
    );
    scene.fill(
        Fill::NonZero,
        transform,
        color(node.string("thumbColor", "#ffffff")),
        None,
        &Circle::new(center, 7.0),
    );
    scene.stroke(
        &Stroke::new(1.5),
        transform,
        accent,
        None,
        &Circle::new(center, 7.0),
    );
}
