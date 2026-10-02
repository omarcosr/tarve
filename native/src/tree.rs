use crate::{
    paint::{GradientGeometry, PaintGradient, PaintTarget},
    protocol::{ImageSource, Node, TreeMutation},
    rich::{self, DiffRow, DiffRowKind, RichContent},
    text::{
        AccessibilityTextLine, DiffPaintArea, DiffPaintDecorations, TEXT_KEYS, TextEngine,
        TextPaintHighlight,
    },
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
#[cfg(feature = "fxhash")]
use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};
use serde_json::{Value, json};
#[cfg(not(feature = "fxhash"))]
use std::collections::{HashMap, HashSet};
use std::{
    collections::VecDeque,
    fs,
    io::Cursor,
    ops::Range,
    path::{Path, PathBuf},
    sync::Arc,
};
use taffy::prelude::*;
use unicode_segmentation::UnicodeSegmentation;
use vello::{
    Scene,
    kurbo::{Affine, Cap, Rect as BoxRect, RoundedRect, Stroke, Vec2},
    peniko::{Blob, Color, Fill, ImageAlphaType, ImageData, ImageFormat},
};

/// Frame-time samples kept by the native debug overlay.
pub const FRAME_OVERLAY_SAMPLES: usize = 120;
/// Graph ceiling: two 60 Hz frame budgets.
const FRAME_OVERLAY_CEILING_MS: f64 = 1000.0 / 30.0;
const FRAME_OVERLAY_BUDGET_MS: f64 = 1000.0 / 60.0;

const LAYOUT_KEYS: &[&str] = &[
    "width",
    "height",
    "minWidth",
    "minHeight",
    "maxWidth",
    "maxHeight",
    "flex",
    "shrink",
    "aspectRatio",
    "direction",
    "wrap",
    "gap",
    "padding",
    "margin",
    "align",
    "justify",
    "display",
    "columns",
    "borderWidth",
    "position",
    "top",
    "right",
    "bottom",
    "left",
];
const MOTION_PROPERTIES: &[&str] = &[
    "width",
    "height",
    "top",
    "right",
    "bottom",
    "left",
    "opacity",
    "radius",
    "background",
    "foreground",
    "borderColor",
    "boxShadow",
    "textShadow",
    "transform",
];
/// Paint-only properties that can also transition when hover/active/focus/
/// disabled changes. Layout properties only animate on JS updates.
const STATE_MOTION_PROPERTIES: &[&str] = &[
    "transform",
    "opacity",
    "radius",
    "background",
    "foreground",
    "borderColor",
    "boxShadow",
    "textShadow",
];
/// Numbers per shadow layer in a motion vector.
const BOX_SHADOW_STRIDE: usize = 9;
const TEXT_SHADOW_STRIDE: usize = 7;
const MOTION_FRAME_MS: f64 = 1000.0 / 60.0;

#[derive(Clone, Copy, Debug)]
enum MotionEasing {
    Linear,
    Ease,
    EaseIn,
    EaseOut,
    EaseInOut,
}

#[derive(Clone, Debug)]
struct MotionTrack {
    /// Scalars hold one value; colours hold rgba; shadows hold one fixed-size
    /// chunk per layer (see the *_STRIDE constants).
    from: Vec<f32>,
    to: Vec<f32>,
    current: Vec<f32>,
    start_ms: f64,
    duration_ms: f64,
    easing: MotionEasing,
    /// Started by a hover/active/focus/disabled change rather than a JS update.
    state_driven: bool,
}

impl MotionTrack {
    fn new(
        property: &str,
        from: Vec<f32>,
        to: Vec<f32>,
        now_ms: f64,
        (duration_ms, delay_ms, easing): (f64, f64, MotionEasing),
        state_driven: bool,
    ) -> Option<Self> {
        let (from, to) = pad_motion_layers(property, from, to);
        if (matches!(property, "background" | "foreground" | "borderColor")
            && !gradient_shapes_match(&from, &to))
            || from.len() != to.len()
            || from
                .iter()
                .zip(&to)
                .all(|(a, b)| (a - b).abs() <= f32::EPSILON)
        {
            return None;
        }
        Some(Self {
            current: from.clone(),
            from,
            to,
            start_ms: now_ms + delay_ms,
            duration_ms,
            easing,
            state_driven,
        })
    }

    fn value_at(&self, now_ms: f64) -> (Vec<f32>, bool) {
        if now_ms <= self.start_ms {
            return (self.from.clone(), false);
        }
        let progress = ((now_ms - self.start_ms) / self.duration_ms).clamp(0.0, 1.0);
        let eased = match self.easing {
            MotionEasing::Linear => progress,
            MotionEasing::Ease => progress * progress * (3.0 - 2.0 * progress),
            MotionEasing::EaseIn => progress * progress * progress,
            MotionEasing::EaseOut => 1.0 - (1.0 - progress).powi(3),
            MotionEasing::EaseInOut => {
                if progress < 0.5 {
                    4.0 * progress * progress * progress
                } else {
                    1.0 - (-2.0 * progress + 2.0).powi(3) / 2.0
                }
            }
        };
        let value = self
            .from
            .iter()
            .zip(&self.to)
            .map(|(from, to)| (*from as f64 + (*to - *from) as f64 * eased) as f32)
            .collect();
        (value, progress >= 1.0)
    }

    fn end_ms(&self) -> f64 {
        self.start_ms + self.duration_ms
    }
}

fn motion_transition(node: &Node, property: &str) -> Option<(f64, f64, MotionEasing)> {
    let transitions = node.style.get("transition")?.as_object()?;
    let config = transitions
        .get(property)
        .or_else(|| transitions.get("all"))?
        .as_object()?;
    let duration = config
        .get("duration")
        .and_then(Value::as_f64)
        .unwrap_or(200.0);
    let delay = config.get("delay").and_then(Value::as_f64).unwrap_or(0.0);
    if !duration.is_finite() || duration <= 0.0 || !delay.is_finite() || delay < 0.0 {
        return None;
    }
    let easing = match config
        .get("easing")
        .and_then(Value::as_str)
        .unwrap_or("ease")
    {
        "linear" => MotionEasing::Linear,
        "easeIn" => MotionEasing::EaseIn,
        "easeOut" => MotionEasing::EaseOut,
        "easeInOut" => MotionEasing::EaseInOut,
        _ => MotionEasing::Ease,
    };
    Some((duration, delay, easing))
}

fn rgba_of(colour: Color) -> [f32; 4] {
    colour.components
}

fn colour_from(values: &[f32]) -> Color {
    let channel = |index: usize| values.get(index).copied().unwrap_or(0.0).clamp(0.0, 1.0);
    Color::new([channel(0), channel(1), channel(2), channel(3)])
}

const GRADIENT_HEADER: usize = 12;
const GRADIENT_STOP: usize = 6;

/// A CSS length as (value, unit): unit 1 is px; unit 0 is a fraction
/// (`"N%"`). Plain numbers are px.
fn gradient_length(value: &Value) -> Option<(f32, f32)> {
    if let Some(number) = value.as_f64() {
        return Some((number as f32, 1.0));
    }
    let text = value.as_str()?.trim();
    if let Some(px) = text.strip_suffix("px") {
        return px.trim().parse::<f32>().ok().map(|px| (px, 1.0));
    }
    text.strip_suffix('%')?
        .trim()
        .parse::<f32>()
        .ok()
        .map(|percent| (percent / 100.0, 0.0))
}

/// A radial centre coordinate as (value, unit): unit 0 is a fraction of the
/// box, 1 is px from the left/top edge, 2 is px from the right/bottom edge.
fn gradient_centre(at: Option<&Value>, key: &str, end_edge: &str) -> (f32, f32) {
    let value = at.and_then(|at| at.get(key));
    let from_end = at
        .and_then(|at| at.get(format!("{key}Edge")))
        .and_then(Value::as_str)
        == Some(end_edge);
    match value {
        Some(Value::Number(number)) => (number.as_f64().unwrap_or(0.5) as f32, 0.0),
        Some(other) => match gradient_length(other) {
            Some((px, unit)) if unit > 0.5 => (px, if from_end { 2.0 } else { 1.0 }),
            Some((fraction, _)) if from_end => (1.0 - fraction, 0.0),
            Some((fraction, _)) => (fraction, 0.0),
            None => (0.5, 0.0),
        },
        None => (0.5, 0.0),
    }
}

/// Motion vector for a background: rgba for a colour, or a gradient as
/// `[kind, a, b, c, repeat, size, sx, sx unit, sy, sy unit, b unit, c unit]`
/// (b/c units: see `gradient_centre`) followed by
/// `(offset, unit, r, g, b, a)` per stop. Kind 1 is linear (a = angle in
/// degrees, b/c = corner); kind 2 is radial (a = circle flag, b/c = centre
/// as fractions; size 0 farthest-corner, 1 closest-side, 2 farthest-side,
/// 3 closest-corner, 4 explicit sx/sy); kind 3 is conic (a = `from` in
/// degrees, b/c = centre). Stop units: 0 fraction, 1 px, 2 auto.
fn background_vector(value: &Value) -> Vec<f32> {
    if let Some(text) = value.as_str() {
        return rgba_of(color(text)).to_vec();
    }
    let Some(object) = value.as_object() else {
        return vec![0.0; 4];
    };
    let stops: Vec<f32> = object
        .get("stops")
        .and_then(Value::as_array)
        .map(|stops| {
            stops
                .iter()
                .flat_map(|stop| {
                    let offset = stop.get("offset").filter(|offset| !offset.is_null());
                    let (offset, unit) = match offset {
                        None => (0.0, 2.0),
                        Some(Value::Number(number)) => (number.as_f64().unwrap_or(0.0) as f32, 0.0),
                        Some(other) => gradient_length(other).unwrap_or((0.0, 2.0)),
                    };
                    let [r, g, b, a] = rgba_of(color(
                        stop.get("color")
                            .and_then(Value::as_str)
                            .unwrap_or("#00000000"),
                    ));
                    [offset, unit, r, g, b, a]
                })
                .collect()
        })
        .unwrap_or_default();
    if stops.is_empty() {
        return vec![0.0; 4];
    }
    let repeat = if object.get("repeating").and_then(Value::as_bool) == Some(true) {
        1.0
    } else {
        0.0
    };
    let kind = object.get("type").and_then(Value::as_str);
    let header: [f32; GRADIENT_HEADER] = if kind == Some("conic") {
        let at = object.get("at");
        let (centre_x, centre_y) = (
            gradient_centre(at, "x", "right"),
            gradient_centre(at, "y", "bottom"),
        );
        let from = object.get("from").and_then(Value::as_f64).unwrap_or(0.0) as f32;
        [
            3.0, from, centre_x.0, centre_y.0, repeat, 0.0, 0.0, 0.0, 0.0, 0.0, centre_x.1,
            centre_y.1,
        ]
    } else if kind == Some("radial") {
        let at = object.get("at");
        let (centre_x, centre_y) = (
            gradient_centre(at, "x", "right"),
            gradient_centre(at, "y", "bottom"),
        );
        let circle = object.get("shape").and_then(Value::as_str) == Some("circle");
        let size = object.get("size").unwrap_or(&Value::Null);
        let (code, x, y) = match size {
            Value::String(keyword) if !keyword.ends_with("px") && !keyword.ends_with('%') => (
                match keyword.as_str() {
                    "closest-side" => 1.0,
                    "farthest-side" => 2.0,
                    "closest-corner" => 3.0,
                    _ => 0.0,
                },
                (0.0, 0.0),
                (0.0, 0.0),
            ),
            Value::Array(pair) => match (
                pair.first().and_then(gradient_length),
                pair.get(1).and_then(gradient_length),
            ) {
                (Some(x), Some(y)) => (4.0, x, y),
                _ => (0.0, (0.0, 0.0), (0.0, 0.0)),
            },
            other => match gradient_length(other) {
                Some(length) => (4.0, length, length),
                None => (0.0, (0.0, 0.0), (0.0, 0.0)),
            },
        };
        [
            2.0,
            if circle { 1.0 } else { 0.0 },
            centre_x.0,
            centre_y.0,
            repeat,
            code,
            x.0,
            x.1,
            y.0,
            y.1,
            centre_x.1,
            centre_y.1,
        ]
    } else {
        let to = object.get("to").and_then(Value::as_str).unwrap_or("");
        let has = |word: &str| to.split_whitespace().any(|part| part == word);
        let x: f32 = if has("right") {
            1.0
        } else if has("left") {
            -1.0
        } else {
            0.0
        };
        let y: f32 = if has("bottom") {
            1.0
        } else if has("top") {
            -1.0
        } else {
            0.0
        };
        let (angle, corner_x, corner_y) = if x != 0.0 && y != 0.0 {
            (0.0, x, y)
        } else if to.is_empty() {
            (
                object.get("angle").and_then(Value::as_f64).unwrap_or(180.0) as f32,
                0.0,
                0.0,
            )
        } else {
            (x.atan2(-y).to_degrees(), 0.0, 0.0)
        };
        [
            1.0, angle, corner_x, corner_y, repeat, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
        ]
    };
    header.into_iter().chain(stops).collect()
}

/// A colour-or-gradient style value as a motion vector (see
/// `background_vector`); missing values use `fallback`.
fn paint_vector(value: &Value, fallback: &str) -> Vec<f32> {
    if value.is_null() {
        rgba_of(color(fallback)).to_vec()
    } else {
        background_vector(value)
    }
}

/// The solid colour of a paint vector: itself, or a gradient's first stop.
fn vector_colour(values: &[f32]) -> Color {
    if values.len() >= GRADIENT_HEADER + GRADIENT_STOP {
        colour_from(&values[GRADIENT_HEADER + 2..GRADIENT_HEADER + 6])
    } else {
        colour_from(values)
    }
}

/// Gradients interpolate only when every discrete field matches (kind,
/// repeat, size, units, corner or circle flag); otherwise they switch, as do
/// colour ↔ gradient changes (their lengths differ).
fn gradient_shapes_match(from: &[f32], to: &[f32]) -> bool {
    if from.len() <= 4 || to.len() <= 4 || from.len() != to.len() {
        return true;
    }
    let mut discrete = vec![0, 4, 5, 7, 9, 10, 11];
    match from[0] as u8 {
        2 => discrete.push(1),
        1 => discrete.extend([2, 3]),
        _ => {}
    }
    discrete.extend((GRADIENT_HEADER + 1..from.len()).step_by(GRADIENT_STOP));
    discrete.iter().all(|index| from[*index] == to[*index])
}

/// Keeps the part of sorted `(position, colour)` stops within `low..=high`,
/// interpolating colours at the cut points.
fn clip_stops(stops: &[(f64, Color)], low: f64, high: f64) -> Vec<(f64, Color)> {
    let at = |position: f64| {
        let index = stops.partition_point(|stop| stop.0 <= position);
        if index == 0 {
            return stops[0].1;
        }
        if index >= stops.len() {
            return stops[stops.len() - 1].1;
        }
        let ((p0, c0), (p1, c1)) = (stops[index - 1], stops[index]);
        let amount = if p1 > p0 {
            ((position - p0) / (p1 - p0)) as f32
        } else {
            1.0
        };
        let mut out = [0.0_f32; 4];
        for (channel, value) in out.iter_mut().enumerate() {
            *value =
                c0.components[channel] + (c1.components[channel] - c0.components[channel]) * amount;
        }
        Color::new(out)
    };
    let mut clipped = vec![(low, at(low))];
    clipped.extend(
        stops
            .iter()
            .copied()
            .filter(|stop| stop.0 > low && stop.0 < high),
    );
    clipped.push((high, at(high)));
    clipped
}

/// Resolves a gradient motion vector against the painted box: radial size,
/// px stops, CSS stop fix-up, and the range the pattern spans.
fn paint_gradient(values: &[f32], rect: BoxRect) -> Option<PaintGradient> {
    if values.len() < GRADIENT_HEADER + GRADIENT_STOP {
        return None;
    }
    let (width, height) = (rect.width(), rect.height());
    let conic = values[0] > 2.5;
    let radial = values[0] > 1.5 && !conic;
    let value = |index: usize| f64::from(values[index]);
    let coordinate = |index: usize, unit: usize, low: f64, high: f64| match values[unit] as u8 {
        1 => low + value(index),
        2 => high - value(index),
        _ => low + value(index) * (high - low),
    };
    let conic_center = conic.then(|| {
        vello::kurbo::Point::new(
            coordinate(2, 10, rect.x0, rect.x1),
            coordinate(3, 11, rect.y0, rect.y1),
        )
    });
    let (line, radii, ray) = if conic {
        (None, None, 1.0)
    } else if radial {
        let center = vello::kurbo::Point::new(
            coordinate(2, 10, rect.x0, rect.x1),
            coordinate(3, 11, rect.y0, rect.y1),
        );
        let (left, right) = ((center.x - rect.x0).abs(), (rect.x1 - center.x).abs());
        let (top, bottom) = ((center.y - rect.y0).abs(), (rect.y1 - center.y).abs());
        let circle = values[1] > 0.5;
        let corner = |dx: f64, dy: f64| {
            if circle {
                (dx.hypot(dy), dx.hypot(dy))
            } else {
                (dx * std::f64::consts::SQRT_2, dy * std::f64::consts::SQRT_2)
            }
        };
        let (radius_x, radius_y) = match values[5] as u8 {
            1 if circle => {
                let side = left.min(right).min(top).min(bottom);
                (side, side)
            }
            1 => (left.min(right), top.min(bottom)),
            2 if circle => {
                let side = left.max(right).max(top).max(bottom);
                (side, side)
            }
            2 => (left.max(right), top.max(bottom)),
            3 => corner(left.min(right), top.min(bottom)),
            4 => {
                let x = if values[7] > 0.5 {
                    value(6)
                } else {
                    value(6) * width
                };
                let y = if circle {
                    x
                } else if values[9] > 0.5 {
                    value(8)
                } else {
                    value(8) * height
                };
                (x.max(0.0), y.max(0.0))
            }
            _ => corner(left.max(right), top.max(bottom)),
        };
        (None, Some((center, radius_x, radius_y)), radius_x)
    } else {
        let (corner_x, corner_y) = (value(2), value(3));
        let direction = if corner_x != 0.0 && corner_y != 0.0 {
            // CSS corner keywords: perpendicular to the other diagonal.
            vello::kurbo::Vec2::new(corner_x * height, corner_y * width)
        } else {
            let angle = value(1).to_radians();
            vello::kurbo::Vec2::new(angle.sin(), -angle.cos())
        };
        let direction = if direction.hypot() > 0.0 {
            direction / direction.hypot()
        } else {
            vello::kurbo::Vec2::new(0.0, 1.0)
        };
        let half = (width * direction.x.abs() + height * direction.y.abs()) / 2.0;
        let center = rect.center();
        (
            Some((center - direction * half, direction * (2.0 * half))),
            None,
            2.0 * half,
        )
    };
    let chunks = values[GRADIENT_HEADER..].as_chunks::<GRADIENT_STOP>().0;
    let mut offsets: Vec<Option<f64>> = chunks
        .iter()
        .map(|stop| match stop[1] as u8 {
            1 => Some(f64::from(stop[0]) / ray.max(1e-6)),
            2 => None,
            _ => Some(f64::from(stop[0])),
        })
        .collect();
    // CSS colour-stop fix-up: ends default to 0/1, positions never go back,
    // and runs of auto stops spread evenly.
    let count = offsets.len();
    offsets[0].get_or_insert(0.0);
    offsets[count - 1].get_or_insert(1.0);
    let mut previous = f64::NEG_INFINITY;
    for offset in offsets.iter_mut().flatten() {
        previous = previous.max(*offset);
        *offset = previous;
    }
    let mut index = 1;
    while index < count {
        if offsets[index].is_some() {
            index += 1;
            continue;
        }
        let end = (index..count)
            .find(|end| offsets[*end].is_some())
            .unwrap_or(count - 1);
        let start = offsets[index - 1].unwrap_or(0.0);
        let step = (offsets[end].unwrap_or(1.0) - start) / (end - index + 1) as f64;
        for (fill, offset) in offsets.iter_mut().enumerate().take(end).skip(index) {
            *offset = Some(start + step * (fill - index + 1) as f64);
        }
        index = end;
    }
    let offsets: Vec<f64> = offsets
        .into_iter()
        .map(|offset| offset.unwrap_or(0.0))
        .collect();
    let (first, last) = (offsets[0], offsets[count - 1]);
    let repeat = values[4] > 0.5 && last - first > 1e-6;
    let (mut low, mut high) = if repeat {
        (first, last)
    } else {
        (first.min(0.0), last.max(1.0))
    };
    if radial && !repeat {
        low = low.max(0.0);
    }
    let span = (high - low).max(1e-9);
    let stops: Vec<(f32, Color)> = offsets
        .iter()
        .zip(chunks)
        .map(|(offset, stop)| {
            (
                ((offset - low) / span).clamp(0.0, 1.0) as f32,
                colour_from(&stop[2..6]),
            )
        })
        .collect();
    let mut stops: Vec<(f32, Color)> = stops;
    let mut repeat = repeat;
    if let (true, Some((center, radius_x, radius_y))) = (radial && repeat, radii) {
        // Unroll repeating radials into plain stops from the centre to the
        // farthest corner: renderers disagree on repeating two-point radials.
        let reach = [
            (rect.x0, rect.y0),
            (rect.x1, rect.y0),
            (rect.x1, rect.y1),
            (rect.x0, rect.y1),
        ]
        .iter()
        .map(|(x, y)| {
            ((x - center.x) / radius_x.max(1e-6)).hypot((y - center.y) / radius_y.max(1e-6))
        })
        .fold(0.0, f64::max)
        .max(1e-6);
        let (first_period, last_period) =
            (((0.0 - low) / span).floor(), ((reach - low) / span).ceil());
        if (last_period - first_period) * stops.len() as f64 > 4096.0 {
            // Finer than a pixel: CSS paints the average colour.
            let mut sum = [0.0_f32; 4];
            for pair in stops.windows(2) {
                let weight = pair[1].0 - pair[0].0;
                for (channel, total) in sum.iter_mut().enumerate() {
                    *total += weight
                        * (pair[0].1.components[channel] + pair[1].1.components[channel])
                        / 2.0;
                }
            }
            stops = vec![(0.0, Color::new(sum)), (1.0, Color::new(sum))];
        } else {
            let mut raw: Vec<(f64, Color)> = Vec::new();
            let mut period = first_period;
            while period < last_period {
                for (offset, colour) in &stops {
                    raw.push((low + (period + f64::from(*offset)) * span, *colour));
                }
                period += 1.0;
            }
            stops = clip_stops(&raw, 0.0, reach)
                .into_iter()
                .map(|(radius, colour)| ((radius / reach) as f32, colour))
                .collect();
        }
        low = 0.0;
        high = reach;
        repeat = false;
    }
    if !repeat {
        // Vello GPU starts the ramp at 0 when the first stop is later.
        if stops.first().is_some_and(|stop| stop.0 > 0.0) {
            stops.insert(0, (0.0, stops[0].1));
        }
        if stops.last().is_some_and(|stop| stop.0 < 1.0) {
            stops.push((1.0, stops[stops.len() - 1].1));
        }
    }
    let geometry = match (line, radii) {
        (Some((start, axis)), _) => GradientGeometry::Linear {
            start: start + axis * low,
            end: start + axis * high,
        },
        (_, Some((center, radius_x, radius_y))) => GradientGeometry::Radial {
            center,
            radius_x,
            radius_y,
            start: low,
            end: high,
        },
        _ => GradientGeometry::Conic {
            center: conic_center?,
            from: value(1).to_radians(),
            start: low,
            end: high,
        },
    };
    Some(PaintGradient {
        geometry,
        stops,
        repeat,
    })
}

fn hex_of(colour: Color) -> String {
    let rgba = colour.to_rgba8();
    format!("#{:02x}{:02x}{:02x}{:02x}", rgba.r, rgba.g, rgba.b, rgba.a)
}

/// The value a property resolves to for `state`, as a motion vector.
fn motion_value(node: &Node, property: &str, state: VisualState) -> Option<Vec<f32>> {
    match property {
        "background" => Some(background_vector(visual_value(node, "background", state))),
        "borderColor" => Some(paint_vector(
            visual_value(node, "borderColor", state),
            "#e4e4e7",
        )),
        "foreground" => {
            let value = visual_value(node, "foreground", state);
            (value.is_string() || value.is_object()).then(|| paint_vector(value, "#18181b"))
        }
        "boxShadow" => Some(
            box_shadows(node, state)
                .iter()
                .flat_map(|shadow| {
                    let [r, g, b, a] = rgba_of(shadow.color);
                    [
                        shadow.x as f32,
                        shadow.y as f32,
                        shadow.blur as f32,
                        shadow.spread as f32,
                        r,
                        g,
                        b,
                        a,
                        if shadow.inset { 1.0 } else { 0.0 },
                    ]
                })
                .collect(),
        ),
        "transform" => {
            let transform = visual_value(node, "transform", state).as_object();
            let number = |key: &str| {
                transform
                    .and_then(|transform| transform.get(key))
                    .and_then(Value::as_f64)
            };
            let scale = number("scale").unwrap_or(1.0);
            Some(vec![
                number("x").unwrap_or(0.0) as f32,
                number("y").unwrap_or(0.0) as f32,
                number("scaleX").unwrap_or(scale) as f32,
                number("scaleY").unwrap_or(scale) as f32,
            ])
        }
        "textShadow" => Some(
            text_shadow(node, state)
                .map(|(x, y, blur, colour)| {
                    let [r, g, b, a] = rgba_of(colour);
                    vec![x as f32, y as f32, blur as f32, r, g, b, a]
                })
                .unwrap_or_default(),
        ),
        _ => visual_value(node, property, state)
            .as_f64()
            .map(|value| value as f32)
            .filter(|value| value.is_finite())
            .map(|value| vec![value]),
    }
}

/// Shadow lists of different lengths interpolate against transparent layers
/// with no offset, blur or spread, as CSS does; the missing side copies the
/// other side's colour (at zero alpha) and inset flag so nothing darkens.
fn pad_motion_layers(property: &str, mut from: Vec<f32>, mut to: Vec<f32>) -> (Vec<f32>, Vec<f32>) {
    let (stride, geometry, alpha) = match property {
        "boxShadow" => (BOX_SHADOW_STRIDE, 4, 7),
        "textShadow" => (TEXT_SHADOW_STRIDE, 3, 6),
        _ => return (from, to),
    };
    let pad = |short: &mut Vec<f32>, long: &[f32]| {
        while short.len() < long.len() {
            let start = short.len();
            let mut layer = long[start..start + stride].to_vec();
            layer[..geometry].fill(0.0);
            layer[alpha] = 0.0;
            short.extend(layer);
        }
    };
    let longer = if from.len() < to.len() {
        to.clone()
    } else {
        from.clone()
    };
    pad(&mut from, &longer);
    pad(&mut to, &longer);
    (from, to)
}

fn box_shadows_from(values: &[f32]) -> Vec<BoxShadow> {
    values
        .as_chunks::<BOX_SHADOW_STRIDE>()
        .0
        .iter()
        .map(|layer| BoxShadow {
            x: f64::from(layer[0]),
            y: f64::from(layer[1]),
            blur: f64::from(layer[2]).max(0.0),
            spread: f64::from(layer[3]),
            color: colour_from(&layer[4..8]),
            inset: layer[8] > 0.5,
        })
        .collect()
}

fn text_shadow_from(values: &[f32]) -> Option<(f64, f64, f64, Color)> {
    (values.len() >= TEXT_SHADOW_STRIDE).then(|| {
        (
            f64::from(values[0]),
            f64::from(values[1]),
            f64::from(values[2]).max(0.0),
            colour_from(&values[3..7]),
        )
    })
}

fn motion_is_layout(property: &str) -> bool {
    matches!(
        property,
        "width" | "height" | "top" | "right" | "bottom" | "left"
    )
}
const MAX_SVG_RASTER_DIMENSION: u32 = 4096;
const MAX_VIRTUAL_MEASUREMENTS_PER_LIST: usize = 100_000;
const MAX_IMAGE_DIMENSION: u32 = 16_384;
const MAX_IMAGE_ENCODED_BYTES: usize = 64 * 1024 * 1024;
const MAX_IMAGE_DECODED_BYTES: usize = 64 * 1024 * 1024;
const MAX_IMAGE_CACHE_BYTES: usize = 256 * 1024 * 1024;
const MAX_IMAGE_BASE64_BYTES: usize = MAX_IMAGE_ENCODED_BYTES.div_ceil(3) * 4;

fn utf16_to_byte(text: &str, offset: usize) -> Option<usize> {
    let mut units = 0;
    for (byte, character) in text.char_indices() {
        if units == offset {
            return Some(byte);
        }
        units += character.len_utf16();
        if units > offset {
            return None;
        }
    }
    (units == offset).then_some(text.len())
}

/// Non-overlapping literal matches as byte ranges of `content`.
///
/// Case-insensitive search folds each char to a single lowercase char (the
/// same simple folding a case-insensitive regex uses), searches the folded
/// text with `str::match_indices` and maps the hits back to original offsets.
pub(crate) fn find_literal(content: &str, query: &str, case_sensitive: bool) -> Vec<Range<usize>> {
    if query.is_empty() {
        return Vec::new();
    }
    if case_sensitive {
        return content
            .match_indices(query)
            .map(|(start, found)| start..start + found.len())
            .collect();
    }
    fn fold(ch: char) -> char {
        let mut lower = ch.to_lowercase();
        match (lower.next(), lower.next()) {
            (Some('ς'), None) => 'σ',
            (Some(single), None) => single,
            _ => ch,
        }
    }
    let needle: String = query.chars().map(fold).collect();
    let mut folded = String::with_capacity(content.len());
    let mut folded_starts = Vec::with_capacity(content.len());
    let mut original_starts = Vec::with_capacity(content.len());
    for (offset, ch) in content.char_indices() {
        folded_starts.push(folded.len());
        original_starts.push(offset);
        folded.push(fold(ch));
    }
    folded_starts.push(folded.len());
    original_starts.push(content.len());
    let original = |folded_offset: usize| {
        folded_starts
            .binary_search(&folded_offset)
            .ok()
            .map(|index| original_starts[index])
    };
    folded
        .match_indices(needle.as_str())
        .filter_map(|(start, found)| Some(original(start)?..original(start + found.len())?))
        .collect()
}

fn is_search_word_char(ch: char) -> bool {
    ch.is_alphabetic() || ch.is_numeric() || ch == '_'
}

fn reveal_delta(start: f64, end: f64, viewport_start: f64, viewport_end: f64, margin: f64) -> f64 {
    let margin = margin.min(((viewport_end - viewport_start) / 4.0).max(0.0));
    if start < viewport_start + margin {
        start - viewport_start - margin
    } else if end > viewport_end - margin {
        end - viewport_end + margin
    } else {
        0.0
    }
}

fn image_cache_key(node: &Node) -> Option<&str> {
    node.image
        .as_ref()
        .map(ImageSource::key)
        .or_else(|| (!node.src.is_empty()).then_some(node.src.as_str()))
}

fn validate_image_shape(width: u32, height: u32, byte_len: usize) -> Result<(), String> {
    if width == 0 || height == 0 || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION {
        return Err(format!(
            "image dimensions {width}x{height} exceed the supported 1..={MAX_IMAGE_DIMENSION} range"
        ));
    }
    let expected = width as usize * height as usize * 4;
    if expected > MAX_IMAGE_DECODED_BYTES {
        return Err(format!(
            "decoded image requires {expected} bytes; limit is {MAX_IMAGE_DECODED_BYTES}"
        ));
    }
    if byte_len != expected {
        return Err(format!(
            "RGBA image has {byte_len} bytes; expected {expected} for {width}x{height}"
        ));
    }
    Ok(())
}

fn rgba_image_data(
    width: u32,
    height: u32,
    bytes: Vec<u8>,
    premultiplied: bool,
) -> Result<ImageData, String> {
    validate_image_shape(width, height, bytes.len())?;
    Ok(ImageData {
        width,
        height,
        format: ImageFormat::Rgba8,
        alpha_type: if premultiplied {
            ImageAlphaType::AlphaPremultiplied
        } else {
            ImageAlphaType::Alpha
        },
        data: Blob::new(Arc::new(bytes)),
    })
}

fn decode_raster_image(bytes: &[u8]) -> Result<ImageData, String> {
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_ENCODED_BYTES {
        return Err(format!(
            "encoded image size must be 1..={MAX_IMAGE_ENCODED_BYTES} bytes"
        ));
    }
    let mut reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| error.to_string())?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    limits.max_alloc = Some((MAX_IMAGE_DECODED_BYTES * 2) as u64);
    reader.limits(limits);
    let image = reader.decode().map_err(|error| error.to_string())?;
    let rgba = image.to_rgba8();
    rgba_image_data(rgba.width(), rgba.height(), rgba.into_raw(), false)
}

fn looks_like_svg(bytes: &[u8]) -> bool {
    let trimmed = bytes
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .map_or(bytes, |index| &bytes[index..]);
    trimmed.starts_with(b"<svg") || trimmed.starts_with(b"<?xml")
}

fn load_image_data(node: &Node) -> Result<ImageData, String> {
    if let Some(source) = &node.image {
        return match source {
            ImageSource::Encoded {
                data, media_type, ..
            } => {
                if data.len() > MAX_IMAGE_BASE64_BYTES {
                    return Err(format!(
                        "base64 image data exceeds the {MAX_IMAGE_BASE64_BYTES} byte transport limit"
                    ));
                }
                let bytes = BASE64_STANDARD
                    .decode(data)
                    .map_err(|error| format!("invalid base64 image data: {error}"))?;
                if bytes.len() > MAX_IMAGE_ENCODED_BYTES {
                    return Err(format!(
                        "encoded image exceeds the {MAX_IMAGE_ENCODED_BYTES} byte limit"
                    ));
                }
                if media_type.eq_ignore_ascii_case("image/svg+xml") || looks_like_svg(&bytes) {
                    load_svg_data(&bytes, None)
                } else {
                    decode_raster_image(&bytes)
                }
            }
            ImageSource::Rgba {
                data,
                width,
                height,
                premultiplied,
                ..
            } => {
                if data.len() > MAX_IMAGE_BASE64_BYTES {
                    return Err(format!(
                        "base64 RGBA data exceeds the {MAX_IMAGE_BASE64_BYTES} byte transport limit"
                    ));
                }
                let bytes = BASE64_STANDARD
                    .decode(data)
                    .map_err(|error| format!("invalid base64 RGBA data: {error}"))?;
                rgba_image_data(*width, *height, bytes, *premultiplied)
            }
        };
    }
    load_image_path(&node.src)
}

fn load_image_path(path: &str) -> Result<ImageData, String> {
    let extension = Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default();
    if extension.eq_ignore_ascii_case("svg") {
        return load_svg_image(path);
    }
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    decode_raster_image(&bytes)
}

fn load_svg_image(path: &str) -> Result<ImageData, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    let resources_dir = fs::canonicalize(path)
        .ok()
        .and_then(|resolved| resolved.parent().map(Path::to_path_buf));
    load_svg_data(&bytes, resources_dir)
}

fn load_svg_data(bytes: &[u8], resources_dir: Option<PathBuf>) -> Result<ImageData, String> {
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_ENCODED_BYTES {
        return Err(format!(
            "encoded SVG size must be 1..={MAX_IMAGE_ENCODED_BYTES} bytes"
        ));
    }
    let options = resvg::usvg::Options {
        resources_dir,
        ..resvg::usvg::Options::default()
    };
    let tree = resvg::usvg::Tree::from_data(bytes, &options).map_err(|error| error.to_string())?;
    let intrinsic = tree.size().to_int_size();
    let largest = intrinsic.width().max(intrinsic.height()).max(1);
    let scale = if largest > MAX_SVG_RASTER_DIMENSION {
        MAX_SVG_RASTER_DIMENSION as f32 / largest as f32
    } else {
        1.0
    };
    let width = ((intrinsic.width() as f32 * scale).round() as u32).max(1);
    let height = ((intrinsic.height() as f32 * scale).round() as u32).max(1);
    let mut pixmap = resvg::tiny_skia::Pixmap::new(width, height)
        .ok_or_else(|| format!("SVG raster target is too large: {width}x{height}"))?;
    resvg::render(
        &tree,
        resvg::tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );
    rgba_image_data(width, height, pixmap.take(), true)
}

#[derive(Default, Clone, Copy, Debug)]
pub struct Dirty {
    pub layout: bool,
    pub text: bool,
    pub paint: bool,
}
impl Dirty {
    fn all() -> Self {
        Self {
            layout: true,
            text: true,
            paint: true,
        }
    }
}

#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
struct VisualState {
    hovered: bool,
    active: bool,
    focused: bool,
    focus_visible: bool,
    disabled: bool,
}

/// A press on a `draggable` node. It stays pending until the pointer travels
/// past `DRAG_THRESHOLD`, so an ordinary click on a draggable still clicks.
struct PointerDrag {
    id: String,
    origin: (f64, f64),
    active: bool,
}

const DRAG_THRESHOLD: f64 = 4.0;

struct ScrollDrag {
    id: String,
    axis: ScrollbarAxis,
    grab: f64,
}

#[derive(Clone)]
struct VirtualRowAnchor {
    row_id: String,
    viewport_delta: f64,
    edge: VirtualAnchorEdge,
}

struct VirtualListRestore {
    list_id: String,
    anchor: Option<VirtualRowAnchor>,
    following_tail: bool,
    initial_layout: bool,
    bottom_aligned: bool,
    scroll_request: Option<crate::protocol::VirtualListScrollRequest>,
}

#[derive(Clone, Copy)]
enum VirtualAnchorEdge {
    Top,
    Bottom,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ScrollbarAxis {
    Horizontal,
    Vertical,
}

enum SelectableTextHit {
    Miss,
    Blocked,
    Text(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum UserSelectMode {
    None,
    Text,
    All,
}

#[derive(Clone, Debug)]
struct StaticTextSelection {
    anchor_id: String,
    anchor: usize,
    focus_id: String,
    focus: usize,
    atomic_root: Option<String>,
}

#[derive(Clone, Debug)]
struct ImeComposition {
    target: String,
    base_value: String,
    replace_start: usize,
    replace_end: usize,
    original_caret: usize,
    original_anchor: Option<usize>,
    preedit: String,
    cursor: Option<(usize, usize)>,
}

#[derive(Clone, Debug)]
struct ImeBlock {
    target: String,
    boundary_seen: bool,
}

struct ImeDisplay {
    node: Node,
    value: String,
    marked_range: (usize, usize),
    cursor_range: Option<(usize, usize)>,
}

struct EditLayout {
    node: Node,
    value: String,
    caret: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AccessibilityScrollAlignment {
    Top,
    Bottom,
}

fn visual_value<'a>(node: &'a Node, key: &str, state: VisualState) -> &'a Value {
    let mut value = &node.style[key];

    if state.hovered
        && !state.disabled
        && let Some(candidate) = node.style.get("hover").and_then(|style| style.get(key))
        && !candidate.is_null()
    {
        value = candidate;
    }

    if state.active
        && !state.disabled
        && let Some(candidate) = node.style.get("active").and_then(|style| style.get(key))
        && !candidate.is_null()
    {
        value = candidate;
    }

    if state.focused
        && let Some(candidate) = node.style.get("focus").and_then(|style| style.get(key))
        && !candidate.is_null()
    {
        value = candidate;
    }

    if state.focus_visible
        && let Some(candidate) = node
            .style
            .get("focusVisible")
            .and_then(|style| style.get(key))
        && !candidate.is_null()
    {
        value = candidate;
    }

    if state.disabled
        && let Some(candidate) = node.style.get("disabled").and_then(|style| style.get(key))
        && !candidate.is_null()
    {
        value = candidate;
    }

    value
}

fn visual_string<'a>(node: &'a Node, key: &str, fallback: &'a str, state: VisualState) -> &'a str {
    visual_value(node, key, state).as_str().unwrap_or(fallback)
}

fn visual_number(node: &Node, key: &str, fallback: f32, state: VisualState) -> f32 {
    visual_value(node, key, state)
        .as_f64()
        .map(|value| value as f32)
        .filter(|value| value.is_finite())
        .unwrap_or(fallback)
}

fn visual_state_overrides(node: &Node, key: &str, state: VisualState) -> bool {
    (state.hovered
        && !state.disabled
        && node
            .style
            .get("hover")
            .and_then(|style| style.get(key))
            .is_some_and(|value| !value.is_null()))
        || (state.active
            && !state.disabled
            && node
                .style
                .get("active")
                .and_then(|style| style.get(key))
                .is_some_and(|value| !value.is_null()))
        || (state.focused
            && node
                .style
                .get("focus")
                .and_then(|style| style.get(key))
                .is_some_and(|value| !value.is_null()))
        || (state.focus_visible
            && node
                .style
                .get("focusVisible")
                .and_then(|style| style.get(key))
                .is_some_and(|value| !value.is_null()))
        || (state.disabled
            && node
                .style
                .get("disabled")
                .and_then(|style| style.get(key))
                .is_some_and(|value| !value.is_null()))
}

fn visual_motion_number(entry: &Entry, key: &str, fallback: f32, state: VisualState) -> f32 {
    entry
        .motions
        .get(key)
        .filter(|track| track.state_driven || !visual_state_overrides(&entry.node, key, state))
        .and_then(|track| track.current.first().copied())
        .unwrap_or_else(|| visual_number(&entry.node, key, fallback, state))
}

fn visual_optional_number(node: &Node, key: &str, state: VisualState) -> Option<f64> {
    visual_value(node, key, state).as_f64()
}

fn input_display_index(node: &Node, value: &str, actual_index: usize) -> usize {
    if node.kind == "input" && node.input_type == "password" {
        let actual_index = floor_boundary(value, actual_index.min(value.len()));
        value[..actual_index].graphemes(true).count() * '•'.len_utf8()
    } else {
        floor_boundary(value, actual_index.min(value.len()))
    }
}

fn input_actual_index(node: &Node, value: &str, display_index: usize) -> usize {
    if node.kind == "input" && node.input_type == "password" {
        let graphemes = display_index / '•'.len_utf8();
        value
            .grapheme_indices(true)
            .nth(graphemes)
            .map(|(index, _)| index)
            .unwrap_or(value.len())
    } else {
        floor_boundary(value, display_index.min(value.len()))
    }
}

fn valid_number_edit(value: &str) -> bool {
    if value.is_empty() {
        return true;
    }
    let mut exponent_at = None;
    for (index, ch) in value.char_indices() {
        if matches!(ch, 'e' | 'E') {
            if exponent_at.is_some() {
                return false;
            }
            exponent_at = Some(index);
        }
    }
    let (mantissa, exponent) = exponent_at.map_or((value, None), |index| {
        (&value[..index], Some(&value[index + 1..]))
    });
    let mantissa_body = mantissa.strip_prefix(['+', '-']).unwrap_or(mantissa);
    if mantissa_body
        .chars()
        .any(|ch| !ch.is_ascii_digit() && ch != '.')
        || mantissa_body.chars().filter(|ch| *ch == '.').count() > 1
    {
        return false;
    }
    if let Some(exponent) = exponent {
        if !mantissa_body.chars().any(|ch| ch.is_ascii_digit()) {
            return false;
        }
        let exponent = exponent.strip_prefix(['+', '-']).unwrap_or(exponent);
        exponent.chars().all(|ch| ch.is_ascii_digit())
    } else {
        true
    }
}

pub struct Entry {
    pub node: Node,
    pub(crate) children: Vec<String>,
    pub(crate) parent: Option<String>,
    layout_id: Option<NodeId>,
    layout_dirty: bool,
    structure_dirty: bool,
    measure_dirty: bool,
    pub rect: BoxRect,
    bounds: BoxRect,
    pub scroll_x: f64,
    pub scroll_max_x: f64,
    pub scroll: f64,
    pub scroll_max: f64,
    virtual_anchor: Option<VirtualRowAnchor>,
    virtual_following_tail: bool,
    virtual_initial_layout: bool,
    virtual_scroll_generation: u64,
    motions: HashMap<String, MotionTrack>,
    /// Visual state at the last state-transition sync.
    last_state: VisualState,
}

fn motion_tracks_for_node(
    node: &Node,
    previous: Option<&Entry>,
    now_ms: f64,
) -> HashMap<String, MotionTrack> {
    let mut motions = previous
        .map(|entry| entry.motions.clone())
        .unwrap_or_default();
    // JS updates animate the base style; state styles transition separately.
    let base = VisualState::default();
    for property in MOTION_PROPERTIES {
        let target = motion_value(node, property, base);
        if let Some(previous) = previous {
            let previous_target = motion_value(&previous.node, property, base);
            if target == previous_target {
                if motion_transition(node, property).is_none() {
                    motions.remove(*property);
                }
                continue;
            }
            let current = motions
                .get(*property)
                .map(|track| track.current.clone())
                .or(previous_target)
                .or_else(|| match *property {
                    "width" if previous.rect.width().is_finite() => {
                        Some(vec![previous.rect.width() as f32])
                    }
                    "height" if previous.rect.height().is_finite() => {
                        Some(vec![previous.rect.height() as f32])
                    }
                    "opacity" => Some(vec![1.0]),
                    "radius" => Some(vec![0.0]),
                    _ => None,
                });
            motions.remove(*property);
            let (Some(from), Some(to), Some(config)) =
                (current, target, motion_transition(node, property))
            else {
                continue;
            };
            if let Some(track) = MotionTrack::new(property, from, to, now_ms, config, false) {
                motions.insert((*property).to_string(), track);
            }
        } else {
            let from = node
                .motion_from
                .get(*property)
                .and_then(Value::as_f64)
                .map(|value| value as f32)
                .filter(|value| value.is_finite())
                .map(|value| vec![value]);
            let (Some(from), Some(to), Some(config)) =
                (from, target, motion_transition(node, property))
            else {
                continue;
            };
            if let Some(track) = MotionTrack::new(property, from, to, now_ms, config, false) {
                motions.insert((*property).to_string(), track);
            }
        }
    }
    motions
}
struct HighlightMatchCache {
    content: String,
    query: String,
    ranges: Vec<crate::protocol::TextHighlightRange>,
    case_sensitive: bool,
    whole_word: bool,
    matches: Vec<Range<usize>>,
}

const CARET_BLINK_MS: f64 = 530.0;
const CARET_BLINK_IDLE_MS: f64 = 10_000.0;
const EDIT_HISTORY_LIMIT: usize = 200;
const EDIT_COALESCE_MS: f64 = 1_000.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EditKind {
    Insert,
    Delete,
    Other,
}

#[derive(Clone, Debug)]
struct EditSnapshot {
    value: String,
    caret: usize,
    anchor: Option<usize>,
}

#[derive(Default)]
struct EditHistory {
    undo: Vec<EditSnapshot>,
    redo: Vec<EditSnapshot>,
    value: Option<String>,
    last_kind: Option<EditKind>,
    last_ms: f64,
}

pub struct Tree {
    pub root: String,
    pub entries: HashMap<String, Entry>,
    pub order: Vec<String>,
    layout: TaffyTree<String>,
    pub text: TextEngine,
    pub(crate) highlight_ranges: HashMap<String, Vec<TextPaintHighlight>>,
    highlight_counts: HashMap<String, usize>,
    highlight_count_queries: HashMap<String, (String, bool, bool)>,
    highlight_focus: HashMap<String, (String, usize, String, usize)>,
    highlight_match_cache: HashMap<String, HighlightMatchCache>,
    #[cfg(test)]
    pub highlight_searches: u64,
    highlight_dirty: bool,
    images: HashMap<String, ImageData>,
    svgs: HashMap<String, crate::svg::SvgScene>,
    virtual_measurements: HashMap<String, HashMap<String, f64>>,
    pending_layout_events: Vec<Value>,
    pending_interaction_events: Vec<Value>,
    pending_motion_events: Vec<Value>,
    motion_time_ms: f64,
    caret_activity_ms: f64,
    edit_history: HashMap<String, EditHistory>,
    frame_overlay: Option<VecDeque<f32>>,
    virtual_focus: Option<(String, String)>,
    stacking: HashMap<String, f32>,
    /// Parents whose children differ in stacking order; hit testing sorts
    /// only these, so wide flat containers are walked without a sort.
    stacked_parents: HashSet<String>,
    /// Top-level portal roots in ascending stacking order.
    portal_order: Vec<String>,
    /// Nodes with a `transform` in their base or state styles.
    transformed: HashSet<String>,
    /// Ids with a `spin` style: rotated by the clock, so they need a frame every tick.
    spinning: HashSet<String>,
    window_chrome_suppressed: bool,
    pub dirty: Dirty,
    pub hovered: Option<String>,
    /// Every node under the pointer that has a `hover` style, ancestors
    /// included, as CSS `:hover` does. `hovered` stays the interactive target.
    hover_styled: Vec<String>,
    /// Ids holding hover/active/focus at the last state-transition sync.
    visual_snapshot_ids: Vec<String>,
    /// Extra ids to re-check at the next sync (e.g. `disabled` changed).
    state_candidates: Vec<String>,
    /// Caret and x of the last textarea Up/Down move (the goal column).
    vertical_goal: Option<(usize, f32)>,
    /// Ids whose entry holds at least one motion track, so frame and
    /// pointer ticks visit only animating nodes instead of the whole tree.
    animating: HashSet<String>,
    pub focused: Option<String>,
    pub(crate) focus_visible: bool,
    pressed: Option<String>,
    pressed_link: Option<(String, String)>,
    pressed_diff_row: Option<(String, usize)>,
    scroll_drag: Option<ScrollDrag>,
    pointer_drag: Option<PointerDrag>,
    pub mouse: (f64, f64),
    caret: usize,
    selection_anchor: Option<usize>,
    text_dragging: bool,
    static_selection: Option<StaticTextSelection>,
    static_text_dragging: bool,
    ime: Option<ImeComposition>,
    ime_blocked: Option<ImeBlock>,
    modal_focus_returns: Vec<(String, Option<String>)>,
    pub layouts: u64,
    pub paints: u64,
    pub layout_nodes_created: u64,
    pub measure_calls: u64,
    pub painted_nodes: u64,
    pub warnings: Vec<String>,
}

/// Period in milliseconds of a node's continuous `spin` rotation, if it has one.
fn spin_period(node: &Node) -> Option<f64> {
    node.style
        .get("spin")
        .and_then(Value::as_f64)
        .filter(|period| period.is_finite() && *period > 0.0)
}

/// The node fields `Tree::refresh_stacking` reads, besides children.
fn stacking_inputs(node: &Node) -> (u32, bool, bool) {
    let transformed = node.style.get("transform").is_some()
        || spin_period(node).is_some()
        || ["hover", "active", "focus", "focusVisible", "disabled"]
            .iter()
            .any(|state| {
                node.style
                    .get(*state)
                    .is_some_and(|style| style.get("transform").is_some())
            });
    (
        node.number("zIndex", 0.0).to_bits(),
        node.portal,
        transformed,
    )
}

impl Tree {
    fn refresh_stacking(&mut self) {
        fn visit(
            entries: &HashMap<String, Entry>,
            id: &str,
            out: &mut HashMap<String, f32>,
        ) -> f32 {
            let entry = &entries[id];
            let highest = entry
                .children
                .iter()
                .fold(entry.node.number("zIndex", 0.0), |highest, child| {
                    highest.max(visit(entries, child, out))
                });
            out.insert(id.to_string(), highest);
            highest
        }
        let mut stacking =
            HashMap::with_capacity_and_hasher(self.entries.len(), Default::default());
        if self.entries.contains_key(&self.root) {
            visit(&self.entries, &self.root, &mut stacking);
        }
        self.stacked_parents = self
            .entries
            .iter()
            .filter(|(_, entry)| {
                let mut levels = entry
                    .children
                    .iter()
                    .map(|child| stacking.get(child).copied().unwrap_or(0.0));
                levels
                    .next()
                    .is_some_and(|first| levels.any(|level| level != first))
            })
            .map(|(id, _)| id.clone())
            .collect();
        self.stacking = stacking;
        self.spinning = self
            .entries
            .iter()
            .filter(|(_, entry)| spin_period(&entry.node).is_some())
            .map(|(id, _)| id.clone())
            .collect();
        self.transformed = self
            .entries
            .iter()
            .filter(|(_, entry)| {
                entry.node.style.get("transform").is_some()
                    || spin_period(&entry.node).is_some()
                    || ["hover", "active", "focus", "focusVisible", "disabled"]
                        .iter()
                        .any(|state| {
                            entry
                                .node
                                .style
                                .get(*state)
                                .is_some_and(|style| style.get("transform").is_some())
                        })
            })
            .map(|(id, _)| id.clone())
            .collect();
        let mut portals = self.portal_roots();
        portals.sort_by(|a, b| {
            self.stacking
                .get(a)
                .copied()
                .unwrap_or(0.0)
                .total_cmp(&self.stacking.get(b).copied().unwrap_or(0.0))
        });
        self.portal_order = portals;
    }
    /// Whether the hit-testing caches match a fresh rebuild and every node
    /// with a motion is tracked as animating.
    #[cfg(test)]
    pub(crate) fn hit_caches_are_fresh(&mut self) -> bool {
        let animating_ok = self
            .entries
            .iter()
            .filter(|(_, entry)| !entry.motions.is_empty())
            .all(|(id, _)| self.animating.contains(id));
        let cached = (
            self.stacked_parents.clone(),
            self.portal_order.clone(),
            self.transformed.clone(),
        );
        self.refresh_stacking();
        animating_ok
            && cached
                == (
                    self.stacked_parents.clone(),
                    self.portal_order.clone(),
                    self.transformed.clone(),
                )
    }
    /// Children of `id` in ascending stacking order (stable), borrowed when
    /// no reordering is needed.
    fn hit_order<'a>(&self, id: &str, children: &'a [String]) -> std::borrow::Cow<'a, [String]> {
        if !self.stacked_parents.contains(id) {
            return std::borrow::Cow::Borrowed(children);
        }
        let mut sorted = children.to_vec();
        sorted.sort_by(|a, b| {
            self.stacking
                .get(a)
                .copied()
                .unwrap_or(0.0)
                .total_cmp(&self.stacking.get(b).copied().unwrap_or(0.0))
        });
        std::borrow::Cow::Owned(sorted)
    }

    fn portal_roots(&self) -> Vec<String> {
        self.order
            .iter()
            .filter(|id| {
                if !self.entries[*id].node.portal {
                    return false;
                }
                let mut parent = self.entries[*id].parent.as_deref();
                while let Some(parent_id) = parent {
                    if self.entries[parent_id].node.portal {
                        return false;
                    }
                    parent = self.entries[parent_id].parent.as_deref();
                }
                true
            })
            .cloned()
            .collect()
    }

    fn ancestor_scroll_offset(&self, id: &str) -> Vec2 {
        let mut offset = Vec2::ZERO;
        let mut parent = self.entries[id].parent.as_deref();
        while let Some(parent_id) = parent {
            let entry = &self.entries[parent_id];
            offset += Vec2::new(entry.scroll_x, entry.scroll);
            parent = self.entries[parent_id].parent.as_deref();
        }
        offset
    }

    fn outside_dismissal_at_pointer(&self) -> Option<String> {
        let mut portals: Vec<_> = self
            .portal_roots()
            .into_iter()
            .filter(|id| self.entries[id].node.dismiss_on_outside)
            .collect();
        portals.sort_by(|a, b| {
            self.stacking
                .get(a)
                .copied()
                .unwrap_or(0.0)
                .total_cmp(&self.stacking.get(b).copied().unwrap_or(0.0))
        });
        let portal = portals.last()?;
        let offset = self.ancestor_scroll_offset(portal);
        let bounds = self.entries[portal].bounds + Vec2::new(-offset.x, -offset.y);
        (!bounds.contains(self.mouse)).then(|| portal.clone())
    }

    pub fn new(root: Node) -> Self {
        let mut tree = Self {
            root: root.id.clone(),
            entries: HashMap::default(),
            order: Vec::new(),
            layout: TaffyTree::new(),
            text: TextEngine::new(),
            highlight_ranges: HashMap::default(),
            highlight_counts: HashMap::default(),
            highlight_count_queries: HashMap::default(),
            highlight_focus: HashMap::default(),
            highlight_match_cache: HashMap::default(),
            #[cfg(test)]
            highlight_searches: 0,
            highlight_dirty: true,
            images: HashMap::default(),
            svgs: HashMap::default(),
            virtual_measurements: HashMap::default(),
            pending_layout_events: Vec::new(),
            pending_interaction_events: Vec::new(),
            pending_motion_events: Vec::new(),
            motion_time_ms: 0.0,
            caret_activity_ms: 0.0,
            edit_history: HashMap::default(),
            frame_overlay: None,
            virtual_focus: None,
            stacking: HashMap::default(),
            stacked_parents: HashSet::default(),
            portal_order: Vec::new(),
            transformed: HashSet::default(),
            spinning: HashSet::default(),
            window_chrome_suppressed: false,
            dirty: Dirty::all(),
            hovered: None,
            hover_styled: Vec::new(),
            visual_snapshot_ids: Vec::new(),
            state_candidates: Vec::new(),
            vertical_goal: None,
            animating: HashSet::default(),
            focused: None,
            focus_visible: false,
            pressed: None,
            pressed_link: None,
            pressed_diff_row: None,
            scroll_drag: None,
            pointer_drag: None,
            mouse: (-1.0, -1.0),
            caret: 0,
            selection_anchor: None,
            text_dragging: false,
            static_selection: None,
            static_text_dragging: false,
            ime: None,
            ime_blocked: None,
            modal_focus_returns: Vec::new(),
            layouts: 0,
            paints: 0,
            layout_nodes_created: 0,
            measure_calls: 0,
            painted_nodes: 0,
            warnings: Vec::new(),
        };
        tree.update(root);
        tree
    }
    pub fn set_window_chrome_suppressed(&mut self, suppressed: bool) -> bool {
        if self.window_chrome_suppressed == suppressed {
            return false;
        }
        self.window_chrome_suppressed = suppressed;
        if let Some(root) = self.entries.get_mut(&self.root) {
            root.layout_dirty = true;
        }
        self.dirty.layout = true;
        self.dirty.paint = true;
        true
    }
    /// Moves the native clock without stepping motion tracks. Cheap enough to
    /// run on every input event; tracks catch up on their next frame deadline.
    pub fn advance_clock(&mut self, now_ms: f64) {
        if !now_ms.is_finite() {
            return;
        }
        let caret_was_visible = self.caret_visible();
        if !self.spinning.is_empty() && now_ms > self.motion_time_ms {
            self.dirty.paint = true;
        }
        self.motion_time_ms = self.motion_time_ms.max(now_ms);
        if self.caret_blink_target().is_some() && caret_was_visible != self.caret_visible() {
            self.dirty.paint = true;
        }
    }
    pub fn advance_motion(&mut self, now_ms: f64) {
        if !now_ms.is_finite() {
            return;
        }
        self.advance_clock(now_ms);
        self.sync_state_transitions();
        let mut completed = Vec::new();
        let ids: Vec<String> = self.animating.iter().cloned().collect();
        for id in ids {
            let Some(entry) = self.entries.get_mut(&id) else {
                self.animating.remove(&id);
                continue;
            };
            let properties: Vec<String> = entry.motions.keys().cloned().collect();
            for property in properties {
                let Some(track) = entry.motions.get_mut(&property) else {
                    continue;
                };
                let (value, done) = track.value_at(self.motion_time_ms);
                let changed = track
                    .current
                    .iter()
                    .zip(&value)
                    .any(|(current, next)| (current - next).abs() > 0.0001);
                track.current = value;
                if changed || done {
                    if motion_is_layout(&property) {
                        entry.layout_dirty = true;
                        self.dirty.layout = true;
                    }
                    self.dirty.paint = true;
                }
                if done {
                    completed.push((id.clone(), property));
                }
            }
        }
        for (id, property) in completed {
            if let Some(entry) = self.entries.get_mut(&id) {
                entry.motions.remove(&property);
                if entry.motions.is_empty() {
                    self.animating.remove(&id);
                }
            }
            self.pending_motion_events
                .push(json!({"type":"motionComplete", "id":id, "property":property}));
        }
    }
    /// Starts transitions for nodes whose hover/active/focus/disabled state
    /// changed since the last sync. Only nodes that held or now hold a state
    /// are visited, so a pointer move never walks the whole tree.
    fn sync_state_transitions(&mut self) {
        let current: Vec<String> = self
            .hovered
            .iter()
            .chain(self.hover_styled.iter())
            .chain(self.pressed.iter())
            .chain(self.focused.iter())
            .cloned()
            .collect();
        let mut ids = std::mem::take(&mut self.state_candidates);
        ids.append(&mut self.visual_snapshot_ids);
        ids.extend(current.iter().cloned());
        ids.sort();
        ids.dedup();
        self.visual_snapshot_ids = current;
        let now_ms = self.motion_time_ms;
        for id in ids {
            let Some(entry) = self.entries.get(&id) else {
                continue;
            };
            let new_state = self.visual_state_for(&id, &entry.node);
            let old_state = entry.last_state;
            if old_state == new_state {
                continue;
            }
            let mut started = Vec::new();
            let mut stopped = Vec::new();
            if entry.node.style.get("transition").is_some() {
                for property in STATE_MOTION_PROPERTIES {
                    let Some(config) = motion_transition(&entry.node, property) else {
                        continue;
                    };
                    let Some(to) = motion_value(&entry.node, property, new_state) else {
                        continue;
                    };
                    let from = entry
                        .motions
                        .get(*property)
                        .map(|track| track.current.clone())
                        .or_else(|| motion_value(&entry.node, property, old_state));
                    let Some(from) = from else {
                        continue;
                    };
                    match MotionTrack::new(property, from, to, now_ms, config, true) {
                        Some(track) => started.push(((*property).to_string(), track)),
                        None => stopped.push(*property),
                    }
                }
            }
            let entry = self.entries.get_mut(&id).expect("entry checked above");
            entry.last_state = new_state;
            for property in stopped {
                if entry
                    .motions
                    .get(property)
                    .is_some_and(|track| track.state_driven)
                {
                    entry.motions.remove(property);
                }
            }
            if !started.is_empty() {
                entry.motions.extend(started);
                self.animating.insert(id.clone());
                self.dirty.paint = true;
            }
        }
    }
    #[cfg(test)]
    pub(crate) fn motion_values(&self, id: &str, property: &str) -> Option<Vec<f32>> {
        Some(self.entries.get(id)?.motions.get(property)?.current.clone())
    }
    pub fn active_motion_count(&self) -> usize {
        self.animating
            .iter()
            .filter_map(|id| self.entries.get(id))
            .map(|entry| entry.motions.len())
            .sum()
    }
    pub fn next_motion_tick_ms(&self) -> Option<f64> {
        self.animating
            .iter()
            .filter_map(|id| self.entries.get(id))
            .flat_map(|entry| entry.motions.values())
            .map(|track| {
                if self.motion_time_ms < track.start_ms {
                    track.start_ms
                } else {
                    (self.motion_time_ms + MOTION_FRAME_MS).min(track.end_ms())
                }
            })
            .min_by(f64::total_cmp)
    }
    pub fn take_motion_events(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.pending_motion_events)
    }
    pub fn motion_time_ms(&self) -> f64 {
        self.motion_time_ms
    }
    /// Earliest native clock deadline: motion frames or the next caret blink phase.
    pub fn next_clock_tick_ms(&self) -> Option<f64> {
        let spin = (!self.spinning.is_empty()).then_some(self.motion_time_ms + MOTION_FRAME_MS);
        [self.next_motion_tick_ms(), self.next_caret_blink_ms(), spin]
            .into_iter()
            .flatten()
            .min_by(f64::total_cmp)
    }
    fn caret_blink_target(&self) -> Option<&str> {
        let id = self.focused.as_deref()?;
        let entry = self.entries.get(id)?;
        (matches!(entry.node.kind.as_str(), "input" | "textarea")
            && !entry.node.disabled
            && self.user_select_mode(id) != UserSelectMode::None)
            .then_some(id)
    }
    /// Caret blinks after activity and settles solid once idle, so an idle
    /// focused editor schedules no further frames.
    pub(crate) fn caret_visible(&self) -> bool {
        let elapsed = self.motion_time_ms - self.caret_activity_ms;
        if !(0.0..CARET_BLINK_IDLE_MS).contains(&elapsed) {
            return true;
        }
        ((elapsed / CARET_BLINK_MS).floor() as u64).is_multiple_of(2)
    }
    pub fn next_caret_blink_ms(&self) -> Option<f64> {
        self.caret_blink_target()?;
        let elapsed = (self.motion_time_ms - self.caret_activity_ms).max(0.0);
        if elapsed >= CARET_BLINK_IDLE_MS {
            return None;
        }
        let next = ((elapsed / CARET_BLINK_MS).floor() + 1.0) * CARET_BLINK_MS;
        Some(self.caret_activity_ms + next.min(CARET_BLINK_IDLE_MS))
    }
    fn touch_caret(&mut self) {
        if !self.caret_visible() {
            self.dirty.paint = true;
        }
        self.caret_activity_ms = self.motion_time_ms;
    }
    pub fn update(&mut self, root: Node) {
        let previous_modal = self.active_modal().map(str::to_string);
        let previous_focus = self.focused.clone();
        let mut old = std::mem::take(&mut self.entries);
        self.order.clear();
        self.root = root.id.clone();
        self.insert(root, &mut old, None);
        if !old.is_empty() {
            self.dirty = Dirty::all();
        }
        for removed in old.values() {
            if let Some(layout_id) = removed.layout_id {
                self.layout
                    .remove(layout_id)
                    .expect("retained layout node exists");
            }
        }
        self.text.retain(|id| {
            self.entries.contains_key(id)
                || id
                    .strip_suffix("::caret")
                    .is_some_and(|id| self.entries.contains_key(id))
                || id
                    .strip_suffix("::ime")
                    .is_some_and(|id| self.entries.contains_key(id))
        });
        self.prune_images();
        self.prune_svgs();
        let restore_focus = self.modal_focus_transition(previous_modal, previous_focus);
        let keyboard = self.focus_visible;
        self.prune_interaction();
        if let Some(id) = restore_focus {
            self.focus_with_visibility(&id, keyboard);
        }
        self.refresh_stacking();
    }
    fn insert(&mut self, mut node: Node, old: &mut HashMap<String, Entry>, parent: Option<&str>) {
        // Store the hierarchy once. Entries own only their properties and child IDs.
        let children = std::mem::take(&mut node.children);
        let child_ids: Vec<String> = children.iter().map(|child| child.id.clone()).collect();
        let previous = old.remove(&node.id);
        let id = node.id.clone();
        self.order.push(node.id.clone());
        self.reconcile_node(node, child_ids, previous);
        self.entries.get_mut(&id).unwrap().parent = parent.map(str::to_string);
        for child in children {
            self.insert(child, old, Some(&id));
        }
    }
    fn reconcile_node(&mut self, mut node: Node, child_ids: Vec<String>, previous: Option<Entry>) {
        // Any external value change invalidates undo history immediately, so a
        // controlled value that later returns to an old string (A -> B -> A)
        // cannot resurrect stale steps. User edits already updated the retained
        // value in set_input, so their echo compares equal and keeps history.
        if let Some(entry) = previous.as_ref() {
            let invalidated = entry.node.kind != node.kind
                || (matches!(node.kind.as_str(), "input" | "textarea")
                    && entry.node.value != node.value
                    && !self.revert_rejected_edit(
                        &node.id,
                        entry.node.value.as_deref(),
                        node.value.as_deref(),
                    ));
            if invalidated {
                self.edit_history.remove(&node.id);
            }
        }
        let rich_changed = previous.as_ref().is_none_or(|prev| {
            node.kind != prev.node.kind
                || node.source != prev.node.source
                || node.text != prev.node.text && node.kind != "markdown" && node.kind != "diff"
                || node.language != prev.node.language
                || node.path != prev.node.path
                || node.word_diff != prev.node.word_diff
                || node.collapsed_paths != prev.node.collapsed_paths
                || node.max_lines != prev.node.max_lines
                || node.old_text != prev.node.old_text
                || node.new_text != prev.node.new_text
        });
        if !rich_changed {
            if let Some(prev) = &previous {
                node.rich = prev.node.rich.clone();
                if matches!(node.kind.as_str(), "markdown" | "diff") {
                    node.text = prev.node.text.clone();
                }
            }
        } else {
            match node.kind.as_str() {
                "markdown" => {
                    let (plain, rich) = rich::markdown(&node.source);
                    node.text = plain;
                    node.rich = Some(Arc::new(rich));
                }
                "code" => {
                    node.rich = Some(Arc::new(rich::code(
                        &node.text,
                        (!node.language.is_empty()).then_some(node.language.as_str()),
                        (!node.path.is_empty()).then_some(node.path.as_str()),
                    )))
                }
                "diff" => match rich::diff(
                    &node.source,
                    node.old_text.as_deref(),
                    node.new_text.as_deref(),
                    node.word_diff,
                    &node.collapsed_paths,
                    node.max_lines,
                ) {
                    Ok((patch, rich)) => {
                        node.text = rich.display_text().unwrap_or(patch);
                        node.rich = Some(Arc::new(rich));
                    }
                    Err(error) => {
                        self.warnings.push(format!("Diff '{}': {error}", node.id));
                        node.text = format!("Invalid diff: {error}");
                        node.rich = Some(Arc::new(RichContent::Diff {
                            rows: vec![DiffRow {
                                text: node.text.clone(),
                                range: 0..node.text.len(),
                                kind: DiffRowKind::Meta,
                                emphasis: Vec::new(),
                                syntax: Vec::new(),
                                old_line: None,
                                new_line: None,
                                file_path: None,
                                hidden_lines: None,
                                file_header: false,
                                gutter_digits: 1,
                            }],
                            files: Vec::new(),
                            max_columns: node.text.chars().count(),
                            max_line_number: 0,
                        }));
                    }
                },
                _ => {}
            }
        }
        if previous.as_ref().is_none_or(|prev| {
            node.kind != prev.node.kind
                || node.text != prev.node.text
                || node.highlight != prev.node.highlight
                || node.style != prev.node.style
                || node.value != prev.node.value
                || node.src != prev.node.src
                || node.image != prev.node.image
                || child_ids != prev.children
        }) {
            self.highlight_dirty = true;
        }
        let mut layout_dirty = true;
        let mut structure_dirty = true;
        let mut measure_dirty = true;
        if let Some(prev) = &previous {
            let syntax_theme_changed = node.syntax_theme != prev.node.syntax_theme;
            if let Some(incoming) = node.value.as_deref()
                && let Some(ime) = self
                    .ime
                    .as_ref()
                    .filter(|ime| ime.target == node.id && incoming != ime.base_value)
            {
                let boundary_seen = ime.preedit.is_empty();
                self.ime = None;
                self.ime_blocked = Some(ImeBlock {
                    target: node.id.clone(),
                    boundary_seen,
                });
                self.text.layouts.remove(&format!("{}::ime", node.id));
                self.selection_anchor = None;
                self.caret = floor_boundary(incoming, self.caret.min(incoming.len()));
                self.dirty.paint = true;
            }
            if matches!(node.kind.as_str(), "input" | "textarea") && node.value.is_none() {
                node.value = prev.node.value.clone();
            }
            structure_dirty = prev.structure_dirty || child_ids != prev.children;
            layout_dirty = prev.layout_dirty
                || node.kind != prev.node.kind
                || node.virtual_list != prev.node.virtual_list
                || LAYOUT_KEYS
                    .iter()
                    .any(|key| node.style[*key] != prev.node.style[*key]);
            measure_dirty = prev.measure_dirty
                || rich_changed
                || node.src != prev.node.src
                || node.image != prev.node.image
                || node.kind != prev.node.kind
                || node.display_text() != prev.node.display_text()
                || syntax_theme_changed
                || TEXT_KEYS
                    .iter()
                    .any(|key| node.style[*key] != prev.node.style[*key]);
            if structure_dirty || layout_dirty || measure_dirty {
                self.dirty.layout = true;
            }
            if rich_changed
                || node.display_text() != prev.node.display_text()
                || syntax_theme_changed
                || TEXT_KEYS
                    .iter()
                    .any(|key| node.style[*key] != prev.node.style[*key])
            {
                self.text.layouts.remove(&node.id);
                self.text.diff_layouts.remove(&node.id);
                self.dirty.text = true;
                self.dirty.layout = true;
            }
            if node != prev.node || structure_dirty {
                self.dirty.paint = true;
            }
        } else {
            self.dirty = Dirty::all();
        }
        if node.kind == "image"
            && let Some(key) = image_cache_key(&node).map(str::to_string)
        {
            let source_changed = previous.as_ref().is_none_or(|entry| {
                entry.node.kind != "image"
                    || entry.node.src != node.src
                    || entry.node.image != node.image
            });
            if source_changed || !self.images.contains_key(&key) {
                match load_image_data(&node) {
                    Ok(image) => {
                        let current_bytes: usize = self
                            .images
                            .iter()
                            .filter(|(existing, _)| *existing != &key)
                            .map(|(_, cached)| cached.data.data().len())
                            .sum();
                        let next_bytes = current_bytes.saturating_add(image.data.data().len());
                        if next_bytes <= MAX_IMAGE_CACHE_BYTES {
                            self.images.insert(key, image);
                        } else {
                            self.images.remove(&key);
                            self.warnings.push(format!(
                                "Image '{}': decoded image cache would exceed the {} byte limit",
                                node.id, MAX_IMAGE_CACHE_BYTES
                            ));
                        }
                    }
                    Err(e) => {
                        self.images.remove(&key);
                        self.warnings.push(format!("Image '{}': {e}", node.id));
                    }
                }
            }
        }
        if node.kind == "svg" {
            let changed = previous
                .as_ref()
                .is_none_or(|entry| entry.node.svg != node.svg || entry.node.kind != node.kind);
            if changed || !self.svgs.contains_key(&node.id) {
                match crate::svg::compile(&node.svg) {
                    Ok(scene) => {
                        self.svgs.insert(node.id.clone(), scene);
                    }
                    Err(error) => {
                        self.svgs.remove(&node.id);
                        self.warnings.push(format!("SVG '{}': {error}", node.id));
                    }
                }
            }
        } else {
            self.svgs.remove(&node.id);
        }
        let id = node.id.clone();
        let virtual_anchor = if node.virtual_list.is_some() {
            previous
                .as_ref()
                .and_then(|entry| entry.virtual_anchor.clone())
        } else {
            None
        };
        let virtual_following_tail = node.virtual_list.as_ref().is_some_and(|metadata| {
            metadata.follow_tail
                && previous.as_ref().is_none_or(|entry| {
                    !entry
                        .node
                        .virtual_list
                        .as_ref()
                        .is_some_and(|previous| previous.follow_tail)
                        || entry.virtual_following_tail
                })
        });
        let virtual_initial_layout = node.virtual_list.is_some()
            && previous.as_ref().is_none_or(|entry| {
                entry.node.virtual_list.is_none() || entry.virtual_initial_layout
            });
        let virtual_scroll_generation = if node.virtual_list.is_some() {
            previous
                .as_ref()
                .map_or(0, |entry| entry.virtual_scroll_generation)
        } else {
            0
        };
        let scroll = previous.as_ref().map(|e| e.scroll).unwrap_or_else(|| {
            node.control
                .as_ref()
                .filter(|control| {
                    node.virtual_list.is_some()
                        && control.role == "virtualList"
                        && control.value.is_finite()
                })
                .map_or(0.0, |control| control.value.max(0.0))
        });
        let motions = motion_tracks_for_node(&node, previous.as_ref(), self.motion_time_ms);
        let last_state = previous.as_ref().map_or(
            VisualState {
                disabled: node.disabled,
                ..VisualState::default()
            },
            |entry| entry.last_state,
        );
        if previous
            .as_ref()
            .is_some_and(|entry| entry.node.disabled != node.disabled)
        {
            self.state_candidates.push(node.id.clone());
        }
        if motions.is_empty() {
            self.animating.remove(&id);
        } else {
            self.animating.insert(id.clone());
        }
        self.entries.insert(
            id,
            Entry {
                node,
                children: child_ids,
                parent: previous.as_ref().and_then(|e| e.parent.clone()),
                layout_id: previous.as_ref().and_then(|e| e.layout_id),
                layout_dirty,
                structure_dirty,
                measure_dirty,
                rect: previous.as_ref().map(|e| e.rect).unwrap_or(BoxRect::ZERO),
                bounds: previous.as_ref().map(|e| e.bounds).unwrap_or(BoxRect::ZERO),
                scroll_x: previous.as_ref().map(|e| e.scroll_x).unwrap_or(0.0),
                scroll_max_x: previous.as_ref().map(|e| e.scroll_max_x).unwrap_or(0.0),
                scroll,
                scroll_max: previous.as_ref().map(|e| e.scroll_max).unwrap_or(0.0),
                virtual_anchor,
                virtual_following_tail,
                virtual_initial_layout,
                virtual_scroll_generation,
                motions,
                last_state,
            },
        );
    }
    pub fn patch(&mut self, nodes: Vec<Node>) -> Result<(), String> {
        let previous_modal = self.active_modal().map(str::to_string);
        let previous_focus = self.focused.clone();
        crate::protocol::validate_patch(&nodes)?;
        // Stacking is a whole-tree pass; a patch keeps children, so it only
        // changes when a patched node changes its own z-index, portal or transform.
        let stacking_changed = nodes.iter().any(|node| {
            self.entries
                .get(&node.id)
                .is_none_or(|entry| stacking_inputs(&entry.node) != stacking_inputs(node))
        });
        // Validate the whole patch before applying any part of it.
        for node in &nodes {
            if !self
                .entries
                .get(&node.id)
                .is_some_and(|entry| entry.node.kind == node.kind)
            {
                return Err(format!(
                    "Patch references a missing or changed node: {}",
                    node.id
                ));
            }
        }
        for node in nodes {
            let previous = self.entries.remove(&node.id).unwrap();
            let children = previous.children.clone();
            self.reconcile_node(node, children, Some(previous));
        }
        self.prune_images();
        self.prune_svgs();
        let restore_focus = self.modal_focus_transition(previous_modal, previous_focus);
        let keyboard = self.focus_visible;
        self.prune_interaction();
        if let Some(id) = restore_focus {
            self.focus_with_visibility(&id, keyboard);
        }
        if stacking_changed {
            self.refresh_stacking();
        }
        Ok(())
    }

    pub fn mutate(&mut self, mutations: Vec<TreeMutation>) -> Result<(), String> {
        crate::protocol::validate_mutations(&mutations)?;
        if mutations.is_empty() {
            return Ok(());
        }

        // Build and validate the resulting hierarchy before touching retained state. This makes
        // the whole mutation batch atomic even though application below is incremental.
        let mut structure: HashMap<String, Vec<String>> = self
            .entries
            .iter()
            .map(|(id, entry)| (id.clone(), entry.children.clone()))
            .collect();
        let mut kinds: HashMap<String, String> = self
            .entries
            .iter()
            .map(|(id, entry)| (id.clone(), entry.node.kind.clone()))
            .collect();
        let mut creates = Vec::new();
        let mut patches = Vec::new();
        let mut child_updates = HashMap::<String, Vec<String>>::default();
        let mut removes = HashSet::<String>::default();
        let mut created = HashSet::<String>::default();
        let mut patched = HashSet::<String>::default();

        for mutation in mutations {
            match mutation {
                TreeMutation::Create { node } => {
                    let node = *node;
                    if kinds.contains_key(&node.id) || !created.insert(node.id.clone()) {
                        return Err(format!("Create references an existing node: {}", node.id));
                    }
                    structure.insert(node.id.clone(), Vec::new());
                    kinds.insert(node.id.clone(), node.kind.clone());
                    creates.push(node);
                }
                TreeMutation::Patch { node } => {
                    let node = *node;
                    if created.contains(&node.id) {
                        return Err(format!(
                            "Created node must carry its final properties: {}",
                            node.id
                        ));
                    }
                    let Some(kind) = kinds.get(&node.id) else {
                        return Err(format!("Patch references a missing node: {}", node.id));
                    };
                    if kind != &node.kind {
                        return Err(format!("Patch changes node kind: {}", node.id));
                    }
                    if !patched.insert(node.id.clone()) {
                        return Err(format!("Duplicate property patch: {}", node.id));
                    }
                    patches.push(node);
                }
                TreeMutation::Children { id, children } => {
                    if !kinds.contains_key(&id) {
                        return Err(format!("Children mutation references a missing node: {id}"));
                    }
                    if child_updates.insert(id.clone(), children).is_some() {
                        return Err(format!("Duplicate children mutation: {id}"));
                    }
                }
                TreeMutation::Remove { id } => {
                    if id == self.root {
                        return Err("Structural mutations cannot remove the root Window".into());
                    }
                    if created.contains(&id) {
                        return Err(format!(
                            "Mutation batch cannot create and remove the same node: {id}"
                        ));
                    }
                    if !kinds.contains_key(&id) || !removes.insert(id.clone()) {
                        return Err(format!(
                            "Remove references a missing or duplicate node: {id}"
                        ));
                    }
                }
            }
        }

        for id in &removes {
            if patched.contains(id) || child_updates.contains_key(id) {
                return Err(format!("Removed node also has another mutation: {id}"));
            }
        }
        for (id, children) in &child_updates {
            if removes.contains(id) {
                return Err(format!("Removed node also changes children: {id}"));
            }
            structure.insert(id.clone(), children.clone());
        }
        for id in &removes {
            structure.remove(id);
            kinds.remove(id);
        }
        if structure.len() > 20_000 {
            return Err("UI tree exceeds size limit".into());
        }
        if kinds.get(&self.root).map(String::as_str) != Some("window") {
            return Err("Structural mutation batch must preserve the root Window".into());
        }

        let mut parents = HashMap::<String, String>::default();
        for (parent, children) in &structure {
            let mut siblings: HashSet<_> =
                HashSet::with_capacity_and_hasher(children.len(), Default::default());
            for child in children {
                if !siblings.insert(child) {
                    return Err(format!("Duplicate child {child} under {parent}"));
                }
                if child == &self.root {
                    return Err("Root Window cannot become a child".into());
                }
                if !structure.contains_key(child) {
                    return Err(format!("Dangling child {child} under {parent}"));
                }
                if let Some(previous) = parents.insert(child.clone(), parent.clone()) {
                    return Err(format!(
                        "Node {child} cannot have two parents: {previous} and {parent}"
                    ));
                }
            }
        }
        for id in structure.keys() {
            if id != &self.root && !parents.contains_key(id) {
                return Err(format!("Structural mutation leaves node detached: {id}"));
            }
        }

        fn visit_order(
            id: &str,
            structure: &HashMap<String, Vec<String>>,
            visited: &mut HashSet<String>,
            order: &mut Vec<String>,
            depth: usize,
        ) -> Result<(), String> {
            if depth > 128 {
                return Err("UI tree exceeds depth limit".into());
            }
            if !visited.insert(id.to_string()) {
                return Err(format!("Structural mutation creates a cycle at {id}"));
            }
            order.push(id.to_string());
            for child in &structure[id] {
                visit_order(child, structure, visited, order, depth + 1)?;
            }
            Ok(())
        }

        let mut final_order = Vec::with_capacity(structure.len());
        let mut visited = HashSet::with_capacity_and_hasher(structure.len(), Default::default());
        visit_order(&self.root, &structure, &mut visited, &mut final_order, 0)?;
        if visited.len() != structure.len() {
            return Err("Structural mutation creates a disconnected cycle".into());
        }

        let previous_modal = self.active_modal().map(str::to_string);
        let previous_focus = self.focused.clone();

        for node in creates {
            self.reconcile_node(node, Vec::new(), None);
        }
        for node in patches {
            let previous = self
                .entries
                .remove(&node.id)
                .expect("validated patch target exists");
            let children = previous.children.clone();
            self.reconcile_node(node, children, Some(previous));
        }
        for (id, children) in child_updates {
            let entry = self
                .entries
                .get_mut(&id)
                .expect("validated children target exists");
            if entry.children != children {
                entry.children = children;
                entry.structure_dirty = true;
                self.highlight_dirty = true;
                self.dirty.layout = true;
                self.dirty.paint = true;
            }
        }
        for id in removes {
            if let Some(removed) = self.entries.remove(&id)
                && let Some(layout_id) = removed.layout_id
            {
                self.layout
                    .remove(layout_id)
                    .expect("retained layout node exists");
            }
            self.svgs.remove(&id);
            self.highlight_dirty = true;
        }
        for (id, entry) in &mut self.entries {
            entry.parent = parents.get(id).cloned();
        }
        self.order = final_order;

        self.text.retain(|id| {
            self.entries.contains_key(id)
                || id
                    .strip_suffix("::caret")
                    .is_some_and(|id| self.entries.contains_key(id))
                || id
                    .strip_suffix("::ime")
                    .is_some_and(|id| self.entries.contains_key(id))
        });
        self.prune_images();
        self.prune_svgs();
        let restore_focus = self.modal_focus_transition(previous_modal, previous_focus);
        let keyboard = self.focus_visible;
        self.prune_interaction();
        if let Some(id) = restore_focus {
            self.focus_with_visibility(&id, keyboard);
        }
        self.refresh_stacking();
        Ok(())
    }

    fn modal_focus_transition(
        &mut self,
        previous_modal: Option<String>,
        previous_focus: Option<String>,
    ) -> Option<String> {
        let next_modal = self.active_modal().map(str::to_string);
        if previous_modal == next_modal {
            return None;
        }

        let valid_return = |id: &str| self.entries.contains_key(id);
        match next_modal {
            Some(next) => {
                if let Some(position) = self
                    .modal_focus_returns
                    .iter()
                    .position(|(modal, _)| modal == &next)
                {
                    let closed = self.modal_focus_returns.split_off(position + 1);
                    return closed
                        .into_iter()
                        .rev()
                        .filter_map(|(_, focus)| focus)
                        .find(|id| valid_return(id));
                }

                let fallback = previous_focus.filter(|id| valid_return(id)).or_else(|| {
                    self.modal_focus_returns
                        .iter()
                        .rev()
                        .filter_map(|(_, focus)| focus.as_ref())
                        .find(|id| valid_return(id))
                        .cloned()
                });
                self.modal_focus_returns.retain(|(modal, _)| {
                    self.entries
                        .get(modal)
                        .is_some_and(|entry| entry.node.modal)
                });
                self.modal_focus_returns.push((next, fallback));
                None
            }
            None => {
                let closed = std::mem::take(&mut self.modal_focus_returns);
                closed
                    .into_iter()
                    .rev()
                    .filter_map(|(_, focus)| focus)
                    .find(|id| valid_return(id))
            }
        }
    }
    fn prune_images(&mut self) {
        let used: HashSet<String> = self
            .entries
            .values()
            .filter(|entry| entry.node.kind == "image")
            .filter_map(|entry| image_cache_key(&entry.node).map(str::to_string))
            .collect();
        self.images.retain(|key, _| used.contains(key));
    }
    fn prune_svgs(&mut self) {
        self.svgs.retain(|id, _| {
            self.entries
                .get(id)
                .is_some_and(|entry| entry.node.kind == "svg")
        });
    }
    fn virtual_rows(&self, list_id: &str) -> Option<Vec<(String, String)>> {
        let list = self.entries.get(list_id)?;
        let metadata = list.node.virtual_list.as_ref()?;
        let content_id = list.children.first()?;
        let content = self.entries.get(content_id)?;
        let first_row = usize::from(metadata.window_start > 0);
        let row_count = metadata.rendered_keys.len();
        if content.children.len() < first_row + row_count {
            return None;
        }
        Some(
            metadata
                .rendered_keys
                .iter()
                .cloned()
                .zip(
                    content.children[first_row..first_row + row_count]
                        .iter()
                        .cloned(),
                )
                .collect(),
        )
    }

    fn virtual_parked_row(&self, list_id: &str) -> Option<(String, String)> {
        let list = self.entries.get(list_id)?;
        let metadata = list.node.virtual_list.as_ref()?;
        let retained_key = metadata.retained_key.as_ref()?;
        let content_id = list.children.first()?;
        let content = self.entries.get(content_id)?;
        let index = usize::from(metadata.window_start > 0)
            + metadata.rendered_keys.len()
            + usize::from(metadata.window_end < metadata.item_count);
        Some((retained_key.clone(), content.children.get(index)?.clone()))
    }

    pub(crate) fn is_virtual_parked(&self, id: &str) -> bool {
        let mut current = id.to_string();
        loop {
            let Some(parent_id) = self
                .entries
                .get(&current)
                .and_then(|entry| entry.parent.clone())
            else {
                return false;
            };
            if let Some(list_id) = self
                .entries
                .get(&parent_id)
                .and_then(|entry| entry.parent.as_deref())
                && self
                    .virtual_parked_row(list_id)
                    .is_some_and(|(_, row_id)| row_id == current)
            {
                return true;
            }
            current = parent_id;
        }
    }

    fn focused_virtual_row(&self) -> Option<(String, String)> {
        let mut current = self.focused.clone()?;
        loop {
            let parent_id = self.entries.get(&current)?.parent.clone()?;
            if let Some(list_id) = self
                .entries
                .get(&parent_id)
                .and_then(|entry| entry.parent.as_deref())
                && self
                    .entries
                    .get(list_id)
                    .and_then(|entry| entry.node.virtual_list.as_ref())
                    .is_some()
            {
                if let Some((key, _)) = self
                    .virtual_rows(list_id)
                    .and_then(|rows| rows.into_iter().find(|(_, row_id)| row_id == &current))
                {
                    return Some((list_id.to_string(), key));
                }
                if let Some((key, row_id)) = self.virtual_parked_row(list_id)
                    && row_id == current
                {
                    return Some((list_id.to_string(), key));
                }
            }
            current = parent_id;
        }
    }

    fn sync_virtual_focus(&mut self) {
        let next = self.focused_virtual_row();
        let previous = self.virtual_focus.clone();
        if previous == next {
            return;
        }
        if let Some((previous_list, _)) = &previous
            && next
                .as_ref()
                .is_none_or(|(next_list, _)| next_list != previous_list)
        {
            self.pending_interaction_events.push(json!({
                "type":"virtualListFocus", "id":previous_list, "key":Value::Null
            }));
        }
        if let Some((list_id, key)) = &next {
            self.pending_interaction_events.push(json!({
                "type":"virtualListFocus", "id":list_id, "key":key
            }));
        }
        self.virtual_focus = next;
    }
    fn current_virtual_anchor(&self, list_id: &str) -> Option<VirtualRowAnchor> {
        let list = self.entries.get(list_id)?;
        let metadata = list.node.virtual_list.as_ref()?;
        if list.rect.height() <= 0.0 {
            return None;
        }
        let rows = self.virtual_rows(list_id)?;
        let viewport_top = list.rect.y0 + list.scroll;
        let viewport_bottom = list.rect.y1 + list.scroll;
        let edge = if metadata.alignment == "bottom" {
            VirtualAnchorEdge::Bottom
        } else {
            VirtualAnchorEdge::Top
        };
        let (_, row_id) = match edge {
            VirtualAnchorEdge::Top => rows
                .iter()
                .find(|(_, row_id)| {
                    self.entries.get(row_id).is_some_and(|row| {
                        row.rect.height() > 0.0 && row.rect.y1 > viewport_top + 1e-6
                    })
                })
                .or_else(|| rows.last())?,
            VirtualAnchorEdge::Bottom => rows
                .iter()
                .rev()
                .find(|(_, row_id)| {
                    self.entries.get(row_id).is_some_and(|row| {
                        row.rect.height() > 0.0 && row.rect.y0 < viewport_bottom - 1e-6
                    })
                })
                .or_else(|| rows.first())?,
        };
        let row = self.entries.get(row_id)?;
        (row.rect.height() > 0.0).then(|| VirtualRowAnchor {
            row_id: row_id.clone(),
            viewport_delta: match edge {
                VirtualAnchorEdge::Top => row.rect.y0 - viewport_top,
                VirtualAnchorEdge::Bottom => row.rect.y1 - viewport_bottom,
            },
            edge,
        })
    }
    fn refresh_virtual_anchor(&mut self, list_id: &str) {
        let anchor = self.current_virtual_anchor(list_id);
        if let Some(list) = self.entries.get_mut(list_id) {
            list.virtual_anchor = anchor;
            list.virtual_initial_layout = false;
        }
    }
    fn refresh_virtual_anchors(&mut self) {
        let list_ids: Vec<String> = self
            .entries
            .iter()
            .filter(|(_, entry)| entry.node.virtual_list.is_some())
            .map(|(id, _)| id.clone())
            .collect();
        for list_id in list_ids {
            self.refresh_virtual_anchor(&list_id);
        }
    }
    fn restore_virtual_anchors(&mut self) {
        let lists: Vec<VirtualListRestore> = self
            .entries
            .iter()
            .filter_map(|(list_id, entry)| {
                let metadata = entry.node.virtual_list.as_ref()?;
                Some(VirtualListRestore {
                    list_id: list_id.clone(),
                    anchor: entry.virtual_anchor.clone(),
                    following_tail: entry.virtual_following_tail,
                    initial_layout: entry.virtual_initial_layout,
                    bottom_aligned: metadata.alignment == "bottom",
                    scroll_request: metadata
                        .scroll_request
                        .as_ref()
                        .filter(|request| request.generation > entry.virtual_scroll_generation)
                        .cloned(),
                })
            })
            .collect();
        for VirtualListRestore {
            list_id,
            anchor,
            following_tail,
            initial_layout,
            bottom_aligned,
            scroll_request,
        } in lists
        {
            let Some(list) = self.entries.get(&list_id) else {
                continue;
            };
            let desired = if let Some(request) = &scroll_request {
                request.offset
            } else if following_tail || (initial_layout && bottom_aligned) {
                list.scroll_max
            } else if let Some(anchor) = anchor {
                let Some(row) = self.entries.get(&anchor.row_id) else {
                    continue;
                };
                match anchor.edge {
                    VirtualAnchorEdge::Top => row.rect.y0 - list.rect.y0 - anchor.viewport_delta,
                    VirtualAnchorEdge::Bottom => row.rect.y1 - list.rect.y1 - anchor.viewport_delta,
                }
            } else {
                continue;
            };
            let next = desired.clamp(0.0, list.scroll_max);
            let changed = (next - list.scroll).abs() > 1e-6;
            let (scroll_x, max_x, max_y) = (list.scroll_x, list.scroll_max_x, list.scroll_max);
            let list = self.entries.get_mut(&list_id).unwrap();
            list.scroll = next;
            if let Some(request) = &scroll_request {
                list.virtual_scroll_generation = request.generation;
                list.virtual_following_tail = list
                    .node
                    .virtual_list
                    .as_ref()
                    .is_some_and(|metadata| metadata.follow_tail)
                    && (next - max_y).abs() <= 0.5;
            }
            if changed {
                self.dirty.paint = true;
            }
            if !changed && scroll_request.is_none() {
                continue;
            }
            self.pending_layout_events.push(json!({
                "type":"scroll", "id":list_id, "offset":next, "max":max_y,
                "offsetX":scroll_x, "offsetY":next, "maxX":max_x, "maxY":max_y
            }));
        }
    }
    fn measure_virtual_rows(&mut self) {
        let active: HashSet<String> = self
            .entries
            .iter()
            .filter(|(_, entry)| entry.node.virtual_list.is_some())
            .map(|(id, _)| id.clone())
            .collect();
        self.virtual_measurements
            .retain(|id, _| active.contains(id));

        for list_id in active {
            let Some(rows) = self.virtual_rows(&list_id) else {
                continue;
            };
            let measured: Vec<(String, f64)> = rows
                .into_iter()
                .filter_map(|(key, row_id)| {
                    let height = self.entries.get(&row_id)?.rect.height();
                    (height.is_finite() && height > 0.0).then_some((key, height))
                })
                .collect();
            let cache = self
                .virtual_measurements
                .entry(list_id.clone())
                .or_default();
            let mut changed = Vec::new();
            for (key, height) in measured {
                if cache
                    .get(&key)
                    .is_some_and(|previous| (previous - height).abs() <= 0.25)
                {
                    continue;
                }
                if !cache.contains_key(&key)
                    && cache.len() >= MAX_VIRTUAL_MEASUREMENTS_PER_LIST
                    && let Some(oldest) = cache.keys().next().cloned()
                {
                    cache.remove(&oldest);
                }
                cache.insert(key.clone(), height);
                changed.push(json!({"key":key,"height":height}));
            }
            if !changed.is_empty() {
                self.pending_layout_events.push(json!({
                    "type":"virtualListLayout", "id":list_id, "items":changed
                }));
            }
        }
    }
    pub fn take_layout_events(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.pending_layout_events)
    }

    pub fn take_interaction_events(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.pending_interaction_events)
    }
    pub fn compute(&mut self, width: f32, height: f32) -> Result<(), String> {
        if !self.dirty.layout && !self.dirty.text {
            if self.highlight_dirty {
                self.resolve_highlights();
                self.highlight_dirty = false;
            }
            return Ok(());
        }
        for entry in self.entries.values() {
            if entry.measure_dirty {
                self.text.prepare(&entry.node);
            }
        }
        let root = self.build_layout(&self.root.clone(), Some((width, height)))?;
        let text = &mut self.text;
        let nodes = &self.entries;
        let images = &self.images;
        let measure_calls = &mut self.measure_calls;
        self.layout
            .compute_layout_with_measure(
                root,
                Size {
                    width: AvailableSpace::Definite(width),
                    height: AvailableSpace::Definite(height),
                },
                |inputs, _, context, style| {
                    *measure_calls += 1;
                    taffy::compute_leaf_layout(
                        inputs,
                        style,
                        |_, _| 0.0,
                        |known, available| {
                            let Some(id) = context.as_deref() else {
                                return Size::ZERO;
                            };
                            let node = &nodes[id].node;
                            let mut measured = Size::ZERO;
                            if node.is_text() {
                                let max_width = if matches!(node.kind.as_str(), "text" | "markdown")
                                {
                                    known.width.or(match available.width {
                                        AvailableSpace::Definite(w) => Some(w),
                                        AvailableSpace::MinContent => Some(0.0),
                                        _ => None,
                                    })
                                } else {
                                    None
                                };
                                let (w, h) = text.measure(id, max_width);
                                measured = Size {
                                    width: w + text.code_gutter_inset(node),
                                    height: h,
                                };
                            } else if node.kind == "diff" {
                                let (w, h) = text.measure_diff(node);
                                measured = Size {
                                    width: w,
                                    height: h,
                                };
                            } else if let Some(image) =
                                image_cache_key(node).and_then(|key| images.get(key))
                            {
                                let ratio = image.width as f32 / image.height as f32;
                                measured = Size {
                                    width: known
                                        .height
                                        .map(|h| h * ratio)
                                        .unwrap_or(image.width as f32),
                                    height: known
                                        .width
                                        .map(|w| w / ratio)
                                        .unwrap_or(image.height as f32),
                                };
                            }
                            Size {
                                width: known.width.unwrap_or(measured.width),
                                height: known.height.unwrap_or(measured.height),
                            }
                        },
                    )
                },
            )
            .map_err(|e| e.to_string())?;
        self.positions(&self.root.clone(), (0.0, 0.0))?;
        self.restore_virtual_anchors();
        self.measure_virtual_rows();
        self.refresh_virtual_anchors();
        self.ensure_focused_textarea_caret_visible();
        self.resolve_highlights();
        self.highlight_dirty = false;
        self.layouts += 1;
        self.dirty.layout = false;
        self.dirty.text = false;
        self.dirty.paint = true;
        Ok(())
    }
    fn build_layout(&mut self, id: &str, viewport: Option<(f32, f32)>) -> Result<NodeId, String> {
        let child_ids = self.entries[id].children.clone();
        let children = child_ids
            .iter()
            .map(|child| self.build_layout(child, None))
            .collect::<Result<Vec<_>, _>>()?;
        let suppress_root_chrome = self.window_chrome_suppressed && id == self.root;
        let entry = self.entries.get_mut(id).unwrap();
        let style = if entry.layout_dirty || entry.layout_id.is_none() || viewport.is_some() {
            let mut style = layout_style(entry, suppress_root_chrome);
            if let Some((w, h)) = viewport {
                style.size = Size {
                    width: length(w),
                    height: length(h),
                };
            }
            Some(style)
        } else {
            None
        };
        let layout_id = if let Some(layout_id) = entry.layout_id {
            if let Some(style) = style
                && self.layout.style(layout_id).map_err(|e| e.to_string())? != &style
            {
                self.layout
                    .set_style(layout_id, style)
                    .map_err(|e| e.to_string())?;
            }
            if entry.measure_dirty {
                self.layout
                    .mark_dirty(layout_id)
                    .map_err(|e| e.to_string())?;
            }
            layout_id
        } else {
            self.layout_nodes_created += 1;
            self.layout
                .new_leaf_with_context(style.unwrap(), id.to_string())
                .map_err(|e| e.to_string())?
        };
        if entry.structure_dirty || entry.layout_id.is_none() {
            self.layout
                .set_children(layout_id, &children)
                .map_err(|e| e.to_string())?;
        }
        entry.layout_id = Some(layout_id);
        entry.layout_dirty = false;
        entry.structure_dirty = false;
        entry.measure_dirty = false;
        Ok(layout_id)
    }
    fn positions(&mut self, id: &str, parent: (f64, f64)) -> Result<BoxRect, String> {
        let entry = self.entries.get_mut(id).unwrap();
        let layout = self
            .layout
            .layout(entry.layout_id.unwrap())
            .map_err(|e| e.to_string())?;
        let origin = (
            parent.0 + layout.location.x as f64,
            parent.1 + layout.location.y as f64,
        );
        entry.rect = BoxRect::from_origin_size(
            origin,
            (layout.size.width as f64, layout.size.height as f64),
        );
        entry.scroll_max_x = if entry.node.kind == "scroll"
            && matches!(
                entry.node.scroll_orientation.as_str(),
                "horizontal" | "both"
            ) {
            layout.scroll_width() as f64
        } else if entry.node.kind == "code" {
            let pad = entry.node.insets("padding");
            let border = entry.node.insets("borderWidth");
            let viewport =
                (entry.rect.width() - (pad[1] + pad[3] + border[1] + border[3]) as f64).max(0.0);
            (self.text.measure(id, None).0 as f64
                + f64::from(self.text.code_gutter_inset(&entry.node))
                - viewport)
                .max(0.0)
        } else {
            0.0
        };
        entry.scroll_max = if entry.node.kind == "scroll"
            && matches!(entry.node.scroll_orientation.as_str(), "vertical" | "both")
        {
            layout.scroll_height() as f64
        } else if entry.node.kind == "textarea" {
            let pad = entry.node.insets("padding");
            let border = entry.node.insets("borderWidth");
            let width = (entry.rect.width() - (pad[1] + pad[3] + border[1] + border[3]) as f64)
                .max(0.0) as f32;
            let height =
                (entry.rect.height() - (pad[0] + pad[2] + border[0] + border[2]) as f64).max(0.0);
            (self.text.measure(id, Some(width)).1 as f64 - height).max(0.0)
        } else {
            0.0
        };
        entry.scroll_x = entry.scroll_x.clamp(0.0, entry.scroll_max_x);
        entry.scroll = entry.scroll.clamp(0.0, entry.scroll_max);
        let children = entry.children.clone();
        let clips = entry.node.kind == "scroll";
        let mut bounds = entry.rect.inset(3.0);
        for child in children {
            let child_bounds = self.positions(&child, origin)?;
            if !clips {
                bounds = bounds.union(child_bounds);
            }
        }
        self.entries.get_mut(id).unwrap().bounds = bounds;
        Ok(bounds)
    }
    pub fn scene(&mut self, scale: f64) -> Scene {
        let mut scene = Scene::new();
        self.paint(scale, &mut scene);
        scene
    }
    fn resolve_highlights(&mut self) {
        self.highlight_ranges.clear();
        let mut counts = HashMap::default();
        let mut queries = HashMap::default();
        let mut focus = HashMap::default();
        let mut focus_requests = Vec::new();
        let mut groups: HashMap<String, Vec<String>> = HashMap::default();
        for id in &self.order {
            let entry = &self.entries[id];
            if entry.rect.width() <= 0.0
                || entry.rect.height() <= 0.0
                || self.is_virtual_parked(id)
                || !matches!(
                    entry.node.kind.as_str(),
                    "text" | "markdown" | "code" | "diff"
                )
            {
                continue;
            }
            let mut ancestor = Some(id.as_str());
            while let Some(candidate) = ancestor {
                let parent = &self.entries[candidate];
                if parent.node.highlight.is_some() {
                    groups
                        .entry(candidate.to_string())
                        .or_default()
                        .push(id.clone());
                    break;
                }
                ancestor = parent.parent.as_deref();
            }
        }
        for (owner_id, leaves) in groups {
            let Some(highlight) = self.entries[&owner_id].node.highlight.as_ref() else {
                continue;
            };
            let mut content = String::new();
            let mut segments = Vec::<(String, Range<usize>)>::new();
            let mut previous: Option<&str> = None;
            for id in &leaves {
                let entry = &self.entries[id];
                if entry.node.text.is_empty() {
                    continue;
                }
                if let Some(previous_id) = previous {
                    let before = &self.entries[previous_id];
                    let adjacent = before.parent == entry.parent
                        && (before.rect.y0 - entry.rect.y0).abs() <= 2.0
                        && (before.rect.x1 - entry.rect.x0).abs() <= 2.0
                        && !before.node.text.ends_with('\n')
                        && !entry.node.text.starts_with('\n');
                    if !adjacent {
                        content.push('\n');
                    }
                }
                let start = content.len();
                content.push_str(&entry.node.text);
                segments.push((id.clone(), start..content.len()));
                previous = Some(id);
            }
            if content.is_empty() {
                continue;
            }
            let cached = self.highlight_match_cache.get(&owner_id).filter(|cached| {
                cached.content == content
                    && cached.query == highlight.query
                    && cached.ranges == highlight.ranges
                    && cached.case_sensitive == highlight.case_sensitive
                    && cached.whole_word == highlight.whole_word
            });
            let matches: Vec<Range<usize>> = if let Some(cached) = cached {
                cached.matches.clone()
            } else {
                #[cfg(test)]
                {
                    self.highlight_searches += 1;
                }
                let matches: Vec<Range<usize>> =
                    if !highlight.query.is_empty() && highlight.query.len() <= 4096 {
                        find_literal(&content, &highlight.query, highlight.case_sensitive)
                            .into_iter()
                            .filter(|found| {
                                !highlight.whole_word
                                    || (content[..found.start]
                                        .chars()
                                        .next_back()
                                        .is_none_or(|ch| !is_search_word_char(ch))
                                        && content[found.end..]
                                            .chars()
                                            .next()
                                            .is_none_or(|ch| !is_search_word_char(ch)))
                            })
                            .take(50_000)
                            .collect()
                    } else {
                        highlight
                            .ranges
                            .iter()
                            .filter_map(|range| {
                                let start = utf16_to_byte(&content, range.start)?;
                                let end = utf16_to_byte(&content, range.end)?;
                                (start < end).then_some(start..end)
                            })
                            .take(50_000)
                            .collect()
                    };
                self.highlight_match_cache.insert(
                    owner_id.clone(),
                    HighlightMatchCache {
                        content,
                        query: highlight.query.clone(),
                        ranges: highlight.ranges.clone(),
                        case_sensitive: highlight.case_sensitive,
                        whole_word: highlight.whole_word,
                        matches: matches.clone(),
                    },
                );
                matches
            };
            counts.insert(owner_id.clone(), matches.len());
            queries.insert(
                owner_id.clone(),
                (
                    highlight.query.clone(),
                    highlight.case_sensitive,
                    highlight.whole_word,
                ),
            );
            if let Some(index) = highlight.active_index
                && let Some(found) = matches.get(index)
                && let Some((id, segment)) = segments
                    .iter()
                    .find(|(_, segment)| segment.start < found.end && found.start < segment.end)
            {
                let start = found.start.max(segment.start) - segment.start;
                let end = found.end.min(segment.end) - segment.start;
                let signature = (highlight.query.clone(), index, id.clone(), start);
                if self.highlight_focus.get(&owner_id) != Some(&signature) {
                    focus_requests.push((id.clone(), start..end));
                }
                focus.insert(owner_id.clone(), signature);
            }
            for (index, found) in matches.into_iter().enumerate() {
                let wash = if highlight.active_index == Some(index) {
                    highlight.active_color.as_deref().unwrap_or("#ffbd2e")
                } else {
                    highlight.color.as_deref().unwrap_or("#fff2a8")
                };
                let first = segments.partition_point(|(_, segment)| segment.end <= found.start);
                for (id, segment) in segments.iter().skip(first) {
                    if segment.start >= found.end {
                        break;
                    }
                    let start = found.start.max(segment.start);
                    let end = found.end.min(segment.end);
                    if start < end {
                        self.highlight_ranges.entry(id.clone()).or_default().push(
                            TextPaintHighlight {
                                range: start - segment.start..end - segment.start,
                                color: color(wash),
                            },
                        );
                    }
                }
            }
        }
        for (id, count) in &counts {
            if self.highlight_counts.get(id) != Some(count)
                || self.highlight_count_queries.get(id) != queries.get(id)
            {
                let (query, case_sensitive, whole_word) = &queries[id];
                self.pending_layout_events.push(json!({
                    "type":"highlight", "id":id, "matchCount":count,
                    "query":query, "caseSensitive":case_sensitive, "wholeWord":whole_word
                }));
            }
        }
        for id in self.highlight_counts.keys() {
            if !counts.contains_key(id) && self.entries.contains_key(id) {
                let (query, case_sensitive, whole_word) = &self.highlight_count_queries[id];
                self.pending_layout_events.push(json!({
                    "type":"highlight", "id":id, "matchCount":0,
                    "query":query, "caseSensitive":case_sensitive, "wholeWord":whole_word
                }));
            }
        }
        for ranges in self.highlight_ranges.values_mut() {
            ranges.sort_by_key(|highlight| highlight.range.start);
        }
        self.highlight_counts = counts;
        self.highlight_match_cache
            .retain(|id, _| self.highlight_counts.contains_key(id));
        self.highlight_count_queries = queries;
        self.highlight_focus = focus;
        for (id, range) in focus_requests {
            self.scroll_highlight_into_view(&id, range);
        }
    }

    fn scroll_highlight_into_view(&mut self, id: &str, range: Range<usize>) {
        let Some(entry) = self.entries.get(id) else {
            return;
        };
        let node = entry.node.clone();
        let rect = entry.rect;
        let pad = node.insets("padding");
        let border = node.insets("borderWidth");
        let (left, top, right, bottom) = if node.kind == "diff" {
            let Some(RichContent::Diff { rows, .. }) = node.rich.as_deref() else {
                return;
            };
            let Some(row) = rows
                .iter()
                .position(|row| row.range.start < range.end && range.start < row.range.end)
            else {
                return;
            };
            let line_height =
                (node.number("fontSize", 13.0) * node.number("lineHeight", 1.5)).max(1.0) as f64;
            (
                0.0,
                row as f64 * line_height,
                rect.width(),
                (row + 1) as f64 * line_height,
            )
        } else {
            let width =
                (rect.width() - (pad[1] + pad[3] + border[1] + border[3]) as f64).max(0.0) as f32;
            if node.kind == "markdown" {
                self.text
                    .reveal_markdown_range(id, range.start, range.end, width);
            }
            let wrap = (node.kind != "code").then_some(width);
            let Some(wash) = self
                .text
                .range_rects(id, range.start, range.end, wrap)
                .into_iter()
                .next()
            else {
                return;
            };
            (wash.x0, wash.y0, wash.x1, wash.y1)
        };
        let offset = self.ancestor_scroll_offset(id);
        let gutter = if node.kind == "code" {
            f64::from(self.text.code_gutter_inset(&node))
        } else {
            0.0
        };
        let mut target = BoxRect::new(
            rect.x0 + pad[3] as f64 + border[3] as f64 + gutter + left - offset.x,
            rect.y0 + pad[0] as f64 + border[0] as f64 + top - offset.y,
            rect.x0 + pad[3] as f64 + border[3] as f64 + gutter + right - offset.x,
            rect.y0 + pad[0] as f64 + border[0] as f64 + bottom - offset.y,
        );
        if node.kind == "code" && self.entries[id].scroll_max_x > 0.0 {
            let viewport = self.visible_rect(id).unwrap();
            let current = self.entries[id].scroll_x;
            target = target + Vec2::new(-current, 0.0);
            let desired = current
                + reveal_delta(
                    target.x0,
                    target.x1,
                    viewport.x0 + gutter,
                    viewport.x1,
                    12.0,
                );
            let events = self.scroll_to_2d(id, desired, self.entries[id].scroll);
            target = target + Vec2::new(current - self.entries[id].scroll_x, 0.0);
            self.pending_layout_events.extend(events);
        }
        let mut parent = self.entries[id].parent.clone();
        while let Some(parent_id) = parent {
            let entry = &self.entries[&parent_id];
            let next = entry.parent.clone();
            if entry.node.kind == "scroll" {
                let viewport = self.visible_rect(&parent_id).unwrap();
                let old_x = entry.scroll_x;
                let old_y = entry.scroll;
                let dx = if entry.scroll_max_x > 0.0 {
                    reveal_delta(target.x0, target.x1, viewport.x0, viewport.x1, 12.0)
                } else {
                    0.0
                };
                let dy = if entry.scroll_max > 0.0 {
                    reveal_delta(target.y0, target.y1, viewport.y0, viewport.y1, 12.0)
                } else {
                    0.0
                };
                let events = self.scroll_to_2d(&parent_id, old_x + dx, old_y + dy);
                let updated = &self.entries[&parent_id];
                target = target + Vec2::new(old_x - updated.scroll_x, old_y - updated.scroll);
                self.pending_layout_events.extend(events);
            }
            parent = next;
        }
    }
    pub(crate) fn paint<P: PaintTarget>(&mut self, scale: f64, target: &mut P) {
        if self.highlight_dirty {
            self.resolve_highlights();
            self.highlight_dirty = false;
        }
        self.painted_nodes = 0;
        let target = &mut crate::paint::TransformTarget::new(target);
        let root_rect = self.entries[&self.root].rect;
        self.paint_node(&self.root.clone(), Vec2::ZERO, scale, root_rect, target);
        let mut portals = self.portal_roots();
        portals.sort_by(|a, b| {
            self.stacking
                .get(a)
                .copied()
                .unwrap_or(0.0)
                .total_cmp(&self.stacking.get(b).copied().unwrap_or(0.0))
        });
        for portal in portals {
            let offset = self.ancestor_scroll_offset(&portal);
            self.paint_node(&portal, offset, scale, root_rect, target);
        }
        self.paint_frame_overlay(scale, root_rect, target);
        self.paints += 1;
        self.dirty.paint = false;
    }
    /// Toggles the frame-time overlay. Returns true when a repaint is needed.
    pub fn set_frame_overlay(&mut self, enabled: bool) -> bool {
        if enabled == self.frame_overlay.is_some() {
            return false;
        }
        self.frame_overlay = enabled.then(VecDeque::new);
        self.dirty.paint = true;
        true
    }
    /// Records a presented frame's CPU time. Never schedules a frame itself:
    /// the graph refreshes only when something else repaints, so an idle
    /// window stays at zero frames.
    pub fn record_frame_time(&mut self, milliseconds: f64) {
        let Some(samples) = &mut self.frame_overlay else {
            return;
        };
        if !milliseconds.is_finite() || milliseconds < 0.0 {
            return;
        }
        if samples.len() == FRAME_OVERLAY_SAMPLES {
            samples.pop_front();
        }
        samples.push_back(milliseconds as f32);
    }
    #[cfg(test)]
    pub fn frame_samples(&self) -> Option<Vec<f32>> {
        self.frame_overlay
            .as_ref()
            .map(|samples| samples.iter().copied().collect())
    }
    fn paint_frame_overlay<P: PaintTarget>(&self, scale: f64, root: BoxRect, target: &mut P) {
        let Some(samples) = &self.frame_overlay else {
            return;
        };
        const WIDTH: f64 = 180.0;
        const HEIGHT: f64 = 48.0;
        let x0 = (root.x1 - WIDTH - 8.0).max(root.x0);
        let y1 = root.y1 - 8.0;
        let y0 = (y1 - HEIGHT).max(root.y0);
        let transform = Affine::scale(scale);
        target.fill(
            Fill::NonZero,
            transform,
            Color::from_rgba8(15, 23, 42, 210),
            &RoundedRect::new(x0, y0, x0 + WIDTH, y1, 4.0),
        );
        let height = y1 - y0;
        let bar = WIDTH / FRAME_OVERLAY_SAMPLES as f64;
        let start = x0 + WIDTH - bar * samples.len() as f64;
        for (index, &sample) in samples.iter().enumerate() {
            let ms = f64::from(sample);
            let ratio = (ms / FRAME_OVERLAY_CEILING_MS).clamp(0.02, 1.0);
            let colour = if ms <= FRAME_OVERLAY_BUDGET_MS {
                Color::from_rgba8(74, 222, 128, 255)
            } else if ms <= FRAME_OVERLAY_CEILING_MS {
                Color::from_rgba8(250, 204, 21, 255)
            } else {
                Color::from_rgba8(248, 113, 113, 255)
            };
            let x = start + bar * index as f64;
            target.fill(
                Fill::NonZero,
                transform,
                colour,
                &BoxRect::new(x, y1 - height * ratio, x + bar, y1),
            );
        }
        let budget_y = y1 - height * (FRAME_OVERLAY_BUDGET_MS / FRAME_OVERLAY_CEILING_MS);
        target.fill(
            Fill::NonZero,
            transform,
            Color::from_rgba8(255, 255, 255, 140),
            &BoxRect::new(x0, budget_y, x0 + WIDTH, budget_y + 1.0),
        );
    }
    fn visual_state_for(&self, id: &str, node: &Node) -> VisualState {
        let otp_slot_focused = node.control.as_ref().is_some_and(|control| {
            if control.role != "otpSlot" || control.group.is_empty() {
                return false;
            }
            let Some(focused) = self.focused.as_deref() else {
                return false;
            };
            if focused != control.group {
                return false;
            }
            let Some(input) = self.entries.get(focused) else {
                return false;
            };
            let value = input.node.value.as_deref().unwrap_or("");
            // A selected character (a clicked filled slot) marks its own slot.
            let position = match self.selection_anchor {
                Some(anchor) if anchor != self.caret => anchor.min(self.caret),
                _ => self.caret,
            };
            let caret = floor_boundary(value, position.min(value.len()));
            let caret_slot = value[..caret].graphemes(true).count();
            let max_slot = control.max.max(0.0) as usize;
            control.value.max(0.0) as usize == caret_slot.min(max_slot)
        });
        VisualState {
            hovered: self.hovered.as_deref() == Some(id)
                || self.hover_styled.iter().any(|hovered| hovered == id),
            active: self.pressed.as_deref() == Some(id) && self.hovered.as_deref() == Some(id),
            focused: self.focused.as_deref() == Some(id) || otp_slot_focused,
            focus_visible: (self.focused.as_deref() == Some(id) || otp_slot_focused)
                && self.focus_visible,
            disabled: node.disabled,
        }
    }

    fn text_decoration_for(&self, id: &str) -> String {
        let mut current = Some(id);
        while let Some(current_id) = current {
            let Some(entry) = self.entries.get(current_id) else {
                break;
            };
            let state = self.visual_state_for(current_id, &entry.node);
            if let Some(value) = visual_value(&entry.node, "textDecoration", state).as_str() {
                return value.to_string();
            }
            current = entry.parent.as_deref();
        }
        "none".into()
    }

    fn link_foreground_for(&self, id: &str) -> Option<String> {
        let mut current = self.entries.get(id)?.parent.as_deref();
        while let Some(current_id) = current {
            let entry = self.entries.get(current_id)?;
            if entry
                .node
                .control
                .as_ref()
                .is_some_and(|control| control.role == "link")
            {
                let state = self.visual_state_for(current_id, &entry.node);
                return Some(
                    visual_string(&entry.node, "foreground", "#18181b", state).to_string(),
                );
            }
            current = entry.parent.as_deref();
        }
        None
    }

    pub(crate) fn resolved_text_foreground(&self, id: &str, fallback: &str) -> String {
        if let Some(link_foreground) = self.link_foreground_for(id) {
            return link_foreground;
        }
        let entry = &self.entries[id];
        let state = self.visual_state_for(id, &entry.node);
        visual_string(&entry.node, "foreground", fallback, state).to_string()
    }
    /// Paints one node and its subtree, applying its `transform` (translate /
    /// scale about the box centre) to everything underneath. Layout, hit
    /// testing and hover use the untransformed box.
    fn paint_node<P: PaintTarget>(
        &mut self,
        id: &str,
        offset: Vec2,
        scale: f64,
        clip: BoxRect,
        target: &mut P,
    ) {
        let Some(local) = self.node_transform(id, offset) else {
            self.paint_node_content(id, offset, scale, clip, target);
            return;
        };
        // Culling and visible text ranges run in the node's own space.
        let local_clip = local.inverse().transform_rect_bbox(clip);
        let device = Affine::scale(scale) * local * Affine::scale(1.0 / scale);
        target.push_transform(device);
        self.paint_node_content(id, offset, scale, local_clip, target);
        target.pop_transform();
    }

    /// The node's transform in layout space, if it is not the identity.
    fn node_transform(&self, id: &str, offset: Vec2) -> Option<Affine> {
        if self.animating.is_empty() && !self.transformed.contains(id) {
            return None;
        }
        let entry = self.entries.get(id)?;
        if !self.transformed.contains(id) && !entry.motions.contains_key("transform") {
            return None;
        }
        let state = self.visual_state_for(id, &entry.node);
        let values = entry
            .motions
            .get("transform")
            .filter(|track| {
                track.state_driven || !visual_state_overrides(&entry.node, "transform", state)
            })
            .map(|track| track.current.clone())
            .or_else(|| motion_value(&entry.node, "transform", state))
            .unwrap_or_else(|| vec![0.0, 0.0, 1.0, 1.0]);
        let [x, y, scale_x, scale_y] = [0, 1, 2, 3].map(|index| f64::from(values[index]));
        let angle = spin_period(&entry.node).map_or(0.0, |period| {
            std::f64::consts::TAU * (self.motion_time_ms.rem_euclid(period) / period)
        });
        if x == 0.0 && y == 0.0 && scale_x == 1.0 && scale_y == 1.0 && angle == 0.0 {
            return None;
        }
        let centre = (entry.rect + Vec2::new(-offset.x, -offset.y)).center();
        Some(
            Affine::translate((centre.x + x, centre.y + y))
                * Affine::rotate(angle)
                * Affine::scale_non_uniform(scale_x, scale_y)
                * Affine::translate((-centre.x, -centre.y)),
        )
    }

    fn paint_node_content<P: PaintTarget>(
        &mut self,
        id: &str,
        offset: Vec2,
        scale: f64,
        clip: BoxRect,
        target: &mut P,
    ) {
        let entry = &self.entries[id];
        let bounds = entry.bounds + Vec2::new(-offset.x, -offset.y);
        if bounds.x1 <= clip.x0
            || bounds.x0 >= clip.x1
            || bounds.y1 <= clip.y0
            || bounds.y0 >= clip.y1
        {
            return;
        }
        let node = entry.node.clone();
        if node.string("display", "flex") == "none" {
            return;
        }
        let rect = entry.rect + Vec2::new(-offset.x, -offset.y);
        let scroll_x = entry.scroll_x;
        let scroll = entry.scroll;
        let scroll_max_x = entry.scroll_max_x;
        let scroll_max = entry.scroll_max;
        let mut children = entry.children.clone();
        children.sort_by(|a, b| {
            self.stacking
                .get(a)
                .copied()
                .unwrap_or(0.0)
                .total_cmp(&self.stacking.get(b).copied().unwrap_or(0.0))
        });
        self.painted_nodes += 1;
        let transform = Affine::scale(scale);
        let state = self.visual_state_for(id, &node);
        // Paint-time values of running colour/shadow transitions. A state style
        // with no transition of its own still wins over a JS-driven track.
        let animated: HashMap<String, Vec<f32>> = entry
            .motions
            .iter()
            .filter(|(key, track)| track.state_driven || !visual_state_overrides(&node, key, state))
            .map(|(key, track)| (key.clone(), track.current.clone()))
            .collect();
        let suppress_root_chrome = self.window_chrome_suppressed && id == self.root;
        let radius = if suppress_root_chrome {
            0.0
        } else {
            visual_motion_number(entry, "radius", 0.0, state) as f64
        };
        let shape = RoundedRect::from_rect(rect, radius);
        let opacity = visual_motion_number(entry, "opacity", 1.0, state).clamp(0.0, 1.0);
        if opacity <= 0.0001 {
            return;
        }
        let opacity_layer = opacity < 0.9999;
        if opacity_layer {
            target.push_opacity(opacity, transform, &clip);
        }
        let shadows = if suppress_root_chrome {
            Vec::new()
        } else {
            animated.get("boxShadow").map_or_else(
                || box_shadows(&node, state),
                |values| box_shadows_from(values),
            )
        };
        for shadow in shadows.iter().rev().filter(|shadow| !shadow.inset) {
            paint_outer_shadow(target, transform, rect, radius, shape, shadow);
        }
        let background = animated.get("background").map_or_else(
            || background_vector(visual_value(&node, "background", state)),
            |values| values.to_vec(),
        );
        if let Some(gradient) = paint_gradient(&background, rect) {
            target.fill_gradient(transform, &gradient, &shape);
        } else {
            let bg = colour_from(&background);
            if bg.components[3] > 0.0 {
                target.fill(Fill::NonZero, transform, bg, &shape);
            }
        }
        let border = if suppress_root_chrome {
            [0.0; 4]
        } else {
            node.insets("borderWidth")
                .map(|value| value.max(0.0) as f64)
        };
        if shadows.iter().any(|shadow| shadow.inset) {
            let padding_box = BoxRect::new(
                rect.x0 + border[3],
                rect.y0 + border[0],
                (rect.x1 - border[1]).max(rect.x0 + border[3]),
                (rect.y1 - border[2]).max(rect.y0 + border[0]),
            );
            let inner_radius = (radius - border.iter().copied().fold(0.0, f64::max)).max(0.0);
            target.push_clip(
                Fill::NonZero,
                transform,
                &RoundedRect::from_rect(padding_box, inner_radius),
            );
            for shadow in shadows.iter().rev().filter(|shadow| shadow.inset) {
                paint_inset_shadow(target, transform, padding_box, inner_radius, shadow);
            }
            target.pop_layer();
        }
        if border.iter().any(|width| *width > 0.0) {
            let border_vector = animated.get("borderColor").map_or_else(
                || paint_vector(visual_value(&node, "borderColor", state), "#e4e4e7"),
                |values| values.to_vec(),
            );
            let border_gradient = paint_gradient(&border_vector, rect);
            let border_color = vector_colour(&border_vector);
            let border_hex = hex_of(border_color);
            let border_style = visual_string(&node, "borderStyle", "solid", state);
            let uniform = border
                .iter()
                .all(|width| (*width - border[0]).abs() < f64::EPSILON);
            if matches!(border_style, "none" | "hidden") {
                // Layout still reserves borderWidth; only the paint is suppressed.
            } else if let (Some(gradient), "solid") = (&border_gradient, border_style) {
                // Gradient borders fill the ring between the border and padding
                // boxes (CSS border-image with a gradient source).
                let inner = BoxRect::new(
                    rect.x0 + border[3],
                    rect.y0 + border[0],
                    (rect.x1 - border[1]).max(rect.x0 + border[3]),
                    (rect.y1 - border[2]).max(rect.y0 + border[0]),
                );
                let inner_radius = (radius - border.iter().copied().fold(0.0, f64::max)).max(0.0);
                let mut ring = vello::kurbo::Shape::to_path(&shape, 0.1);
                ring.extend(vello::kurbo::Shape::path_elements(
                    &RoundedRect::from_rect(inner, inner_radius),
                    0.1,
                ));
                target.push_clip(Fill::EvenOdd, transform, &ring);
                target.fill_gradient(transform, gradient, &shape);
                target.pop_layer();
            } else if uniform
                && border_gradient.as_ref().is_some_and(|gradient| {
                    paint_gradient_styled_border(
                        target,
                        transform,
                        rect,
                        radius,
                        border[0],
                        border_style,
                        gradient,
                    )
                })
            {
            } else if uniform && border_style != "solid" {
                // A border is an outline drawn inside the border box.
                paint_outline(
                    target,
                    transform,
                    rect,
                    radius,
                    Outline {
                        width: border[0],
                        offset: -border[0],
                        radius_override: None,
                        color: &border_hex,
                        style: border_style,
                    },
                );
            } else if uniform {
                let width = border[0];
                target.stroke(
                    &Stroke::new(width),
                    transform,
                    border_color,
                    &RoundedRect::from_rect(
                        rect.inset(-width / 2.0),
                        (radius - width / 2.0).max(0.0),
                    ),
                );
            } else {
                target.push_clip(Fill::NonZero, transform, &shape);
                if border[0] > 0.0 {
                    target.fill(
                        Fill::NonZero,
                        transform,
                        border_color,
                        &BoxRect::new(
                            rect.x0,
                            rect.y0,
                            rect.x1,
                            (rect.y0 + border[0]).min(rect.y1),
                        ),
                    );
                }
                if border[1] > 0.0 {
                    target.fill(
                        Fill::NonZero,
                        transform,
                        border_color,
                        &BoxRect::new(
                            (rect.x1 - border[1]).max(rect.x0),
                            rect.y0,
                            rect.x1,
                            rect.y1,
                        ),
                    );
                }
                if border[2] > 0.0 {
                    target.fill(
                        Fill::NonZero,
                        transform,
                        border_color,
                        &BoxRect::new(
                            rect.x0,
                            (rect.y1 - border[2]).max(rect.y0),
                            rect.x1,
                            rect.y1,
                        ),
                    );
                }
                if border[3] > 0.0 {
                    target.fill(
                        Fill::NonZero,
                        transform,
                        border_color,
                        &BoxRect::new(
                            rect.x0,
                            rect.y0,
                            (rect.x0 + border[3]).min(rect.x1),
                            rect.y1,
                        ),
                    );
                }
                target.pop_layer();
            }
        }
        let outline_width = visual_number(&node, "outlineWidth", 0.0, state).max(0.0) as f64;
        if outline_width > 0.0 {
            paint_outline(
                target,
                transform,
                rect,
                radius,
                Outline {
                    width: outline_width,
                    offset: visual_number(&node, "outlineOffset", 0.0, state) as f64,
                    radius_override: visual_optional_number(&node, "outlineRadius", state),
                    color: visual_string(&node, "outlineColor", "#a1a1aa", state),
                    style: visual_string(&node, "outlineStyle", "solid", state),
                },
            );
        }
        if node.is_text() {
            let ime_display = self.ime_display(id);
            let render_node = ime_display
                .as_ref()
                .map(|display| display.node.clone())
                .unwrap_or_else(|| node.clone());
            if ime_display.is_some() {
                self.text.prepare(&render_node);
            }
            let pad = node.insets("padding");
            let available_width =
                (rect.width() - pad[1] as f64 - pad[3] as f64 - border[1] - border[3]).max(0.0)
                    as f32;
            let (tw, th) = self.text.measure(
                &render_node.id,
                if matches!(node.kind.as_str(), "text" | "markdown" | "textarea") {
                    Some(available_width)
                } else {
                    None
                },
            );
            let gutter = f64::from(self.text.code_gutter_width(&node));
            let mut x = rect.x0 + pad[3] as f64 + border[3] + gutter
                - if node.kind == "code" { scroll_x } else { 0.0 };
            let y = if matches!(node.kind.as_str(), "text" | "markdown" | "code") {
                rect.y0 + pad[0] as f64 + border[0]
            } else if node.kind == "textarea" {
                rect.y0 + pad[0] as f64 + border[0] - scroll
            } else {
                rect.y0 + (rect.height() - th as f64) / 2.0
            };
            let visible_text_y = (clip.y0.max(rect.y0) - y, clip.y1.min(rect.y1) - y);
            if node.kind == "button" {
                x = rect.x0 + (rect.width() - tw as f64) / 2.0;
            }
            let foreground_vector = animated.get("foreground").cloned().or_else(|| {
                let value = visual_value(&node, "foreground", state);
                value.is_object().then(|| background_vector(value))
            });
            let foreground_gradient = foreground_vector
                .as_deref()
                .filter(|_| {
                    matches!(node.kind.as_str(), "text" | "button") && ime_display.is_none()
                })
                .and_then(|values| paint_gradient(values, rect));
            let foreground = if let Some(values) = &foreground_vector {
                hex_of(vector_colour(values))
            } else if matches!(node.kind.as_str(), "input" | "textarea")
                && render_node.value.as_deref().unwrap_or("").is_empty()
            {
                visual_string(&node, "placeholderColor", "#a1a1aa", state).to_string()
            } else if matches!(node.kind.as_str(), "text" | "markdown" | "code") {
                self.resolved_text_foreground(id, "#18181b")
            } else {
                visual_string(&node, "foreground", "#18181b", state).to_string()
            };
            // The shadow is ink overflow: it may extend past the text box by its
            // own offset, so it gets a clip grown by that offset instead of the
            // node clip used for the glyphs themselves.
            if matches!(node.kind.as_str(), "text" | "button" | "input" | "textarea")
                && ime_display.is_none()
                && let Some(shadow) = animated.get("textShadow").map_or_else(
                    || text_shadow(&node, state),
                    |values| text_shadow_from(values),
                )
            {
                let (dx, dy, blur) = (shadow.0, shadow.1, shadow.2);
                // A gaussian of sigma = blur / 2 is invisible past 3 sigma.
                let reach = (blur * 1.5).ceil();
                let shadow_clip = BoxRect::new(
                    rect.x0 + dx.min(0.0) - reach,
                    rect.y0 + dy.min(0.0) - reach,
                    rect.x1 + dx.max(0.0) + reach,
                    rect.y1 + dy.max(0.0) + reach,
                );
                target.push_clip(Fill::NonZero, transform, &shadow_clip);
                self.text.draw_shadow(
                    target,
                    &render_node.id,
                    (x + dx, y + dy),
                    shadow.3,
                    blur,
                    scale,
                );
                target.pop_layer();
            }
            target.push_clip(Fill::NonZero, transform, &shape);
            let code_source_clip = (node.kind == "code").then(|| {
                let left = rect.x0 + pad[3] as f64 + border[3] + gutter;
                let right = (rect.x1 - pad[1] as f64 - border[1]).max(left);
                BoxRect::new(left, rect.y0, right, rect.y1)
            });
            if node.kind == "markdown" {
                self.text.draw_markdown_blocks(
                    target,
                    &render_node,
                    (x, y),
                    available_width,
                    scale,
                    visible_text_y,
                );
            }
            if let Some(source_clip) = code_source_clip {
                target.push_clip(Fill::NonZero, transform, &source_clip);
            }
            if matches!(node.kind.as_str(), "text" | "markdown" | "code") {
                let wrap_width = (node.kind != "code").then_some(available_width);
                let visible_markdown_bytes = (node.kind == "markdown")
                    .then(|| {
                        self.text.markdown_visible_byte_range(
                            &render_node.id,
                            available_width,
                            visible_text_y,
                        )
                    })
                    .flatten();
                if let Some(highlights) = self.highlight_ranges.get(id) {
                    for highlight in highlights {
                        if visible_markdown_bytes.as_ref().is_some_and(|visible| {
                            highlight.range.end <= visible.start
                                || highlight.range.start >= visible.end
                        }) {
                            continue;
                        }
                        for wash in self.text.range_rects(
                            &render_node.id,
                            highlight.range.start,
                            highlight.range.end,
                            wrap_width,
                        ) {
                            target.fill(
                                Fill::NonZero,
                                transform,
                                highlight.color,
                                &BoxRect::new(x + wash.x0, y + wash.y0, x + wash.x1, y + wash.y1),
                            );
                        }
                    }
                }
            }
            if matches!(node.kind.as_str(), "text" | "markdown" | "code")
                && let Some((start, end)) = self.static_selection_range_for(id)
            {
                for selection in self.text_range_rects(
                    &node,
                    id,
                    &node.text,
                    start,
                    end,
                    (node.kind != "code").then_some(available_width),
                ) {
                    target.fill(
                        Fill::NonZero,
                        transform,
                        color(visual_string(&node, "selectionColor", "#dbeafe", state)),
                        &BoxRect::new(
                            x + selection.x0,
                            y + selection.y0,
                            x + selection.x1,
                            y + selection.y1,
                        ),
                    );
                }
            }
            if code_source_clip.is_some() {
                target.pop_layer();
            }
            if matches!(node.kind.as_str(), "input" | "textarea")
                && self.focused.as_deref() == Some(id)
                && ime_display.is_none()
                && let Some((start, end)) = self.selected_range()
            {
                let wrap_width = (node.kind == "textarea").then_some(available_width);
                for selection in self.selection_rects(id, start, end, wrap_width) {
                    target.fill(
                        Fill::NonZero,
                        transform,
                        color(visual_string(&node, "selectionColor", "#dbeafe", state)),
                        &BoxRect::new(
                            x + selection.x0,
                            y + selection.y0,
                            x + selection.x1,
                            y + selection.y1,
                        ),
                    );
                }
            }
            if let Some(display) = &ime_display {
                let wrap_width = (node.kind == "textarea").then_some(available_width);
                if let Some((anchor, caret)) = display.cursor_range
                    && anchor != caret
                {
                    for selection in self.text_range_rects(
                        &display.node,
                        &display.node.id,
                        &display.value,
                        anchor.min(caret),
                        anchor.max(caret),
                        wrap_width,
                    ) {
                        target.fill(
                            Fill::NonZero,
                            transform,
                            color(visual_string(&node, "selectionColor", "#dbeafe", state)),
                            &BoxRect::new(
                                x + selection.x0,
                                y + selection.y0,
                                x + selection.x1,
                                y + selection.y1,
                            ),
                        );
                    }
                }
                for marked in self.text_range_rects(
                    &display.node,
                    &display.node.id,
                    &display.value,
                    display.marked_range.0,
                    display.marked_range.1,
                    wrap_width,
                ) {
                    let underline_y = y + marked.y1 - 1.0;
                    target.fill(
                        Fill::NonZero,
                        transform,
                        color(visual_string(&node, "caretColor", "#18181b", state)),
                        &BoxRect::new(x + marked.x0, underline_y, x + marked.x1, underline_y + 1.0),
                    );
                }
            }
            let text_area = crate::text::TextDrawArea {
                // Code paint owns the gutter and horizontal scroll offset.
                // Keep its paint origin fixed at the content box so line
                // numbers do not slide away when the code scrolls.
                origin: if node.kind == "code" {
                    (x - gutter + scroll_x, y)
                } else {
                    (x, y)
                },
                width: available_width,
                visible_y: visible_text_y,
                scroll_x: if node.kind == "code" { scroll_x } else { 0.0 },
            };
            if let Some(gradient) = &foreground_gradient {
                self.text.draw_gradient(
                    target,
                    &render_node,
                    text_area,
                    gradient,
                    transform,
                    scale,
                );
            } else {
                self.text
                    .draw(target, &render_node, text_area, color(&foreground), scale);
            }
            let decoration = self.text_decoration_for(id);
            if decoration != "none" {
                if let Some(source_clip) = code_source_clip {
                    target.push_clip(Fill::NonZero, transform, &source_clip);
                }
                let display_text = render_node.display_text();
                if !display_text.is_empty() {
                    let wrap_width = matches!(node.kind.as_str(), "text" | "markdown" | "textarea")
                        .then_some(available_width);
                    let thickness =
                        f64::from((node.number("fontSize", 14.0) * 0.06).clamp(1.0, 2.0));
                    for line in
                        self.text
                            .range_rects(&render_node.id, 0, display_text.len(), wrap_width)
                    {
                        let line_y = match decoration.as_str() {
                            "underline" => y + line.y1 - thickness,
                            "overline" => y + line.y0,
                            "line-through" => y + (line.y0 + line.y1) * 0.5 - thickness * 0.5,
                            _ => continue,
                        };
                        target.fill(
                            Fill::NonZero,
                            transform,
                            color(&foreground),
                            &BoxRect::new(x + line.x0, line_y, x + line.x1, line_y + thickness),
                        );
                    }
                }
                if code_source_clip.is_some() {
                    target.pop_layer();
                }
            }
            if matches!(node.kind.as_str(), "input" | "textarea")
                && self.focused.as_deref() == Some(id)
                && self.user_select_mode(id) != UserSelectMode::None
                && (ime_display.is_some() || self.caret_visible())
            {
                let caret = if let Some(display) = &ime_display {
                    display.cursor_range.map(|(_, caret)| caret)
                } else {
                    let value = node.value.as_deref().unwrap_or("");
                    Some(floor_boundary(value, self.caret.min(value.len())))
                };
                if let Some(caret) = caret {
                    let value = ime_display
                        .as_ref()
                        .map(|display| display.value.as_str())
                        .unwrap_or_else(|| node.value.as_deref().unwrap_or(""));
                    let display_index = input_display_index(&render_node, value, caret);
                    let wrap_width = (node.kind == "textarea").then_some(available_width);
                    if let Some(cursor) =
                        self.text
                            .caret_rect(&render_node.id, display_index, wrap_width)
                    {
                        let content_right = rect.x1 - pad[1] as f64 - border[1];
                        let cx = (x + cursor.x0).clamp(x, content_right.max(x));
                        let cy0 = y + cursor.y0;
                        let cy1 = y + cursor.y1;
                        target.fill(
                            Fill::NonZero,
                            transform,
                            color(visual_string(&node, "caretColor", "#18181b", state)),
                            &BoxRect::new(cx, cy0, cx + 1.0, cy1.max(cy0 + 1.0)),
                        );
                    }
                }
            }
            target.pop_layer();
        }
        if node.kind == "svg"
            && let Some(scene) = self.svgs.get(id).cloned()
        {
            crate::svg::draw(
                target,
                &scene,
                rect,
                color(visual_string(&node, "foreground", "#18181b", state)),
                scale,
            );
        }
        if node.kind == "slider" {
            crate::controls::slider(
                target,
                &node,
                rect,
                scale,
                color(visual_string(
                    &node,
                    "foreground",
                    if node.disabled { "#a1a1aa" } else { "#18181b" },
                    state,
                )),
                color(visual_string(&node, "borderColor", "#e4e4e7", state)),
                color(visual_string(&node, "thumbColor", "#ffffff", state)),
            );
        }
        if node.kind == "image" {
            target.push_clip(Fill::NonZero, transform, &shape);
            if let Some((key, image)) = image_cache_key(&node)
                .and_then(|key| self.images.get(key).map(|image| (key, image)))
            {
                let sx = rect.width() / image.width as f64;
                let sy = rect.height() / image.height as f64;
                let factor = if node.fit == "contain" {
                    sx.min(sy)
                } else {
                    sx.max(sy)
                };
                let tx = rect.x0 + (rect.width() - image.width as f64 * factor) / 2.0;
                let ty = rect.y0 + (rect.height() - image.height as f64 * factor) / 2.0;
                target.draw_image(
                    key,
                    image,
                    transform * Affine::translate((tx, ty)) * Affine::scale(factor),
                );
            } else {
                target.fill(
                    Fill::NonZero,
                    transform,
                    color(visual_string(
                        &node,
                        "placeholderBackground",
                        "#f4f4f5",
                        state,
                    )),
                    &shape,
                );
            }
            target.pop_layer();
        }
        if node.kind == "scroll" {
            target.push_clip(Fill::NonZero, transform, &shape);
        }
        let child_clip = if node.kind == "scroll" {
            clip.intersect(rect)
        } else {
            clip
        };
        for child in &children {
            if self.entries[child].node.portal && !node.portal {
                continue;
            }
            self.paint_node(
                child,
                offset + Vec2::new(scroll_x, scroll),
                scale,
                child_clip,
                target,
            );
        }
        if node.kind == "scroll" {
            target.pop_layer();
        }
        if node.kind == "diff" {
            let pad = node.insets("padding");
            let inner = (
                rect.x0 + pad[3] as f64 + border[3],
                rect.y0 + pad[0] as f64 + border[0],
            );
            target.push_clip(Fill::NonZero, transform, &shape);
            self.text.draw_diff(
                target,
                &node,
                DiffPaintArea {
                    rect,
                    clip: clip.intersect(rect),
                    origin: inner,
                },
                color(visual_string(&node, "foreground", "#18181b", state)),
                DiffPaintDecorations {
                    selection: self.static_selection_range_for(id),
                    highlights: self
                        .highlight_ranges
                        .get(id)
                        .map(Vec::as_slice)
                        .unwrap_or(&[]),
                },
                scale,
            );
            target.pop_layer();
        }
        if matches!(node.kind.as_str(), "scroll" | "textarea") && scroll_max > 0.0 {
            let track = rect.height() - 12.0;
            let thumb = (track * rect.height() / (rect.height() + scroll_max)).max(28.0);
            let top = rect.y0 + 6.0 + (track - thumb) * scroll / scroll_max;
            target.fill(
                Fill::NonZero,
                transform,
                color(visual_string(&node, "scrollbarColor", "#d4d4d8", state)),
                &RoundedRect::new(rect.x1 - 7.0, top, rect.x1 - 3.0, top + thumb, 2.0),
            );
        }
        if node.kind == "scroll" && scroll_max_x > 0.0 {
            let track = rect.width() - 12.0;
            let thumb = (track * rect.width() / (rect.width() + scroll_max_x))
                .max(28.0)
                .min(track);
            let left = rect.x0 + 6.0 + (track - thumb) * scroll_x / scroll_max_x;
            target.fill(
                Fill::NonZero,
                transform,
                color(visual_string(&node, "scrollbarColor", "#d4d4d8", state)),
                &RoundedRect::new(left, rect.y1 - 7.0, left + thumb, rect.y1 - 3.0, 2.0),
            );
        }
        if opacity_layer {
            target.pop_layer();
        }
    }
    /// Recomputes `hover_styled`; repaints only when that set changes.
    fn refresh_hover_chain(&mut self) {
        let next: Vec<String> = self
            .hover_path()
            .into_iter()
            .filter(|id| {
                self.entries.get(id).is_some_and(|entry| {
                    !entry.node.disabled
                        && entry.node.style.get("hover").is_some_and(Value::is_object)
                })
            })
            .collect();
        if next != self.hover_styled {
            self.hover_styled = next;
            self.dirty.paint = true;
        }
    }

    /// Root-to-leaf ids of the deepest node under the pointer, whatever its kind.
    fn hover_path(&self) -> Vec<String> {
        if !self.entries.contains_key(&self.root) {
            return Vec::new();
        }
        let root_rect = self.entries[&self.root].rect;
        let portals = &self.portal_order;
        for portal in portals.iter().rev() {
            if let Some(path) = self.hover_path_in(
                portal,
                self.ancestor_scroll_offset(portal),
                root_rect,
                self.mouse.into(),
            ) {
                return path;
            }
        }
        self.hover_path_in(&self.root, Vec2::ZERO, root_rect, self.mouse.into())
            .unwrap_or_default()
    }

    fn hover_path_in(
        &self,
        id: &str,
        offset: Vec2,
        clip: BoxRect,
        mouse: vello::kurbo::Point,
    ) -> Option<Vec<String>> {
        let entry = self.entries.get(id)?;
        let (mouse, clip) = match self.node_transform(id, offset) {
            Some(transform) => {
                let inverse = transform.inverse();
                (inverse * mouse, inverse.transform_rect_bbox(clip))
            }
            None => (mouse, clip),
        };
        if !(entry.bounds + Vec2::new(-offset.x, -offset.y)).contains(mouse)
            || entry.node.string("display", "flex") == "none"
        {
            return None;
        }
        let rect = entry.rect + Vec2::new(-offset.x, -offset.y);
        let clip = if entry.node.kind == "scroll" {
            clip.intersect(rect)
        } else {
            clip
        };
        if !clip.contains(mouse) {
            return None;
        }
        let children = self.hit_order(id, &entry.children);
        for child in children.iter().rev() {
            if self.entries[child].node.portal && !entry.node.portal {
                continue;
            }
            if let Some(mut path) = self.hover_path_in(
                child,
                offset + Vec2::new(entry.scroll_x, entry.scroll),
                clip,
                mouse,
            ) {
                path.insert(0, id.to_string());
                return Some(path);
            }
        }
        rect.contains(mouse).then(|| vec![id.to_string()])
    }

    fn hit_root(&self, scroll_only: bool) -> Option<String> {
        let root_rect = self.entries[&self.root].rect;
        let portals = &self.portal_order;
        for portal in portals.iter().rev() {
            if let Some(id) = self.hit(
                portal,
                self.ancestor_scroll_offset(portal),
                root_rect,
                scroll_only,
                self.mouse.into(),
            ) {
                return Some(id);
            }
        }
        self.hit(
            &self.root,
            Vec2::ZERO,
            root_rect,
            scroll_only,
            self.mouse.into(),
        )
    }

    fn selectable_text_hit_root(&self) -> Option<String> {
        let root_rect = self.entries[&self.root].rect;
        let portals = &self.portal_order;
        for portal in portals.iter().rev() {
            match self.selectable_text_hit(portal, self.ancestor_scroll_offset(portal), root_rect) {
                SelectableTextHit::Text(id) => return Some(id),
                SelectableTextHit::Blocked => return None,
                SelectableTextHit::Miss => {}
            }
        }
        match self.selectable_text_hit(&self.root, Vec2::ZERO, root_rect) {
            SelectableTextHit::Text(id) => Some(id),
            SelectableTextHit::Miss | SelectableTextHit::Blocked => None,
        }
    }

    fn selectable_text_hit(&self, id: &str, offset: Vec2, clip: BoxRect) -> SelectableTextHit {
        let entry = &self.entries[id];
        if !(entry.bounds + Vec2::new(-offset.x, -offset.y)).contains(self.mouse)
            || entry.node.disabled
            || entry.node.string("display", "flex") == "none"
        {
            return SelectableTextHit::Miss;
        }
        let rect = entry.rect + Vec2::new(-offset.x, -offset.y);
        let clip = if entry.node.kind == "scroll" {
            clip.intersect(rect)
        } else {
            clip
        };
        if !clip.contains(self.mouse) {
            return SelectableTextHit::Miss;
        }
        let children = self.hit_order(id, &entry.children);
        for child in children.iter().rev() {
            if self.entries[child].node.portal && !entry.node.portal {
                continue;
            }
            match self.selectable_text_hit(
                child,
                offset + Vec2::new(entry.scroll_x, entry.scroll),
                clip,
            ) {
                SelectableTextHit::Text(id) => return SelectableTextHit::Text(id),
                SelectableTextHit::Blocked => return SelectableTextHit::Blocked,
                SelectableTextHit::Miss => {}
            }
        }
        if matches!(
            entry.node.kind.as_str(),
            "text" | "markdown" | "code" | "diff"
        ) && self.user_select_mode(id) != UserSelectMode::None
            && rect.contains(self.mouse)
        {
            return SelectableTextHit::Text(id.to_string());
        }
        if rect.contains(self.mouse)
            && (entry.node.interactive()
                || entry.node.string("pointerEvents", "auto") == "block"
                || entry.node.modal)
        {
            return SelectableTextHit::Blocked;
        }
        SelectableTextHit::Miss
    }

    pub(crate) fn selectable_text_at_pointer(&self) -> Option<String> {
        self.selectable_text_hit_root()
    }

    fn hit(
        &self,
        id: &str,
        offset: Vec2,
        clip: BoxRect,
        scroll_only: bool,
        mouse: vello::kurbo::Point,
    ) -> Option<String> {
        let entry = &self.entries[id];
        let (mouse, clip) = match self.node_transform(id, offset) {
            Some(transform) => {
                let inverse = transform.inverse();
                (inverse * mouse, inverse.transform_rect_bbox(clip))
            }
            None => (mouse, clip),
        };
        if !(entry.bounds + Vec2::new(-offset.x, -offset.y)).contains(mouse) {
            return None;
        }
        if entry.node.disabled || entry.node.string("display", "flex") == "none" {
            return None;
        }
        let rect = entry.rect + Vec2::new(-offset.x, -offset.y);
        let clip = if entry.node.kind == "scroll" {
            clip.intersect(rect)
        } else {
            clip
        };
        if !clip.contains(mouse) {
            return None;
        }
        let children = self.hit_order(id, &entry.children);
        for child in children.iter().rev() {
            if self.entries[child].node.portal && !entry.node.portal {
                continue;
            }
            if let Some(id) = self.hit(
                child,
                offset + Vec2::new(entry.scroll_x, entry.scroll),
                clip,
                scroll_only,
                mouse,
            ) {
                return Some(id);
            }
        }
        let blocks_pointer = entry.node.string("pointerEvents", "auto") == "block";
        let eligible = if scroll_only {
            (matches!(entry.node.kind.as_str(), "scroll" | "textarea")
                && (entry.scroll_max > 0.0 || entry.scroll_max_x > 0.0))
                || (entry.node.kind == "code" && entry.scroll_max_x > 0.0)
                || blocks_pointer
                || entry.node.modal
        } else {
            entry.node.interactive() || entry.node.kind == "markdown" || blocks_pointer
        };
        (eligible && rect.contains(mouse)).then(|| id.to_string())
    }
    fn interactive(&self, id: &str) -> bool {
        let Some(target) = self.entries.get(id) else {
            return false;
        };
        if !target.node.interactive() {
            return false;
        }
        let mut current = Some(id);
        while let Some(current_id) = current {
            let Some(entry) = self.entries.get(current_id) else {
                return false;
            };
            if entry.node.disabled || entry.node.string("display", "flex") == "none" {
                return false;
            }
            current = entry.parent.as_deref();
        }
        true
    }
    fn accessibility_interactive(&self, id: &str) -> bool {
        !self.is_virtual_parked(id)
            && self.interactive(id)
            && self
                .active_modal()
                .is_none_or(|modal| self.is_descendant_of(id, modal))
    }
    fn accessibility_in_scope(&self, id: &str) -> bool {
        self.entries.contains_key(id)
            && !self.is_virtual_parked(id)
            && self
                .active_modal()
                .is_none_or(|modal| self.is_descendant_of(id, modal))
    }
    fn roving_group(&self, id: &str) -> Option<&str> {
        let group = self.entries.get(id)?.node.roving_group.as_str();
        (!group.is_empty()).then_some(group).or_else(|| {
            self.entries[id]
                .node
                .control
                .as_ref()
                .map(|control| control.group.as_str())
                .filter(|group| !group.is_empty())
        })
    }
    fn focus_order(&self) -> Vec<String> {
        let modal = self.active_modal();
        let mut group_choice = HashMap::<String, String>::default();
        for id in &self.order {
            if !self.interactive(id)
                || self.is_virtual_parked(id)
                || !self.entries[id].node.focusable
                || modal.is_some_and(|modal| !self.is_descendant_of(id, modal))
            {
                continue;
            }
            if let Some(group) = self.roving_group(id) {
                let choice = group_choice
                    .entry(group.to_string())
                    .or_insert_with(|| id.clone());
                let chosen = self.entries[id]
                    .node
                    .control
                    .as_ref()
                    .is_some_and(|control| {
                        control.selected == Some(true) || control.checked == Some(true)
                    });
                if chosen {
                    *choice = id.clone();
                }
            }
        }
        if let Some(id) = &self.focused
            && let Some(group) = self.roving_group(id)
            && group_choice.contains_key(group)
        {
            group_choice.insert(group.to_string(), id.clone());
        }
        self.order
            .iter()
            .filter(|id| {
                self.interactive(id)
                    && !self.is_virtual_parked(id)
                    && self.entries[*id].node.focusable
                    && modal.is_none_or(|modal| self.is_descendant_of(id, modal))
                    && self
                        .roving_group(id)
                        .is_none_or(|group| group_choice.get(group) == Some(*id))
            })
            .cloned()
            .collect()
    }
    fn set_focus_visible(&mut self, visible: bool) {
        if self.focus_visible != visible {
            self.focus_visible = visible;
            if self.focused.is_some() {
                self.dirty.paint = true;
            }
        }
    }

    fn focus_with_visibility(&mut self, id: &str, visible: bool) -> Option<String> {
        let modal = self.active_modal();
        if !self.interactive(id)
            || !self.entries[id].node.focusable
            || modal.is_some_and(|modal| !self.is_descendant_of(id, modal))
        {
            return None;
        }
        self.set_focus_visible(visible);
        let mut blurred = None;
        if self.focused.as_deref() != Some(id) {
            self.ime_cancel();
            blurred = self.focused.replace(id.to_string());
            self.selection_anchor = None;
            self.text_dragging = false;
            self.static_selection = None;
            self.static_text_dragging = false;
            self.caret = self.entries[id].node.value.as_deref().map_or(0, str::len);
            self.dirty.paint = true;
            self.touch_caret();
        }
        let mut virtual_scrolls = Vec::new();
        let mut ancestor = self.entries[id].parent.clone();
        while let Some(parent_id) = ancestor {
            if self.entries[&parent_id].node.kind == "scroll"
                && let (Some(target), Some(viewport)) =
                    (self.visible_rect(id), self.visible_rect(&parent_id))
            {
                let delta_x = if target.x0 < viewport.x0 {
                    target.x0 - viewport.x0
                } else if target.x1 > viewport.x1 {
                    target.x1 - viewport.x1
                } else {
                    0.0
                };
                let delta_y = if target.y0 < viewport.y0 {
                    target.y0 - viewport.y0
                } else if target.y1 > viewport.y1 {
                    target.y1 - viewport.y1
                } else {
                    0.0
                };
                let entry = self.entries.get_mut(&parent_id).unwrap();
                let next_x = (entry.scroll_x + delta_x).clamp(0.0, entry.scroll_max_x);
                let next_y = (entry.scroll + delta_y).clamp(0.0, entry.scroll_max);
                if next_x != entry.scroll_x || next_y != entry.scroll {
                    let variable_list = entry.node.virtual_list.is_some();
                    let follows_tail = entry
                        .node
                        .virtual_list
                        .as_ref()
                        .is_some_and(|metadata| metadata.follow_tail);
                    entry.scroll_x = next_x;
                    entry.scroll = next_y;
                    if variable_list {
                        entry.virtual_following_tail =
                            follows_tail && (next_y - entry.scroll_max).abs() <= 0.5;
                    }
                    self.dirty.paint = true;
                    if variable_list {
                        virtual_scrolls.push(parent_id.clone());
                    }
                }
            }
            ancestor = self.entries[&parent_id].parent.clone();
        }
        for list_id in virtual_scrolls {
            self.refresh_virtual_anchor(&list_id);
        }
        self.sync_virtual_focus();
        blurred
    }

    pub fn focus(&mut self, id: &str) -> Option<String> {
        self.focus_with_visibility(id, true)
    }
    fn prune_interaction(&mut self) {
        self.edit_history.retain(|id, _| {
            self.entries
                .get(id)
                .is_some_and(|entry| matches!(entry.node.kind.as_str(), "input" | "textarea"))
        });
        let keep_hovered = self
            .hovered
            .as_deref()
            .is_some_and(|id| self.interactive(id));
        let modal = self.active_modal().map(str::to_string);
        let keep_focused = self.focused.as_deref().is_some_and(|id| {
            self.interactive(id)
                && self.entries[id].node.focusable
                && modal
                    .as_deref()
                    .is_none_or(|modal| self.is_descendant_of(id, modal))
        });
        let keep_pressed = self
            .pressed
            .as_deref()
            .is_some_and(|id| self.interactive(id));
        let keep_static_selection = self.static_selection.as_ref().is_none_or(|selection| {
            self.entries.contains_key(&selection.anchor_id)
                && self.entries.contains_key(&selection.focus_id)
                && selection
                    .atomic_root
                    .as_ref()
                    .is_none_or(|root| self.entries.contains_key(root))
                && self.user_select_mode(&selection.anchor_id) != UserSelectMode::None
                && self.user_select_mode(&selection.focus_id) != UserSelectMode::None
        });
        let changed = (!keep_hovered && self.hovered.is_some())
            || (!keep_focused && self.focused.is_some())
            || (!keep_pressed && self.pressed.is_some());
        if !keep_hovered {
            self.hovered = None;
        }
        if !keep_focused {
            // Moving focus into a modal keeps the input modality: a mouse-opened
            // dialog must not paint a keyboard ring on its first control.
            let keyboard = self.focus_visible;
            self.ime_cancel();
            self.focused = None;
            self.focus_visible = false;
            self.caret = 0;
            self.selection_anchor = None;
            self.text_dragging = false;
            if modal.is_some()
                && let Some(id) = self.focus_order().into_iter().next()
            {
                let _ = self.focus_with_visibility(&id, keyboard);
            }
        }
        if !keep_pressed {
            self.pressed = None;
        }
        if self
            .focused
            .as_deref()
            .is_some_and(|id| self.user_select_mode(id) == UserSelectMode::None)
        {
            self.selection_anchor = None;
            self.text_dragging = false;
        }
        if !keep_static_selection {
            self.static_selection = None;
            self.static_text_dragging = false;
        }
        if self
            .scroll_drag
            .as_ref()
            .is_some_and(|drag| !self.entries.contains_key(&drag.id))
        {
            self.scroll_drag = None;
        }
        if changed {
            self.dirty.paint = true;
        }
        self.sync_virtual_focus();
    }

    pub(crate) fn active_modal(&self) -> Option<&str> {
        self.order
            .iter()
            .rev()
            .find(|id| self.entries[*id].node.modal)
            .map(String::as_str)
    }

    pub(crate) fn is_descendant_of(&self, id: &str, ancestor: &str) -> bool {
        let mut current = Some(id);
        while let Some(current_id) = current {
            if current_id == ancestor {
                return true;
            }
            current = self
                .entries
                .get(current_id)
                .and_then(|entry| entry.parent.as_deref());
        }
        false
    }
    pub(crate) fn user_select_mode(&self, id: &str) -> UserSelectMode {
        let Some(entry) = self.entries.get(id) else {
            return UserSelectMode::None;
        };
        match entry.node.string("userSelect", "auto") {
            "none" => UserSelectMode::None,
            "all" => UserSelectMode::All,
            "text" => UserSelectMode::Text,
            _ => {
                let mut parent = entry.parent.as_deref();
                while let Some(parent_id) = parent {
                    let Some(parent_entry) = self.entries.get(parent_id) else {
                        break;
                    };
                    match parent_entry.node.string("userSelect", "auto") {
                        "none" => return UserSelectMode::None,
                        "all" => return UserSelectMode::All,
                        "text" => return UserSelectMode::Text,
                        _ => parent = parent_entry.parent.as_deref(),
                    }
                }
                if matches!(entry.node.kind.as_str(), "input" | "textarea") {
                    UserSelectMode::Text
                } else {
                    UserSelectMode::None
                }
            }
        }
    }
    fn user_select_all_root(&self, id: &str) -> Option<String> {
        let mut current = Some(id);
        let mut selected = None;
        while let Some(current_id) = current {
            let entry = self.entries.get(current_id)?;
            match entry.node.string("userSelect", "auto") {
                "all" => selected = Some(current_id.to_string()),
                "none" | "text" => break,
                _ => {}
            }
            current = entry.parent.as_deref();
        }
        selected
    }
    pub(crate) fn visible_rect(&self, id: &str) -> Option<BoxRect> {
        let entry = self.entries.get(id)?;
        let mut offset = Vec2::ZERO;
        let mut current = entry.parent.as_deref();
        while let Some(parent_id) = current {
            let parent = self.entries.get(parent_id)?;
            offset += Vec2::new(parent.scroll_x, parent.scroll);
            current = parent.parent.as_deref();
        }
        Some(entry.rect + Vec2::new(-offset.x, -offset.y))
    }
    fn set_slider(&mut self, id: &str, value: f64) -> Vec<Value> {
        if !value.is_finite() {
            return vec![];
        }
        let Some(entry) = self.entries.get_mut(id) else {
            return vec![];
        };
        let Some(control) = entry.node.control.as_mut() else {
            return vec![];
        };
        let steps = ((value - control.min) / control.step).round();
        let next = (control.min + steps * control.step).clamp(control.min, control.max);
        let tolerance = f64::EPSILON * next.abs().max(control.value.abs()).max(1.0);
        if (next - control.value).abs() <= tolerance {
            return vec![];
        }
        control.value = next;
        self.dirty.paint = true;
        vec![json!({"type":"valueChange", "id":id, "value":next})]
    }
    fn slider_from_pointer(&mut self, id: &str) -> Vec<Value> {
        let Some(rect) = self.visible_rect(id) else {
            return vec![];
        };
        let Some(control) = self
            .entries
            .get(id)
            .and_then(|entry| entry.node.control.as_ref())
        else {
            return vec![];
        };
        let inset = 8.0;
        let ratio = if control.orientation == "vertical" {
            let span = (rect.height() - 2.0 * inset).max(1.0);
            ((rect.y1 - inset - self.mouse.1) / span).clamp(0.0, 1.0)
        } else {
            let span = (rect.width() - 2.0 * inset).max(1.0);
            ((self.mouse.0 - rect.x0 - inset) / span).clamp(0.0, 1.0)
        };
        let value = control.min + (control.max - control.min) * ratio;
        self.set_slider(id, value)
    }
    fn splitter_from_pointer(&mut self, id: &str) -> Vec<Value> {
        let Some(entry) = self.entries.get(id) else {
            return vec![];
        };
        let Some(parent_id) = entry.parent.clone() else {
            return vec![];
        };
        let Some(rect) = self.visible_rect(&parent_id) else {
            return vec![];
        };
        let Some(control) = entry.node.control.as_ref() else {
            return vec![];
        };
        let ratio = if control.orientation == "vertical" {
            ((self.mouse.1 - rect.y0) / rect.height().max(1.0)).clamp(0.0, 1.0)
        } else {
            ((self.mouse.0 - rect.x0) / rect.width().max(1.0)).clamp(0.0, 1.0)
        };
        let value = control.min + (control.max - control.min) * ratio;
        self.set_slider(id, value)
    }
    fn begin_static_text_selection(&mut self, id: &str) {
        match self.user_select_mode(id) {
            UserSelectMode::None => {
                self.static_selection = None;
                self.static_text_dragging = false;
            }
            UserSelectMode::All => {
                let root = self
                    .user_select_all_root(id)
                    .unwrap_or_else(|| id.to_string());
                self.static_selection = Some(StaticTextSelection {
                    anchor_id: id.to_string(),
                    anchor: 0,
                    focus_id: id.to_string(),
                    focus: self.entries[id].node.text.len(),
                    atomic_root: Some(root),
                });
                self.static_text_dragging = false;
                self.dirty.paint = true;
            }
            UserSelectMode::Text => {
                let Some(index) = self.static_text_index_from_pointer(id) else {
                    return;
                };
                self.static_selection = Some(StaticTextSelection {
                    anchor_id: id.to_string(),
                    anchor: index,
                    focus_id: id.to_string(),
                    focus: index,
                    atomic_root: None,
                });
                self.static_text_dragging = true;
                self.dirty.paint = true;
            }
        }
    }
    fn update_static_text_selection_from_pointer(&mut self) {
        if !self.static_text_dragging {
            return;
        }
        let Some(id) = self.selectable_text_hit_root() else {
            return;
        };
        match self.user_select_mode(&id) {
            UserSelectMode::None => {}
            UserSelectMode::All => {
                let root = self.user_select_all_root(&id).unwrap_or_else(|| id.clone());
                if let Some(selection) = self.static_selection.as_mut() {
                    selection.focus_id = id.clone();
                    selection.focus = self.entries[&id].node.text.len();
                    selection.atomic_root = Some(root);
                }
                self.static_text_dragging = false;
                self.dirty.paint = true;
            }
            UserSelectMode::Text => {
                let Some(index) = self.static_text_index_from_pointer(&id) else {
                    return;
                };
                if let Some(selection) = self.static_selection.as_mut() {
                    selection.focus_id = id;
                    selection.focus = index;
                    selection.atomic_root = None;
                    self.dirty.paint = true;
                }
            }
        }
    }
    fn drop_target_enabled(&self, id: &str, source: &str) -> bool {
        if !self.entries.get(id).is_some_and(|entry| entry.node.drop_target) {
            return false;
        }
        let mut current = Some(id);
        while let Some(current_id) = current {
            if current_id == source {
                return false;
            }
            let Some(entry) = self.entries.get(current_id) else {
                return false;
            };
            if entry.node.disabled || entry.node.string("display", "flex") == "none" {
                return false;
            }
            current = entry.parent.as_deref();
        }
        true
    }
    /// The innermost visible drop target under the pointer. Targets inside the
    /// dragged node, clipped by a scroll ancestor, or hidden behind an open modal
    /// layer are skipped; nested targets resolve to the smallest one.
    fn drop_target_at_pointer(&self, source: &str) -> Option<String> {
        let (x, y) = self.mouse;
        let inside = |rect: &BoxRect| x >= rect.x0 && x < rect.x1 && y >= rect.y0 && y < rect.y1;
        let modal = self
            .portal_order
            .iter()
            .rev()
            .find(|id| self.entries.get(*id).is_some_and(|entry| entry.node.modal))
            .cloned();
        let mut best: Option<(f64, &String)> = None;
        for (id, entry) in &self.entries {
            if !entry.node.drop_target || !self.drop_target_enabled(id, source) {
                continue;
            }
            let Some(rect) = self.visible_rect(id) else {
                continue;
            };
            if !inside(&rect) {
                continue;
            }
            let mut visible = true;
            let mut within_modal = modal.is_none();
            let mut current = Some(id.as_str());
            while let Some(current_id) = current {
                if modal.as_deref() == Some(current_id) {
                    within_modal = true;
                }
                let Some(ancestor) = self.entries.get(current_id) else {
                    visible = false;
                    break;
                };
                if current_id != id
                    && ancestor.node.kind == "scroll"
                    && !self.visible_rect(current_id).is_some_and(|clip| inside(&clip))
                {
                    visible = false;
                    break;
                }
                current = ancestor.parent.as_deref();
            }
            if !visible || !within_modal {
                continue;
            }
            let area = rect.width() * rect.height();
            if best.is_none_or(|(smallest, _)| area < smallest) {
                best = Some((area, id));
            }
        }
        best.map(|(_, id)| id.clone())
    }
    fn pointer_drag_move(&mut self) -> Option<Vec<Value>> {
        let drag = self.pointer_drag.as_ref()?;
        if !self.entries.contains_key(&drag.id) {
            return Some(self.cancel_pointer_drag());
        }
        let (x, y) = self.mouse;
        let mut events = vec![];
        if !drag.active {
            let (origin_x, origin_y) = drag.origin;
            if (x - origin_x).hypot(y - origin_y) < DRAG_THRESHOLD {
                return None;
            }
            let id = drag.id.clone();
            if let Some(drag) = self.pointer_drag.as_mut() {
                drag.active = true;
            }
            self.text_dragging = false;
            self.static_text_dragging = false;
            self.static_selection = None;
            self.dirty.paint = true;
            events.push(json!({"type":"dragStart", "id":id, "x":origin_x, "y":origin_y}));
        }
        let id = self.pointer_drag.as_ref()?.id.clone();
        let over = self.drop_target_at_pointer(&id);
        events.push(json!({"type":"dragMove", "id":id, "x":x, "y":y, "over":over}));
        Some(events)
    }
    /// Abandons an in-flight pointer drag (Escape, focus loss, source removed).
    /// A drag that never crossed the threshold ends silently.
    pub fn cancel_pointer_drag(&mut self) -> Vec<Value> {
        match self.pointer_drag.take() {
            Some(drag) if drag.active => {
                self.pressed = None;
                self.dirty.paint = true;
                vec![json!({"type":"dragCancel", "id":drag.id})]
            }
            _ => vec![],
        }
    }
    pub fn pointer_move(&mut self, x: f64, y: f64) -> Vec<Value> {
        self.mouse = (x, y);
        if self.text_dragging
            && let Some(id) = self.focused.clone()
            && matches!(self.entries[&id].node.kind.as_str(), "input" | "textarea")
            && self.user_select_mode(&id) == UserSelectMode::Text
        {
            self.place_text_caret_from_pointer(&id);
            if self.entries[&id].node.kind == "textarea" {
                self.ensure_focused_textarea_caret_visible();
            }
        }
        self.update_static_text_selection_from_pointer();
        if let Some(drag) = &self.scroll_drag {
            let id = drag.id.clone();
            let axis = drag.axis;
            let grab = drag.grab;
            return self.drag_scrollbar(&id, axis, grab);
        }
        let next = self.hit_root(false);
        let mut events = vec![];
        if next != self.hovered {
            if let Some(id) = &self.hovered {
                events.push(json!({"type":"hover", "id":id, "entered":false}));
            }
            if let Some(id) = &next {
                events.push(json!({"type":"hover", "id":id, "entered":true}));
            }
            self.hovered = next;
            self.dirty.paint = true;
        }
        self.refresh_hover_chain();
        if let Some(drag_events) = self.pointer_drag_move() {
            events.extend(drag_events);
            return events;
        }
        if let Some(id) = self
            .pressed
            .clone()
            .filter(|id| matches!(self.entries[id].node.kind.as_str(), "slider" | "splitter"))
        {
            events.extend(if self.entries[&id].node.kind == "splitter" {
                self.splitter_from_pointer(&id)
            } else {
                self.slider_from_pointer(&id)
            });
        }
        events
    }
    pub fn pointer_leave(&mut self) -> Vec<Value> {
        self.mouse = (-1.0, -1.0);
        self.refresh_hover_chain();
        if let Some(id) = self.hovered.take() {
            self.dirty.paint = true;
            vec![json!({"type":"hover", "id":id, "entered":false})]
        } else {
            vec![]
        }
    }
    pub fn blur(&mut self) -> Option<String> {
        self.scroll_drag = None;
        self.text_dragging = false;
        self.static_text_dragging = false;
        self.ime_cancel();
        let blurred = self.focused.take();
        self.focus_visible = false;
        if blurred.is_some() || self.pressed.take().is_some() {
            self.caret = 0;
            self.selection_anchor = None;
            self.dirty.paint = true;
        }
        self.sync_virtual_focus();
        blurred
    }
    pub fn pointer_down(&mut self) -> Vec<Value> {
        self.pointer_drag = None;
        self.pressed_link = None;
        self.pressed_diff_row = None;
        self.set_focus_visible(false);
        if let Some(id) = self.outside_dismissal_at_pointer() {
            self.pressed = None;
            self.text_dragging = false;
            self.static_text_dragging = false;
            return vec![json!({"type":"outside", "id":id})];
        }
        if let Some((id, axis, grab)) = self.scrollbar_at_pointer() {
            self.pressed = None;
            self.scroll_drag = Some(ScrollDrag {
                id: id.clone(),
                axis,
                grab,
            });
            return self.drag_scrollbar(&id, axis, grab);
        }
        let selectable_text = self.selectable_text_hit_root();
        if let Some(id) = selectable_text.as_deref()
            && let Some(href) = self.markdown_link_at_pointer(id)
        {
            self.pressed_link = Some((id.to_string(), href));
        }
        if let Some(id) = selectable_text.as_deref()
            && self
                .entries
                .get(id)
                .is_some_and(|entry| entry.node.kind == "diff")
            && let Some(index) = self.diff_row_index_at_pointer(id)
        {
            self.pressed_diff_row = Some((id.to_string(), index));
        }
        self.hovered = self.hit_root(false);
        self.refresh_hover_chain();
        self.pressed = self.hovered.clone();
        self.pointer_drag = self
            .pressed
            .as_deref()
            .filter(|id| self.entries[*id].node.draggable && self.interactive(id))
            .map(|id| PointerDrag {
                id: id.to_string(),
                origin: self.mouse,
                active: false,
            });
        let mut events = vec![];
        if let Some(id) = self.hovered.clone() {
            if let Some(blurred) = self.focus_with_visibility(&id, false) {
                events.push(json!({"type":"blur", "id":blurred}));
            }
            if matches!(self.entries[&id].node.kind.as_str(), "input" | "textarea") {
                if self.ime_target() == Some(id.as_str()) {
                    self.ime_cancel();
                }
                self.place_text_caret_from_pointer(&id);
                if self.select_otp_slot_from_pointer(&id) {
                    self.text_dragging = false;
                } else {
                    match self.user_select_mode(&id) {
                        UserSelectMode::None => {
                            self.selection_anchor = None;
                            self.text_dragging = false;
                        }
                        UserSelectMode::Text => {
                            self.selection_anchor = Some(self.caret);
                            self.text_dragging = true;
                        }
                        UserSelectMode::All => {
                            let value_len =
                                self.entries[&id].node.value.as_deref().unwrap_or("").len();
                            self.selection_anchor = Some(0);
                            self.caret = value_len;
                            self.text_dragging = false;
                        }
                    }
                }
            } else {
                self.text_dragging = false;
            }
        } else {
            if let Some(blurred) = self.blur() {
                events.push(json!({"type":"blur", "id":blurred}));
            }
        }
        let hovered_editable = self
            .hovered
            .as_deref()
            .is_some_and(|id| matches!(self.entries[id].node.kind.as_str(), "input" | "textarea"));
        if hovered_editable {
            self.static_selection = None;
            self.static_text_dragging = false;
        } else if let Some(id) = selectable_text.as_deref() {
            self.begin_static_text_selection(id);
        } else {
            self.static_selection = None;
            self.static_text_dragging = false;
        }
        self.dirty.paint = true;
        if let Some(id) = self
            .pressed
            .clone()
            .filter(|id| matches!(self.entries[id].node.kind.as_str(), "slider" | "splitter"))
        {
            events.extend(if self.entries[&id].node.kind == "splitter" {
                self.splitter_from_pointer(&id)
            } else {
                self.slider_from_pointer(&id)
            });
        }
        events
    }
    pub fn pointer_up(&mut self) -> Vec<Value> {
        if let Some(drag) = self.pointer_drag.take()
            && drag.active
        {
            self.text_dragging = false;
            self.static_text_dragging = false;
            self.pressed = None;
            self.pressed_link = None;
            self.pressed_diff_row = None;
            self.hovered = self.hit_root(false);
            self.refresh_hover_chain();
            self.dirty.paint = true;
            let target = self.drop_target_at_pointer(&drag.id);
            return vec![json!({
                "type":"drop", "id":drag.id, "target":target, "x":self.mouse.0, "y":self.mouse.1
            })];
        }
        self.text_dragging = false;
        self.static_text_dragging = false;
        if self.selection_anchor == Some(self.caret) {
            self.selection_anchor = None;
        }
        let has_selection = self.static_selected_text().is_some();
        if !has_selection {
            self.static_selection = None;
        }
        if self.scroll_drag.take().is_some() {
            self.pressed_link = None;
            return vec![];
        }
        self.hovered = self.hit_root(false);
        self.refresh_hover_chain();
        let mut out = vec![];
        if let Some(id) = self.pressed.take() {
            if self.hovered.as_ref() == Some(&id)
                && matches!(self.entries[&id].node.kind.as_str(), "button" | "pressable")
            {
                out.push(json!({"type":"click", "id":id}));
            }
            self.dirty.paint = true;
        }
        if let Some((id, href)) = self.pressed_link.take()
            && !has_selection
            && self.selectable_text_hit_root().as_deref() == Some(id.as_str())
            && self.markdown_link_at_pointer(&id).as_deref() == Some(href.as_str())
        {
            out.push(json!({"type":"markdownLink", "id":id, "href":href}));
        }
        if !has_selection
            && let Some((id, pressed_index)) = self.pressed_diff_row.take()
            && self.selectable_text_hit_root().as_deref() == Some(id.as_str())
            && self.diff_row_index_at_pointer(&id) == Some(pressed_index)
            && let Some(RichContent::Diff { rows, .. }) = self.entries[&id].node.rich.as_deref()
            && let Some(row) = rows.get(pressed_index)
        {
            if row.file_header {
                if let Some(path) = &row.file_path {
                    out.push(json!({"type":"diffToggleFile", "id":id, "path":path}));
                }
            } else if row.kind == DiffRowKind::ShowMore {
                if let Some(hidden) = row.hidden_lines {
                    out.push(json!({"type":"diffShowMore", "id":id, "hidden":hidden, "path":row.file_path}));
                }
            } else if matches!(
                row.kind,
                DiffRowKind::Added | DiffRowKind::Removed | DiffRowKind::Context
            ) {
                out.push(json!({
                    "type":"diffLineClick", "id":id, "text":row.text,
                    "oldLine":row.old_line, "newLine":row.new_line, "path":row.file_path
                }));
            }
        } else {
            self.pressed_diff_row = None;
        }
        out
    }
    pub fn pointer_context(&mut self) -> Vec<Value> {
        if let Some(id) = self.outside_dismissal_at_pointer() {
            return vec![json!({"type":"outside", "id":id})];
        }
        self.hovered = self.hit_root(false);
        self.refresh_hover_chain();
        let Some(id) = self.hovered.clone() else {
            return vec![];
        };
        vec![json!({"type":"context", "id":id, "x":self.mouse.0, "y":self.mouse.1})]
    }
    #[cfg(test)]
    pub fn wheel(&mut self, delta: f64) -> Vec<Value> {
        self.wheel_2d(0.0, delta)
    }
    pub fn wheel_2d(&mut self, delta_x: f64, delta_y: f64) -> Vec<Value> {
        if let Some(id) = self.hit_root(false)
            && let Some(entry) = self.entries.get(&id)
            && entry.node.kind == "markdown"
            && let Some(rect) = self.visible_rect(&id)
        {
            let pad = entry.node.insets("padding");
            let border = entry.node.insets("borderWidth");
            let width =
                (rect.width() - f64::from(pad[1] + pad[3] + border[1] + border[3])).max(0.0) as f32;
            let y = (self.mouse.1 - rect.y0 - f64::from(pad[0] + border[0])) as f32;
            let delta = if delta_x.abs() > f64::EPSILON {
                delta_x
            } else {
                delta_y
            };
            if self.text.scroll_markdown_block(&id, y, width, delta as f32) {
                self.dirty.paint = true;
                return vec![];
            }
        }
        if let Some(id) = self.hit_root(true) {
            let entry = &self.entries[&id];
            let speed = if entry.node.kind == "scroll" {
                entry.node.scroll_speed
            } else {
                1.0
            };
            let (dx, dy) = match entry.node.kind.as_str() {
                "textarea" => (0.0, delta_y),
                "code" => {
                    let horizontal = if delta_x.abs() > f64::EPSILON {
                        delta_x
                    } else {
                        delta_y
                    };
                    (horizontal, 0.0)
                }
                "scroll" => match entry.node.scroll_orientation.as_str() {
                    "horizontal" => {
                        let horizontal = if delta_x.abs() > f64::EPSILON {
                            delta_x
                        } else {
                            delta_y
                        };
                        (horizontal, 0.0)
                    }
                    "both" => (delta_x, delta_y),
                    _ => (0.0, delta_y),
                },
                _ => (0.0, 0.0),
            };
            return self.scroll_to_2d(&id, entry.scroll_x + dx * speed, entry.scroll + dy * speed);
        }
        vec![]
    }
    fn scrollbar_at_pointer(&self) -> Option<(String, ScrollbarAxis, f64)> {
        let id = self.hit_root(true)?;
        let entry = self.entries.get(&id)?;
        if !matches!(entry.node.kind.as_str(), "scroll" | "textarea")
            || (entry.scroll_max <= 0.0 && entry.scroll_max_x <= 0.0)
        {
            return None;
        }
        let rect = self.visible_rect(&id)?;
        if entry.scroll_max > 0.0 {
            let track = rect.height() - 12.0;
            if track > 0.0
                && self.mouse.0 >= rect.x1 - 10.0
                && self.mouse.0 <= rect.x1
                && self.mouse.1 >= rect.y0 + 6.0
                && self.mouse.1 <= rect.y1 - 6.0
            {
                let thumb = (track * rect.height() / (rect.height() + entry.scroll_max))
                    .max(28.0)
                    .min(track);
                let top = rect.y0 + 6.0 + (track - thumb) * entry.scroll / entry.scroll_max;
                let grab = if self.mouse.1 >= top && self.mouse.1 <= top + thumb {
                    self.mouse.1 - top
                } else {
                    thumb / 2.0
                };
                return Some((id, ScrollbarAxis::Vertical, grab));
            }
        }
        if entry.node.kind == "scroll" && entry.scroll_max_x > 0.0 {
            let track = rect.width() - 12.0;
            if track > 0.0
                && self.mouse.1 >= rect.y1 - 10.0
                && self.mouse.1 <= rect.y1
                && self.mouse.0 >= rect.x0 + 6.0
                && self.mouse.0 <= rect.x1 - 6.0
            {
                let thumb = (track * rect.width() / (rect.width() + entry.scroll_max_x))
                    .max(28.0)
                    .min(track);
                let left = rect.x0 + 6.0 + (track - thumb) * entry.scroll_x / entry.scroll_max_x;
                let grab = if self.mouse.0 >= left && self.mouse.0 <= left + thumb {
                    self.mouse.0 - left
                } else {
                    thumb / 2.0
                };
                return Some((id, ScrollbarAxis::Horizontal, grab));
            }
        }
        None
    }
    fn drag_scrollbar(&mut self, id: &str, axis: ScrollbarAxis, grab: f64) -> Vec<Value> {
        let Some(entry) = self.entries.get(id) else {
            return vec![];
        };
        let Some(rect) = self.visible_rect(id) else {
            return vec![];
        };
        let (track, thumb, pointer, start, max) = match axis {
            ScrollbarAxis::Vertical => {
                let track = rect.height() - 12.0;
                let thumb = (track * rect.height() / (rect.height() + entry.scroll_max))
                    .max(28.0)
                    .min(track);
                (track, thumb, self.mouse.1, rect.y0, entry.scroll_max)
            }
            ScrollbarAxis::Horizontal => {
                let track = rect.width() - 12.0;
                let thumb = (track * rect.width() / (rect.width() + entry.scroll_max_x))
                    .max(28.0)
                    .min(track);
                (track, thumb, self.mouse.0, rect.x0, entry.scroll_max_x)
            }
        };
        let travel = track - thumb;
        if travel <= 0.0 || max <= 0.0 {
            return vec![];
        }
        let offset = ((pointer - grab - start - 6.0) / travel).clamp(0.0, 1.0) * max;
        match axis {
            ScrollbarAxis::Vertical => self.scroll_to_2d(id, entry.scroll_x, offset),
            ScrollbarAxis::Horizontal => self.scroll_to_2d(id, offset, entry.scroll),
        }
    }
    fn scroll_to(&mut self, id: &str, offset: f64) -> Vec<Value> {
        let x = self.entries.get(id).map_or(0.0, |entry| entry.scroll_x);
        self.scroll_to_2d(id, x, offset)
    }
    pub fn request_virtual_scroll_to_item(
        &self,
        id: &str,
        index: usize,
        offset: f64,
    ) -> Result<Vec<Value>, String> {
        if !offset.is_finite() {
            return Err("VirtualList scrollToItem offset must be finite".into());
        }
        let metadata = self
            .entries
            .get(id)
            .and_then(|entry| entry.node.virtual_list.as_ref())
            .ok_or_else(|| format!("scrollToItem target is not a variable VirtualList: {id}"))?;
        if index >= metadata.item_count {
            return Err(format!(
                "VirtualList scrollToItem index {index} is outside itemCount {}",
                metadata.item_count
            ));
        }
        Ok(vec![json!({
            "type":"virtualListScrollToItem", "id":id, "index":index, "offset":offset
        })])
    }
    fn scroll_to_2d(&mut self, id: &str, offset_x: f64, offset_y: f64) -> Vec<Value> {
        if !offset_x.is_finite() || !offset_y.is_finite() {
            return vec![];
        }
        let entry = self.entries.get_mut(id).unwrap();
        let next_x = offset_x.clamp(0.0, entry.scroll_max_x);
        let next_y = offset_y.clamp(0.0, entry.scroll_max);
        if (next_x - entry.scroll_x).abs() < 1e-6 && (next_y - entry.scroll).abs() < 1e-6 {
            return vec![];
        }
        entry.scroll_x = next_x;
        entry.scroll = next_y;
        let variable_list = entry.node.virtual_list.is_some();
        if variable_list {
            entry.virtual_following_tail = entry
                .node
                .virtual_list
                .as_ref()
                .is_some_and(|metadata| metadata.follow_tail)
                && (next_y - entry.scroll_max).abs() <= 0.5;
        }
        if !entry
            .node
            .control
            .as_ref()
            .is_some_and(|control| control.role == "virtualList")
        {
            self.dirty.paint = true;
        }
        let (offset, max) =
            if entry.node.kind == "scroll" && entry.node.scroll_orientation == "horizontal" {
                (next_x, entry.scroll_max_x)
            } else {
                (next_y, entry.scroll_max)
            };
        let events = vec![json!({
            "type":"scroll", "id":id, "offset":offset, "max":max,
            "offsetX":next_x, "offsetY":next_y,
            "maxX":entry.scroll_max_x, "maxY":entry.scroll_max
        })];
        if variable_list {
            self.refresh_virtual_anchor(id);
        }
        events
    }

    fn ime_display(&self, id: &str) -> Option<ImeDisplay> {
        let ime = self
            .ime
            .as_ref()
            .filter(|ime| ime.target == id && !ime.preedit.is_empty())?;
        let entry = self.entries.get(id)?;
        if !matches!(entry.node.kind.as_str(), "input" | "textarea") {
            return None;
        }
        let base = entry.node.value.as_deref().unwrap_or("");
        if base != ime.base_value {
            return None;
        }
        let start = floor_boundary(base, ime.replace_start.min(base.len()));
        let end = floor_boundary(base, ime.replace_end.min(base.len())).max(start);
        let mut value = String::with_capacity(base.len() - (end - start) + ime.preedit.len());
        value.push_str(&base[..start]);
        value.push_str(&ime.preedit);
        value.push_str(&base[end..]);
        let marked_range = (start, start + ime.preedit.len());
        let cursor_range = ime.cursor.map(|(anchor, caret)| {
            let anchor = floor_char_boundary(&ime.preedit, anchor.min(ime.preedit.len()));
            let caret = floor_char_boundary(&ime.preedit, caret.min(ime.preedit.len()));
            (start + anchor, start + caret)
        });
        let mut node = entry.node.clone();
        node.id = format!("{id}::ime");
        node.value = Some(value.clone());
        node.placeholder.clear();
        Some(ImeDisplay {
            node,
            value,
            marked_range,
            cursor_range,
        })
    }

    fn prepare_edit_layout(&mut self, id: &str) -> Option<EditLayout> {
        if let Some(display) = self.ime_display(id) {
            let caret = display
                .cursor_range
                .map(|(_, caret)| caret)
                .unwrap_or(display.marked_range.1);
            self.text.prepare(&display.node);
            return Some(EditLayout {
                node: display.node,
                value: display.value,
                caret,
            });
        }
        let entry = self.entries.get(id)?;
        if !matches!(entry.node.kind.as_str(), "input" | "textarea") {
            return None;
        }
        let node = entry.node.clone();
        let value = node.value.clone().unwrap_or_default();
        let caret = floor_boundary(&value, self.caret.min(value.len()));
        self.text.prepare(&node);
        Some(EditLayout { node, value, caret })
    }

    pub(crate) fn ime_cursor_area(&mut self) -> Option<BoxRect> {
        let id = self.focused.clone()?;
        let entry = self.entries.get(&id)?;
        if !matches!(entry.node.kind.as_str(), "input" | "textarea") {
            return None;
        }
        let visible = self.visible_rect(&id)?;
        let pad = entry.node.insets("padding");
        let border = entry.node.insets("borderWidth");
        let scroll = entry.scroll;
        let multiline = entry.node.kind == "textarea";
        let available_width =
            (entry.rect.width() - (pad[1] + pad[3] + border[1] + border[3]) as f64).max(0.0) as f32;
        let layout = self.prepare_edit_layout(&id)?;
        let wrap_width = multiline.then_some(available_width);
        let (_, text_height) = self.text.measure(&layout.node.id, wrap_width);
        let display_index = input_display_index(&layout.node, &layout.value, layout.caret);
        let cursor = self
            .text
            .caret_rect(&layout.node.id, display_index, wrap_width)?;
        let origin_x = visible.x0 + pad[3] as f64 + border[3] as f64;
        let origin_y = if multiline {
            visible.y0 + pad[0] as f64 + border[0] as f64 - scroll
        } else {
            visible.y0 + (visible.height() - text_height as f64) / 2.0
        };
        let content_right = visible.x1 - pad[1] as f64 - border[1] as f64;
        let x = (origin_x + cursor.x0).clamp(origin_x, content_right.max(origin_x));
        let y = origin_y + cursor.y0;
        let width = (cursor.x1 - cursor.x0).max(1.0);
        let height = (cursor.y1 - cursor.y0).max(1.0);
        Some(BoxRect::new(x, y, x + width, y + height))
    }

    fn clear_ime_layout(&mut self, target: &str) {
        self.text.layouts.remove(&format!("{target}::ime"));
    }

    pub(crate) fn ime_active(&self) -> bool {
        self.ime.as_ref().is_some_and(|ime| !ime.preedit.is_empty())
    }

    pub(crate) fn ime_target(&self) -> Option<&str> {
        self.ime.as_ref().map(|ime| ime.target.as_str())
    }

    pub(crate) fn ime_enabled(&mut self, target: &str) {
        if self.focused.as_deref() == Some(target) {
            self.ime_blocked = None;
        }
    }

    #[cfg(test)]
    pub(crate) fn ime_display_text(&self) -> Option<String> {
        let target = self.ime.as_ref()?.target.as_str();
        self.ime_display(target)
            .map(|display| display.node.display_text())
    }

    #[cfg(test)]
    pub(crate) fn ime_cursor_bytes(&self) -> Option<(usize, usize)> {
        self.ime.as_ref()?.cursor
    }

    #[cfg(test)]
    pub(crate) fn ime_marked_rects(&mut self) -> Vec<BoxRect> {
        let id = match self.ime.as_ref() {
            Some(ime) => ime.target.clone(),
            None => return vec![],
        };
        let Some(display) = self.ime_display(&id) else {
            return vec![];
        };
        let entry = &self.entries[&id];
        let pad = entry.node.insets("padding");
        let border = entry.node.insets("borderWidth");
        let available_width =
            (entry.rect.width() - (pad[1] + pad[3] + border[1] + border[3]) as f64).max(0.0) as f32;
        let wrap_width = (entry.node.kind == "textarea").then_some(available_width);
        self.text.prepare(&display.node);
        self.text_range_rects(
            &display.node,
            &display.node.id,
            &display.value,
            display.marked_range.0,
            display.marked_range.1,
            wrap_width,
        )
    }

    pub(crate) fn ime_preedit(&mut self, target: &str, text: &str, cursor: Option<(usize, usize)>) {
        self.touch_caret();
        if self.focused.as_deref() != Some(target)
            || !self
                .entries
                .get(target)
                .is_some_and(|entry| matches!(entry.node.kind.as_str(), "input" | "textarea"))
        {
            return;
        }

        if self
            .ime_blocked
            .as_ref()
            .is_some_and(|blocked| blocked.target == target)
        {
            if text.is_empty()
                && let Some(blocked) = self.ime_blocked.as_mut()
            {
                if blocked.boundary_seen {
                    self.ime_blocked = None;
                } else {
                    blocked.boundary_seen = true;
                }
            }
            return;
        }

        if text.is_empty() {
            if let Some(ime) = self.ime.as_mut().filter(|ime| ime.target == target) {
                ime.preedit.clear();
                ime.cursor = None;
                self.clear_ime_layout(target);
                self.dirty.paint = true;
                self.ensure_focused_textarea_caret_visible();
            }
            return;
        }

        let value = self.entries[target].node.value.clone().unwrap_or_default();
        let restart = self.ime.as_ref().is_none_or(|ime| {
            ime.target != target || ime.base_value != value || ime.preedit.is_empty()
        });
        if restart {
            self.ime_cancel();
            self.ime_blocked = None;
            let caret = floor_boundary(&value, self.caret.min(value.len()));
            let (replace_start, replace_end) = self.selected_range().unwrap_or((caret, caret));
            self.ime = Some(ImeComposition {
                target: target.to_string(),
                base_value: value,
                replace_start,
                replace_end,
                original_caret: self.caret,
                original_anchor: self.selection_anchor,
                preedit: String::new(),
                cursor: None,
            });
        }

        let normalized_cursor = cursor.map(|(anchor, caret)| {
            (
                floor_char_boundary(text, anchor.min(text.len())),
                floor_char_boundary(text, caret.min(text.len())),
            )
        });
        if let Some(ime) = self.ime.as_mut() {
            ime.preedit.clear();
            ime.preedit.push_str(text);
            ime.cursor = normalized_cursor;
        }
        self.clear_ime_layout(target);
        self.dirty.paint = true;
        self.ensure_focused_textarea_caret_visible();
    }

    pub(crate) fn ime_cancel(&mut self) {
        let Some(ime) = self.ime.take() else {
            return;
        };
        let boundary_seen = ime.preedit.is_empty();
        self.ime_blocked = Some(ImeBlock {
            target: ime.target.clone(),
            boundary_seen,
        });
        self.clear_ime_layout(&ime.target);
        if self.focused.as_deref() == Some(ime.target.as_str())
            && let Some(entry) = self.entries.get(&ime.target)
        {
            let value = entry.node.value.as_deref().unwrap_or("");
            self.caret = floor_boundary(value, ime.original_caret.min(value.len()));
            self.selection_anchor = ime
                .original_anchor
                .map(|anchor| floor_boundary(value, anchor.min(value.len())));
        }
        self.dirty.paint = true;
        self.ensure_focused_textarea_caret_visible();
    }

    pub(crate) fn ime_commit(&mut self, target: &str, text: &str) -> Vec<Value> {
        if self.focused.as_deref() != Some(target)
            || !self
                .entries
                .get(target)
                .is_some_and(|entry| matches!(entry.node.kind.as_str(), "input" | "textarea"))
        {
            return vec![];
        }

        let Some(ime) = self.ime.take() else {
            if self
                .ime_blocked
                .as_ref()
                .is_some_and(|blocked| blocked.target == target)
            {
                self.ime_blocked = None;
                return vec![];
            }
            return self.type_text(text);
        };
        if ime.target != target {
            self.ime = Some(ime);
            return vec![];
        }
        self.clear_ime_layout(target);
        if self
            .ime_blocked
            .as_ref()
            .is_some_and(|blocked| blocked.target == target)
        {
            self.ime_blocked = None;
        }

        let multiline = self.entries[target].node.kind == "textarea";
        let current = self.entries[target].node.value.clone().unwrap_or_default();
        if current != ime.base_value {
            self.caret = floor_boundary(&current, self.caret.min(current.len()));
            self.selection_anchor = None;
            self.dirty.paint = true;
            return vec![];
        }
        let start = floor_boundary(&current, ime.replace_start.min(current.len()));
        let end = floor_boundary(&current, ime.replace_end.min(current.len())).max(start);
        let committed: String = text
            .chars()
            .filter(|ch| !ch.is_control() || (multiline && *ch == '\n'))
            .collect();
        let mut value = current;
        value.replace_range(start..end, &committed);
        if self.entries[target].node.kind == "input"
            && self.entries[target].node.input_type == "number"
            && !valid_number_edit(&value)
        {
            let base = self.entries[target].node.value.as_deref().unwrap_or("");
            self.caret = floor_boundary(base, ime.original_caret.min(base.len()));
            self.selection_anchor = ime
                .original_anchor
                .map(|anchor| floor_boundary(base, anchor.min(base.len())));
            self.dirty.paint = true;
            return vec![];
        }
        self.caret = start + committed.len();
        self.selection_anchor = None;
        self.commit_edit(
            target.to_string(),
            ime.base_value,
            (ime.original_caret, ime.original_anchor),
            value,
            EditKind::Other,
            true,
        )
    }

    fn selected_range(&self) -> Option<(usize, usize)> {
        let anchor = self.selection_anchor?;
        let id = self.focused.as_ref()?;
        if !matches!(self.entries[id].node.kind.as_str(), "input" | "textarea") {
            return None;
        }
        if self.user_select_mode(id) == UserSelectMode::None {
            return None;
        }
        let value = self.entries[id].node.value.as_deref().unwrap_or("");
        let a = floor_boundary(value, anchor.min(value.len()));
        let b = floor_boundary(value, self.caret.min(value.len()));
        (a != b).then_some((a.min(b), a.max(b)))
    }
    pub fn selected_text(&self) -> Option<String> {
        if let Some(id) = self.focused.as_ref()
            && matches!(self.entries[id].node.kind.as_str(), "input" | "textarea")
        {
            if self.entries[id].node.kind == "input"
                && self.entries[id].node.input_type == "password"
            {
                return None;
            }
            let value = self.entries[id].node.value.as_deref().unwrap_or("");
            if let Some((start, end)) = self.selected_range() {
                return Some(value[start..end].to_string());
            }
        }
        self.static_selected_text()
    }
    pub fn key(&mut self, key: &str) -> Vec<Value> {
        if key == "Escape" && self.pointer_drag.as_ref().is_some_and(|drag| drag.active) {
            return self.cancel_pointer_drag();
        }
        self.set_focus_visible(true);
        let editable_focus = self
            .focused
            .as_deref()
            .and_then(|id| self.entries.get(id))
            .is_some_and(|entry| matches!(entry.node.kind.as_str(), "input" | "textarea"));
        let key = if !editable_focus && matches!(key, "ShiftEnter" | "ModEnter") {
            "Enter"
        } else if !editable_focus {
            // Word navigation only means something inside a text field.
            match key {
                "WordLeft" => "ArrowLeft",
                "WordRight" => "ArrowRight",
                "ShiftWordLeft" => "ShiftArrowLeft",
                "ShiftWordRight" => "ShiftArrowRight",
                "WordBackspace" => "Backspace",
                "WordDelete" => "Delete",
                _ => key,
            }
        } else {
            key
        };
        if key == "Tab" || key == "ShiftTab" {
            let ids = self.focus_order();
            if !ids.is_empty() {
                let index = self
                    .focused
                    .as_ref()
                    .and_then(|id| ids.iter().position(|i| i == id));
                let next = if key == "ShiftTab" {
                    index.map_or(ids.len() - 1, |i| (i + ids.len() - 1) % ids.len())
                } else {
                    index.map_or(0, |i| (i + 1) % ids.len())
                };
                if let Some(blurred) = self.focus(&ids[next]) {
                    return vec![json!({"type":"blur", "id":blurred})];
                }
            }
            return vec![];
        }
        if key == "SelectAll" && self.focused.is_none() {
            if let Some(selection) = self.static_selection.clone() {
                let id = selection.focus_id;
                if let Some(entry) = self.entries.get(&id)
                    && matches!(entry.node.kind.as_str(), "text" | "markdown" | "code")
                    && self.user_select_mode(&id) != UserSelectMode::None
                {
                    let atomic_root = (self.user_select_mode(&id) == UserSelectMode::All)
                        .then(|| self.user_select_all_root(&id).unwrap_or_else(|| id.clone()));
                    self.static_selection = Some(StaticTextSelection {
                        anchor_id: id.clone(),
                        anchor: 0,
                        focus_id: id.clone(),
                        focus: entry.node.text.len(),
                        atomic_root,
                    });
                    self.dirty.paint = true;
                }
            }
            return vec![];
        }
        let Some(id) = self.focused.clone() else {
            return vec![];
        };
        if self.ime_target() == Some(id.as_str())
            && matches!(self.entries[&id].node.kind.as_str(), "input" | "textarea")
        {
            if self.ime_active() {
                if key == "Escape" {
                    self.ime_cancel();
                }
                return vec![];
            } else {
                self.ime_cancel();
            }
        }
        if self.entries[&id]
            .node
            .control
            .as_ref()
            .is_some_and(|control| control.role == "treeitem")
            && matches!(key, "ArrowLeft" | "ArrowRight")
        {
            return vec![json!({"type":"key", "id":id, "key":key})];
        }
        if self.entries[&id]
            .node
            .control
            .as_ref()
            .is_some_and(|control| control.role == "select")
            && matches!(key, "ArrowDown" | "ArrowUp" | "Home" | "End" | "Escape")
        {
            return vec![json!({"type":"key", "id":id, "key":key})];
        }
        let node = &self.entries[&id].node;
        let is_link = node
            .control
            .as_ref()
            .is_some_and(|control| control.role == "link");
        if matches!(node.kind.as_str(), "button" | "pressable")
            && (key == "Enter" || (key == "Space" && !is_link))
        {
            return vec![json!({"type":"click", "id": id})];
        }
        if self.entries[&id].node.kind == "slider" {
            let control = self.entries[&id].node.control.as_ref().unwrap();
            let value = match key {
                "ArrowRight" | "ArrowUp" => control.value + control.step,
                "ArrowLeft" | "ArrowDown" => control.value - control.step,
                "Home" => control.min,
                "End" => control.max,
                _ => return vec![],
            };
            return self.set_slider(&id, value);
        }
        if self.entries[&id].node.kind == "splitter" {
            let control = self.entries[&id].node.control.as_ref().unwrap();
            let value = match (control.orientation.as_str(), key) {
                ("vertical", "ArrowDown") | ("horizontal", "ArrowRight") => {
                    control.value + control.step
                }
                ("vertical", "ArrowUp") | ("horizontal", "ArrowLeft") => {
                    control.value - control.step
                }
                (_, "Home") => control.min,
                (_, "End") => control.max,
                _ => return vec![],
            };
            return self.set_slider(&id, value);
        }
        if let Some(control) = &self.entries[&id].node.control
            && !control.group.is_empty()
            && matches!(control.role.as_str(), "radio" | "tab")
            && matches!(
                key,
                "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Home" | "End"
            )
        {
            let group = control.group.clone();
            let choices: Vec<_> = self
                .order
                .iter()
                .filter(|candidate| {
                    self.interactive(candidate)
                        && self.entries[*candidate]
                            .node
                            .control
                            .as_ref()
                            .is_some_and(|c| c.group == group)
                })
                .cloned()
                .collect();
            if choices.is_empty() {
                return vec![];
            }
            let index = choices
                .iter()
                .position(|candidate| candidate == &id)
                .unwrap_or(0);
            let next = match key {
                "Home" => 0,
                "End" => choices.len() - 1,
                "ArrowLeft" | "ArrowUp" => (index + choices.len() - 1) % choices.len(),
                _ => (index + 1) % choices.len(),
            };
            let blurred = self.focus(&choices[next]);
            let mut events = vec![json!({"type":"click", "id":choices[next]})];
            if let Some(blurred) = blurred {
                events.push(json!({"type":"blur", "id":blurred}));
            }
            return events;
        }
        if let Some(group) = self.roving_group(&id).map(str::to_string)
            && (self
                .entries
                .get(&group)
                .and_then(|entry| entry.node.control.as_ref())
                .is_some_and(|control| {
                    matches!(
                        control.role.as_str(),
                        "navigation" | "togglegroup" | "tree" | "grid"
                    )
                })
                || self.entries[&id]
                    .node
                    .control
                    .as_ref()
                    .is_some_and(|control| {
                        matches!(
                            control.role.as_str(),
                            "toggle" | "menuitem" | "treeitem" | "row"
                        )
                    }))
            && (if self
                .entries
                .get(&group)
                .and_then(|entry| entry.node.control.as_ref())
                .is_some_and(|control| matches!(control.role.as_str(), "tree" | "grid"))
                || self.entries[&id]
                    .node
                    .control
                    .as_ref()
                    .is_some_and(|control| matches!(control.role.as_str(), "treeitem" | "row"))
            {
                matches!(key, "ArrowUp" | "ArrowDown" | "Home" | "End")
            } else {
                matches!(
                    key,
                    "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Home" | "End"
                )
            })
        {
            let choices: Vec<_> = self
                .order
                .iter()
                .filter(|candidate| {
                    self.interactive(candidate)
                        && self.roving_group(candidate) == Some(group.as_str())
                })
                .cloned()
                .collect();
            if choices.is_empty() {
                return vec![];
            }
            let index = choices
                .iter()
                .position(|candidate| candidate == &id)
                .unwrap_or(0);
            let next = match key {
                "Home" => 0,
                "End" => choices.len() - 1,
                "ArrowLeft" | "ArrowUp" => (index + choices.len() - 1) % choices.len(),
                _ => (index + 1) % choices.len(),
            };
            return self.focus(&choices[next]).map_or_else(Vec::new, |blurred| {
                vec![json!({"type":"blur", "id":blurred})]
            });
        }
        if !matches!(self.entries[&id].node.kind.as_str(), "input" | "textarea") {
            return vec![];
        }
        let user_select = self.user_select_mode(&id);
        let multiline = self.entries[&id].node.kind == "textarea";
        let value = self.entries[&id].node.value.clone().unwrap_or_default();
        self.caret = floor_boundary(&value, self.caret.min(value.len()));
        self.touch_caret();
        let origin = (self.caret, self.selection_anchor);
        if user_select == UserSelectMode::None {
            self.selection_anchor = None;
        }
        match key {
            "Undo" => return self.undo_edit(&id, false),
            "Redo" => return self.undo_edit(&id, true),
            _ => {}
        }
        let submit_on_enter = !multiline || self.entries[&id].node.submit_on_enter;
        if key == "ModEnter"
            || (submit_on_enter && key == "Enter")
            || (!multiline && key == "ShiftEnter")
        {
            return vec![json!({"type":"submit", "id":id, "value":value})];
        }
        let selecting =
            key.starts_with("Shift") && key != "ShiftEnter" && user_select != UserSelectMode::None;
        let key = key.strip_prefix("Shift").unwrap_or(key);
        if user_select == UserSelectMode::All && (selecting || key == "SelectAll") {
            self.selection_anchor = Some(0);
            self.caret = value.len();
            if multiline {
                self.ensure_focused_textarea_caret_visible();
            }
            self.dirty.paint = true;
            return vec![];
        }
        if selecting && self.selection_anchor.is_none() {
            self.selection_anchor = Some(self.caret);
        }
        match key {
            "SelectAll" => {
                if user_select == UserSelectMode::Text {
                    self.selection_anchor = Some(0);
                    self.caret = value.len();
                }
            }
            "Home" => {
                self.caret = if multiline {
                    self.textarea_visual_edge(&id, false).unwrap_or(0)
                } else {
                    0
                };
                if !selecting {
                    self.selection_anchor = None;
                }
            }
            "End" => {
                self.caret = if multiline {
                    self.textarea_visual_edge(&id, true).unwrap_or(value.len())
                } else {
                    value.len()
                };
                if !selecting {
                    self.selection_anchor = None;
                }
            }
            "ArrowLeft" => {
                self.caret = previous_boundary(&value, self.caret);
                if !selecting {
                    self.selection_anchor = None;
                }
            }
            "ArrowRight" => {
                self.caret = next_boundary(&value, self.caret);
                if !selecting {
                    self.selection_anchor = None;
                }
            }
            "WordLeft" => {
                self.caret = previous_word_boundary(&value, self.caret);
                if !selecting {
                    self.selection_anchor = None;
                }
            }
            "WordRight" => {
                self.caret = next_word_boundary(&value, self.caret);
                if !selecting {
                    self.selection_anchor = None;
                }
            }
            "ArrowUp" if multiline => {
                if let Some(next) = self.textarea_vertical_index(&id, -1.0) {
                    self.caret = next;
                }
                if !selecting {
                    self.selection_anchor = None;
                }
            }
            "ArrowDown" if multiline => {
                if let Some(next) = self.textarea_vertical_index(&id, 1.0) {
                    self.caret = next;
                }
                if !selecting {
                    self.selection_anchor = None;
                }
            }
            "Enter" if multiline => {
                let mut changed = value.clone();
                if let Some((start, end)) = self.selected_range() {
                    changed.replace_range(start..end, "");
                    self.caret = start;
                }
                changed.insert(self.caret, '\n');
                self.caret += 1;
                self.selection_anchor = None;
                return self.commit_edit(id, value, origin, changed, EditKind::Other, true);
            }
            "Backspace" | "Delete" | "WordBackspace" | "WordDelete" => {
                let mut changed = value.clone();
                if let Some((start, end)) = self.selected_range() {
                    changed.replace_range(start..end, "");
                    self.caret = start;
                } else if key == "Backspace" || key == "WordBackspace" {
                    let start = if key == "Backspace" {
                        previous_boundary(&value, self.caret)
                    } else {
                        previous_word_boundary(&value, self.caret)
                    };
                    changed.replace_range(start..self.caret, "");
                    self.caret = start;
                } else {
                    let end = if key == "Delete" {
                        next_boundary(&value, self.caret)
                    } else {
                        next_word_boundary(&value, self.caret)
                    };
                    changed.replace_range(self.caret..end, "");
                }
                self.selection_anchor = None;
                if changed == value {
                    // Backspace at the start or Delete at the end: nothing to edit.
                    return vec![];
                }
                let kind = if origin.1.is_some_and(|anchor| anchor != origin.0) {
                    EditKind::Other
                } else {
                    EditKind::Delete
                };
                return self.commit_edit(id, value, origin, changed, kind, false);
            }
            _ => return vec![],
        }
        if multiline {
            self.ensure_focused_textarea_caret_visible();
        }
        self.dirty.paint = true;
        vec![]
    }
    pub fn type_text(&mut self, text: &str) -> Vec<Value> {
        self.ime_cancel();
        let Some(id) = self.focused.clone() else {
            return vec![];
        };
        if !matches!(self.entries[&id].node.kind.as_str(), "input" | "textarea") {
            return vec![];
        }
        let multiline = self.entries[&id].node.kind == "textarea";
        let mut value = self.entries[&id].node.value.clone().unwrap_or_default();
        let before = value.clone();
        let origin = (self.caret, self.selection_anchor);
        if let Some((start, end)) = self.selected_range() {
            value.replace_range(start..end, "");
            self.caret = start;
        }
        self.caret = floor_boundary(&value, self.caret.min(value.len()));
        let text: String = text
            .chars()
            .filter(|c| !c.is_control() || (multiline && *c == '\n'))
            .collect();
        value.insert_str(self.caret, &text);
        if self.entries[&id].node.kind == "input"
            && self.entries[&id].node.input_type == "number"
            && !valid_number_edit(&value)
        {
            return vec![];
        }
        self.caret += text.len();
        self.selection_anchor = None;
        let replaced = origin.1.is_some_and(|anchor| anchor != origin.0);
        let kind = if replaced || text.chars().count() > 1 {
            EditKind::Other
        } else {
            EditKind::Insert
        };
        let boundary = text.ends_with(char::is_whitespace);
        self.commit_edit(id, before, origin, value, kind, boundary)
    }
    /// Records a user edit in the per-field undo history, then applies it.
    /// Consecutive typing or deletion coalesces into one step; an external
    /// (controlled) value change invalidates the history for that field.
    fn commit_edit(
        &mut self,
        id: String,
        before: String,
        origin: (usize, Option<usize>),
        value: String,
        kind: EditKind,
        boundary: bool,
    ) -> Vec<Value> {
        if before != value {
            let now = self.motion_time_ms;
            let history = self.edit_history.entry(id.clone()).or_default();
            if history.value.as_deref() != Some(before.as_str()) {
                history.undo.clear();
                history.redo.clear();
                history.last_kind = None;
            }
            let coalesce = kind != EditKind::Other
                && history.last_kind == Some(kind)
                && now - history.last_ms <= EDIT_COALESCE_MS
                && !history.undo.is_empty();
            if !coalesce {
                history.undo.push(EditSnapshot {
                    value: before,
                    caret: origin.0,
                    anchor: origin.1,
                });
                if history.undo.len() > EDIT_HISTORY_LIMIT {
                    history.undo.remove(0);
                }
            }
            history.redo.clear();
            history.value = Some(value.clone());
            history.last_kind = (!boundary && kind != EditKind::Other).then_some(kind);
            history.last_ms = now;
        }
        self.set_input(id, value)
    }
    /// A controlled field that answers the latest user edit with the value it had
    /// just before that edit rejected the edit: drop that one step and keep the
    /// rest of the history. Any other external change is not recognised here.
    fn revert_rejected_edit(
        &mut self,
        id: &str,
        current: Option<&str>,
        next: Option<&str>,
    ) -> bool {
        let Some(history) = self.edit_history.get_mut(id) else {
            return false;
        };
        let rejected = history.value.as_deref() == current
            && history.redo.is_empty()
            && history.undo.last().map(|step| step.value.as_str())
                == Some(next.unwrap_or_default());
        if !rejected {
            return false;
        }
        history.undo.pop();
        history.value = next.map(str::to_string);
        history.last_kind = None;
        true
    }
    fn undo_edit(&mut self, id: &str, redo: bool) -> Vec<Value> {
        let current = self.entries[id].node.value.clone().unwrap_or_default();
        let Some(history) = self.edit_history.get_mut(id) else {
            return vec![];
        };
        if history.value.as_deref() != Some(current.as_str()) {
            self.edit_history.remove(id);
            return vec![];
        }
        let (from, to) = if redo {
            (&mut history.redo, &mut history.undo)
        } else {
            (&mut history.undo, &mut history.redo)
        };
        let Some(snapshot) = from.pop() else {
            return vec![];
        };
        to.push(EditSnapshot {
            value: current,
            caret: self.caret,
            anchor: self.selection_anchor,
        });
        history.value = Some(snapshot.value.clone());
        history.last_kind = None;
        let len = snapshot.value.len();
        self.caret = floor_boundary(&snapshot.value, snapshot.caret.min(len));
        self.selection_anchor = snapshot
            .anchor
            .map(|anchor| floor_boundary(&snapshot.value, anchor.min(len)));
        self.set_input(id.to_string(), snapshot.value)
    }
    fn set_input(&mut self, id: String, value: String) -> Vec<Value> {
        let entry = self.entries.get_mut(&id).unwrap();
        entry.node.value = Some(value.clone());
        entry.measure_dirty = true;
        self.text.layouts.remove(&id);
        self.dirty = Dirty::all();
        self.touch_caret();
        vec![json!({"type":"change", "id": id, "value": value})]
    }

    pub(crate) fn accessibility_text_selection(&self, id: &str) -> Option<(usize, usize)> {
        if self.focused.as_deref() != Some(id) {
            return None;
        }
        let entry = self.entries.get(id)?;
        if !matches!(entry.node.kind.as_str(), "input" | "textarea") {
            return None;
        }
        if self.user_select_mode(id) == UserSelectMode::None {
            return None;
        }
        let value = entry.node.value.as_deref().unwrap_or("");
        let focus = floor_boundary(value, self.caret.min(value.len()));
        let anchor = self
            .selection_anchor
            .map(|anchor| floor_boundary(value, anchor.min(value.len())))
            .unwrap_or(focus);
        Some((anchor, focus))
    }

    pub(crate) fn accessibility_text_lines(
        &mut self,
        id: &str,
        value: &str,
    ) -> Vec<AccessibilityTextLine> {
        let Some(entry) = self.entries.get(id) else {
            return vec![];
        };
        if !matches!(entry.node.kind.as_str(), "input" | "textarea") {
            return vec![];
        }
        let node = entry.node.clone();
        let scroll = entry.scroll;
        let rect = entry.rect;
        let Some(visible) = self.visible_rect(id) else {
            return vec![];
        };
        let pad = node.insets("padding");
        let border = node.insets("borderWidth");
        let multiline = node.kind == "textarea";
        let available_width =
            (rect.width() - (pad[1] + pad[3] + border[1] + border[3]) as f64).max(0.0) as f32;
        let wrap_width = multiline.then_some(available_width);
        self.text.prepare(&node);
        let (_, text_height) = self.text.measure(id, wrap_width);
        let origin_x = visible.x0 + pad[3] as f64 + border[3] as f64;
        let origin_y = if multiline {
            visible.y0 + pad[0] as f64 + border[0] as f64 - scroll
        } else {
            visible.y0 + (visible.height() - text_height as f64) / 2.0
        };
        let mut lines = self.text.accessibility_lines(id, value, wrap_width);
        for line in &mut lines {
            line.x0 += origin_x;
            line.x1 += origin_x;
            line.y0 += origin_y;
            line.y1 += origin_y;
        }
        lines
    }

    pub(crate) fn accessibility_selection_dragging(&self) -> bool {
        self.text_dragging
    }

    pub(crate) fn accessibility_focus(&mut self, id: &str) -> Vec<Value> {
        self.focus(id).map_or_else(Vec::new, |blurred| {
            vec![json!({"type":"blur", "id":blurred})]
        })
    }

    pub(crate) fn accessibility_blur(&mut self, id: &str) -> Vec<Value> {
        if self.focused.as_deref() != Some(id) {
            return vec![];
        }
        self.blur()
            .map(|blurred| vec![json!({"type":"blur", "id":blurred})])
            .unwrap_or_default()
    }

    pub(crate) fn accessibility_click(&self, id: &str) -> Vec<Value> {
        if !self.accessibility_interactive(id) {
            return vec![];
        }
        let node = &self.entries[id].node;
        if matches!(node.kind.as_str(), "button" | "pressable") {
            vec![json!({"type":"click", "id":id})]
        } else {
            vec![]
        }
    }

    pub(crate) fn accessibility_context(&self, id: &str) -> Vec<Value> {
        if !self.accessibility_interactive(id) {
            return vec![];
        }
        let Some(rect) = self.visible_rect(id) else {
            return vec![];
        };
        vec![json!({
            "type":"context",
            "id":id,
            "x":rect.center().x,
            "y":rect.center().y
        })]
    }

    fn valid_accessibility_text_value(&self, id: &str, value: &str) -> bool {
        let Some(entry) = self.entries.get(id) else {
            return false;
        };
        if !self.accessibility_interactive(id)
            || !matches!(entry.node.kind.as_str(), "input" | "textarea")
            || value
                .chars()
                .any(|ch| ch.is_control() && !(entry.node.kind == "textarea" && ch == '\n'))
        {
            return false;
        }
        entry.node.kind != "input" || entry.node.input_type != "number" || valid_number_edit(value)
    }

    pub(crate) fn accessibility_set_text_value(&mut self, id: &str, value: &str) -> Vec<Value> {
        if !self.valid_accessibility_text_value(id, value) {
            return vec![];
        }
        if self.ime_target() == Some(id) {
            self.ime_cancel();
        }
        let origin = (self.caret, self.selection_anchor);
        if self.focused.as_deref() == Some(id) {
            self.caret = value.len();
            self.selection_anchor = None;
        }
        let before = self
            .entries
            .get(id)
            .and_then(|entry| entry.node.value.clone())
            .unwrap_or_default();
        self.commit_edit(
            id.to_string(),
            before,
            origin,
            value.to_string(),
            EditKind::Other,
            true,
        )
    }

    pub(crate) fn accessibility_replace_selected_text(
        &mut self,
        id: &str,
        replacement: &str,
    ) -> Vec<Value> {
        if self.focused.as_deref() != Some(id) {
            return vec![];
        }
        let Some(entry) = self.entries.get(id) else {
            return vec![];
        };
        if !matches!(entry.node.kind.as_str(), "input" | "textarea") {
            return vec![];
        }
        let mut value = entry.node.value.clone().unwrap_or_default();
        let (start, end) = self
            .selected_range()
            .unwrap_or_else(|| (self.caret.min(value.len()), self.caret.min(value.len())));
        value.replace_range(start..end, replacement);
        if !self.valid_accessibility_text_value(id, &value) {
            return vec![];
        }
        self.ime_cancel();
        let origin = (self.caret, self.selection_anchor);
        let before = self.entries[id].node.value.clone().unwrap_or_default();
        self.caret = start + replacement.len();
        self.selection_anchor = None;
        self.commit_edit(id.to_string(), before, origin, value, EditKind::Other, true)
    }

    pub(crate) fn accessibility_set_text_selection(
        &mut self,
        id: &str,
        anchor_character: usize,
        focus_character: usize,
    ) -> Vec<Value> {
        let Some(entry) = self.entries.get(id) else {
            return vec![];
        };
        if !self.accessibility_interactive(id)
            || !matches!(entry.node.kind.as_str(), "input" | "textarea")
        {
            return vec![];
        }
        let user_select = self.user_select_mode(id);
        if user_select == UserSelectMode::None {
            return vec![];
        }
        let value = entry.node.value.clone().unwrap_or_default();
        let multiline = entry.node.kind == "textarea";
        let byte_at_character = |character: usize| {
            value
                .grapheme_indices(true)
                .nth(character)
                .map(|(index, _)| index)
                .unwrap_or(value.len())
        };
        let mut anchor = byte_at_character(anchor_character);
        let mut focus = byte_at_character(focus_character);
        if user_select == UserSelectMode::All && anchor != focus {
            anchor = 0;
            focus = value.len();
        }
        let events = self.accessibility_focus(id);
        self.ime_cancel();
        self.caret = focus;
        self.selection_anchor = (anchor != focus).then_some(anchor);
        if multiline {
            self.ensure_focused_textarea_caret_visible();
        }
        self.dirty.paint = true;
        events
    }

    pub(crate) fn accessibility_set_numeric_value(&mut self, id: &str, value: f64) -> Vec<Value> {
        if !self.accessibility_interactive(id)
            || !self
                .entries
                .get(id)
                .is_some_and(|entry| matches!(entry.node.kind.as_str(), "slider" | "splitter"))
        {
            return vec![];
        }
        self.set_slider(id, value)
    }

    pub(crate) fn accessibility_adjust_numeric(&mut self, id: &str, direction: f64) -> Vec<Value> {
        let Some(control) = self
            .entries
            .get(id)
            .filter(|_| self.accessibility_interactive(id))
            .and_then(|entry| entry.node.control.as_ref())
        else {
            return vec![];
        };
        self.set_slider(id, control.value + control.step * direction.signum())
    }

    pub(crate) fn accessibility_scroll_by(
        &mut self,
        id: &str,
        direction_x: f64,
        direction_y: f64,
        page: bool,
    ) -> Vec<Value> {
        if !self.accessibility_in_scope(id) {
            return vec![];
        }
        let Some(entry) = self.entries.get(id) else {
            return vec![];
        };
        if !matches!(entry.node.kind.as_str(), "scroll" | "textarea")
            || (entry.scroll_max <= 0.0 && entry.scroll_max_x <= 0.0)
        {
            return vec![];
        }
        let rect = self.visible_rect(id);
        let amount_x = if page {
            rect.map_or(120.0, |rect| (rect.width() - 24.0).max(36.0))
        } else {
            36.0
        };
        let amount_y = if page {
            rect.map_or(120.0, |rect| (rect.height() - 24.0).max(36.0))
        } else {
            36.0
        };
        self.scroll_to_2d(
            id,
            entry.scroll_x + amount_x * direction_x.signum(),
            entry.scroll + amount_y * direction_y.signum(),
        )
    }

    pub(crate) fn accessibility_set_scroll(
        &mut self,
        id: &str,
        offset_x: f64,
        offset_y: f64,
    ) -> Vec<Value> {
        if !self.accessibility_in_scope(id) {
            return vec![];
        }
        let Some(entry) = self.entries.get(id) else {
            return vec![];
        };
        if !matches!(entry.node.kind.as_str(), "scroll" | "textarea")
            || (entry.scroll_max <= 0.0 && entry.scroll_max_x <= 0.0)
        {
            return vec![];
        }
        self.scroll_to_2d(id, offset_x, offset_y)
    }

    pub(crate) fn accessibility_scroll_into_view(&mut self, id: &str) -> Vec<Value> {
        if !self.accessibility_in_scope(id) {
            return vec![];
        }
        let mut ancestors = Vec::new();
        let mut parent = self.entries[id].parent.clone();
        while let Some(parent_id) = parent {
            parent = self.entries[&parent_id].parent.clone();
            if matches!(
                self.entries[&parent_id].node.kind.as_str(),
                "scroll" | "textarea"
            ) && (self.entries[&parent_id].scroll_max > 0.0
                || self.entries[&parent_id].scroll_max_x > 0.0)
            {
                ancestors.push(parent_id);
            }
        }
        let mut events = Vec::new();
        for ancestor in ancestors {
            let (Some(target), Some(viewport)) =
                (self.visible_rect(id), self.visible_rect(&ancestor))
            else {
                continue;
            };
            let delta_x = if target.x0 < viewport.x0 {
                target.x0 - viewport.x0
            } else if target.x1 > viewport.x1 {
                target.x1 - viewport.x1
            } else {
                0.0
            };
            let delta_y = if target.y0 < viewport.y0 {
                target.y0 - viewport.y0
            } else if target.y1 > viewport.y1 {
                target.y1 - viewport.y1
            } else {
                0.0
            };
            if delta_x != 0.0 || delta_y != 0.0 {
                let entry = &self.entries[&ancestor];
                events.extend(self.scroll_to_2d(
                    &ancestor,
                    entry.scroll_x + delta_x,
                    entry.scroll + delta_y,
                ));
            }
        }
        events
    }

    pub(crate) fn accessibility_scroll_text_position_into_view(
        &mut self,
        id: &str,
        character: usize,
        alignment: Option<AccessibilityScrollAlignment>,
    ) -> Vec<Value> {
        if !self.accessibility_in_scope(id) {
            return vec![];
        }
        let Some(entry) = self.entries.get(id) else {
            return vec![];
        };
        if !matches!(entry.node.kind.as_str(), "input" | "textarea") {
            return self.accessibility_scroll_into_view(id);
        }
        let value = entry.node.value.clone().unwrap_or_default();
        let byte = value
            .grapheme_indices(true)
            .nth(character)
            .map(|(index, _)| index)
            .unwrap_or(value.len());
        let multiline = entry.node.kind == "textarea";
        let display_byte = input_display_index(&entry.node, &value, byte);
        let mut events = Vec::new();

        if multiline {
            let Some((width, viewport_height, _)) = self.textarea_metrics(id) else {
                return vec![];
            };
            self.text.prepare(&self.entries[id].node.clone());
            if let Some(cursor) = self.text.caret_rect(id, display_byte, Some(width)) {
                let current = self.entries[id].scroll;
                let next = match alignment {
                    Some(AccessibilityScrollAlignment::Top) => cursor.y0,
                    Some(AccessibilityScrollAlignment::Bottom) => cursor.y1 - viewport_height,
                    None if cursor.y0 < current => cursor.y0,
                    None if cursor.y1 > current + viewport_height => cursor.y1 - viewport_height,
                    None => current,
                };
                if next != current {
                    events.extend(self.scroll_to(id, next));
                }
            }
        }

        if let Some(alignment) = alignment {
            let mut ancestors = Vec::new();
            let mut parent = self.entries[id].parent.clone();
            while let Some(parent_id) = parent {
                parent = self.entries[&parent_id].parent.clone();
                if matches!(
                    self.entries[&parent_id].node.kind.as_str(),
                    "scroll" | "textarea"
                ) && (self.entries[&parent_id].scroll_max > 0.0
                    || self.entries[&parent_id].scroll_max_x > 0.0)
                {
                    ancestors.push(parent_id);
                }
            }
            for ancestor in ancestors {
                let Some(target) = self.accessibility_text_position_rect(id, display_byte) else {
                    break;
                };
                let Some(viewport) = self.visible_rect(&ancestor) else {
                    continue;
                };
                let delta_x = if target.x0 < viewport.x0 {
                    target.x0 - viewport.x0
                } else if target.x1 > viewport.x1 {
                    target.x1 - viewport.x1
                } else {
                    0.0
                };
                let delta_y = match alignment {
                    AccessibilityScrollAlignment::Top => target.y0 - viewport.y0,
                    AccessibilityScrollAlignment::Bottom => target.y1 - viewport.y1,
                };
                if delta_x != 0.0 || delta_y != 0.0 {
                    let entry = &self.entries[&ancestor];
                    events.extend(self.scroll_to_2d(
                        &ancestor,
                        entry.scroll_x + delta_x,
                        entry.scroll + delta_y,
                    ));
                }
            }
        } else {
            events.extend(self.accessibility_scroll_into_view(id));
        }
        events
    }

    fn accessibility_text_position_rect(
        &mut self,
        id: &str,
        display_byte: usize,
    ) -> Option<BoxRect> {
        let entry = self.entries.get(id)?;
        if !matches!(entry.node.kind.as_str(), "input" | "textarea") {
            return self.visible_rect(id);
        }
        let node = entry.node.clone();
        let scroll = entry.scroll;
        let rect = entry.rect;
        let visible = self.visible_rect(id)?;
        let pad = node.insets("padding");
        let border = node.insets("borderWidth");
        let multiline = node.kind == "textarea";
        let available_width =
            (rect.width() - (pad[1] + pad[3] + border[1] + border[3]) as f64).max(0.0) as f32;
        let wrap_width = multiline.then_some(available_width);
        self.text.prepare(&node);
        let (_, text_height) = self.text.measure(id, wrap_width);
        let cursor = self.text.caret_rect(id, display_byte, wrap_width)?;
        let origin_x = visible.x0 + pad[3] as f64 + border[3] as f64;
        let origin_y = if multiline {
            visible.y0 + pad[0] as f64 + border[0] as f64 - scroll
        } else {
            visible.y0 + (visible.height() - text_height as f64) / 2.0
        };
        Some(BoxRect::new(
            origin_x + cursor.x0,
            origin_y + cursor.y0,
            origin_x + cursor.x1.max(cursor.x0 + 1.0),
            origin_y + cursor.y1.max(cursor.y0 + 1.0),
        ))
    }

    fn static_text_index_from_pointer(&mut self, id: &str) -> Option<usize> {
        let entry = self.entries.get(id)?;
        if !matches!(
            entry.node.kind.as_str(),
            "text" | "markdown" | "code" | "diff"
        ) || self.user_select_mode(id) == UserSelectMode::None
        {
            return None;
        }
        let node = entry.node.clone();
        let rect = self.visible_rect(id).unwrap_or(entry.rect);
        let pad = node.insets("padding");
        let border = node.insets("borderWidth");
        if node.kind == "diff" {
            let x = (self.mouse.0 - rect.x0 - pad[3] as f64 - border[3] as f64).max(0.0) as f32;
            let y = (self.mouse.1 - rect.y0 - pad[0] as f64 - border[0] as f64).max(0.0) as f32;
            return self.text.diff_index_at(&node, x, y);
        }
        let width =
            (entry.rect.width() - (pad[1] + pad[3] + border[1] + border[3]) as f64).max(0.0) as f32;
        let x = (self.mouse.0
            - rect.x0
            - pad[3] as f64
            - border[3] as f64
            - f64::from(self.text.code_gutter_width(&node))
            + if node.kind == "code" {
                entry.scroll_x
            } else {
                0.0
            })
        .max(0.0) as f32;
        let y = (self.mouse.1 - rect.y0 - pad[0] as f64 - border[0] as f64).max(0.0) as f32;
        self.text.prepare(&node);
        let index = self
            .text
            .index_at(id, x, y, (node.kind != "code").then_some(width))?;
        Some(floor_boundary(&node.text, index.min(node.text.len())))
    }

    fn markdown_link_at_pointer(&mut self, id: &str) -> Option<String> {
        if self.entries.get(id)?.node.kind != "markdown" {
            return None;
        }
        let index = self.static_text_index_from_pointer(id)?;
        let RichContent::Text { spans, .. } = self.entries[id].node.rich.as_ref()?.as_ref() else {
            return None;
        };
        spans
            .iter()
            .find(|span| span.href.is_some() && span.range.contains(&index))
            .and_then(|span| span.href.clone())
    }

    fn diff_row_index_at_pointer(&self, id: &str) -> Option<usize> {
        let entry = self.entries.get(id)?;
        if entry.node.kind != "diff" {
            return None;
        }
        let rect = self.visible_rect(id).unwrap_or(entry.rect);
        let pad = entry.node.insets("padding");
        let border = entry.node.insets("borderWidth");
        let y = self.mouse.1 - rect.y0 - pad[0] as f64 - border[0] as f64;
        if y < 0.0 {
            return None;
        }
        let line_height = f64::from(
            (entry.node.number("fontSize", 13.0) * entry.node.number("lineHeight", 1.5)).max(1.0),
        );
        let index = (y / line_height).floor() as usize;
        let RichContent::Diff { rows, .. } = entry.node.rich.as_ref()?.as_ref() else {
            return None;
        };
        (index < rows.len()).then_some(index)
    }

    fn static_selection_range_for(&self, id: &str) -> Option<(usize, usize)> {
        if self.is_virtual_parked(id) {
            return None;
        }
        let selection = self.static_selection.as_ref()?;
        let entry = self.entries.get(id)?;
        if !matches!(
            entry.node.kind.as_str(),
            "text" | "markdown" | "code" | "diff"
        ) || self.user_select_mode(id) == UserSelectMode::None
        {
            return None;
        }
        let value = &entry.node.text;
        if let Some(root) = selection.atomic_root.as_deref() {
            if !self.is_descendant_of(id, root) || value.is_empty() {
                return None;
            }
            return Some((0, value.len()));
        }

        let anchor_index = self
            .order
            .iter()
            .position(|candidate| candidate == &selection.anchor_id)?;
        let focus_index = self
            .order
            .iter()
            .position(|candidate| candidate == &selection.focus_id)?;
        let current_index = self.order.iter().position(|candidate| candidate == id)?;
        let anchor = floor_boundary(
            self.entries.get(&selection.anchor_id)?.node.text.as_str(),
            selection.anchor,
        );
        let focus = floor_boundary(
            self.entries.get(&selection.focus_id)?.node.text.as_str(),
            selection.focus,
        );

        if anchor_index == focus_index {
            if current_index != anchor_index {
                return None;
            }
            let (start, end) = (anchor.min(focus), anchor.max(focus));
            return (start != end).then_some((start, end));
        }

        let (start_index, start_offset, end_index, end_offset) = if anchor_index < focus_index {
            (anchor_index, anchor, focus_index, focus)
        } else {
            (focus_index, focus, anchor_index, anchor)
        };
        if current_index < start_index || current_index > end_index {
            return None;
        }
        let (start, end) = if current_index == start_index {
            (start_offset.min(value.len()), value.len())
        } else if current_index == end_index {
            (0, end_offset.min(value.len()))
        } else {
            (0, value.len())
        };
        (start != end).then_some((start, end))
    }

    fn static_selected_text(&self) -> Option<String> {
        let mut parts = Vec::new();
        for id in &self.order {
            let Some((start, end)) = self.static_selection_range_for(id) else {
                continue;
            };
            let node = &self.entries[id].node;
            let part = node
                .rich
                .as_ref()
                .and_then(|rich| rich.copy_text(&node.text, start..end))
                .or_else(|| node.text.get(start..end).map(str::to_string));
            if let Some(part) = part
                && !part.is_empty()
            {
                parts.push(part);
            }
        }
        (!parts.is_empty()).then(|| parts.join("\n"))
    }

    fn selection_rects(
        &mut self,
        id: &str,
        start: usize,
        end: usize,
        width: Option<f32>,
    ) -> Vec<BoxRect> {
        let node = self.entries[id].node.clone();
        let value = node.value.clone().unwrap_or_default();
        self.text_range_rects(&node, id, &value, start, end, width)
    }

    fn text_range_rects(
        &mut self,
        node: &Node,
        layout_id: &str,
        value: &str,
        start: usize,
        end: usize,
        width: Option<f32>,
    ) -> Vec<BoxRect> {
        let start = floor_boundary(value, start.min(value.len()));
        let end = floor_boundary(value, end.min(value.len())).max(start);
        if start == end {
            return vec![];
        }
        let display_start = input_display_index(node, value, start);
        let display_end = input_display_index(node, value, end);
        self.text
            .range_rects(layout_id, display_start, display_end, width)
            .into_iter()
            .filter(|rect| rect.x1 > rect.x0 && rect.y1 > rect.y0)
            .map(|rect| BoxRect::new(rect.x0, rect.y0, rect.x1, rect.y1))
            .collect()
    }

    /// InputOTP: its transparent input spans every slot, so a text hit test
    /// would put the caret wherever the (tiny) value text happens to end.
    /// Map the click to the nearest slot instead: a filled slot selects its
    /// character so typing replaces it; an empty one puts the caret at the end.
    fn select_otp_slot_from_pointer(&mut self, id: &str) -> bool {
        let slot = self
            .entries
            .values()
            .filter_map(|entry| {
                let control = entry.node.control.as_ref()?;
                (control.role == "otpSlot" && control.group == id).then(|| {
                    let rect = self.visible_rect(&entry.node.id).unwrap_or(entry.rect);
                    let distance = if self.mouse.0 < rect.x0 {
                        rect.x0 - self.mouse.0
                    } else if self.mouse.0 > rect.x1 {
                        self.mouse.0 - rect.x1
                    } else {
                        0.0
                    };
                    (distance, control.value.max(0.0) as usize)
                })
            })
            .min_by(|a, b| a.0.total_cmp(&b.0));
        let Some((_, slot)) = slot else {
            return false;
        };
        let value = self.entries[id].node.value.as_deref().unwrap_or("");
        let starts: Vec<usize> = value
            .grapheme_indices(true)
            .map(|(start, _)| start)
            .collect();
        if let Some(start) = starts.get(slot).copied() {
            self.selection_anchor = Some(start);
            self.caret = starts.get(slot + 1).copied().unwrap_or(value.len());
        } else {
            self.selection_anchor = None;
            self.caret = value.len();
        }
        self.dirty.paint = true;
        self.touch_caret();
        true
    }

    fn place_text_caret_from_pointer(&mut self, id: &str) {
        let entry = &self.entries[id];
        let pad = entry.node.insets("padding");
        let border = entry.node.insets("borderWidth");
        let rect = self.visible_rect(id).unwrap_or(entry.rect);
        let width =
            (entry.rect.width() - (pad[1] + pad[3] + border[1] + border[3]) as f64).max(0.0) as f32;
        let x = (self.mouse.0 - rect.x0 - pad[3] as f64 - border[3] as f64).max(0.0) as f32;
        let multiline = entry.node.kind == "textarea";
        let y = if multiline {
            (self.mouse.1 - rect.y0 - pad[0] as f64 - border[0] as f64 + entry.scroll).max(0.0)
                as f32
        } else {
            0.0
        };
        let value = entry.node.value.as_deref().unwrap_or("");
        if let Some(index) = self.text.index_at(id, x, y, multiline.then_some(width)) {
            self.caret = input_actual_index(&entry.node, value, index);
            self.dirty.paint = true;
            self.touch_caret();
        }
    }

    fn textarea_metrics(&self, id: &str) -> Option<(f32, f64, String)> {
        let entry = self.entries.get(id)?;
        if entry.node.kind != "textarea" {
            return None;
        }
        let pad = entry.node.insets("padding");
        let border = entry.node.insets("borderWidth");
        let width =
            (entry.rect.width() - (pad[1] + pad[3] + border[1] + border[3]) as f64).max(0.0) as f32;
        let height =
            (entry.rect.height() - (pad[0] + pad[2] + border[0] + border[2]) as f64).max(0.0);
        Some((width, height, entry.node.value.clone().unwrap_or_default()))
    }

    fn textarea_vertical_index(&mut self, id: &str, direction: f32) -> Option<usize> {
        let (width, _, value) = self.textarea_metrics(id)?;
        let caret = floor_boundary(&value, self.caret.min(value.len()));
        let cursor = self.text.caret_rect(id, caret, Some(width))?;
        // Keep the column from where a run of Up/Down started, so passing a
        // shorter line does not pull the caret left for the rest of the run.
        let x = self
            .vertical_goal
            .filter(|(goal_caret, _)| *goal_caret == caret)
            .map_or(cursor.x0 as f32, |(_, x)| x);
        let y = if direction < 0.0 {
            (cursor.y0 as f32 - 1.0).max(0.0)
        } else {
            cursor.y1 as f32 + 1.0
        };
        let next = self.text.index_at(id, x, y, Some(width))?;
        let next = floor_boundary(&value, next.min(value.len()));
        self.vertical_goal = Some((next, x));
        Some(next)
    }

    fn textarea_visual_edge(&mut self, id: &str, end: bool) -> Option<usize> {
        let (width, _, value) = self.textarea_metrics(id)?;
        let caret = floor_boundary(&value, self.caret.min(value.len()));
        let cursor = self.text.caret_rect(id, caret, Some(width))?;
        let x = if end { width } else { 0.0 };
        let y = ((cursor.y0 + cursor.y1) * 0.5) as f32;
        let next = self.text.index_at(id, x, y, Some(width))?;
        Some(floor_boundary(&value, next.min(value.len())))
    }

    fn ensure_focused_textarea_caret_visible(&mut self) {
        let Some(id) = self.focused.clone() else {
            return;
        };
        let Some((width, viewport_height, _)) = self.textarea_metrics(&id) else {
            return;
        };
        let Some(layout) = self.prepare_edit_layout(&id) else {
            return;
        };
        let display_index = input_display_index(&layout.node, &layout.value, layout.caret);
        let Some(cursor) = self
            .text
            .caret_rect(&layout.node.id, display_index, Some(width))
        else {
            return;
        };
        let content_height = self.text.measure(&layout.node.id, Some(width)).1 as f64;
        let entry = self.entries.get_mut(&id).unwrap();
        entry.scroll_max = (content_height - viewport_height).max(0.0);
        let next = if cursor.y0 < entry.scroll {
            cursor.y0
        } else if cursor.y1 > entry.scroll + viewport_height {
            cursor.y1 - viewport_height
        } else {
            entry.scroll
        };
        entry.scroll = next.clamp(0.0, entry.scroll_max);
    }

    pub fn snapshots(&self) -> Vec<Value> {
        let mut result = vec![];
        self.snapshot_node(&self.root, Vec2::ZERO, &mut result);
        result
    }
    fn virtual_list_anchor_snapshot(&self, id: &str) -> Option<Value> {
        let list = self.entries.get(id)?;
        let metadata = list.node.virtual_list.as_ref()?;
        let rows = self.virtual_rows(id)?;
        let top = list.rect.y0 + list.scroll;
        let (offset, (key, row_id)) = rows.iter().enumerate().find(|(_, (_, row_id))| {
            self.entries
                .get(row_id)
                .is_some_and(|row| row.rect.height() > 0.0 && row.rect.y1 > top + 1e-6)
        })?;
        let row = self.entries.get(row_id)?;
        Some(json!({
            "index": metadata.window_start + offset,
            "key": key,
            "offset": (top - row.rect.y0).max(0.0)
        }))
    }
    fn snapshot_node(&self, id: &str, offset: Vec2, out: &mut Vec<Value>) {
        let e = &self.entries[id];
        let virtual_list_anchor = self.virtual_list_anchor_snapshot(id);
        out.push(json!({
            "id":id,"kind":e.node.kind,
            "x":e.rect.x0-offset.x,"y":e.rect.y0-offset.y,
            "width":e.rect.width(),"height":e.rect.height(),
            "scroll":e.scroll,"scrollMax":e.scroll_max,
            "scrollX":e.scroll_x,"scrollY":e.scroll,
            "scrollMaxX":e.scroll_max_x,"scrollMaxY":e.scroll_max,
            "text":e.node.display_text(),"control":e.node.control,
            "virtualListAnchor":virtual_list_anchor
        }));
        for child in &e.children {
            self.snapshot_node(child, offset + Vec2::new(e.scroll_x, e.scroll), out);
        }
    }
    pub fn layout_node_count(&self) -> usize {
        self.layout.total_node_count()
    }
    #[cfg(test)]
    pub(crate) fn image_cache_len(&self) -> usize {
        self.images.len()
    }
    #[cfg(test)]
    pub(crate) fn image_cache_bytes(&self, key: &str) -> Option<Vec<u8>> {
        self.images.get(key).map(|image| image.data.data().to_vec())
    }
    #[cfg(test)]
    pub(crate) fn svg_cache_len(&self) -> usize {
        self.svgs.len()
    }
    #[cfg(test)]
    pub(crate) fn svg_cache_scene(&self, id: &str) -> Option<crate::svg::SvgScene> {
        self.svgs.get(id).cloned()
    }
    #[cfg(test)]
    pub(crate) fn resolved_visual_string(&self, id: &str, key: &str, fallback: &str) -> String {
        let entry = &self.entries[id];
        let state = self.visual_state_for(id, &entry.node);
        visual_string(&entry.node, key, fallback, state).to_string()
    }
    #[cfg(test)]
    pub(crate) fn resolved_visual_number(&self, id: &str, key: &str, fallback: f32) -> f32 {
        let entry = &self.entries[id];
        let state = self.visual_state_for(id, &entry.node);
        visual_number(&entry.node, key, fallback, state)
    }
}

fn floor_boundary(value: &str, position: usize) -> usize {
    value
        .grapheme_indices(true)
        .map(|(i, _)| i)
        .chain(std::iter::once(value.len()))
        .take_while(|i| *i <= position)
        .last()
        .unwrap_or(0)
}
fn floor_char_boundary(value: &str, position: usize) -> usize {
    let mut position = position.min(value.len());
    while position > 0 && !value.is_char_boundary(position) {
        position -= 1;
    }
    position
}
fn previous_boundary(value: &str, position: usize) -> usize {
    value
        .grapheme_indices(true)
        .map(|(i, _)| i)
        .take_while(|i| *i < position)
        .last()
        .unwrap_or(0)
}
/// Start of the word at or before `position`, skipping whitespace first
/// (Ctrl+Left / Ctrl+Backspace). Uses Unicode word boundaries (UAX #29).
pub(crate) fn previous_word_boundary(value: &str, position: usize) -> usize {
    value
        .split_word_bound_indices()
        .rev()
        .find(|(start, word)| *start < position && !word.trim().is_empty())
        .map(|(start, _)| start)
        .unwrap_or(0)
}
/// End of the word at or after `position`, skipping whitespace first
/// (Ctrl+Right / Ctrl+Delete).
pub(crate) fn next_word_boundary(value: &str, position: usize) -> usize {
    value
        .split_word_bound_indices()
        .map(|(start, word)| (start + word.len(), word))
        .find(|(end, word)| *end > position && !word.trim().is_empty())
        .map_or(value.len(), |(end, _)| end)
}
fn next_boundary(value: &str, position: usize) -> usize {
    value
        .grapheme_indices(true)
        .map(|(i, _)| i)
        .find(|i| *i > position)
        .unwrap_or(value.len())
}

pub fn color(hex: &str) -> Color {
    let hex = hex.trim_start_matches('#');
    let number = u32::from_str_radix(hex, 16).unwrap_or(0);
    if hex.len() == 8 {
        Color::from_rgba8(
            (number >> 24) as u8,
            (number >> 16) as u8,
            (number >> 8) as u8,
            number as u8,
        )
    } else {
        Color::from_rgb8((number >> 16) as u8, (number >> 8) as u8, number as u8)
    }
}

/// `textShadow: { x, y, blur, color }` as (dx, dy, blur, colour). `blur` is
/// the CSS blur radius (sigma = blur / 2); 0 paints a solid offset copy.
fn text_shadow(node: &Node, state: VisualState) -> Option<(f64, f64, f64, Color)> {
    let shadow = visual_value(node, "textShadow", state).as_object()?;
    let number = |key: &str| shadow.get(key).and_then(Value::as_f64).unwrap_or(0.0);
    let colour = shadow.get("color")?.as_str()?;
    Some((
        number("x"),
        number("y"),
        number("blur").max(0.0),
        color(colour),
    ))
}

struct BoxShadow {
    x: f64,
    y: f64,
    blur: f64,
    spread: f64,
    color: Color,
    inset: bool,
}

/// `boxShadow` as one object or a list; the first entry paints on top, as in CSS.
fn box_shadows(node: &Node, state: VisualState) -> Vec<BoxShadow> {
    let value = visual_value(node, "boxShadow", state);
    let entries: Vec<&Value> = match value {
        Value::Array(items) => items.iter().collect(),
        Value::Object(_) => vec![value],
        _ => Vec::new(),
    };
    entries
        .into_iter()
        .filter_map(|entry| {
            let entry = entry.as_object()?;
            let number = |key: &str| entry.get(key).and_then(Value::as_f64).unwrap_or(0.0);
            Some(BoxShadow {
                x: number("x"),
                y: number("y"),
                blur: number("blur").max(0.0),
                spread: number("spread"),
                color: color(entry.get("color")?.as_str()?),
                inset: entry.get("inset").and_then(Value::as_bool).unwrap_or(false),
            })
        })
        .collect()
}

/// CSS blur radius is twice the gaussian standard deviation.
fn shadow_sigma(blur: f64) -> f64 {
    blur / 2.0
}

fn paint_outer_shadow<P: PaintTarget>(
    target: &mut P,
    transform: Affine,
    rect: BoxRect,
    radius: f64,
    shape: RoundedRect,
    shadow: &BoxShadow,
) {
    let spread = shadow.spread;
    let casting = BoxRect::new(
        rect.x0 + shadow.x - spread,
        rect.y0 + shadow.y - spread,
        rect.x1 + shadow.x + spread,
        rect.y1 + shadow.y + spread,
    );
    if casting.width() <= 0.0 || casting.height() <= 0.0 {
        return;
    }
    let casting_radius = if radius > 0.0 {
        (radius + spread).max(0.0)
    } else {
        0.0
    };
    let sigma = shadow_sigma(shadow.blur);
    let area = casting
        .inflate(sigma * 3.0 + 1.0, sigma * 3.0 + 1.0)
        .union(rect);
    // An outer shadow is never visible through its own box, even when the
    // background is translucent: clip to the area minus the border box.
    let mut outside = vello::kurbo::Shape::to_path(&area, 0.1);
    outside.extend(vello::kurbo::Shape::to_path(&shape, 0.1));
    target.push_clip(Fill::EvenOdd, transform, &outside);
    if sigma < 0.01 {
        target.fill(
            Fill::NonZero,
            transform,
            shadow.color,
            &RoundedRect::from_rect(casting, casting_radius),
        );
    } else {
        target.box_shadow(
            transform,
            area,
            casting,
            shadow.color,
            casting_radius,
            sigma,
            false,
        );
    }
    target.pop_layer();
}

/// Paints inside the padding box; the caller has already clipped to it.
fn paint_inset_shadow<P: PaintTarget>(
    target: &mut P,
    transform: Affine,
    padding_box: BoxRect,
    radius: f64,
    shadow: &BoxShadow,
) {
    let spread = shadow.spread;
    let hole = BoxRect::new(
        padding_box.x0 + shadow.x + spread,
        padding_box.y0 + shadow.y + spread,
        padding_box.x1 + shadow.x - spread,
        padding_box.y1 + shadow.y - spread,
    );
    if hole.width() <= 0.0 || hole.height() <= 0.0 {
        target.fill(Fill::NonZero, transform, shadow.color, &padding_box);
        return;
    }
    let hole_radius = (radius - spread).max(0.0);
    let sigma = shadow_sigma(shadow.blur);
    if sigma < 0.01 {
        let mut ring = vello::kurbo::Shape::to_path(&padding_box, 0.1);
        ring.extend(vello::kurbo::Shape::to_path(
            &RoundedRect::from_rect(hole, hole_radius),
            0.1,
        ));
        target.fill(Fill::EvenOdd, transform, shadow.color, &ring);
    } else {
        target.box_shadow(
            transform,
            padding_box,
            hole,
            shadow.color,
            hole_radius,
            sigma,
            true,
        );
    }
}

struct Outline<'a> {
    width: f64,
    offset: f64,
    radius_override: Option<f64>,
    color: &'a str,
    style: &'a str,
}

fn paint_outline<P: PaintTarget>(
    target: &mut P,
    transform: Affine,
    rect: BoxRect,
    base_radius: f64,
    outline: Outline<'_>,
) {
    let Outline {
        width,
        offset,
        radius_override,
        color: outline_color,
        style: outline_style,
    } = outline;
    if width <= 0.0 || matches!(outline_style, "none" | "hidden") {
        return;
    }
    match outline_style {
        "dashed" => paint_outline_stroke(
            target,
            transform,
            rect,
            base_radius,
            width,
            offset,
            radius_override,
            color(outline_color),
            Stroke::new(width).with_dashes(0.0, [width * 3.0, width * 2.0]),
            width,
            offset,
        ),
        "dotted" => paint_outline_stroke(
            target,
            transform,
            rect,
            base_radius,
            width,
            offset,
            radius_override,
            color(outline_color),
            Stroke::new(width)
                .with_caps(Cap::Round)
                .with_dashes(0.0, [0.01, width * 2.0]),
            width,
            offset,
        ),
        "double" => {
            let band = width / 3.0;
            paint_outline_stroke(
                target,
                transform,
                rect,
                base_radius,
                band,
                offset,
                radius_override,
                color(outline_color),
                Stroke::new(band),
                width,
                offset,
            );
            paint_outline_stroke(
                target,
                transform,
                rect,
                base_radius,
                band,
                offset + band * 2.0,
                radius_override,
                color(outline_color),
                Stroke::new(band),
                width,
                offset,
            );
        }
        "inset" | "outset" => {
            let light = shade_hex(outline_color, 0.35);
            let dark = shade_hex(outline_color, -0.35);
            let top_left = if outline_style == "inset" {
                &dark
            } else {
                &light
            };
            let bottom_right = if outline_style == "inset" {
                &light
            } else {
                &dark
            };
            paint_directional_outline(
                target,
                transform,
                rect,
                base_radius,
                width,
                offset,
                radius_override,
                top_left,
                bottom_right,
                width,
                offset,
            );
        }
        "groove" | "ridge" => {
            let light = shade_hex(outline_color, 0.35);
            let dark = shade_hex(outline_color, -0.35);
            let band = width / 2.0;
            let outer_is_inset = outline_style == "groove";
            let (outer_tl, outer_br) = if outer_is_inset {
                (&dark, &light)
            } else {
                (&light, &dark)
            };
            let (inner_tl, inner_br) = if outer_is_inset {
                (&light, &dark)
            } else {
                (&dark, &light)
            };
            paint_directional_outline(
                target,
                transform,
                rect,
                base_radius,
                band,
                offset,
                radius_override,
                inner_tl,
                inner_br,
                width,
                offset,
            );
            paint_directional_outline(
                target,
                transform,
                rect,
                base_radius,
                band,
                offset + band,
                radius_override,
                outer_tl,
                outer_br,
                width,
                offset,
            );
        }
        _ => paint_outline_stroke(
            target,
            transform,
            rect,
            base_radius,
            width,
            offset,
            radius_override,
            color(outline_color),
            Stroke::new(width),
            width,
            offset,
        ),
    }
}

#[allow(clippy::too_many_arguments)]
fn paint_outline_stroke<P: PaintTarget>(
    target: &mut P,
    transform: Affine,
    rect: BoxRect,
    base_radius: f64,
    band_width: f64,
    band_offset: f64,
    radius_override: Option<f64>,
    outline_color: Color,
    stroke: Stroke,
    total_width: f64,
    total_offset: f64,
) {
    if let Some(ring) = outline_ring(
        rect,
        base_radius,
        band_width,
        band_offset,
        radius_override,
        total_width,
        total_offset,
    ) {
        target.stroke(&stroke, transform, outline_color, &ring);
    }
}

/// The rounded rect whose stroke paints one outline band.
fn outline_ring(
    rect: BoxRect,
    base_radius: f64,
    band_width: f64,
    band_offset: f64,
    radius_override: Option<f64>,
    total_width: f64,
    total_offset: f64,
) -> Option<RoundedRect> {
    if band_width <= 0.0 {
        return None;
    }
    let max_inset = (rect.width().min(rect.height()) / 2.0 - 0.01).max(0.0);
    let expansion = (band_offset + band_width / 2.0).max(-max_inset);
    let outline_rect = BoxRect::new(
        rect.x0 - expansion,
        rect.y0 - expansion,
        rect.x1 + expansion,
        rect.y1 + expansion,
    );
    let base_expansion = total_offset + total_width / 2.0;
    let outline_radius = radius_override
        .map(|radius| radius + expansion - base_expansion)
        .unwrap_or(base_radius + expansion)
        .max(0.0);
    Some(RoundedRect::from_rect(outline_rect, outline_radius))
}

/// Dashed, dotted and double borders painted with a gradient: the style's
/// strokes become one clip path (expanded once on the CPU) over a single
/// gradient fill, so dashes sample the gradient where they sit.
fn paint_gradient_styled_border<P: PaintTarget>(
    target: &mut P,
    transform: Affine,
    rect: BoxRect,
    radius: f64,
    width: f64,
    style: &str,
    gradient: &PaintGradient,
) -> bool {
    let bands: Vec<(f64, f64, Stroke)> = match style {
        "dashed" => vec![(
            width,
            -width,
            Stroke::new(width).with_dashes(0.0, [width * 3.0, width * 2.0]),
        )],
        "dotted" => vec![(
            width,
            -width,
            Stroke::new(width)
                .with_caps(Cap::Round)
                .with_dashes(0.0, [0.01, width * 2.0]),
        )],
        "double" => {
            let band = width / 3.0;
            vec![
                (band, -width, Stroke::new(band)),
                (band, -width + band * 2.0, Stroke::new(band)),
            ]
        }
        _ => return false,
    };
    let mut clip = vello::kurbo::BezPath::new();
    for (band, offset, stroke) in bands {
        if let Some(ring) = outline_ring(rect, radius, band, offset, None, width, -width) {
            let outline = vello::kurbo::stroke(
                vello::kurbo::Shape::path_elements(&ring, 0.1),
                &stroke,
                &vello::kurbo::StrokeOpts::default(),
                0.1,
            );
            clip.extend(outline);
        }
    }
    target.push_clip(Fill::NonZero, transform, &clip);
    target.fill_gradient(transform, gradient, &rect);
    target.pop_layer();
    true
}

#[allow(clippy::too_many_arguments)]
fn paint_directional_outline<P: PaintTarget>(
    target: &mut P,
    transform: Affine,
    rect: BoxRect,
    base_radius: f64,
    band_width: f64,
    band_offset: f64,
    radius_override: Option<f64>,
    top_left_color: &str,
    bottom_right_color: &str,
    total_width: f64,
    total_offset: f64,
) {
    paint_outline_stroke(
        target,
        transform,
        rect,
        base_radius,
        band_width,
        band_offset,
        radius_override,
        color(bottom_right_color),
        Stroke::new(band_width),
        total_width,
        total_offset,
    );

    let outer = (band_offset + band_width).max(0.0);
    let clip_rect = BoxRect::new(
        rect.x0 - outer,
        rect.y0 - outer,
        rect.x1 + outer,
        rect.y1 + outer,
    );
    let center_x = (rect.x0 + rect.x1) / 2.0;
    let center_y = (rect.y0 + rect.y1) / 2.0;
    for clip in [
        BoxRect::new(clip_rect.x0, clip_rect.y0, clip_rect.x1, center_y),
        BoxRect::new(clip_rect.x0, clip_rect.y0, center_x, clip_rect.y1),
    ] {
        target.push_clip(Fill::NonZero, transform, &clip);
        paint_outline_stroke(
            target,
            transform,
            rect,
            base_radius,
            band_width,
            band_offset,
            radius_override,
            color(top_left_color),
            Stroke::new(band_width),
            total_width,
            total_offset,
        );
        target.pop_layer();
    }
}

fn shade_hex(hex: &str, amount: f64) -> String {
    let raw = hex.trim_start_matches('#');
    let parsed = u32::from_str_radix(raw, 16).unwrap_or(0);
    let (r, g, b, a) = if raw.len() == 8 {
        (
            (parsed >> 24) as u8,
            (parsed >> 16) as u8,
            (parsed >> 8) as u8,
            parsed as u8,
        )
    } else {
        ((parsed >> 16) as u8, (parsed >> 8) as u8, parsed as u8, 255)
    };
    let adjust = |channel: u8| -> u8 {
        if amount >= 0.0 {
            (channel as f64 + (255.0 - channel as f64) * amount.clamp(0.0, 1.0)).round() as u8
        } else {
            (channel as f64 * (1.0 + amount.clamp(-1.0, 0.0))).round() as u8
        }
    };
    format!(
        "#{:02x}{:02x}{:02x}{:02x}",
        adjust(r),
        adjust(g),
        adjust(b),
        a
    )
}
fn dimension(v: &Value) -> Dimension {
    if let Some(n) = v.as_f64() {
        return length(n as f32);
    }
    if let Some(s) = v
        .as_str()
        .and_then(|s| s.strip_suffix('%'))
        .and_then(|s| s.parse::<f32>().ok())
    {
        return percent(s / 100.0);
    }
    auto()
}
fn limit(v: &Value) -> LengthPercentageAuto {
    if let Some(n) = v.as_f64() {
        return length(n as f32);
    }
    if let Some(s) = v
        .as_str()
        .and_then(|s| s.strip_suffix('%'))
        .and_then(|s| s.parse::<f32>().ok())
    {
        return percent(s / 100.0);
    }
    auto()
}
fn motion_dimension(entry: &Entry, key: &str) -> Dimension {
    entry.motions.get(key).map_or_else(
        || dimension(&entry.node.style[key]),
        |track| length(track.current.first().copied().unwrap_or(0.0)),
    )
}
fn motion_limit(entry: &Entry, key: &str) -> LengthPercentageAuto {
    entry.motions.get(key).map_or_else(
        || limit(&entry.node.style[key]),
        |track| length(track.current.first().copied().unwrap_or(0.0)),
    )
}
fn layout_style(entry: &Entry, suppress_border: bool) -> Style {
    let node = &entry.node;
    let pad = node.insets("padding");
    let margin = node.insets("margin");
    let border = if suppress_border {
        [0.0; 4]
    } else {
        node.insets("borderWidth").map(|value| value.max(0.0))
    };
    let mut style = Style {
        display: match node.string("display", "flex") {
            "grid" => Display::Grid,
            "none" => Display::None,
            _ => Display::Flex,
        },
        flex_direction: match node.string(
            "direction",
            if node.kind == "row" { "row" } else { "column" },
        ) {
            "row" => FlexDirection::Row,
            "row-reverse" => FlexDirection::RowReverse,
            "column-reverse" => FlexDirection::ColumnReverse,
            _ => FlexDirection::Column,
        },
        aspect_ratio: node.style["aspectRatio"]
            .as_f64()
            .map(|value| value as f32)
            .filter(|value| value.is_finite() && *value > 0.0),
        flex_wrap: if node.style["wrap"].as_bool().unwrap_or(false) {
            FlexWrap::Wrap
        } else {
            FlexWrap::NoWrap
        },
        position: if node.string("position", "relative") == "absolute" {
            Position::Absolute
        } else {
            Position::Relative
        },
        inset: Rect {
            top: motion_limit(entry, "top"),
            right: motion_limit(entry, "right"),
            bottom: motion_limit(entry, "bottom"),
            left: motion_limit(entry, "left"),
        },
        size: Size {
            width: motion_dimension(entry, "width"),
            height: motion_dimension(entry, "height"),
        },
        min_size: Size {
            width: limit(&node.style["minWidth"]),
            height: limit(&node.style["minHeight"]),
        },
        max_size: Size {
            width: limit(&node.style["maxWidth"]),
            height: limit(&node.style["maxHeight"]),
        },
        padding: Rect {
            top: length(pad[0]),
            right: length(pad[1]),
            bottom: length(pad[2]),
            left: length(pad[3]),
        },
        margin: Rect {
            top: length(margin[0]),
            right: length(margin[1]),
            bottom: length(margin[2]),
            left: length(margin[3]),
        },
        border: Rect {
            top: length(border[0]),
            right: length(border[1]),
            bottom: length(border[2]),
            left: length(border[3]),
        },
        gap: Size {
            width: length(node.number("gap", 0.0)),
            height: length(node.number("gap", 0.0)),
        },
        flex_grow: node.number("flex", 0.0),
        flex_shrink: node.number("shrink", 0.0),
        align_items: Some(match node.string("align", "stretch") {
            "start" => AlignItems::START,
            "center" => AlignItems::CENTER,
            "end" => AlignItems::END,
            _ => AlignItems::STRETCH,
        }),
        justify_content: Some(match node.string("justify", "start") {
            "center" => JustifyContent::CENTER,
            "end" => JustifyContent::END,
            "between" => JustifyContent::SPACE_BETWEEN,
            _ => JustifyContent::START,
        }),
        ..Default::default()
    };
    if node.style["flex"].as_f64().is_some_and(|n| n > 0.0) {
        style.flex_basis = length(0.0);
        style.min_size.width = length(0.0);
    }
    if node.kind == "scroll" {
        if matches!(node.scroll_orientation.as_str(), "horizontal" | "both") {
            style.overflow.x = taffy::style::Overflow::Scroll;
            style.min_size.width = length(0.0);
        }
        if matches!(node.scroll_orientation.as_str(), "vertical" | "both") {
            style.overflow.y = taffy::style::Overflow::Scroll;
            style.min_size.height = length(0.0);
        }
    }
    if style.display == Display::Grid {
        style.grid_template_columns =
            vec![flex(1.0); node.number("columns", 2.0).clamp(1.0, 24.0) as usize];
    }
    style
}
