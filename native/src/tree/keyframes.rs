use super::*;

/// `property` as a motion vector were the node's style to set it to `value`
/// (a transform object merges over the node's own, keeping its origin).
pub(super) fn motion_value_with(node: &Node, property: &str, value: &Value) -> Option<Vec<f32>> {
    let mut node = node.clone();
    let value = match (
        property,
        value.as_object(),
        node.style.get(property).and_then(Value::as_object),
    ) {
        ("transform", Some(over), Some(own)) => {
            let mut merged = own.clone();
            merged.extend(over.clone());
            Value::Object(merged)
        }
        _ => value.clone(),
    };
    if let Some(style) = node.style.as_object_mut() {
        style.insert(property.to_string(), value);
    }
    motion_value(&node, property, VisualState::default())
}

/// `style.animation`: CSS `@keyframes` with a `from` and a `to` (the style's own value
/// where `to` leaves a property out), run `iterations` times (`"infinite"`: for ever),
/// every other run backwards with `direction: "alternate"`. A changed animation starts
/// over; an unchanged one keeps running through updates; none stops it.
pub(super) fn animation_tracks(
    node: &Node,
    previous: Option<&Entry>,
    now_ms: f64,
    motions: &mut HashMap<String, MotionTrack>,
) {
    let animation = node
        .style
        .get("animation")
        .filter(|value| value.is_object());
    let before = previous.and_then(|entry| entry.node.style.get("animation"));
    motions.retain(|_, track| track.repeat.is_none());
    let Some(animation) = animation else {
        return;
    };
    if let Some(previous) = previous.filter(|_| before == Some(animation)) {
        for (property, track) in &previous.motions {
            if track.repeat.is_some() {
                motions.insert(property.clone(), track.clone());
            }
        }
        return;
    }
    let Some(from) = animation.get("from").and_then(Value::as_object) else {
        return;
    };
    let to = animation.get("to").and_then(Value::as_object);
    let duration = animation
        .get("duration")
        .and_then(Value::as_f64)
        .unwrap_or(1000.0);
    let delay = animation
        .get("delay")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    if !duration.is_finite() || duration <= 0.0 || !delay.is_finite() || delay < 0.0 {
        return;
    }
    let iterations = match animation.get("iterations") {
        Some(Value::String(text)) if text == "infinite" => f64::INFINITY,
        Some(value) => value.as_f64().filter(|n| *n > 0.0).unwrap_or(1.0),
        None => 1.0,
    };
    let alternate = animation.get("direction").and_then(Value::as_str) == Some("alternate");
    let easing = match animation
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
    for (property, start) in from {
        if !MOTION_PROPERTIES.contains(&property.as_str()) {
            continue;
        }
        let Some(start) = motion_value_with(node, property, start) else {
            continue;
        };
        let end = match to.and_then(|to| to.get(property)) {
            Some(end) => motion_value_with(node, property, end),
            None => motion_value(node, property, VisualState::default()).or_else(|| match property
                .as_str()
            {
                "opacity" => Some(vec![1.0]),
                "radius" => Some(vec![0.0; 4]),
                _ => None,
            }),
        };
        let Some(end) = end else {
            continue;
        };
        if let Some(mut track) = MotionTrack::new(
            property,
            start,
            end,
            now_ms,
            (duration, delay, easing),
            false,
        ) {
            track.repeat = Some((iterations, alternate));
            motions.insert(property.clone(), track);
        }
    }
}
