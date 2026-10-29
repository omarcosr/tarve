use super::*;

/// Feeds a JSON value to `hasher`; numbers hash by their `f64` value, so
/// `1` and `1.0` agree, as they do for every style reader.
pub(crate) fn hash_value(value: &Value, hasher: &mut impl std::hash::Hasher) {
    use std::hash::Hash;
    match value {
        Value::Null => 0u8.hash(hasher),
        Value::Bool(value) => (1u8, value).hash(hasher),
        Value::Number(value) => (2u8, value.as_f64().unwrap_or(f64::NAN).to_bits()).hash(hasher),
        Value::String(value) => (3u8, value).hash(hasher),
        Value::Array(values) => {
            (4u8, values.len()).hash(hasher);
            for value in values {
                hash_value(value, hasher);
            }
        }
        Value::Object(map) => {
            (5u8, map.len()).hash(hasher);
            for (key, value) in map {
                key.hash(hasher);
                hash_value(value, hasher);
            }
        }
    }
}

pub(super) const NUMERIC_MOTION_PROPERTIES: &[&str] = &[
    "width", "height", "top", "right", "bottom", "left", "opacity", "radius",
];
pub(super) const MOTION_PROPERTIES: &[&str] = &[
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

pub(super) fn validate_motion(node: &Node) -> Result<(), String> {
    if let Some(value) = node.style.get("transition") {
        let Some(transitions) = value.as_object() else {
            return Err(format!("transition must be an object on {}", node.id));
        };
        for (property, value) in transitions {
            if property != "all" && !MOTION_PROPERTIES.contains(&property.as_str()) {
                return Err(format!(
                    "Unsupported transition property on {}: {property}",
                    node.id
                ));
            }
            let Some(config) = value.as_object() else {
                return Err(format!(
                    "transition.{property} must be an object on {}",
                    node.id
                ));
            };
            for key in config.keys() {
                if !matches!(key.as_str(), "duration" | "delay" | "easing") {
                    return Err(format!(
                        "Unsupported transition option on {}: {property}.{key}",
                        node.id
                    ));
                }
            }
            for key in ["duration", "delay"] {
                if let Some(value) = config.get(key) {
                    let Some(value) = value.as_f64().filter(|value| value.is_finite()) else {
                        return Err(format!(
                            "transition.{property}.{key} must be a finite number on {}",
                            node.id
                        ));
                    };
                    if !(0.0..=600_000.0).contains(&value) {
                        return Err(format!(
                            "transition.{property}.{key} must be between 0 and 600000 on {}",
                            node.id
                        ));
                    }
                }
            }
            if let Some(easing) = config.get("easing") {
                let Some(easing) = easing.as_str() else {
                    return Err(format!(
                        "transition.{property}.easing must be a string on {}",
                        node.id
                    ));
                };
                if !matches!(
                    easing,
                    "linear" | "ease" | "easeIn" | "easeOut" | "easeInOut"
                ) {
                    return Err(format!(
                        "Unsupported transition easing on {}: {easing}",
                        node.id
                    ));
                }
            }
        }
    }

    if !node.motion_from.is_null() {
        let Some(values) = node.motion_from.as_object() else {
            return Err(format!("motionFrom must be an object on {}", node.id));
        };
        for (property, value) in values {
            if property == "transform" {
                if !value.is_object() {
                    return Err(format!(
                        "motionFrom.transform must be a transform object on {}",
                        node.id
                    ));
                }
                continue;
            }
            if !NUMERIC_MOTION_PROPERTIES.contains(&property.as_str()) {
                return Err(format!(
                    "Unsupported motionFrom property on {}: {property}",
                    node.id
                ));
            }
            if value.as_f64().is_none_or(|value| !value.is_finite()) {
                return Err(format!(
                    "motionFrom.{property} must be a finite number on {}",
                    node.id
                ));
            }
        }
    }
    Ok(())
}

pub(super) const MAX_BOX_SHADOWS: usize = 8;

pub(super) fn valid_box_shadow(value: &Value) -> bool {
    let one = |value: &Value| {
        value.as_object().is_some_and(|shadow| {
            shadow.get("color").is_some_and(Value::is_string)
                && ["x", "y", "spread"].iter().all(|key| {
                    shadow
                        .get(*key)
                        .is_none_or(|value| value.as_f64().is_some_and(f64::is_finite))
                })
                && shadow.get("blur").is_none_or(|value| {
                    value
                        .as_f64()
                        .is_some_and(|blur| blur.is_finite() && blur >= 0.0)
                })
                && shadow.get("inset").is_none_or(Value::is_boolean)
                && shadow.keys().all(|key| {
                    matches!(
                        key.as_str(),
                        "x" | "y" | "blur" | "spread" | "color" | "inset"
                    )
                })
        })
    };
    match value {
        Value::Array(items) => items.len() <= MAX_BOX_SHADOWS && items.iter().all(one),
        _ => one(value),
    }
}
