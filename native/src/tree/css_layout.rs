//! A node's Taffy style: CSS `flex` shorthands, grid lines and templates, and layout styles
//! shared between nodes.
use super::*;

/// CSS's automatic minimum sizes that Taffy cannot take from the content.
pub(super) fn apply_automatic_minimums(node: &Node, style: &mut Style) {
    // Replaced elements (img, svg): CSS's automatic minimum size is their
    // specified size, so a sized image never shrinks below it.
    if matches!(node.kind.as_str(), "image" | "svg" | "video") {
        if node.style["minWidth"].is_null() && node.style["width"].is_number() {
            style.min_size.width = length(node.number("width", 0.0));
        }
        if node.style["minHeight"].is_null() && node.style["height"].is_number() {
            style.min_size.height = length(node.number("height", 0.0));
        }
    }
    // An input's text scrolls inside it, so its value never sets its minimum width (a browser's
    // <input> does not grow with its value): the specified width, as CSS's specified size
    // suggestion, else 0 so a `flex` field shrinks with its row.
    if node.kind == "input" && node.style["minWidth"].is_null() {
        style.min_size.width = length(if node.style["width"].is_number() {
            node.number("width", 0.0)
        } else {
            0.0
        });
    }
}

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
    // `200px` and `50%` (the flex shorthand's basis), then whatever Taffy parses.
    if let Some(px) = token.strip_suffix("px").and_then(|n| n.parse::<f32>().ok()) {
        return Some(length(px));
    }
    if let Some(pc) = token.strip_suffix('%').and_then(|n| n.parse::<f32>().ok()) {
        return Some(percent(pc / 100.0));
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
/// `repeat(auto-fill, minmax(176px, 1fr))` or `200px 1fr auto`. `"none"` is CSS's initial
/// value: no explicit tracks, so items fill implicit ones (one auto column, a row each).
pub(crate) fn grid_template(
    value: &serde_json::Value,
    default_count: usize,
) -> Vec<GridTemplateComponent<String>> {
    if value.as_str().is_some_and(|text| text.trim() == "none") {
        return Vec::new();
    }
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

/// `0` standing alone between delimiters becomes `0px`; every other token is kept.
fn zero_lengths(piece: &str) -> String {
    let mut out = String::with_capacity(piece.len() + 4);
    let mut token = String::new();
    let flush = |token: &mut String, out: &mut String| {
        out.push_str(if token == "0" { "0px" } else { token });
        token.clear();
    };
    for character in piece.chars() {
        if matches!(character, '(' | ')' | ',' | ' ' | '\t' | '\n') {
            flush(&mut token, &mut out);
            out.push(character);
        } else {
            token.push(character);
        }
    }
    flush(&mut token, &mut out);
    out
}

pub(crate) fn css_track_list(text: &str) -> Option<Vec<GridTemplateComponent<String>>> {
    let mut tracks = Vec::new();
    let mut depth = 0usize;
    let mut start = 0usize;
    let bytes = text.as_bytes();
    let mut push = |piece: &str| -> Option<()> {
        let piece = piece.trim();
        if !piece.is_empty() {
            // CSS allows a unitless 0 as a length (`minmax(0, 1fr)`); the track parser wants `0px`.
            let piece = zero_lengths(piece);
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

/// Layout styles shared by the nodes they fit (`shared_layout_style`): by the address of the
/// node's interned style, with that style held so the address stays its own.
pub(crate) type LayoutStyles =
    HashMap<(usize, u64), Vec<(Arc<Value>, String, String, std::rc::Rc<Style>)>>;

/// The layout style of a node that does not animate (see `build_layout`), shared with every
/// node of the same style, kind and scroll orientation: a list's rows hold one between them.
pub(super) fn shared_layout_style(styles: &mut LayoutStyles, entry: &Entry) -> std::rc::Rc<Style> {
    use std::hash::{Hash, Hasher};
    let node = &entry.node;
    let value = node.style.shared();
    let mut hasher = rustc_hash::FxHasher::default();
    node.kind.hash(&mut hasher);
    node.scroll_orientation.hash(&mut hasher);
    let key = (Arc::as_ptr(value) as usize, hasher.finish());
    if styles.len() > 4096 {
        styles.clear();
    }
    let bucket = styles.entry(key).or_default();
    if let Some((_, _, _, style)) = bucket.iter().find(|(held, kind, orientation, _)| {
        Arc::ptr_eq(held, value) && *kind == node.kind && *orientation == node.scroll_orientation
    }) {
        return style.clone();
    }
    let style = std::rc::Rc::new(layout_style(entry, false));
    bucket.push((
        value.clone(),
        node.kind.clone(),
        node.scroll_orientation.clone(),
        style.clone(),
    ));
    style
}

pub(super) fn layout_style(entry: &Entry, suppress_border: bool) -> Style {
    let node = &entry.node;
    let pad = node.insets("padding");
    let margin = &node.style["margin"];
    let border = if suppress_border {
        [0.0; 4]
    } else {
        node.insets("borderWidth").map(|value| value.max(0.0))
    };
    let mut style = Style {
        display: match node.string("display", "flex") {
            "grid" => Display::Grid,
            "block" => Display::Block,
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
        // CSS `box-sizing`: Tarve sizes border boxes unless a node asks for content boxes.
        box_sizing: if node.string("boxSizing", "border-box") == "content-box" {
            taffy::style::BoxSizing::ContentBox
        } else {
            taffy::style::BoxSizing::BorderBox
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
        // Percentages (CSS `padding: 5%`) are of the container's width, as in CSS.
        padding: Rect {
            top: padding_side(node, "top", pad[0]),
            right: padding_side(node, "right", pad[1]),
            bottom: padding_side(node, "bottom", pad[2]),
            left: padding_side(node, "left", pad[3]),
        },
        // Margins take `"auto"` (and percentages) per side, as CSS does: `mx-auto` centres.
        margin: Rect {
            top: margin_side(margin, "top"),
            right: margin_side(margin, "right"),
            bottom: margin_side(margin, "bottom"),
            left: margin_side(margin, "left"),
        },
        border: Rect {
            top: length(border[0]),
            right: length(border[1]),
            bottom: length(border[2]),
            left: length(border[3]),
        },
        // CSS `column-gap` is the horizontal gap and `row-gap` the vertical; both fall back to `gap`.
        gap: Size {
            width: length(node.number("columnGap", node.number("gap", 0.0))),
            height: length(node.number("rowGap", node.number("gap", 0.0))),
        },
        flex_grow: node.number("flex", 0.0),
        // CSS: every flex item may shrink (`flex-shrink: 1`), never below its content.
        flex_shrink: node.number("shrink", 1.0),
        align_items: Some(match node.string("align", "stretch") {
            "start" => AlignItems::START,
            "center" => AlignItems::CENTER,
            "end" => AlignItems::END,
            "baseline" => AlignItems::BASELINE,
            _ => AlignItems::STRETCH,
        }),
        justify_content: Some(match node.string("justify", "start") {
            "center" => JustifyContent::CENTER,
            "end" => JustifyContent::END,
            "between" => JustifyContent::SPACE_BETWEEN,
            "around" => JustifyContent::SPACE_AROUND,
            "evenly" => JustifyContent::SPACE_EVENLY,
            "stretch" => JustifyContent::STRETCH,
            // CSS `flex-start`: the main start, the right of a `row-reverse` row.
            _ => JustifyContent::FLEX_START,
        }),
        // CSS `align-self`, `align-content`, `justify-items`, `justify-self`: unset means the container decides.
        align_self: align_keyword(node.string("alignSelf", "")),
        align_content: content_keyword(node.string("alignContent", "")),
        justify_items: align_keyword(node.string("justifyItems", "")),
        justify_self: align_keyword(node.string("justifySelf", "")),
        ..Default::default()
    };
    apply_css_flex(node, &mut style);
    // `overflow: hidden | clip` clips children and, as in CSS, lets the box
    // shrink below its content (automatic minimum size 0).
    if clips_overflow(node) && node.kind != "scroll" {
        style.overflow.x = taffy::style::Overflow::Hidden;
        style.overflow.y = taffy::style::Overflow::Hidden;
    }
    apply_automatic_minimums(node, &mut style);
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
        // CSS `justify-content: normal` stretches auto tracks; START would not.
        if node.style["justify"].is_null() {
            style.justify_content = None;
        }
        style.grid_template_columns = grid_template(&node.style["columns"], 2);
        style.grid_template_rows = grid_template(&node.style["rows"], 0);
        // CSS `grid-auto-rows` / `grid-auto-columns`: the size of implicit tracks.
        style.grid_auto_rows = auto_tracks(&node.style["autoRows"]);
        style.grid_auto_columns = auto_tracks(&node.style["autoColumns"]);
    }
    // CSS `grid-column` / `grid-row`: "span 2", "2", "1 / 3", "2 / span 2".
    if let Some(line) = grid_line(&node.style["gridColumn"]) {
        style.grid_column = line;
    }
    if let Some(line) = grid_line(&node.style["gridRow"]) {
        style.grid_row = line;
    }
    style
}
