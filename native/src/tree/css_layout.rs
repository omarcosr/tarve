//! CSS `flex` shorthands and grid lines/templates as Taffy styles.
use super::*;

pub(super) fn apply_css_flex(node: &Node, style: &mut Style) {
    let shorthand = match &node.style["flex"] {
        serde_json::Value::Number(number) => number
            .as_f64()
            .filter(|n| n.is_finite() && *n >= 0.0)
            .map(|n| (n as f32, 1.0, length(0.0))),
        serde_json::Value::String(text) => css_flex_shorthand(text),
        _ => None,
    };
    let grow = node.style["grow"].as_f64();
    let basis = css_basis(&node.style["basis"]);
    if shorthand.is_none() && grow.is_none() && basis.is_none() {
        return;
    }
    let (mut flex_grow, mut flex_shrink, mut flex_basis) =
        shorthand.unwrap_or((0.0, 1.0, Dimension::auto()));
    if let Some(grow) = grow {
        flex_grow = grow as f32;
    }
    if let Some(shrink) = node.style["shrink"].as_f64() {
        flex_shrink = shrink as f32;
    }
    if let Some(basis) = basis {
        flex_basis = basis;
    }
    style.flex_grow = flex_grow.max(0.0);
    style.flex_shrink = flex_shrink.max(0.0);
    style.flex_basis = flex_basis;
}

/// `flex` shorthand as CSS defines it: none | auto | initial | <grow> [<shrink>]? || <basis>.
pub(crate) fn css_flex_shorthand(value: &str) -> Option<(f32, f32, Dimension)> {
    match value.trim() {
        "none" => return Some((0.0, 0.0, Dimension::auto())),
        "auto" => return Some((1.0, 1.0, Dimension::auto())),
        "initial" => return Some((0.0, 1.0, Dimension::auto())),
        _ => {}
    }
    let mut numbers = Vec::new();
    let mut basis = None;
    for token in value.split_whitespace() {
        match token.parse::<f32>() {
            Ok(number) if number.is_finite() && number >= 0.0 && token != "0px" => {
                numbers.push(number)
            }
            _ if basis.is_none() => basis = Some(css_dimension(token)?),
            _ => return None,
        }
    }
    if numbers.is_empty() && basis.is_none() || numbers.len() > 2 {
        return None;
    }
    let grow = numbers.first().copied().unwrap_or(1.0);
    let shrink = numbers.get(1).copied().unwrap_or(1.0);
    // A bare number sets the basis to 0, as in `flex: 1` = `1 1 0%`.
    Some((grow, shrink, basis.unwrap_or_else(|| length(0.0))))
}

pub(super) fn css_dimension(token: &str) -> Option<Dimension> {
    if token == "0" {
        return Some(length(0.0));
    }
    token.parse::<Dimension>().ok()
}

pub(super) fn css_basis(value: &serde_json::Value) -> Option<Dimension> {
    match value {
        serde_json::Value::Number(number) => number.as_f64().map(|n| length(n as f32)),
        serde_json::Value::String(text) => css_dimension(text.trim()),
        _ => None,
    }
}

pub(crate) fn grid_line(
    value: &serde_json::Value,
) -> Option<taffy::Line<taffy::GridPlacement<String>>> {
    let text = match value {
        serde_json::Value::Number(number) => number.to_string(),
        serde_json::Value::String(text) => text.trim().to_string(),
        _ => return None,
    };
    let mut parts = text.splitn(2, '/');
    let start = parts
        .next()?
        .trim()
        .parse::<taffy::GridPlacement<String>>()
        .ok()?;
    let end = match parts.next() {
        Some(end) => end.trim().parse::<taffy::GridPlacement<String>>().ok()?,
        None => taffy::GridPlacement::Auto,
    };
    Some(taffy::Line { start, end })
}

/// `columns`/`rows`: a count of equal tracks, or a CSS track list such as
/// `repeat(auto-fill, minmax(176px, 1fr))` or `200px 1fr auto`.
pub(crate) fn grid_template(
    value: &serde_json::Value,
    default_count: usize,
) -> Vec<GridTemplateComponent<String>> {
    if let Some(text) = value.as_str()
        && let Some(tracks) = css_track_list(text)
    {
        return tracks;
    }
    let count = value
        .as_f64()
        .map(|n| n.clamp(1.0, 24.0) as usize)
        .unwrap_or(default_count);
    vec![flex(1.0); count]
}

pub(crate) fn css_track_list(text: &str) -> Option<Vec<GridTemplateComponent<String>>> {
    let mut tracks = Vec::new();
    let mut depth = 0usize;
    let mut start = 0usize;
    let bytes = text.as_bytes();
    let mut push = |piece: &str| -> Option<()> {
        let piece = piece.trim();
        if !piece.is_empty() {
            tracks.push(piece.parse::<GridTemplateComponent<String>>().ok()?);
        }
        Some(())
    };
    for (index, byte) in bytes.iter().enumerate() {
        match byte {
            b'(' => depth += 1,
            b')' => depth = depth.checked_sub(1)?,
            b' ' | b'\t' | b'\n' if depth == 0 => {
                push(&text[start..index])?;
                start = index + 1;
            }
            _ => {}
        }
    }
    if depth != 0 {
        return None;
    }
    push(&text[start..])?;
    (!tracks.is_empty()).then_some(tracks)
}
