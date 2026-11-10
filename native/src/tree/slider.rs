//! Slider paint: track, filled part and thumb, each a colour or a gradient, sized by
//! the slider's style (CSS `::-webkit-slider-runnable-track` / `::-webkit-slider-thumb`).
use super::*;
use crate::controls::{
    DEFAULT_THUMB_SIZE, DEFAULT_TRACK_INSET, DEFAULT_TRACK_THICKNESS, SliderGeometry, SliderMetrics,
};
use vello::kurbo::{Circle, Point, Shape};

const DEFAULT_THUMB_BORDER_WIDTH: f64 = 1.5;

fn length(node: &Node, key: &str, state: VisualState) -> Option<f64> {
    visual_value(node, key, state)
        .as_f64()
        .filter(|value| value.is_finite())
        .map(|value| value.max(0.0))
}

/// Track and thumb sizes for `state`: `trackThickness` (px or `"fill"`), `trackInset`,
/// `thumbSize`, `thumbWidth`, `thumbHeight`.
pub(super) fn slider_metrics(node: &Node, state: VisualState) -> SliderMetrics {
    let fill = visual_value(node, "trackThickness", state).as_str() == Some("fill");
    let size = length(node, "thumbSize", state).unwrap_or(DEFAULT_THUMB_SIZE);
    SliderMetrics {
        thickness: (!fill)
            .then(|| length(node, "trackThickness", state).unwrap_or(DEFAULT_TRACK_THICKNESS)),
        inset: length(node, "trackInset", state).unwrap_or(if fill {
            0.0
        } else {
            DEFAULT_TRACK_INSET
        }),
        thumb: (
            length(node, "thumbWidth", state).unwrap_or(size),
            length(node, "thumbHeight", state).unwrap_or(size),
        ),
    }
}

pub(super) fn slider_ratio(control: &crate::protocol::Control) -> f64 {
    let span = control.max - control.min;
    if span > 0.0 {
        ((control.value - control.min) / span).clamp(0.0, 1.0)
    } else {
        0.0
    }
}

pub(super) fn slider_geometry(
    node: &Node,
    rect: BoxRect,
    state: VisualState,
) -> Option<SliderGeometry> {
    let control = node.control.as_ref()?;
    Some(SliderGeometry::new(
        rect,
        control.orientation == "vertical",
        slider_ratio(control),
        &slider_metrics(node, state),
    ))
}

/// How far past its box a slider paints: a thumb taller than the box, its border and
/// shadows, in any state.
pub(super) fn slider_overflow(node: &Node, rect: BoxRect) -> f64 {
    let states = [
        VisualState {
            disabled: node.disabled,
            ..VisualState::default()
        },
        VisualState {
            hovered: true,
            ..VisualState::default()
        },
        VisualState {
            active: true,
            ..VisualState::default()
        },
        VisualState {
            focused: true,
            focus_visible: true,
            ..VisualState::default()
        },
    ];
    states
        .into_iter()
        .filter_map(|state| {
            let geometry = slider_geometry(node, rect, state)?;
            let thumb = geometry.thumb;
            let border =
                length(node, "thumbBorderWidth", state).unwrap_or(DEFAULT_THUMB_BORDER_WIDTH) / 2.0;
            let past = (rect.x0 - thumb.x0)
                .max(thumb.x1 - rect.x1)
                .max(rect.y0 - thumb.y0)
                .max(thumb.y1 - rect.y1)
                .max(0.0)
                + border;
            let shadow = box_shadows_of(node, "thumbShadow", state)
                .iter()
                .filter(|shadow| !shadow.inset)
                .map(|shadow| {
                    shadow.x.abs().max(shadow.y.abs())
                        + shadow.spread.max(0.0)
                        + shadow.blur * 1.5
                        + 1.0
                })
                .fold(0.0, f64::max);
            Some(past + shadow)
        })
        .fold(0.0, f64::max)
}

fn fill_paint<P: PaintTarget, S: Shape>(
    target: &mut P,
    transform: Affine,
    vector: &[f32],
    area: BoxRect,
    shape: &S,
) {
    if let Some(gradient) = paint_gradient(vector, area) {
        target.fill_gradient(transform, &gradient, shape);
    } else {
        let colour = colour_from(vector);
        if colour.components[3] > 0.0 {
            target.fill(Fill::NonZero, transform, colour, shape);
        }
    }
}

fn clamp_radii(radii: [f64; 4], rect: BoxRect) -> (f64, f64, f64, f64) {
    let most = (rect.width().min(rect.height()) / 2.0).max(0.0);
    let [a, b, c, d] = radii.map(|radius| radius.clamp(0.0, most));
    (a, b, c, d)
}

/// Paints the slider. `foreground` fills from the start to the thumb, `trackBackground`
/// (else `borderColor`) is the track, both laid over the whole track so a gradient stays
/// put as the value moves; `thumbColor`, `thumbBorderColor` (else the fill) and
/// `thumbShadow` dress the thumb.
#[allow(clippy::too_many_arguments)]
pub(super) fn paint_slider<P: PaintTarget>(
    target: &mut P,
    node: &Node,
    rect: BoxRect,
    transform: Affine,
    state: VisualState,
    animated: &HashMap<String, Vec<f32>>,
    box_radii: [f64; 4],
) {
    let Some(geometry) = slider_geometry(node, rect, state) else {
        return;
    };
    let metrics = slider_metrics(node, state);
    let fill_vector = animated.get("foreground").cloned().unwrap_or_else(|| {
        paint_vector(
            visual_value(node, "foreground", state),
            if node.disabled { "#a1a1aa" } else { "#18181b" },
        )
    });
    let track_value = visual_value(node, "trackBackground", state);
    let track_vector = if track_value.is_null() {
        animated
            .get("borderColor")
            .cloned()
            .unwrap_or_else(|| paint_vector(visual_value(node, "borderColor", state), "#e4e4e7"))
    } else {
        background_vector(track_value)
    };
    let track = geometry.track;
    let radii = corner_radii(visual_value(node, "trackRadius", state))
        .map(|radii| radii.map(f64::from))
        .unwrap_or_else(|| {
            if metrics.thickness.is_none() {
                box_radii
            } else {
                [track.width().min(track.height()) / 2.0; 4]
            }
        });
    let radii = clamp_radii(radii, track);
    let track_shape = RoundedRect::from_rect(track, radii);
    if track.width() > 0.0 && track.height() > 0.0 {
        fill_paint(target, transform, &track_vector, track, &track_shape);
    }
    let fill = geometry.fill;
    let (extent, start_radius, end_radius, gap) = if geometry.vertical {
        (
            fill.height(),
            radii.2.max(radii.3),
            radii.0.max(radii.1),
            fill.y0 - track.y0,
        )
    } else {
        (
            fill.width(),
            radii.0.max(radii.3),
            radii.1.max(radii.2),
            track.x1 - fill.x1,
        )
    };
    if extent > 0.0 && fill.width() > 0.0 && fill.height() > 0.0 {
        // A rounded rect caps each corner at half its shorter side, so a fill shorter than
        // two end radii would get smaller corners than the track: clip it instead.
        if extent >= 2.0 * start_radius && gap >= end_radius {
            // Rounded where the track is, square where it ends at the thumb.
            let corners = if geometry.vertical {
                (0.0, 0.0, radii.2, radii.3)
            } else {
                (radii.0, 0.0, 0.0, radii.3)
            };
            let shape = RoundedRect::from_rect(
                fill,
                clamp_radii([corners.0, corners.1, corners.2, corners.3], fill),
            );
            fill_paint(target, transform, &fill_vector, track, &shape);
        } else {
            // Shorter than a rounded end, or into the far one: the track's shape cuts it.
            target.push_clip(Fill::NonZero, transform, &track_shape);
            fill_paint(target, transform, &fill_vector, track, &fill);
            target.pop_layer();
        }
    }
    if !metrics.thumb_visible() {
        return;
    }
    let thumb = geometry.thumb;
    let (width, height) = metrics.thumb;
    let most = width.min(height) / 2.0;
    let radius = length(node, "thumbRadius", state).map_or(most, |radius| radius.min(most));
    let thumb_shape = RoundedRect::from_rect(thumb, radius);
    let circle = (width - height).abs() < 1e-9 && radius >= most - 1e-9;
    let shadows = box_shadows_of(node, "thumbShadow", state);
    for shadow in shadows.iter().rev().filter(|shadow| !shadow.inset) {
        paint_outer_shadow(target, transform, thumb, radius, thumb_shape, shadow);
    }
    let thumb_vector = paint_vector(visual_value(node, "thumbColor", state), "#ffffff");
    if circle {
        fill_paint(
            target,
            transform,
            &thumb_vector,
            thumb,
            &Circle::new(geometry.center, most),
        );
    } else {
        fill_paint(target, transform, &thumb_vector, thumb, &thumb_shape);
    }
    if shadows.iter().any(|shadow| shadow.inset) {
        target.push_clip(Fill::NonZero, transform, &thumb_shape);
        for shadow in shadows.iter().rev().filter(|shadow| shadow.inset) {
            paint_inset_shadow(target, transform, thumb, radius, shadow);
        }
        target.pop_layer();
    }
    let border = length(node, "thumbBorderWidth", state).unwrap_or(DEFAULT_THUMB_BORDER_WIDTH);
    if border <= 0.0 {
        return;
    }
    let border_value = visual_value(node, "thumbBorderColor", state);
    let (vector, area) = if border_value.is_null() {
        (fill_vector, track)
    } else {
        (background_vector(border_value), thumb)
    };
    let half = border / 2.0;
    if let Some(gradient) = paint_gradient(&vector, area) {
        // A centred stroke as the ring between the thumb grown and shrunk by half the width.
        let outer = thumb.inflate(half, half);
        let mut ring = RoundedRect::from_rect(outer, radius + half).to_path(0.1);
        let inner = thumb.inflate(-half, -half);
        if inner.width() > 0.0 && inner.height() > 0.0 {
            ring.extend(RoundedRect::from_rect(inner, (radius - half).max(0.0)).path_elements(0.1));
        }
        target.push_clip(Fill::EvenOdd, transform, &ring);
        target.fill_gradient(transform, &gradient, &outer);
        target.pop_layer();
    } else {
        let colour = colour_from(&vector);
        if colour.components[3] <= 0.0 {
            return;
        }
        if circle {
            target.stroke(
                &Stroke::new(border),
                transform,
                colour,
                &Circle::new(geometry.center, most),
            );
        } else {
            target.stroke(&Stroke::new(border), transform, colour, &thumb_shape);
        }
    }
}

impl Tree {
    /// The value a pointer at the current mouse position sets on slider `id`.
    pub(super) fn slider_ratio_at_pointer(&self, id: &str, rect: BoxRect) -> Option<f64> {
        let node = &self.entries.get(id)?.node;
        let state = self.visual_state_for(id, node);
        let geometry = slider_geometry(node, rect, state)?;
        Some(geometry.ratio_at(Point::new(self.mouse.0, self.mouse.1)))
    }
}
