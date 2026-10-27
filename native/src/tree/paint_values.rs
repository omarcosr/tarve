use super::*;

pub(super) fn rgba_of(colour: Color) -> [f32; 4] {
    colour.components
}

/// `style.glass`: `{ blur, saturate?, refraction?, highlight?, magnify?, merge?, blend? }`;
/// absent or invalid means no glass.
pub(crate) fn glass_params(value: &Value) -> Option<crate::paint::GlassParams> {
    let object = value.as_object()?;
    let number = |key: &str, fallback: f32| {
        object
            .get(key)
            .and_then(Value::as_f64)
            .map_or(fallback, |value| value as f32)
            .max(0.0)
    };
    // `max` drops a NaN fallback, so the key's presence is checked on its own.
    let blur = object
        .get("blur")
        .and_then(Value::as_f64)
        .filter(|blur| blur.is_finite())? as f32;
    let blur = blur.max(0.0);
    Some(crate::paint::GlassParams {
        blur: blur.min(64.0),
        saturate: number("saturate", 1.0).min(4.0),
        refraction: number("refraction", 0.0).min(48.0),
        highlight: number("highlight", 0.0).min(1.0),
        magnify: number("magnify", 0.0).min(0.3),
        merge: object
            .get("merge")
            .and_then(Value::as_str)
            .filter(|key| !key.is_empty())
            .map_or(0, |key| {
                use std::hash::{Hash, Hasher};
                let mut hasher = std::collections::hash_map::DefaultHasher::new();
                key.hash(&mut hasher);
                hasher.finish().max(1)
            }),
        blend: number("blend", 0.0).min(128.0),
    })
}

pub(super) fn colour_from(values: &[f32]) -> Color {
    let channel = |index: usize| values.get(index).copied().unwrap_or(0.0).clamp(0.0, 1.0);
    Color::new([channel(0), channel(1), channel(2), channel(3)])
}

pub(super) const GRADIENT_HEADER: usize = 12;
pub(super) const GRADIENT_STOP: usize = 6;

/// A CSS length as (value, unit): unit 1 is px; unit 0 is a fraction
/// (`"N%"`). Plain numbers are px.
pub(super) fn gradient_length(value: &Value) -> Option<(f32, f32)> {
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
pub(super) fn gradient_centre(at: Option<&Value>, key: &str, end_edge: &str) -> (f32, f32) {
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
pub(super) fn background_vector(value: &Value) -> Vec<f32> {
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
pub(super) fn paint_vector(value: &Value, fallback: &str) -> Vec<f32> {
    if value.is_null() {
        rgba_of(color(fallback)).to_vec()
    } else {
        background_vector(value)
    }
}

/// The solid colour of a paint vector: itself, or a gradient's first stop.
pub(super) fn vector_colour(values: &[f32]) -> Color {
    if values.len() >= GRADIENT_HEADER + GRADIENT_STOP {
        colour_from(&values[GRADIENT_HEADER + 2..GRADIENT_HEADER + 6])
    } else {
        colour_from(values)
    }
}

/// Gradients interpolate only when every discrete field matches (kind,
/// repeat, size, units, corner or circle flag); otherwise they switch, as do
/// colour ↔ gradient changes (their lengths differ).
pub(super) fn gradient_shapes_match(from: &[f32], to: &[f32]) -> bool {
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
pub(super) fn clip_stops(stops: &[(f64, Color)], low: f64, high: f64) -> Vec<(f64, Color)> {
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
pub(super) fn paint_gradient(values: &[f32], rect: BoxRect) -> Option<PaintGradient> {
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
