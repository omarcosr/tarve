use crate::{
    paint::{PaintGlyph, PaintTarget},
    protocol::Node,
    rich::{
        DiffRow, DiffRowKind, MarkdownBlock, MarkdownBlockKind, RichContent, Span, TaskMarker,
        ToneRole,
    },
    syntax::HighlightKind,
};
use parley::{
    FontContext, FontFamily, FontStyle, FontWeight, GenericFamily, Layout, LayoutContext,
    LineHeight, PositionedLayoutItem, StyleProperty,
    layout::{Affinity, Cursor, Selection},
};
#[cfg(feature = "fxhash")]
use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};
use serde_json::Value;
#[cfg(not(feature = "fxhash"))]
use std::collections::{HashMap, HashSet};
use std::ops::Range;
use unicode_segmentation::UnicodeSegmentation;
use vello::{
    kurbo::{Affine, BezPath, Rect, RoundedRect, Stroke},
    peniko::{Color, Fill},
};

/// Run colour, plus CSS `vertical-align: super | sub`: `.1` is the baseline
/// shift (px, up) and `.2` the run's own line box height (px).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TextBrush(pub Option<String>, pub f32, pub f32, pub DecorationStyle);

impl TextBrush {
    pub fn color(color: String) -> Self {
        Self(Some(color), 0.0, 0.0, DecorationStyle::Solid)
    }
}

/// CSS `text-decoration-style`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum DecorationStyle {
    #[default]
    Solid,
    Double,
    Dotted,
    Dashed,
    Wavy,
}

impl DecorationStyle {
    pub fn parse(value: &str) -> Self {
        match value {
            "double" => Self::Double,
            "dotted" => Self::Dotted,
            "dashed" => Self::Dashed,
            "wavy" => Self::Wavy,
            _ => Self::Solid,
        }
    }
}

/// One decoration line from x0 to x1 whose top edge is y, drawn like Chromium:
/// dotted is round dots one thickness wide with equal gaps, dashed is 3:1, double
/// is two lines a thickness apart, wavy a sine of amplitude ~thickness.
#[allow(clippy::too_many_arguments)]
pub(crate) fn draw_decoration<P: PaintTarget>(
    target: &mut P,
    transform: Affine,
    color: Color,
    x0: f64,
    x1: f64,
    y: f64,
    thickness: f64,
    style: DecorationStyle,
) {
    if x1 <= x0 {
        return;
    }
    match style {
        DecorationStyle::Solid => target.fill(
            Fill::NonZero,
            transform,
            color,
            &Rect::new(x0, y, x1, y + thickness),
        ),
        DecorationStyle::Double => {
            target.fill(
                Fill::NonZero,
                transform,
                color,
                &Rect::new(x0, y, x1, y + thickness),
            );
            let y2 = y + thickness * 2.0;
            target.fill(
                Fill::NonZero,
                transform,
                color,
                &Rect::new(x0, y2, x1, y2 + thickness),
            );
        }
        DecorationStyle::Dotted | DecorationStyle::Dashed => {
            let (dash, gap) = if style == DecorationStyle::Dotted {
                (thickness, thickness)
            } else {
                (thickness * 3.0, thickness)
            };
            let mut x = x0;
            while x < x1 {
                let end = (x + dash).min(x1);
                if style == DecorationStyle::Dotted {
                    let r = thickness / 2.0;
                    target.fill(
                        Fill::NonZero,
                        transform,
                        color,
                        &vello::kurbo::Circle::new((x + r, y + r), r),
                    );
                } else {
                    target.fill(
                        Fill::NonZero,
                        transform,
                        color,
                        &Rect::new(x, y, end, y + thickness),
                    );
                }
                x += dash + gap;
            }
        }
        DecorationStyle::Wavy => {
            let amplitude = thickness.max(1.0);
            let wavelength = amplitude * 4.0;
            let mut path = vello::kurbo::BezPath::new();
            let mid = y + thickness / 2.0;
            path.move_to((x0, mid));
            let mut x = x0;
            let mut up = true;
            while x < x1 {
                let next = (x + wavelength / 2.0).min(x1);
                let peak = if up { mid - amplitude } else { mid + amplitude };
                path.quad_to(((x + next) / 2.0, peak), (next, mid));
                x = next;
                up = !up;
            }
            target.stroke(
                &vello::kurbo::Stroke::new(thickness),
                transform,
                color,
                &path,
            );
        }
    }
}

/// Extra space a line needs above and below for raised and lowered runs, as
/// CSS grows a line box to contain shifted inline boxes. Per line: (top, bottom).
pub(crate) fn shifted_line_extents(layout: &Layout<TextBrush>) -> Option<Vec<(f32, f32)>> {
    let mut any = false;
    let extents = layout
        .lines()
        .map(|line| {
            let metrics = line.metrics();
            let above = metrics.baseline - metrics.block_min_coord;
            let below = metrics.block_max_coord - metrics.baseline;
            let (mut top, mut bottom) = (0.0f32, 0.0f32);
            for item in line.items() {
                let PositionedLayoutItem::GlyphRun(glyph_run) = item else {
                    continue;
                };
                let TextBrush(_, shift, line_box, _) = &glyph_run.style().brush;
                if *shift == 0.0 {
                    continue;
                }
                any = true;
                let run = glyph_run.run().metrics();
                let half = (line_box - (run.ascent + run.descent)) / 2.0;
                top = top.max(run.ascent + half + shift - above);
                bottom = bottom.max(run.descent + half - shift - below);
            }
            (top.max(0.0), bottom.max(0.0))
        })
        .collect();
    any.then_some(extents)
}

/// Moves a layout-space y (selection, caret) onto the line it belongs to once
/// shifted runs have grown the lines above it.
pub(crate) fn shifted_y(layout: &Layout<TextBrush>, y: f64) -> f64 {
    let Some(extents) = shifted_line_extents(layout) else {
        return y;
    };
    let (offsets, _) = shifted_line_offsets(&extents);
    for (index, line) in layout.lines().enumerate() {
        if y < f64::from(line.metrics().block_max_coord) || index + 1 == offsets.len() {
            return y + f64::from(offsets[index]);
        }
    }
    y
}

/// Cumulative offset of each line once shifted runs have grown the lines above it.
pub(crate) fn shifted_line_offsets(extents: &[(f32, f32)]) -> (Vec<f32>, f32) {
    let mut offsets = Vec::with_capacity(extents.len());
    let mut total = 0.0;
    for (top, bottom) in extents {
        offsets.push(total + top);
        total += top + bottom;
    }
    (offsets, total)
}

pub struct DiffPaintArea {
    pub rect: Rect,
    pub clip: Rect,
    pub origin: (f64, f64),
}

pub struct TextDrawArea {
    pub origin: (f64, f64),
    pub width: f32,
    pub visible_y: (f64, f64),
    pub scroll_x: f64,
}

#[derive(Clone, Debug)]
pub struct TextPaintHighlight {
    pub range: Range<usize>,
    pub color: Color,
}

pub struct DiffPaintDecorations<'a> {
    pub selection: Option<(usize, usize)>,
    pub highlights: &'a [TextPaintHighlight],
}

#[derive(Clone, Copy)]
struct TaskMarkerPaintStyle {
    font_size: f32,
    marker_color: Color,
    check_color: Color,
}

fn draw_task_markers<P: PaintTarget>(
    target: &mut P,
    layout: &Layout<TextBrush>,
    markers: &[TaskMarker],
    origin: (f64, f64),
    style: TaskMarkerPaintStyle,
    scale: f64,
) {
    let transform = Affine::scale(scale);
    let size = f64::from((style.font_size * 0.86).clamp(10.0, 18.0));
    let border = (size * 0.105).clamp(1.25, 1.8);
    for marker in markers {
        let anchor = Cursor::from_byte_index(layout, marker.range.start, Affinity::Downstream);
        let focus = Cursor::from_byte_index(layout, marker.range.end, Affinity::Upstream);
        let Some((geometry, _)) = Selection::new(anchor, focus)
            .geometry(layout)
            .into_iter()
            .next()
        else {
            continue;
        };
        let x = origin.0 + geometry.x0 + (geometry.width() - size) * 0.5;
        let y = origin.1 + geometry.y0 + (geometry.height() - size) * 0.5;
        let rect = Rect::new(x, y, x + size, y + size);
        let rounded = RoundedRect::from_rect(rect, (size * 0.2).clamp(2.0, 3.5));
        if marker.checked {
            target.fill(Fill::NonZero, transform, style.marker_color, &rounded);
            let mut check = BezPath::new();
            check.move_to((x + size * 0.23, y + size * 0.52));
            check.line_to((x + size * 0.43, y + size * 0.70));
            check.line_to((x + size * 0.78, y + size * 0.31));
            target.stroke(
                &Stroke::new((size * 0.12).clamp(1.5, 2.2)),
                transform,
                style.check_color,
                &check,
            );
        } else {
            target.stroke(
                &Stroke::new(border),
                transform,
                style.marker_color,
                &rounded,
            );
        }
    }
}

fn block_vertical_extent(layout: &Layout<TextBrush>, range: &Range<usize>) -> Option<(f64, f64)> {
    if range.start >= range.end {
        return None;
    }
    let anchor = Cursor::from_byte_index(layout, range.start, Affinity::Downstream);
    let focus = Cursor::from_byte_index(layout, range.end, Affinity::Upstream);
    let geometry = Selection::new(anchor, focus).geometry(layout);
    Some((
        geometry.iter().map(|(rect, _)| rect.y0).reduce(f64::min)?,
        geometry.iter().map(|(rect, _)| rect.y1).reduce(f64::max)?,
    ))
}

fn markdown_block_extent(lines: &[MarkdownLine], range: &Range<usize>) -> Option<(f64, f64)> {
    let first = lines.get(lines.partition_point(|line| line.range.end <= range.start))?;
    if first.range.start >= range.end {
        return None;
    }
    let last_index = lines
        .partition_point(|line| line.range.start < range.end)
        .saturating_sub(1);
    let last = lines.get(last_index)?;
    Some((f64::from(first.y), f64::from(last.y + last.height)))
}

fn draw_markdown_blocks<P: PaintTarget>(
    target: &mut P,
    layout: &Layout<TextBrush>,
    blocks: &[MarkdownBlock],
    node: &Node,
    origin: (f64, f64),
    width: f32,
    scale: f64,
) {
    let transform = Affine::scale(scale);
    let right = origin.0 + f64::from(width);
    for block in blocks {
        let Some((top, bottom)) = block_vertical_extent(layout, &block.range) else {
            continue;
        };
        match &block.kind {
            MarkdownBlockKind::Code => target.fill(
                Fill::NonZero,
                transform,
                crate::tree::color(node.string("markdownCodeBackground", "#f6f8fa")),
                &Rect::new(
                    origin.0 - 4.0,
                    origin.1 + top - 3.0,
                    right,
                    origin.1 + bottom + 3.0,
                ),
            ),
            MarkdownBlockKind::Quote => {
                target.fill(
                    Fill::NonZero,
                    transform,
                    crate::tree::color(node.string("markdownQuoteBackground", "#f6f8fa")),
                    &Rect::new(
                        origin.0 - 4.0,
                        origin.1 + top - 2.0,
                        right,
                        origin.1 + bottom + 2.0,
                    ),
                );
                target.fill(
                    Fill::NonZero,
                    transform,
                    crate::tree::color(node.string("markdownQuoteAccent", "#64748b")),
                    &Rect::new(
                        origin.0 - 4.0,
                        origin.1 + top - 2.0,
                        origin.0 - 1.0,
                        origin.1 + bottom + 2.0,
                    ),
                );
            }
            MarkdownBlockKind::Table { rows, header } => {
                for (index, row) in rows.iter().enumerate() {
                    if let Some((row_top, row_bottom)) = block_vertical_extent(layout, row) {
                        if *header == Some(index) {
                            target.fill(
                                Fill::NonZero,
                                transform,
                                crate::tree::color(
                                    node.string("markdownTableHeaderBackground", "#f6f8fa"),
                                ),
                                &Rect::new(
                                    origin.0 - 4.0,
                                    origin.1 + row_top - 2.0,
                                    right,
                                    origin.1 + row_bottom + 2.0,
                                ),
                            );
                        }
                        target.fill(
                            Fill::NonZero,
                            transform,
                            crate::tree::color(node.string("markdownTableRule", "#d0d7de")),
                            &Rect::new(
                                origin.0 - 4.0,
                                origin.1 + row_bottom + 1.0,
                                right,
                                origin.1 + row_bottom + 2.0,
                            ),
                        );
                    }
                }
            }
        }
    }
}

pub const TEXT_KEYS: &[&str] = &[
    "fontSize",
    "fontWeight",
    "fontFamily",
    "lineHeight",
    "textAlign",
    "fontStyle",
    "letterSpacing",
    "wordSpacing",
    "whiteSpace",
    "textOverflow",
    "textDecorationStyle",
    "lineClamp",
    "overflow",
];

/// CSS `white-space: nowrap | pre` keep a text node on its source lines.
pub(crate) fn text_nowrap(node: &Node) -> bool {
    node.kind == "text" && matches!(node.string("whiteSpace", "normal"), "nowrap" | "pre")
}

/// Lines a text node may show: `lineClamp`, or one for a single-line ellipsis.
fn text_line_clamp(node: &Node) -> Option<usize> {
    if node.kind != "text" {
        return None;
    }
    node.style["lineClamp"]
        .as_f64()
        .filter(|n| *n >= 1.0)
        .map(|n| n as usize)
}

/// CSS `text-overflow: ellipsis` applies to a box that clips its overflow.
fn text_ellipsis(node: &Node) -> bool {
    node.kind == "text"
        && (text_line_clamp(node).is_some()
            || (node.string("textOverflow", "clip") == "ellipsis"
                && matches!(node.string("overflow", "visible"), "hidden" | "clip")))
}

/// A run of a text node: `{ start, end, style, id }` with byte offsets.
pub(crate) struct TextRun<'a> {
    pub start: usize,
    pub end: usize,
    pub style: &'a Value,
    pub id: Option<&'a str>,
}

pub(crate) fn text_runs<'a>(node: &'a Node, len: usize, text: &str) -> Vec<TextRun<'a>> {
    let Some(runs) = node.runs.as_array() else {
        return vec![];
    };
    runs.iter()
        .filter_map(|run| {
            let start = run["start"].as_u64()? as usize;
            let end = (run["end"].as_u64()? as usize).min(len);
            (start < end && text.is_char_boundary(start) && text.is_char_boundary(end)).then(|| {
                TextRun {
                    start,
                    end,
                    style: &run["style"],
                    id: run["id"].as_str(),
                }
            })
        })
        .collect()
}

fn optical_size(size: f32) -> StyleProperty<'static, TextBrush> {
    StyleProperty::FontVariations(parley::FontVariations::Source(std::borrow::Cow::Owned(
        format!("\"opsz\" {size}"),
    )))
}

fn push_text_style(
    builder: &mut parley::RangedBuilder<'_, TextBrush>,
    style: &Value,
    range: std::ops::Range<usize>,
    base: (f32, f32),
) {
    if let Some(size) = style["fontSize"].as_f64() {
        builder.push(StyleProperty::FontSize(size as f32), range.clone());
        builder.push(optical_size(size as f32), range.clone());
    }
    if let Some(weight) = style["fontWeight"].as_f64() {
        builder.push(
            StyleProperty::FontWeight(FontWeight::new(weight as f32)),
            range.clone(),
        );
    }
    match style["fontStyle"].as_str() {
        Some("italic" | "oblique") => {
            builder.push(StyleProperty::FontStyle(FontStyle::Italic), range.clone())
        }
        Some("normal") => builder.push(StyleProperty::FontStyle(FontStyle::Normal), range.clone()),
        _ => {}
    }
    if let Some(family) = style["fontFamily"].as_str() {
        builder.push(
            StyleProperty::FontFamily(font_family_from_name(family)),
            range.clone(),
        );
    }
    let shift = style["baselineShift"].as_f64().unwrap_or(0.0) as f32;
    let decoration = style["textDecorationStyle"]
        .as_str()
        .map_or(DecorationStyle::Solid, DecorationStyle::parse);
    if style["foreground"].is_string() || shift != 0.0 || decoration != DecorationStyle::Solid {
        let size = style["fontSize"]
            .as_f64()
            .map(|n| n as f32)
            .unwrap_or(base.0);
        builder.push(
            StyleProperty::Brush(TextBrush(
                style["foreground"].as_str().map(str::to_string),
                shift,
                size * base.1,
                decoration,
            )),
            range.clone(),
        );
    }
    if let Some(spacing) = style["letterSpacing"].as_f64() {
        builder.push(StyleProperty::LetterSpacing(spacing as f32), range.clone());
    }
    if let Some(spacing) = style["wordSpacing"].as_f64() {
        builder.push(StyleProperty::WordSpacing(spacing as f32), range.clone());
    }
    if let Some(value) = style["textDecoration"].as_str() {
        builder.push(
            StyleProperty::Underline(value.contains("underline")),
            range.clone(),
        );
        builder.push(
            StyleProperty::Strikethrough(value.contains("line-through")),
            range,
        );
    }
}

fn node_font_family(node: &Node, fallback: GenericFamily) -> FontFamily<'_> {
    node.optional_string("fontFamily")
        .map(font_family_from_name)
        .unwrap_or_else(|| fallback.into())
}

fn font_family_from_name(family: &str) -> FontFamily<'_> {
    match GenericFamily::parse(family) {
        // Fontconfig's `system-ui` mapping is not equally reliable across
        // Linux distributions. Preserve the native UI family elsewhere while
        // using the portable sans-serif generic on Linux.
        Some(GenericFamily::SystemUi) => default_ui_generic_family().into(),
        Some(generic) => generic.into(),
        None => FontFamily::Source(family.into()),
    }
}

fn default_ui_generic_family() -> GenericFamily {
    // Fontconfig does not map the CSS-like `system-ui` generic consistently
    // across Linux distributions. In particular, a bad system-ui match can
    // force otherwise basic characters into per-glyph fallback faces. The
    // standard `sans-serif` generic is the portable Fontconfig UI fallback.
    // Keep the native system UI family on platforms where the mapping is
    // provided directly by the OS font backend (for example Segoe UI on
    // Windows).
    if cfg!(target_os = "linux") {
        GenericFamily::SansSerif
    } else {
        GenericFamily::SystemUi
    }
}

pub struct TextEngine {
    fonts: FontContext,
    context: LayoutContext<TextBrush>,
    pub layouts: HashMap<String, Layout<TextBrush>>,
    markdown_lines: HashMap<String, Vec<MarkdownLine>>,
    markdown_scroll: HashMap<(String, usize), f32>,
    markdown_metrics: HashMap<String, (Option<f32>, (f32, f32))>,
    markdown_block_widths: HashMap<String, HashMap<usize, f32>>,
    pub(crate) diff_layouts: HashMap<String, HashMap<usize, DiffRowLayouts>>,
    pub(crate) code_gutter_layouts: HashMap<String, Vec<Layout<TextBrush>>>,
    code_gutter_widths: HashMap<String, f32>,
    /// `Code` blocks, which are measured unwrapped and scroll sideways.
    unwrapped_code: HashSet<String>,
    diff_column_widths: HashMap<String, (String, f32, f32)>,
    pub shapes: u64,
    #[cfg(test)]
    pub markdown_painted_lines: usize,
    signatures: HashMap<String, (String, Vec<serde_json::Value>)>,
    alignments: HashMap<String, parley::Alignment>,
    /// Blurred text-shadow images by node id, with their signature and
    /// device-pixel offset from the recorder base.
    shadow_images: HashMap<String, (u64, vello::peniko::ImageData, (f64, f64))>,
    /// Gradient-filled text images by node id, cached like `shadow_images`.
    ink_images: HashMap<String, (u64, vello::peniko::ImageData, (f64, f64))>,
    scale_context: swash::scale::ScaleContext,
    /// Text nodes laid out on their source lines (`white-space: nowrap | pre`).
    nowrap: HashSet<String>,
    /// `lineClamp` per text node.
    clamps: HashMap<String, usize>,
    /// Ellipsized layout per text node and paint width; `None` when it fits.
    truncated: HashMap<String, (u32, Option<Layout<TextBrush>>)>,
}

struct MarkdownLine {
    range: Range<usize>,
    content_end: usize,
    nowrap: bool,
    block_start: Option<usize>,
    layout: Layout<TextBrush>,
    y: f32,
    height: f32,
}

pub(crate) struct DiffRowLayouts {
    content: Layout<TextBrush>,
    old: Option<Layout<TextBrush>>,
    new: Option<Layout<TextBrush>>,
    marker: Option<Layout<TextBrush>>,
}

#[derive(Clone, Debug)]
pub(crate) struct AccessibilityTextLine {
    pub line_index: usize,
    pub byte_range: Range<usize>,
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
    pub character_positions: Vec<f32>,
    pub character_widths: Vec<f32>,
    pub right_to_left: bool,
}

fn markdown_accessibility_lines(
    line: &MarkdownLine,
    value: &str,
    first_line_index: usize,
) -> Vec<AccessibilityTextLine> {
    let layout = &line.layout;
    let mut result = Vec::new();
    for (visual_index, visual) in layout.lines().enumerate() {
        let visual_range = visual.text_range();
        let metrics = visual.metrics();
        let y0 = f64::from(line.y + metrics.block_min_coord);
        let y1 = f64::from(line.y + metrics.block_max_coord);
        let mut runs: Vec<_> = visual
            .runs()
            .map(|run| (run.text_range(), run.is_rtl()))
            .collect();
        runs.sort_by_key(|(range, _)| range.start);
        if runs.is_empty() {
            runs.push((visual_range.clone(), layout.is_rtl()));
        } else if let Some((range, _)) = runs.iter_mut().max_by_key(|(range, _)| range.end) {
            range.end = range.end.max(visual_range.end);
        }
        for (mut range, right_to_left) in runs {
            range.start = range.start.max(visual_range.start).min(value.len());
            range.end = range
                .end
                .min(visual_range.end)
                .min(value.len())
                .max(range.start);
            let Some(run_value) = value.get(range.clone()) else {
                continue;
            };
            let mut geometry = Vec::new();
            for (local_start, grapheme) in run_value.grapheme_indices(true) {
                let start = range.start + local_start;
                let end = start + grapheme.len();
                let cursor = Cursor::from_byte_index(layout, start, Affinity::Downstream)
                    .geometry(layout, 1.0);
                let selected = Selection::new(
                    Cursor::from_byte_index(layout, start, Affinity::Downstream),
                    Cursor::from_byte_index(layout, end, Affinity::Upstream),
                )
                .geometry(layout)
                .into_iter()
                .map(|(rect, _)| rect)
                .find(|rect| {
                    rect.y1 >= f64::from(metrics.block_min_coord)
                        && rect.y0 <= f64::from(metrics.block_max_coord)
                });
                let (x0, x1) = selected
                    .map(|rect| (rect.x0.min(rect.x1), rect.x0.max(rect.x1)))
                    .unwrap_or((cursor.x0, cursor.x0));
                geometry.push((x0, x1));
            }
            let fallback = f64::from(metrics.offset + metrics.inline_min_coord);
            let x0 = geometry
                .iter()
                .map(|(x0, _)| *x0)
                .fold(f64::INFINITY, f64::min);
            let x1 = geometry
                .iter()
                .map(|(_, x1)| *x1)
                .fold(f64::NEG_INFINITY, f64::max);
            let (x0, x1) = if x0.is_finite() && x1.is_finite() {
                (x0.min(x1), x0.max(x1))
            } else {
                (fallback, fallback)
            };
            let positions = geometry
                .iter()
                .map(|(left, right)| {
                    if right_to_left {
                        (x1 - right).max(0.0) as f32
                    } else {
                        (left - x0).max(0.0) as f32
                    }
                })
                .collect();
            let widths = geometry
                .iter()
                .map(|(left, right)| (right - left).max(0.0) as f32)
                .collect();
            result.push(AccessibilityTextLine {
                line_index: first_line_index + visual_index,
                byte_range: line.range.start + range.start..line.range.start + range.end,
                x0,
                y0,
                x1,
                y1,
                character_positions: positions,
                character_widths: widths,
                right_to_left,
            });
        }
    }
    result
}

fn alignment_for_node(node: &Node) -> parley::Alignment {
    match node.string("textAlign", "start") {
        "center" => parley::Alignment::Center,
        "end" => parley::Alignment::End,
        _ => parley::Alignment::Start,
    }
}

fn default_syntax_color(kind: HighlightKind) -> &'static str {
    match kind {
        HighlightKind::Comment => "#6e7781",
        HighlightKind::Keyword => "#cf222e",
        HighlightKind::String => "#0a3069",
        HighlightKind::StringSpecial => "#0550ae",
        HighlightKind::Escape => "#953800",
        HighlightKind::Number | HighlightKind::Boolean | HighlightKind::Constant => "#0550ae",
        HighlightKind::Type
        | HighlightKind::TypeBuiltin
        | HighlightKind::Constructor
        | HighlightKind::Function
        | HighlightKind::Macro => "#8250df",
        HighlightKind::FunctionBuiltin => "#6639ba",
        HighlightKind::Property | HighlightKind::VariableSpecial | HighlightKind::Label => {
            "#953800"
        }
        HighlightKind::Variable | HighlightKind::Parameter | HighlightKind::Embedded => "#24292f",
        HighlightKind::Operator | HighlightKind::Invalid => "#cf222e",
        HighlightKind::Punctuation => "#57606a",
        HighlightKind::Tag => "#116329",
        HighlightKind::Attribute => "#0550ae",
    }
}

fn syntax_color(node: &Node, kind: HighlightKind) -> &str {
    node.syntax_theme[kind.key()]
        .as_str()
        .unwrap_or(default_syntax_color(kind))
}

/// Colour for a semantic markdown role.
///
/// The parser emits a role, never a hex literal, so one document stays correct
/// under a light and a dark theme. A style key overrides the fallback.
fn role_color(node: &Node, role: ToneRole) -> &str {
    let fallback = match role {
        ToneRole::Code => node.string("foreground", "#24292f"),
        ToneRole::InlineCode => "#0a3069",
        ToneRole::Link => "#0969da",
        ToneRole::Quote => node.string("mutedForeground", "#57606a"),
        ToneRole::Muted => node.string("mutedForeground", "#57606a"),
    };
    node.string(role.key(), fallback)
}

/// Background and foreground for a diff row kind, both overridable per style.
fn diff_row_colors(node: &Node, kind: DiffRowKind) -> (Option<&str>, Option<&str>) {
    let (background, foreground) = match kind {
        DiffRowKind::Header => ("diffHeaderBackground", "diffHeaderForeground"),
        DiffRowKind::Notice => ("diffNoticeBackground", "diffNoticeForeground"),
        DiffRowKind::Hunk => ("diffHunkBackground", "diffHunkForeground"),
        DiffRowKind::Added => ("diffAddedBackground", "diffAddedForeground"),
        DiffRowKind::Removed => ("diffRemovedBackground", "diffRemovedForeground"),
        DiffRowKind::Context | DiffRowKind::Meta | DiffRowKind::ShowMore => ("", ""),
    };
    (
        node.optional_string(background),
        node.optional_string(foreground),
    )
}

/// Accent bar colour for a changed row. Context rows keep an invisible spacer so
/// the columns always line up.
fn diff_accent_color(node: &Node, kind: DiffRowKind) -> Option<&str> {
    match kind {
        DiffRowKind::Added => Some(node.string("diffAddedAccent", "#2da44e")),
        DiffRowKind::Removed => Some(node.string("diffRemovedAccent", "#cf222e")),
        _ => None,
    }
}

fn push_span(
    builder: &mut parley::RangedBuilder<'_, TextBrush>,
    span: &Span,
    node: &Node,
    base_size: f32,
) {
    let range = span.range.clone();
    if let Some(scale) = span.size {
        builder.push(StyleProperty::FontSize(base_size * scale), range.clone());
    }
    if let Some(weight) = span.weight {
        builder.push(
            StyleProperty::FontWeight(FontWeight::new(weight)),
            range.clone(),
        );
    }
    if span.italic {
        builder.push(StyleProperty::FontStyle(FontStyle::Italic), range.clone());
    }
    if span.mono {
        builder.push(
            StyleProperty::FontFamily(GenericFamily::Monospace.into()),
            range.clone(),
        );
    }
    if let Some(font_family) = &span.font_family {
        builder.push(
            StyleProperty::FontFamily(font_family_from_name(font_family)),
            range.clone(),
        );
    }
    if let Some(kind) = span.syntax {
        builder.push(
            StyleProperty::Brush(TextBrush::color(syntax_color(node, kind).to_string())),
            range.clone(),
        );
    } else if let Some(role) = span.role {
        builder.push(
            StyleProperty::Brush(TextBrush::color(role_color(node, role).to_string())),
            range.clone(),
        );
    }
    if span.underline {
        builder.push(StyleProperty::Underline(true), range.clone());
    }
    if span.strike {
        builder.push(StyleProperty::Strikethrough(true), range);
    }
}

fn draw_layout<P: PaintTarget>(
    target: &mut P,
    layout: &Layout<TextBrush>,
    origin: (f64, f64),
    fallback: Color,
    scale: f64,
) {
    draw_layout_with(target, layout, origin, fallback, scale, false);
}

/// `solid` paints every run in `fallback`, ignoring per-span brushes; used
/// for text shadows so rich spans keep one shadow colour.
fn draw_layout_with<P: PaintTarget>(
    target: &mut P,
    layout: &Layout<TextBrush>,
    origin: (f64, f64),
    fallback: Color,
    scale: f64,
    solid: bool,
) {
    let offsets = shifted_line_extents(layout).map(|extents| shifted_line_offsets(&extents).0);
    for (index, line) in layout.lines().enumerate() {
        let line_offset = offsets.as_ref().map_or(0.0, |offsets| offsets[index]);
        for item in line.items() {
            if let PositionedLayoutItem::GlyphRun(glyph_run) = item {
                let run = glyph_run.run();
                let dy = line_offset - glyph_run.style().brush.1;
                let origin = (origin.0, origin.1 + f64::from(dy));
                let glyphs: Vec<_> = glyph_run
                    .positioned_glyphs()
                    .map(|glyph| PaintGlyph {
                        id: glyph.id,
                        x: glyph.x,
                        y: glyph.y,
                    })
                    .collect();
                let color = if solid {
                    fallback
                } else {
                    glyph_run
                        .style()
                        .brush
                        .0
                        .as_deref()
                        .map(crate::tree::color)
                        .unwrap_or(fallback)
                };
                target.draw_glyphs(
                    run.font(),
                    run.font_size(),
                    run.normalized_coords(),
                    Affine::scale(scale) * Affine::translate(origin),
                    color,
                    &glyphs,
                );
                let x0 = origin.0 + f64::from(glyph_run.offset());
                let x1 = x0 + f64::from(glyph_run.advance());
                if x1 > x0 {
                    let baseline = origin.1 + f64::from(glyph_run.baseline());
                    let thickness = f64::from((run.font_size() * 0.07).clamp(1.0, 2.0));
                    let style = glyph_run.style().brush.3;
                    if glyph_run.style().underline.is_some() {
                        let y = baseline + thickness;
                        draw_decoration(
                            target,
                            Affine::scale(scale),
                            color,
                            x0,
                            x1,
                            y,
                            thickness,
                            style,
                        );
                    }
                    if glyph_run.style().strikethrough.is_some() {
                        let y = baseline - f64::from(run.font_size() * 0.3);
                        draw_decoration(
                            target,
                            Affine::scale(scale),
                            color,
                            x0,
                            x1,
                            y,
                            thickness,
                            style,
                        );
                    }
                }
            }
        }
    }
}

fn diff_line_height(node: &Node) -> f32 {
    (node.number("fontSize", 13.0) * node.number("lineHeight", 1.5)).max(1.0)
}

const DIFF_ACCENT_WIDTH: f64 = 3.0;
const DIFF_MARKER_WIDTH: f64 = 24.0;
const CODE_GUTTER_PADDING: f32 = 8.0;
// Shaped monospace digits keep a small right side-bearing. Nudging only the
// number paint origin makes the visible ink sit at the intended optical gap
// while leaving source geometry, clipping, scrolling, and hit-testing intact.
const CODE_GUTTER_OPTICAL_X: f64 = 1.0;
// Monospace digits can sit optically a touch higher than braces and lowercase
// code at the same mathematical baseline. Keep the typographic baseline math
// exact, then move only the painted gutter ink by one physical pixel.
const CODE_GUTTER_OPTICAL_Y_PX: f64 = 1.0;

fn diff_content_inset(node: &Node, max_line_number: u32) -> f64 {
    f64::from(diff_gutter_width(node, max_line_number)) * 2.0
        + DIFF_ACCENT_WIDTH
        + DIFF_MARKER_WIDTH
}

/// Fonts for the browser build. There is no system font database on wasm32, so the
/// page registers font files before creating a tree; every `TextEngine` sees them.
#[cfg(target_arch = "wasm32")]
pub(crate) mod web_fonts {
    use parley::fontique::{Blob, FamilyId, GenericFamily};
    use std::sync::{Arc, Mutex};

    static FONTS: Mutex<Vec<(Blob<u8>, Vec<GenericFamily>)>> = Mutex::new(Vec::new());

    pub(crate) fn register(bytes: Vec<u8>, generics: Vec<GenericFamily>) {
        FONTS
            .lock()
            .unwrap()
            .push((Blob::new(Arc::new(bytes)), generics));
    }

    pub(crate) fn context() -> parley::FontContext {
        let mut fonts = parley::FontContext::new();
        let mut generic_families: Vec<(GenericFamily, Vec<FamilyId>)> = Vec::new();
        for (blob, generics) in FONTS.lock().unwrap().iter() {
            let families: Vec<FamilyId> = fonts
                .collection
                .register_fonts(blob.clone(), None)
                .into_iter()
                .map(|(family, _)| family)
                .collect();
            for generic in generics {
                match generic_families
                    .iter_mut()
                    .find(|(known, _)| known == generic)
                {
                    Some((_, ids)) => ids.extend(families.iter().copied()),
                    None => generic_families.push((*generic, families.clone())),
                }
            }
        }
        for (generic, ids) in generic_families {
            fonts
                .collection
                .set_generic_families(generic, ids.into_iter());
        }
        fonts
    }
}

/// Fonts the app ships (`createApp(view, { fonts })`), registered before the
/// tree exists so every `TextEngine` resolves them by family name.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) mod app_fonts {
    use parley::fontique::Blob;
    use std::sync::{Arc, Mutex};

    static FONTS: Mutex<Vec<Blob<u8>>> = Mutex::new(Vec::new());

    pub(crate) fn register(bytes: Vec<u8>) {
        FONTS.lock().unwrap().push(Blob::new(Arc::new(bytes)));
    }

    pub(crate) fn context() -> parley::FontContext {
        let mut fonts = parley::FontContext::new();
        for blob in FONTS.lock().unwrap().iter() {
            fonts.collection.register_fonts(blob.clone(), None);
        }
        fonts
    }
}

impl TextEngine {
    pub fn new() -> Self {
        Self {
            #[cfg(not(target_arch = "wasm32"))]
            fonts: app_fonts::context(),
            #[cfg(target_arch = "wasm32")]
            fonts: web_fonts::context(),
            context: LayoutContext::new(),
            layouts: HashMap::default(),
            markdown_lines: HashMap::default(),
            markdown_scroll: HashMap::default(),
            markdown_metrics: HashMap::default(),
            markdown_block_widths: HashMap::default(),
            diff_layouts: HashMap::default(),
            code_gutter_layouts: HashMap::default(),
            code_gutter_widths: HashMap::default(),
            unwrapped_code: HashSet::default(),
            nowrap: HashSet::default(),
            clamps: HashMap::default(),
            truncated: HashMap::default(),
            diff_column_widths: HashMap::default(),
            shapes: 0,
            #[cfg(test)]
            markdown_painted_lines: 0,
            signatures: HashMap::default(),
            alignments: HashMap::default(),
            shadow_images: HashMap::default(),
            ink_images: HashMap::default(),
            scale_context: swash::scale::ScaleContext::new(),
        }
    }
    pub fn prepare(&mut self, node: &Node) {
        if !node.is_text() {
            return;
        }
        let content = node.display_text();
        let mut style_signature = node.signature(TEXT_KEYS);
        style_signature.push(node.syntax_theme.clone());
        style_signature.push(node.runs.clone());
        // The gutter is a node field, not a style key, so it has to join the
        // signature explicitly. Without it a node that turns line numbers on
        // keeps the geometry of the unnumbered block and paints the code
        // underneath its own numbers.
        style_signature.push(Value::Bool(node.show_line_numbers));
        let signature = (content.clone(), style_signature);
        if self.layouts.contains_key(&node.id) && self.signatures.get(&node.id) == Some(&signature)
        {
            return;
        }
        if node.kind == "markdown" {
            if self
                .signatures
                .get(&node.id)
                .is_some_and(|(previous, _)| previous != &content)
            {
                self.markdown_scroll.retain(|(id, _), _| id != &node.id);
            }
            self.prepare_markdown_lines(node, &content);
            let mut placeholder = self.context.ranged_builder(&mut self.fonts, "", 1.0, true);
            placeholder.push_default(StyleProperty::FontSize(node.number("fontSize", 14.0)));
            self.layouts.insert(node.id.clone(), placeholder.build(""));
            self.signatures.insert(node.id.clone(), signature);
            self.alignments
                .insert(node.id.clone(), alignment_for_node(node));
            self.shapes += 1;
            return;
        }
        let mut layout = self.build_text_layout(node, &content, content.len());
        self.truncated.remove(&node.id);
        if text_nowrap(node) {
            self.nowrap.insert(node.id.clone());
        } else {
            self.nowrap.remove(&node.id);
        }
        match text_line_clamp(node) {
            Some(lines) => self.clamps.insert(node.id.clone(), lines),
            None => self.clamps.remove(&node.id),
        };
        // `Code` never wraps, so the line breaking has to happen here rather
        // than being deferred to paint. `draw` also breaks, but a caller that
        // only measures — the a11y pass, the hit test, a snapshot — must see the
        // same line structure, or the gutter numbers a different set of lines
        // than the text does.
        layout.break_all_lines(None);
        if node.kind == "code" && node.show_line_numbers {
            // Keep the gutter on the exact same typographic grid as the code.
            // A smaller standalone layout can share the mathematical baseline
            // and still look vertically offset because its glyph box and line
            // box use different metrics.
            let gutter_size = node.number("fontSize", 13.0);
            let gutter_line_height = node.number("lineHeight", 1.5);
            let gutter_weight = node.number("fontWeight", 400.0);
            let family = node.string("fontFamily", "monospace").to_string();
            let line_count = content.split('\n').count().max(1);
            let mut gutters = Vec::with_capacity(line_count);
            for line in 1..=line_count {
                let number = line.to_string();
                let mut gutter = self
                    .context
                    .ranged_builder(&mut self.fonts, &number, 1.0, true);
                gutter.push_default(StyleProperty::FontSize(gutter_size));
                gutter.push_default(StyleProperty::FontWeight(FontWeight::new(gutter_weight)));
                gutter.push_default(StyleProperty::FontFamily(font_family_from_name(&family)));
                gutter.push_default(StyleProperty::LineHeight(LineHeight::FontSizeRelative(
                    gutter_line_height,
                )));
                let mut gutter = gutter.build(&number);
                gutter.break_all_lines(None);
                gutters.push(gutter);
            }
            let widest_number = gutters.iter().map(Layout::width).fold(0.0_f32, f32::max);
            self.code_gutter_widths.insert(
                node.id.clone(),
                (widest_number + CODE_GUTTER_PADDING * 2.0).ceil(),
            );
            self.code_gutter_layouts.insert(node.id.clone(), gutters);
        } else {
            self.code_gutter_layouts.remove(&node.id);
            self.code_gutter_widths.remove(&node.id);
        }
        if node.kind == "code" {
            // A `Code` block is measured as its own content and scrolls
            // sideways. Recording that here keeps measurement, paint and the
            // hit test agreeing, whether or not the gutter is on.
            self.unwrapped_code.insert(node.id.clone());
        } else {
            self.unwrapped_code.remove(&node.id);
        }
        self.layouts.insert(node.id.clone(), layout);
        self.markdown_lines.remove(&node.id);
        self.signatures.insert(node.id.clone(), signature);
        self.alignments
            .insert(node.id.clone(), alignment_for_node(node));
        self.shapes += 1;
    }
    /// Shapes `content` with the node's text style, its rich spans and the runs
    /// that start before `run_limit` (a truncated copy keeps its prefix runs).
    fn build_text_layout(
        &mut self,
        node: &Node,
        content: &str,
        run_limit: usize,
    ) -> Layout<TextBrush> {
        let mut builder = self
            .context
            .ranged_builder(&mut self.fonts, content, 1.0, true);
        builder.push_default(StyleProperty::FontSize(node.number("fontSize", 14.0)));
        // CSS `font-optical-sizing: auto`: a variable font's `opsz` axis follows
        // the font size. Fonts without the axis ignore it.
        builder.push_default(optical_size(node.number("fontSize", 14.0)));
        builder.push_default(StyleProperty::FontWeight(FontWeight::new(
            node.number("fontWeight", 400.0),
        )));
        builder.push_default(StyleProperty::FontFamily(node_font_family(
            node,
            default_ui_generic_family(),
        )));
        builder.push_default(StyleProperty::LineHeight(LineHeight::FontSizeRelative(
            node.number("lineHeight", 1.5),
        )));
        if matches!(node.string("fontStyle", "normal"), "italic" | "oblique") {
            builder.push_default(StyleProperty::FontStyle(FontStyle::Italic));
        }
        if let Some(spacing) = node.style["letterSpacing"].as_f64() {
            builder.push_default(StyleProperty::LetterSpacing(spacing as f32));
        }
        if let Some(spacing) = node.style["wordSpacing"].as_f64() {
            builder.push_default(StyleProperty::WordSpacing(spacing as f32));
        }
        if let Some(rich) = &node.rich
            && let RichContent::Text { spans, .. } = rich.as_ref()
        {
            for span in spans {
                push_span(&mut builder, span, node, node.number("fontSize", 14.0));
            }
        }
        for run in text_runs(node, run_limit.min(content.len()), content) {
            push_text_style(
                &mut builder,
                run.style,
                run.start..run.end,
                (
                    node.number("fontSize", 14.0),
                    node.number("lineHeight", 1.5),
                ),
            );
        }
        builder.build(content)
    }
    /// Width and line count of the ellipsized layout painted for `id`.
    #[cfg(test)]
    pub(crate) fn truncated_metrics(&mut self, node: &Node, width: f32) -> Option<(f32, usize)> {
        self.ensure_truncated(node, width);
        let (_, layout) = self.truncated.get_mut(&node.id)?;
        let layout = layout.as_mut()?;
        Some((layout.width(), layout.len()))
    }
    fn wrap_width(&self, id: &str, width: Option<f32>) -> Option<f32> {
        if self.nowrap.contains(id) {
            None
        } else {
            width
        }
    }
    /// `text-overflow: ellipsis` and `lineClamp`: the longest prefix that,
    /// followed by "…", fits the clamp (or the width for a nowrap line).
    fn ensure_truncated(&mut self, node: &Node, width: f32) {
        if self
            .truncated
            .get(&node.id)
            .is_some_and(|(bits, _)| *bits == width.to_bits())
        {
            return;
        }
        let nowrap = self.nowrap.contains(&node.id);
        let clamp = self.clamps.get(&node.id).copied().unwrap_or(1);
        let wrap = if nowrap { None } else { Some(width) };
        let Some(layout) = self.layouts.get_mut(&node.id) else {
            return;
        };
        layout.break_all_lines(wrap);
        let too_wide = layout.width() > width + 0.5 && (nowrap || layout.len() == 1);
        let needs = layout.len() > clamp || too_wide;
        let end = if layout.len() > clamp {
            layout
                .get(clamp - 1)
                .map(|line| line.text_range().end)
                .unwrap_or(0)
        } else {
            node.text.len()
        };
        let mut result = None;
        if needs {
            let text = node.display_text();
            let mut end = end.min(text.len());
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            let bounds: Vec<usize> = (0..=end).filter(|i| text.is_char_boundary(*i)).collect();
            let (mut lo, mut hi) = (0usize, bounds.len().saturating_sub(1));
            let mut best = None;
            while lo <= hi {
                let mid = (lo + hi) / 2;
                let cut = bounds[mid];
                let candidate = format!("{}…", text[..cut].trim_end());
                let mut built =
                    self.build_text_layout(node, &candidate, text[..cut].trim_end().len());
                built.break_all_lines(wrap);
                let fits = built.len() <= clamp && (!nowrap || built.width() <= width + 0.5);
                if fits {
                    best = Some(built);
                    lo = mid + 1;
                } else if mid == 0 {
                    break;
                } else {
                    hi = mid - 1;
                }
            }
            result = Some(best.unwrap_or_else(|| {
                let mut built = self.build_text_layout(node, "…", 0);
                built.break_all_lines(wrap);
                built
            }));
        }
        self.truncated
            .insert(node.id.clone(), (width.to_bits(), result));
    }
    fn prepare_markdown_lines(&mut self, node: &Node, content: &str) {
        let Some(RichContent::Text { spans, blocks, .. }) = node.rich.as_deref() else {
            return;
        };
        let mut spans_by_end: Vec<_> = spans.iter().collect();
        spans_by_end.sort_by_key(|span| span.range.end);
        let mut blocks_by_end: Vec<_> = blocks.iter().collect();
        blocks_by_end.sort_by_key(|block| block.range.end);
        let mut lines = Vec::new();
        let mut start = 0;
        for part in content.split_inclusive('\n') {
            let end = start + part.len();
            let content_end = end - usize::from(part.ends_with('\n'));
            let value = &content[start..content_end];
            let block_start = blocks_by_end
                [blocks_by_end.partition_point(|block| block.range.end <= start)..]
                .iter()
                .find(|block| {
                    block.range.start <= start
                        && start < block.range.end
                        && matches!(
                            block.kind,
                            MarkdownBlockKind::Code | MarkdownBlockKind::Table { .. }
                        )
                })
                .map(|block| block.range.start);
            let nowrap = block_start.is_some();
            let mut builder = self
                .context
                .ranged_builder(&mut self.fonts, value, 1.0, true);
            builder.push_default(StyleProperty::FontSize(node.number("fontSize", 14.0)));
            builder.push_default(StyleProperty::FontWeight(FontWeight::new(
                node.number("fontWeight", 400.0),
            )));
            builder.push_default(StyleProperty::FontFamily(node_font_family(
                node,
                default_ui_generic_family(),
            )));
            builder.push_default(StyleProperty::LineHeight(LineHeight::FontSizeRelative(
                node.number("lineHeight", 1.5),
            )));
            for span in
                &spans_by_end[spans_by_end.partition_point(|span| span.range.end <= start)..]
            {
                let clipped = span.range.start.max(start)..span.range.end.min(content_end);
                if clipped.start < clipped.end {
                    let mut local = (*span).clone();
                    local.range = clipped.start - start..clipped.end - start;
                    push_span(&mut builder, &local, node, node.number("fontSize", 14.0));
                }
            }
            let layout = builder.build(value);
            lines.push(MarkdownLine {
                range: start..end,
                content_end,
                nowrap,
                block_start,
                layout,
                y: 0.0,
                height: 0.0,
            });
            start = end;
        }
        if content.is_empty() || content.ends_with('\n') {
            let mut builder = self.context.ranged_builder(&mut self.fonts, "", 1.0, true);
            builder.push_default(StyleProperty::FontSize(node.number("fontSize", 14.0)));
            builder.push_default(StyleProperty::LineHeight(LineHeight::FontSizeRelative(
                node.number("lineHeight", 1.5),
            )));
            lines.push(MarkdownLine {
                range: content.len()..content.len(),
                content_end: content.len(),
                nowrap: false,
                block_start: None,
                layout: builder.build(""),
                y: 0.0,
                height: 0.0,
            });
        }
        self.markdown_lines.insert(node.id.clone(), lines);
        self.markdown_metrics.remove(&node.id);
        self.markdown_block_widths.remove(&node.id);
        self.markdown_scroll.retain(|(id, start), _| {
            id != &node.id || blocks.iter().any(|block| block.range.start == *start)
        });
    }
    fn layout_markdown_lines(&mut self, id: &str, width: Option<f32>) -> Option<(f32, f32)> {
        if let Some((cached_width, dimensions)) = self.markdown_metrics.get(id)
            && *cached_width == width
        {
            return Some(*dimensions);
        }
        let lines = self.markdown_lines.get_mut(id)?;
        let mut y: f32 = 0.0;
        let mut max_width: f32 = 0.0;
        let mut block_widths = HashMap::<usize, f32>::default();
        for line in lines {
            line.layout
                .break_all_lines(if line.nowrap { None } else { width });
            line.y = y;
            line.height = line.layout.height().max(1.0);
            y += line.height;
            max_width = max_width.max(line.layout.width());
            if let Some(block) = line.block_start {
                block_widths
                    .entry(block)
                    .and_modify(|width| *width = width.max(line.layout.width()))
                    .or_insert(line.layout.width());
            }
        }
        if let Some(viewport_width) = width {
            for ((scroll_id, block), scroll) in &mut self.markdown_scroll {
                if scroll_id == id {
                    *scroll = scroll.clamp(
                        0.0,
                        (block_widths.get(block).copied().unwrap_or(0.0) - viewport_width).max(0.0),
                    );
                }
            }
        }
        let dimensions = (max_width.ceil(), y.ceil());
        self.markdown_block_widths
            .insert(id.to_string(), block_widths);
        self.markdown_metrics
            .insert(id.to_string(), (width, dimensions));
        Some(dimensions)
    }
    pub fn scroll_markdown_block(&mut self, id: &str, y: f32, width: f32, delta: f32) -> bool {
        self.layout_markdown_lines(id, Some(width.max(0.0)));
        let Some(lines) = self.markdown_lines.get(id) else {
            return false;
        };
        let Some(block) = lines
            .get(lines.partition_point(|line| y >= line.y + line.height))
            .filter(|line| y >= line.y)
            .and_then(|line| line.block_start)
        else {
            return false;
        };
        let max_width = self
            .markdown_block_widths
            .get(id)
            .and_then(|widths| widths.get(&block))
            .copied()
            .unwrap_or(0.0);
        let max_scroll = (max_width - width).max(0.0);
        if max_scroll <= 0.0 {
            return false;
        }
        let key = (id.to_string(), block);
        let current = self.markdown_scroll.get(&key).copied().unwrap_or(0.0);
        let next = (current + delta).clamp(0.0, max_scroll);
        if (next - current).abs() < 0.001 {
            return false;
        }
        self.markdown_scroll.insert(key, next);
        true
    }
    pub fn reveal_markdown_range(
        &mut self,
        id: &str,
        start: usize,
        end: usize,
        width: f32,
    ) -> bool {
        self.layout_markdown_lines(id, Some(width.max(0.0)));
        let Some(line) = self.markdown_lines.get(id).and_then(|lines| {
            lines
                .get(lines.partition_point(|line| line.range.end <= start))
                .filter(|line| line.range.start <= start && start < line.range.end)
        }) else {
            return false;
        };
        let Some(block) = line.block_start else {
            return false;
        };
        let local_start = start
            .saturating_sub(line.range.start)
            .min(line.content_end - line.range.start);
        let local_end = end
            .saturating_sub(line.range.start)
            .min(line.content_end - line.range.start)
            .max(local_start);
        let anchor = Cursor::from_byte_index(&line.layout, local_start, Affinity::Downstream);
        let focus = Cursor::from_byte_index(&line.layout, local_end, Affinity::Upstream);
        let Some((rect, _)) = Selection::new(anchor, focus)
            .geometry(&line.layout)
            .into_iter()
            .next()
        else {
            return false;
        };
        let key = (id.to_string(), block);
        let current = self.markdown_scroll.get(&key).copied().unwrap_or(0.0);
        let next = if rect.x0 < f64::from(current) {
            rect.x0 as f32
        } else if rect.x1 > f64::from(current + width) {
            (rect.x1 as f32 - width).max(0.0)
        } else {
            current
        };
        let max_width = self
            .markdown_block_widths
            .get(id)
            .and_then(|widths| widths.get(&block))
            .copied()
            .unwrap_or(0.0);
        let next = next.clamp(0.0, (max_width - width).max(0.0));
        if (next - current).abs() < 0.001 {
            return false;
        }
        self.markdown_scroll.insert(key, next);
        true
    }
    pub fn markdown_visible_byte_range(
        &mut self,
        id: &str,
        width: f32,
        visible_y: (f64, f64),
    ) -> Option<Range<usize>> {
        self.layout_markdown_lines(id, Some(width.max(0.0)));
        let lines = self.markdown_lines.get(id)?;
        let first = lines.partition_point(|line| f64::from(line.y + line.height) < visible_y.0);
        let last = lines.partition_point(|line| f64::from(line.y) <= visible_y.1);
        (first < last).then(|| lines[first].range.start..lines[last - 1].range.end)
    }
    pub fn retain(&mut self, mut keep: impl FnMut(&str) -> bool) {
        self.layouts.retain(|id, _| keep(id));
        self.markdown_lines.retain(|id, _| keep(id));
        self.markdown_scroll.retain(|(id, _), _| keep(id));
        self.markdown_metrics.retain(|id, _| keep(id));
        self.markdown_block_widths.retain(|id, _| keep(id));
        self.signatures
            .retain(|id, _| self.layouts.contains_key(id));
        self.alignments
            .retain(|id, _| self.layouts.contains_key(id));
        self.diff_layouts.retain(|id, _| keep(id));
        self.code_gutter_layouts.retain(|id, _| keep(id));
        self.code_gutter_widths.retain(|id, _| keep(id));
        self.unwrapped_code.retain(|id| keep(id));
        self.diff_column_widths.retain(|id, _| keep(id));
    }
    pub fn measure(&mut self, id: &str, width: Option<f32>) -> (f32, f32) {
        if let Some((measured_width, height)) =
            self.layout_markdown_lines(id, width.map(|w| w.max(0.0)))
        {
            return (
                width.map_or(measured_width, |w| measured_width.min(w)),
                height,
            );
        }
        let Some(layout) = self.layouts.get_mut(id) else {
            return (0.0, 0.0);
        };
        // A `Code` block never wraps: its width is its content and the block
        // scrolls sideways instead. Measuring it at a viewport width would
        // reflow the source into fewer, taller lines, which desynchronises the
        // line-number gutter from the text. The height comes from the ink rather
        // than from `Layout::height`, which under-reports a block whose lines
        // include blanks and would size the node too small to hold what it
        // draws. Both apply with and without a gutter, so turning the line
        // numbers on or off never resizes the block.
        if self.unwrapped_code.contains(id) {
            return (layout.width().ceil(), code_content_height(layout));
        }
        let wrap = if self.nowrap.contains(id) {
            None
        } else {
            width.map(|w| w.max(0.0))
        };
        layout.break_all_lines(wrap);
        let mut height = layout.height();
        if let Some(extents) = shifted_line_extents(layout) {
            height += shifted_line_offsets(&extents).1;
        }
        if let Some(lines) = self.clamps.get(id).copied()
            && layout.len() > lines
            && let Some(line) = layout.get(lines - 1)
        {
            height = line.metrics().block_max_coord;
        }
        (layout.width().ceil(), height.ceil())
    }
    /// Paints a plain text layout once more in a single colour, offset by the
    /// caller, before the real text is drawn on top. With `blur` (the CSS
    /// blur radius) the glyphs are rasterized to a coverage mask, blurred on
    /// the CPU and drawn as one cached image, so every renderer shows the same
    /// gaussian.
    pub fn draw_shadow<P: PaintTarget>(
        &mut self,
        target: &mut P,
        id: &str,
        origin: (f64, f64),
        color: Color,
        blur: f64,
        scale: f64,
    ) {
        let Some(layout) = self.layouts.get(id) else {
            self.shadow_images.remove(id);
            return;
        };
        if blur <= 0.0 {
            self.shadow_images.remove(id);
            draw_layout_with(target, layout, origin, color, scale, true);
            return;
        }
        let mut recorder = crate::shadow::ShadowRecorder::default();
        draw_layout_with(&mut recorder, layout, origin, color, scale, true);
        let sigma = blur / 2.0 * scale;
        let Some(base) = recorder.base() else {
            return;
        };
        let signature = recorder.signature(base, sigma, color);
        let stale = self
            .shadow_images
            .get(id)
            .is_none_or(|cached| cached.0 != signature);
        if stale {
            match crate::shadow::rasterize(
                &mut self.scale_context,
                &recorder,
                base,
                sigma,
                crate::shadow::Ink::Solid(color),
            ) {
                Some((image, offset)) => {
                    self.shadow_images
                        .insert(id.to_string(), (signature, image, offset));
                }
                None => {
                    self.shadow_images.remove(id);
                    return;
                }
            }
        }
        if let Some((_, image, offset)) = self.shadow_images.get(id) {
            target.draw_image(
                &format!("text-shadow:{id}"),
                image,
                Affine::translate((base.0 + offset.0, base.1 + offset.1)),
            );
        }
    }

    /// Paints text filled with a gradient (CSS `background-clip: text`):
    /// the glyph coverage is rasterized once, each pixel takes the gradient
    /// colour, and the cached image is drawn, identically on every renderer.
    pub fn draw_gradient<P: PaintTarget>(
        &mut self,
        target: &mut P,
        node: &Node,
        area: TextDrawArea,
        gradient: &crate::paint::PaintGradient,
        local_to_device: Affine,
        scale: f64,
    ) {
        use std::hash::{Hash, Hasher};
        let mut recorder = crate::shadow::ShadowRecorder::default();
        self.draw(&mut recorder, node, area, Color::BLACK, scale);
        let Some(base) = recorder.base() else {
            self.ink_images.remove(&node.id);
            return;
        };
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        format!("{gradient:?}{:?}", local_to_device.as_coeffs()).hash(&mut hasher);
        base.0.to_bits().hash(&mut hasher);
        base.1.to_bits().hash(&mut hasher);
        let signature = recorder.signature(base, 0.0, Color::BLACK) ^ hasher.finish();
        let stale = self
            .ink_images
            .get(&node.id)
            .is_none_or(|cached| cached.0 != signature);
        if stale {
            let ink = crate::shadow::Ink::Gradient {
                gradient,
                device_to_local: local_to_device.inverse(),
            };
            match crate::shadow::rasterize(&mut self.scale_context, &recorder, base, 0.0, ink) {
                Some((image, offset)) => {
                    self.ink_images
                        .insert(node.id.clone(), (signature, image, offset));
                }
                None => {
                    self.ink_images.remove(&node.id);
                    return;
                }
            }
        }
        if let Some((_, image, offset)) = self.ink_images.get(&node.id) {
            target.draw_image(
                &format!("text-ink:{}", node.id),
                image,
                Affine::translate((base.0 + offset.0, base.1 + offset.1)),
            );
        }
    }

    pub fn draw<P: PaintTarget>(
        &mut self,
        target: &mut P,
        node: &Node,
        area: TextDrawArea,
        color: Color,
        scale: f64,
    ) {
        let TextDrawArea {
            origin,
            width,
            visible_y,
            scroll_x,
        } = area;
        if node.kind == "markdown" {
            #[cfg(test)]
            {
                self.markdown_painted_lines = 0;
            }
            self.layout_markdown_lines(&node.id, Some(width.max(0.0)));
            if let Some(lines) = self.markdown_lines.get(&node.id) {
                let first =
                    lines.partition_point(|line| f64::from(line.y + line.height) < visible_y.0);
                for line in lines[first..]
                    .iter()
                    .take_while(|line| f64::from(line.y) <= visible_y.1)
                {
                    #[cfg(test)]
                    {
                        self.markdown_painted_lines += 1;
                    }
                    let scroll = line
                        .block_start
                        .and_then(|start| self.markdown_scroll.get(&(node.id.clone(), start)))
                        .copied()
                        .unwrap_or(0.0);
                    if line.nowrap {
                        target.push_clip(
                            Fill::NonZero,
                            Affine::scale(scale),
                            &Rect::new(
                                origin.0,
                                origin.1 + f64::from(line.y),
                                origin.0 + f64::from(width),
                                origin.1 + f64::from(line.y + line.height),
                            ),
                        );
                    }
                    draw_layout(
                        target,
                        &line.layout,
                        (origin.0 - f64::from(scroll), origin.1 + f64::from(line.y)),
                        color,
                        scale,
                    );
                    if line.nowrap {
                        target.pop_layer();
                    }
                }
            }
            return;
        }
        let gutter_width = self.code_gutter_width(node);
        let ellipsis = text_ellipsis(node);
        if ellipsis {
            self.ensure_truncated(node, width.max(0.0));
        }
        let nowrap = self.nowrap.contains(&node.id);
        let truncated = ellipsis
            && self
                .truncated
                .get(&node.id)
                .is_some_and(|(_, layout)| layout.is_some());
        let layout = if truncated {
            self.truncated
                .get_mut(&node.id)
                .and_then(|(_, layout)| layout.as_mut())
        } else {
            self.layouts.get_mut(&node.id)
        };
        let Some(layout) = layout else {
            return;
        };
        layout.break_all_lines(
            if matches!(node.kind.as_str(), "text" | "markdown" | "textarea") && !nowrap {
                Some(width.max(0.0))
            } else {
                None
            },
        );
        let align = alignment_for_node(node);
        layout.align(align, parley::AlignmentOptions::default());
        if node.kind == "code" && node.show_line_numbers {
            let gutter_color = crate::tree::color(node.string("gutterColor", "#8b949e"));
            if let Some(gutters) = self.code_gutter_layouts.get(&node.id) {
                // First align every number to the exact source baseline, then
                // apply a one-physical-pixel optical correction to the painted
                // gutter only. Source geometry and hit testing stay unchanged.
                let y_offsets = code_gutter_y_offsets(layout, gutters);
                for (gutter, y_offset) in gutters.iter().zip(y_offsets) {
                    let width = f64::from(gutter.width());
                    draw_layout(
                        target,
                        gutter,
                        (
                            origin.0 + f64::from(gutter_width)
                                - width
                                - f64::from(CODE_GUTTER_PADDING)
                                + CODE_GUTTER_OPTICAL_X,
                            origin.1 + y_offset + CODE_GUTTER_OPTICAL_Y_PX / scale.max(0.01),
                        ),
                        gutter_color,
                        scale,
                    );
                }
            }
            // Keep horizontal scrolling inside the source column. The outer
            // node clip includes the fixed gutter, so without a second clip a
            // scrolled line can paint back across its own line numbers.
            let source_left = origin.0 + f64::from(gutter_width);
            let source_right = (origin.0 + f64::from(width)).max(source_left);
            target.push_clip(
                Fill::NonZero,
                Affine::scale(scale),
                &Rect::new(
                    source_left,
                    origin.1 + visible_y.0,
                    source_right,
                    origin.1 + visible_y.1,
                ),
            );
            draw_layout(
                target,
                layout,
                (source_left - scroll_x, origin.1),
                color,
                scale,
            );
            target.pop_layer();
            return;
        }
        if node.kind == "markdown"
            && let Some(rich) = &node.rich
            && let RichContent::Text { task_markers, .. } = rich.as_ref()
            && !task_markers.is_empty()
        {
            draw_task_markers(
                target,
                layout,
                task_markers,
                origin,
                TaskMarkerPaintStyle {
                    font_size: node.number("fontSize", 14.0),
                    marker_color: crate::tree::color(
                        node.string("taskMarkerColor", node.string("foreground", "#18181b")),
                    ),
                    check_color: crate::tree::color(node.string("taskMarkerCheckColor", "#ffffff")),
                },
                scale,
            );
        }
        let origin = if node.kind == "code" {
            (origin.0 - scroll_x, origin.1)
        } else {
            origin
        };
        if node.kind == "text" {
            let text = node.display_text();
            for run in text_runs(node, text.len(), &text) {
                let Some(background) = run.style["background"].as_str() else {
                    continue;
                };
                let anchor = Cursor::from_byte_index(layout, run.start, Affinity::Downstream);
                let focus = Cursor::from_byte_index(layout, run.end, Affinity::Upstream);
                for (rect, _) in Selection::new(anchor, focus).geometry(layout) {
                    target.fill(
                        Fill::NonZero,
                        Affine::scale(scale),
                        crate::tree::color(background),
                        &Rect::new(
                            origin.0 + rect.x0,
                            origin.1 + rect.y0,
                            origin.0 + rect.x1,
                            origin.1 + rect.y1,
                        ),
                    );
                }
            }
        }
        draw_layout(target, layout, origin, color, scale);
    }

    pub fn draw_markdown_blocks<P: PaintTarget>(
        &mut self,
        target: &mut P,
        node: &Node,
        origin: (f64, f64),
        width: f32,
        scale: f64,
        visible_y: (f64, f64),
    ) {
        if node.kind == "markdown" {
            self.layout_markdown_lines(&node.id, Some(width.max(0.0)));
            let Some(lines) = self.markdown_lines.get(&node.id) else {
                return;
            };
            let Some(RichContent::Text {
                blocks,
                task_markers,
                ..
            }) = node.rich.as_deref()
            else {
                return;
            };
            let transform = Affine::scale(scale);
            let right = origin.0 + f64::from(width);
            for block in blocks {
                let Some((top, bottom)) = markdown_block_extent(lines, &block.range) else {
                    continue;
                };
                if bottom < visible_y.0 || top > visible_y.1 {
                    continue;
                }
                match &block.kind {
                    MarkdownBlockKind::Code | MarkdownBlockKind::Quote => {
                        let quote = matches!(block.kind, MarkdownBlockKind::Quote);
                        let background = if quote {
                            node.string("markdownQuoteBackground", "#f6f8fa")
                        } else {
                            node.string("markdownCodeBackground", "#f6f8fa")
                        };
                        target.fill(
                            Fill::NonZero,
                            transform,
                            crate::tree::color(background),
                            &Rect::new(
                                origin.0 - 4.0,
                                origin.1 + top - 2.0,
                                right,
                                origin.1 + bottom + 2.0,
                            ),
                        );
                        if quote {
                            target.fill(
                                Fill::NonZero,
                                transform,
                                crate::tree::color(node.string("markdownQuoteAccent", "#64748b")),
                                &Rect::new(
                                    origin.0 - 4.0,
                                    origin.1 + top - 2.0,
                                    origin.0 - 1.0,
                                    origin.1 + bottom + 2.0,
                                ),
                            );
                        }
                    }
                    MarkdownBlockKind::Table { rows, header } => {
                        for (index, row) in rows.iter().enumerate() {
                            if let Some((row_top, row_bottom)) = markdown_block_extent(lines, row) {
                                if *header == Some(index) {
                                    target.fill(
                                        Fill::NonZero,
                                        transform,
                                        crate::tree::color(
                                            node.string("markdownTableHeaderBackground", "#f6f8fa"),
                                        ),
                                        &Rect::new(
                                            origin.0 - 4.0,
                                            origin.1 + row_top - 2.0,
                                            right,
                                            origin.1 + row_bottom + 2.0,
                                        ),
                                    );
                                }
                                target.fill(
                                    Fill::NonZero,
                                    transform,
                                    crate::tree::color(node.string("markdownTableRule", "#d0d7de")),
                                    &Rect::new(
                                        origin.0 - 4.0,
                                        origin.1 + row_bottom + 1.0,
                                        right,
                                        origin.1 + row_bottom + 2.0,
                                    ),
                                );
                            }
                        }
                    }
                }
            }
            for marker in task_markers {
                if let Some(line) =
                    lines.get(lines.partition_point(|line| line.range.end <= marker.range.start))
                    && line.range.start <= marker.range.start
                    && marker.range.start < line.range.end
                {
                    if f64::from(line.y + line.height) < visible_y.0
                        || f64::from(line.y) > visible_y.1
                    {
                        continue;
                    }
                    let local = marker.range.start - line.range.start
                        ..marker.range.end.min(line.content_end) - line.range.start;
                    draw_task_markers(
                        target,
                        &line.layout,
                        &[TaskMarker {
                            range: local,
                            checked: marker.checked,
                        }],
                        (origin.0, origin.1 + f64::from(line.y)),
                        TaskMarkerPaintStyle {
                            font_size: node.number("fontSize", 14.0),
                            marker_color: crate::tree::color(
                                node.string(
                                    "taskMarkerColor",
                                    node.string("foreground", "#18181b"),
                                ),
                            ),
                            check_color: crate::tree::color(
                                node.string("taskMarkerCheckColor", "#ffffff"),
                            ),
                        },
                        scale,
                    );
                }
            }
            return;
        }
        let Some(layout) = self.layouts.get_mut(&node.id) else {
            return;
        };
        let Some(rich) = &node.rich else {
            return;
        };
        let RichContent::Text { blocks, .. } = rich.as_ref() else {
            return;
        };
        layout.break_all_lines(Some(width.max(0.0)));
        layout.align(
            alignment_for_node(node),
            parley::AlignmentOptions::default(),
        );
        draw_markdown_blocks(target, layout, blocks, node, origin, width, scale);
    }

    pub fn measure_diff(&mut self, node: &Node) -> (f32, f32) {
        let Some(rich) = &node.rich else {
            return (0.0, 0.0);
        };
        let RichContent::Diff {
            rows,
            max_columns,
            max_line_number,
            ..
        } = rich.as_ref()
        else {
            return (0.0, 0.0);
        };
        let line_height = diff_line_height(node);
        // The widest gutter in the patch bounds the content inset, so every
        // file's code column starts at the same x and the rows stay aligned
        // even though each file sizes its own gutter.
        let gutter = diff_gutter_width(node, *max_line_number);
        let family = node.string("fontFamily", "monospace");
        let size = node.number("fontSize", 13.0);
        let column_width = match self.diff_column_widths.get(&node.id) {
            Some((cached_family, cached_size, width))
                if cached_family == family && *cached_size == size =>
            {
                *width
            }
            _ => {
                let mut builder = self.context.ranged_builder(&mut self.fonts, "W", 1.0, true);
                builder.push_default(StyleProperty::FontSize(size));
                builder.push_default(StyleProperty::FontWeight(FontWeight::new(700.0)));
                builder.push_default(StyleProperty::FontFamily(font_family_from_name(family)));
                let mut reference = builder.build("W");
                reference.break_all_lines(None);
                let width = reference.width().max(size * 0.62);
                self.diff_column_widths
                    .insert(node.id.clone(), (family.to_string(), size, width));
                width
            }
        };
        (
            (*max_columns as f32 * column_width
                + gutter * 2.0
                + DIFF_ACCENT_WIDTH as f32
                + DIFF_MARKER_WIDTH as f32)
                .ceil(),
            rows.len() as f32 * line_height,
        )
    }

    pub fn draw_diff<P: PaintTarget>(
        &mut self,
        target: &mut P,
        node: &Node,
        area: DiffPaintArea,
        foreground: Color,
        decorations: DiffPaintDecorations<'_>,
        scale: f64,
    ) {
        let Some(rich) = &node.rich else {
            return;
        };
        let RichContent::Diff { rows, .. } = rich.as_ref() else {
            return;
        };
        let line_height = f64::from(diff_line_height(node));
        if line_height <= 0.0 {
            return;
        }
        let start =
            (((area.clip.y0 - area.origin.1) / line_height).floor() as isize - 2).max(0) as usize;
        let end =
            (((area.clip.y1 - area.origin.1) / line_height).ceil() as usize + 2).min(rows.len());
        if start >= end {
            return;
        }
        let mut largest_end = 0usize;
        let highlight_prefix_ends: Vec<usize> = decorations
            .highlights
            .iter()
            .map(|highlight| {
                largest_end = largest_end.max(highlight.range.end);
                largest_end
            })
            .collect();
        self.diff_layouts
            .entry(node.id.clone())
            .or_default()
            .retain(|index, _| *index >= start && *index < end);
        for (index, row) in rows.iter().enumerate().take(end).skip(start) {
            if !self.diff_layouts[&node.id].contains_key(&index) {
                let layout = self.build_diff_row(node, row);
                self.diff_layouts
                    .get_mut(&node.id)
                    .unwrap()
                    .insert(index, layout);
                self.shapes += 1;
            }
            let layouts = self
                .diff_layouts
                .get_mut(&node.id)
                .unwrap()
                .get_mut(&index)
                .unwrap();
            layouts.content.break_all_lines(None);
            let y = area.origin.1 + index as f64 * line_height;
            let (background, text_color) = diff_row_colors(node, row.kind);
            if let Some(background) = background {
                target.fill(
                    Fill::NonZero,
                    Affine::scale(scale),
                    crate::tree::color(background),
                    &Rect::new(area.rect.x0, y, area.rect.x1, y + line_height),
                );
            }
            let gutter = f64::from(diff_gutter_width(node, row.gutter_digits as u32));
            let marker_width = DIFF_MARKER_WIDTH;
            let accent_width = DIFF_ACCENT_WIDTH;
            let old_x = area.origin.0 + accent_width;
            let new_x = old_x + gutter;
            let marker_x = new_x + gutter;
            let text_x = marker_x + marker_width;
            if let Some(accent) = diff_accent_color(node, row.kind) {
                target.fill(
                    Fill::NonZero,
                    Affine::scale(scale),
                    crate::tree::color(accent),
                    &Rect::new(
                        area.rect.x0,
                        y,
                        area.rect.x0 + accent_width,
                        y + line_height,
                    ),
                );
            }
            let gutter_color = crate::tree::color(node.string("diffGutterColor", "#8b949e"));
            if let Some(layout) = layouts.old.as_mut() {
                layout.break_all_lines(None);
                draw_layout(target, layout, (old_x + 4.0, y), gutter_color, scale);
            }
            if let Some(layout) = layouts.new.as_mut() {
                layout.break_all_lines(None);
                draw_layout(target, layout, (new_x + 4.0, y), gutter_color, scale);
            }
            if let Some(layout) = layouts.marker.as_mut() {
                layout.break_all_lines(None);
                draw_layout(
                    target,
                    layout,
                    (marker_x + 6.0, y),
                    text_color.map(crate::tree::color).unwrap_or(foreground),
                    scale,
                );
            }
            for emphasis in &row.emphasis {
                let offset = row.content_offset();
                if emphasis.end <= offset || emphasis.start >= emphasis.end {
                    continue;
                }
                let anchor = Cursor::from_byte_index(
                    &layouts.content,
                    emphasis.start.max(offset) - offset,
                    Affinity::Downstream,
                );
                let focus = Cursor::from_byte_index(
                    &layouts.content,
                    emphasis.end - offset,
                    Affinity::Upstream,
                );
                for (box_rect, _) in Selection::new(anchor, focus).geometry(&layouts.content) {
                    let fill = if row.kind == DiffRowKind::Added {
                        node.string("diffAddedEmphasisBackground", "#bbf7d0")
                    } else {
                        node.string("diffRemovedEmphasisBackground", "#fecaca")
                    };
                    target.fill(
                        Fill::NonZero,
                        Affine::scale(scale),
                        crate::tree::color(fill),
                        &Rect::new(
                            text_x + box_rect.x0,
                            y + box_rect.y0,
                            text_x + box_rect.x1,
                            y + box_rect.y1,
                        ),
                    );
                }
            }
            let last_highlight = decorations
                .highlights
                .partition_point(|highlight| highlight.range.start < row.range.end);
            let first_highlight = highlight_prefix_ends[..last_highlight]
                .partition_point(|end| *end <= row.range.start);
            for highlight in &decorations.highlights[first_highlight..last_highlight] {
                let start = highlight.range.start.max(row.range.start);
                let end = highlight.range.end.min(row.range.end);
                let offset = row.content_offset();
                if start >= end || end - row.range.start <= offset {
                    continue;
                }
                let anchor = Cursor::from_byte_index(
                    &layouts.content,
                    (start - row.range.start).max(offset) - offset,
                    Affinity::Downstream,
                );
                let focus = Cursor::from_byte_index(
                    &layouts.content,
                    end - row.range.start - offset,
                    Affinity::Upstream,
                );
                for (box_rect, _) in Selection::new(anchor, focus).geometry(&layouts.content) {
                    target.fill(
                        Fill::NonZero,
                        Affine::scale(scale),
                        highlight.color,
                        &Rect::new(
                            text_x + box_rect.x0,
                            y + box_rect.y0,
                            text_x + box_rect.x1,
                            y + box_rect.y1,
                        ),
                    );
                }
            }
            if let Some((selection_start, selection_end)) = decorations.selection {
                let start = selection_start.max(row.range.start);
                let end = selection_end.min(row.range.end);
                let offset = row.content_offset();
                if start < end && end - row.range.start > offset {
                    let anchor = Cursor::from_byte_index(
                        &layouts.content,
                        (start - row.range.start).max(offset) - offset,
                        Affinity::Downstream,
                    );
                    let focus = Cursor::from_byte_index(
                        &layouts.content,
                        end - row.range.start - offset,
                        Affinity::Upstream,
                    );
                    for (box_rect, _) in Selection::new(anchor, focus).geometry(&layouts.content) {
                        target.fill(
                            Fill::NonZero,
                            Affine::scale(scale),
                            crate::tree::color(node.string("selectionColor", "#dbeafe")),
                            &Rect::new(
                                text_x + box_rect.x0,
                                y + box_rect.y0,
                                text_x + box_rect.x1,
                                y + box_rect.y1,
                            ),
                        );
                    }
                }
            }
            draw_layout(
                target,
                &layouts.content,
                (text_x, y),
                text_color.map(crate::tree::color).unwrap_or(foreground),
                scale,
            );
        }
    }

    fn build_diff_row(&mut self, node: &Node, row: &DiffRow) -> DiffRowLayouts {
        let mut builder =
            self.context
                .ranged_builder(&mut self.fonts, row.content_text(), 1.0, true);
        builder.push_default(StyleProperty::FontSize(node.number("fontSize", 13.0)));
        builder.push_default(StyleProperty::FontFamily(font_family_from_name(
            node.string("fontFamily", "monospace"),
        )));
        builder.push_default(StyleProperty::LineHeight(LineHeight::FontSizeRelative(
            node.number("lineHeight", 1.5),
        )));
        if matches!(row.kind, DiffRowKind::Header | DiffRowKind::Hunk) {
            builder.push_default(StyleProperty::FontWeight(FontWeight::new(650.0)));
        }
        let offset = row.content_offset();
        for span in &row.syntax {
            if span.range.end <= offset {
                continue;
            }
            builder.push(
                StyleProperty::Brush(TextBrush::color(syntax_color(node, span.kind).to_string())),
                span.range.start.max(offset) - offset..span.range.end - offset,
            );
        }
        for range in &row.emphasis {
            if range.end <= offset {
                continue;
            }
            builder.push(
                StyleProperty::FontWeight(FontWeight::new(700.0)),
                range.start.max(offset) - offset..range.end - offset,
            );
        }
        let content = builder.build(row.content_text());
        let old = row
            .old_line
            .map(|line| self.build_diff_chrome(node, &line.to_string()));
        let new = row
            .new_line
            .map(|line| self.build_diff_chrome(node, &line.to_string()));
        let marker = match row.kind {
            DiffRowKind::Added => Some("+"),
            DiffRowKind::Removed => Some("−"),
            DiffRowKind::Context => Some("·"),
            _ => None,
        }
        .map(|marker| self.build_diff_chrome(node, marker));
        DiffRowLayouts {
            content,
            old,
            new,
            marker,
        }
    }

    fn build_diff_chrome(&mut self, node: &Node, value: &str) -> Layout<TextBrush> {
        let mut builder = self
            .context
            .ranged_builder(&mut self.fonts, value, 1.0, true);
        builder.push_default(StyleProperty::FontSize(
            (node.number("fontSize", 13.0) * 0.88).max(9.0),
        ));
        builder.push_default(StyleProperty::FontFamily(font_family_from_name(
            node.string("fontFamily", "monospace"),
        )));
        builder.push_default(StyleProperty::LineHeight(LineHeight::FontSizeRelative(
            node.number("lineHeight", 1.5),
        )));
        builder.build(value)
    }

    pub fn diff_index_at(&mut self, node: &Node, x: f32, y: f32) -> Option<usize> {
        let RichContent::Diff { rows, .. } = node.rich.as_ref()?.as_ref() else {
            return None;
        };
        let line_height = diff_line_height(node);
        if line_height <= 0.0 || rows.is_empty() {
            return None;
        }
        let index = (y.max(0.0) / line_height).floor() as usize;
        let row = rows.get(index)?;
        if !self
            .diff_layouts
            .get(&node.id)
            .is_some_and(|layouts| layouts.contains_key(&index))
        {
            let layout = self.build_diff_row(node, row);
            self.diff_layouts
                .entry(node.id.clone())
                .or_default()
                .insert(index, layout);
        }
        // The same per-file gutter the row was painted with, so a click maps to
        // the same character the reader sees under the pointer.
        let content_inset = diff_content_inset(node, row.gutter_digits as u32) as f32;
        if x < content_inset {
            return Some(row.range.start);
        }
        let content_x = (x - content_inset).max(0.0);
        let layouts = self.diff_layouts.get_mut(&node.id)?.get_mut(&index)?;
        layouts.content.break_all_lines(None);
        let local = Cursor::from_point(&layouts.content, content_x, line_height * 0.5).index();
        Some(row.range.start + row.content_offset() + local.min(row.content_text().len()))
    }
    pub fn caret_rect(
        &mut self,
        id: &str,
        index: usize,
        width: Option<f32>,
    ) -> Option<parley::BoundingBox> {
        let align = self
            .alignments
            .get(id)
            .copied()
            .unwrap_or(parley::Alignment::Start);
        let width = self.wrap_width(id, width);
        let layout = self.layouts.get_mut(id)?;
        layout.break_all_lines(width.map(|width| width.max(0.0)));
        layout.align(align, parley::AlignmentOptions::default());
        let mut rect =
            Cursor::from_byte_index(layout, index, Affinity::Downstream).geometry(layout, 1.0);
        let dy = shifted_y(layout, rect.y0) - rect.y0;
        rect.y0 += dy;
        rect.y1 += dy;
        Some(rect)
    }
    pub fn range_rects(
        &mut self,
        id: &str,
        start: usize,
        end: usize,
        width: Option<f32>,
    ) -> Vec<parley::BoundingBox> {
        if start >= end {
            return vec![];
        }
        if self.markdown_lines.contains_key(id) {
            self.layout_markdown_lines(id, width);
            let mut result = Vec::new();
            let lines = &self.markdown_lines[id];
            let first = lines.partition_point(|line| line.range.end <= start);
            let last = lines.partition_point(|line| line.range.start < end);
            for line in &lines[first..last] {
                let local_start =
                    start.max(line.range.start).min(line.content_end) - line.range.start;
                let local_end = end.min(line.content_end).max(line.range.start) - line.range.start;
                if local_start < local_end {
                    let anchor =
                        Cursor::from_byte_index(&line.layout, local_start, Affinity::Downstream);
                    let focus =
                        Cursor::from_byte_index(&line.layout, local_end, Affinity::Upstream);
                    for (rect, _) in Selection::new(anchor, focus).geometry(&line.layout) {
                        let scroll = line
                            .block_start
                            .and_then(|block| self.markdown_scroll.get(&(id.to_string(), block)))
                            .copied()
                            .unwrap_or(0.0);
                        let x0 = rect.x0 - f64::from(scroll);
                        let x1 = rect.x1 - f64::from(scroll);
                        let (x0, x1) = if line.nowrap
                            && let Some(width) = width
                        {
                            (
                                x0.clamp(0.0, f64::from(width)),
                                x1.clamp(0.0, f64::from(width)),
                            )
                        } else {
                            (x0, x1)
                        };
                        if x0 < x1 {
                            result.push(parley::BoundingBox::new(
                                x0,
                                rect.y0 + f64::from(line.y),
                                x1,
                                rect.y1 + f64::from(line.y),
                            ));
                        }
                    }
                }
            }
            return result;
        }
        let align = self
            .alignments
            .get(id)
            .copied()
            .unwrap_or(parley::Alignment::Start);
        let width = self.wrap_width(id, width);
        let Some(layout) = self.layouts.get_mut(id) else {
            return vec![];
        };
        layout.break_all_lines(width.map(|width| width.max(0.0)));
        layout.align(align, parley::AlignmentOptions::default());
        let anchor = Cursor::from_byte_index(layout, start, Affinity::Downstream);
        let focus = Cursor::from_byte_index(layout, end, Affinity::Upstream);
        Selection::new(anchor, focus)
            .geometry(layout)
            .into_iter()
            .map(|(mut rect, _)| {
                let dy = shifted_y(layout, rect.y0) - rect.y0;
                rect.y0 += dy;
                rect.y1 += dy;
                rect
            })
            .collect()
    }
    pub fn index_at(&mut self, id: &str, x: f32, y: f32, width: Option<f32>) -> Option<usize> {
        if self.markdown_lines.contains_key(id) {
            self.layout_markdown_lines(id, width);
            let lines = self.markdown_lines.get(id)?;
            let line = lines
                .get(lines.partition_point(|line| y >= line.y + line.height))
                .or_else(|| lines.last())?;
            let scroll = line
                .block_start
                .and_then(|block| self.markdown_scroll.get(&(id.to_string(), block)))
                .copied()
                .unwrap_or(0.0);
            let local = Cursor::from_point(&line.layout, x + scroll, (y - line.y).max(0.0)).index();
            return Some((line.range.start + local).min(line.content_end));
        }
        let align = self
            .alignments
            .get(id)
            .copied()
            .unwrap_or(parley::Alignment::Start);
        let width = self.wrap_width(id, width);
        let layout = self.layouts.get_mut(id)?;
        layout.break_all_lines(width.map(|width| width.max(0.0)));
        layout.align(align, parley::AlignmentOptions::default());
        Some(Cursor::from_point(layout, x, y).index())
    }

    pub(crate) fn accessibility_lines(
        &mut self,
        id: &str,
        value: &str,
        width: Option<f32>,
    ) -> Vec<AccessibilityTextLine> {
        if self.markdown_lines.contains_key(id) {
            self.layout_markdown_lines(id, width);
            let mut result = Vec::new();
            let mut visual_index = 0;
            for line in &self.markdown_lines[id] {
                let Some(local_value) = value.get(line.range.start..line.content_end) else {
                    continue;
                };
                let mut visual = markdown_accessibility_lines(line, local_value, visual_index);
                let scroll = line
                    .block_start
                    .and_then(|block| self.markdown_scroll.get(&(id.to_string(), block)))
                    .copied()
                    .unwrap_or(0.0);
                for run in &mut visual {
                    run.x0 -= f64::from(scroll);
                    run.x1 -= f64::from(scroll);
                }
                if line.range.end > line.content_end
                    && let Some(last) = visual.last_mut()
                {
                    last.byte_range.end = line.range.end;
                    last.character_positions
                        .push(last.character_positions.last().copied().unwrap_or(0.0));
                    last.character_widths.push(0.0);
                }
                visual_index += line.layout.lines().count();
                result.extend(visual);
            }
            return result;
        }
        let align = self
            .alignments
            .get(id)
            .copied()
            .unwrap_or(parley::Alignment::Start);
        let Some(layout) = self.layouts.get_mut(id) else {
            return vec![];
        };
        layout.break_all_lines(width.map(|width| width.max(0.0)));
        layout.align(align, parley::AlignmentOptions::default());
        let lines: Vec<_> = layout
            .lines()
            .enumerate()
            .map(|(line_index, line)| {
                let line_range = line.text_range();
                let mut runs: Vec<_> = line
                    .runs()
                    .map(|run| (run.text_range(), run.is_rtl()))
                    .collect();
                runs.sort_by_key(|(range, _)| range.start);
                if runs.is_empty() {
                    runs.push((line_range.clone(), layout.is_rtl()));
                } else if let Some((range, _)) = runs.iter_mut().max_by_key(|(range, _)| range.end)
                    && range.end < line_range.end
                {
                    // Parley may keep a hard line break outside the shaped glyph run. AccessKit
                    // requires that break to live on the final TextRun for the visual line.
                    range.end = line_range.end;
                }
                (line_index, line_range, *line.metrics(), runs)
            })
            .collect();
        let mut result = Vec::with_capacity(lines.len().max(1));

        for (line_index, line_range, metrics, runs) in lines {
            let y0 = f64::from(metrics.block_min_coord);
            let y1 = f64::from(metrics.block_max_coord);
            for (mut range, right_to_left) in runs {
                range.start = range.start.max(line_range.start).min(value.len());
                range.end = range
                    .end
                    .min(line_range.end)
                    .min(value.len())
                    .max(range.start);
                let Some(run_value) = value.get(range.clone()) else {
                    continue;
                };
                let mut geometry = Vec::new();

                for (local_start, grapheme) in run_value.grapheme_indices(true) {
                    let start = range.start + local_start;
                    let end = start + grapheme.len();
                    let start_cursor = Cursor::from_byte_index(layout, start, Affinity::Downstream)
                        .geometry(layout, 1.0);
                    let is_line_break = matches!(grapheme, "\n" | "\r" | "\r\n");
                    let selection = if is_line_break {
                        None
                    } else {
                        let anchor = Cursor::from_byte_index(layout, start, Affinity::Downstream);
                        let focus = Cursor::from_byte_index(layout, end, Affinity::Upstream);
                        Selection::new(anchor, focus)
                            .geometry(layout)
                            .into_iter()
                            .map(|(rect, _)| rect)
                            .find(|rect| rect.y1 >= y0 && rect.y0 <= y1)
                    };
                    let (character_x0, character_x1) = selection
                        .map(|rect| (rect.x0.min(rect.x1), rect.x0.max(rect.x1)))
                        .unwrap_or((start_cursor.x0, start_cursor.x0));
                    geometry.push((character_x0, character_x1));
                }

                let fallback_x = f64::from(metrics.offset + metrics.inline_min_coord);
                let x0 = geometry
                    .iter()
                    .map(|(x0, _)| *x0)
                    .fold(f64::INFINITY, f64::min);
                let x1 = geometry
                    .iter()
                    .map(|(_, x1)| *x1)
                    .fold(f64::NEG_INFINITY, f64::max);
                let (x0, x1) = if x0.is_finite() && x1.is_finite() {
                    (x0.min(x1), x0.max(x1))
                } else {
                    (fallback_x, fallback_x)
                };
                let character_positions = geometry
                    .iter()
                    .map(|(character_x0, character_x1)| {
                        if right_to_left {
                            (x1 - character_x1).max(0.0) as f32
                        } else {
                            (character_x0 - x0).max(0.0) as f32
                        }
                    })
                    .collect();
                let character_widths = geometry
                    .iter()
                    .map(|(character_x0, character_x1)| {
                        (character_x1 - character_x0).max(0.0) as f32
                    })
                    .collect();

                result.push(AccessibilityTextLine {
                    line_index,
                    byte_range: range,
                    x0,
                    y0,
                    x1,
                    y1,
                    character_positions,
                    character_widths,
                    right_to_left,
                });
            }
        }
        result.sort_by_key(|run| (run.byte_range.start, run.byte_range.end));
        result
    }

    /// Horizontal space reserved for a `Code` line-number gutter.
    ///
    /// After `prepare`, this is derived from the widest actually shaped number,
    /// plus 8px of padding on each side. The fallback only covers geometry
    /// queries that happen before the text engine has prepared the node.
    pub fn code_gutter_width(&self, node: &Node) -> f32 {
        if node.kind != "code" || !node.show_line_numbers {
            return 0.0;
        }
        self.code_gutter_widths
            .get(&node.id)
            .copied()
            .unwrap_or_else(|| estimated_code_gutter_width(node))
    }

    pub fn code_gutter_inset(&self, node: &Node) -> f32 {
        self.code_gutter_width(node)
    }
}

/// Origin offsets that make each gutter number share the exact baseline of the
/// source line it labels.
fn code_gutter_y_offsets(layout: &Layout<TextBrush>, gutters: &[Layout<TextBrush>]) -> Vec<f64> {
    layout
        .lines()
        .zip(gutters)
        .filter_map(|(line, gutter)| {
            let gutter_baseline = gutter.lines().next()?.metrics().baseline;
            Some(f64::from(line.metrics().baseline) - f64::from(gutter_baseline))
        })
        .collect()
}

/// Height a `Code` block needs to hold every line it draws.
fn code_content_height(layout: &mut Layout<TextBrush>) -> f32 {
    // Parley exposes absolute block coordinates for every shaped line. The
    // bottom of the last line is the full painted extent; cursor y0 plus
    // descent only covers part of that box and clips short multi-line blocks.
    layout
        .lines()
        .map(|line| line.metrics().block_max_coord)
        .fold(layout.height(), f32::max)
        .ceil()
}

fn estimated_code_gutter_width(node: &Node) -> f32 {
    if node.kind != "code" || !node.show_line_numbers {
        return 0.0;
    }
    // `prepare` replaces this estimate with the actual shaped width.
    let digits = node.text.split('\n').count().max(1).to_string().len() as f32;
    (digits * node.number("fontSize", 13.0) * 0.62 + CODE_GUTTER_PADDING * 2.0).ceil()
}

fn diff_gutter_width(node: &Node, max_line_number: u32) -> f32 {
    let digits = max_line_number.max(1).to_string().len() as f32;
    (digits * node.number("fontSize", 13.0) * 0.56 + 14.0).max(32.0)
}

#[cfg(test)]
mod rich_measure_tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn css_generic_font_families_are_resolved_as_generics() {
        let node = |family: &str| -> Node {
            serde_json::from_value(serde_json::json!({
                "id": "font-family",
                "kind": "text",
                "text": "123",
                "style": { "fontFamily": family }
            }))
            .unwrap()
        };

        let system = node("system-ui");
        assert_eq!(
            node_font_family(&system, GenericFamily::Serif),
            FontFamily::from(default_ui_generic_family())
        );

        let monospace = node("monospace");
        assert_eq!(
            node_font_family(&monospace, GenericFamily::Serif),
            FontFamily::from(GenericFamily::Monospace)
        );

        let named = node("Segoe UI");
        assert_eq!(
            node_font_family(&named, GenericFamily::Serif),
            FontFamily::Source("Segoe UI".into())
        );
    }

    #[derive(Debug)]
    struct GlyphRunProbe {
        origin: (f64, f64),
        first_glyph: Option<(u32, f64, f64)>,
    }

    #[derive(Default)]
    struct ProbeTarget {
        runs: Vec<GlyphRunProbe>,
        clips: Vec<Rect>,
        pops: usize,
    }

    impl PaintTarget for ProbeTarget {
        fn box_shadow(&mut self, _: Affine, _: Rect, _: Rect, _: Color, _: f64, _: f64, _: bool) {}

        fn fill<S: vello::kurbo::Shape>(
            &mut self,
            _fill: Fill,
            _transform: Affine,
            _color: Color,
            _shape: &S,
        ) {
        }

        fn stroke<S: vello::kurbo::Shape>(
            &mut self,
            _stroke: &Stroke,
            _transform: Affine,
            _color: Color,
            _shape: &S,
        ) {
        }

        fn push_clip<S: vello::kurbo::Shape>(
            &mut self,
            _fill: Fill,
            _transform: Affine,
            shape: &S,
        ) {
            self.clips.push(shape.bounding_box());
        }

        fn push_opacity<S: vello::kurbo::Shape>(
            &mut self,
            _alpha: f32,
            _transform: Affine,
            _shape: &S,
        ) {
        }

        fn pop_layer(&mut self) {
            self.pops += 1;
        }

        fn draw_image(
            &mut self,
            _key: &str,
            _image: &vello::peniko::ImageData,
            _transform: Affine,
        ) {
        }

        fn draw_glyphs(
            &mut self,
            _font: &vello::peniko::FontData,
            _font_size: f32,
            _normalized_coords: &[i16],
            transform: Affine,
            _color: Color,
            glyphs: &[PaintGlyph],
        ) {
            let coeffs = transform.as_coeffs();
            let origin = (coeffs[4], coeffs[5]);
            let first_glyph = glyphs.first().map(|glyph| {
                (
                    glyph.id,
                    origin.0 + f64::from(glyph.x),
                    origin.1 + f64::from(glyph.y),
                )
            });
            self.runs.push(GlyphRunProbe {
                origin,
                first_glyph,
            });
        }
    }

    #[test]
    fn a_code_gutter_number_shares_its_lines_baseline() {
        // Every number is its own Parley layout, but it must use the same font
        // metrics as the source so baseline alignment also looks aligned.
        let mut node: Node = serde_json::from_value(serde_json::json!({
            "id":"code", "kind":"code", "showLineNumbers":true,
            "text":"alpha\n\nbravo\n\ncharlie",
            "style":{"fontFamily":"Consolas","fontSize":13,"lineHeight":1.5}
        }))
        .unwrap();
        node.rich = Some(Arc::new(crate::rich::code(&node.text, None, None)));
        let mut engine = TextEngine::new();
        engine.prepare(&node);
        let layout = engine.layouts.get("code").expect("layout prepared");
        let count = layout.lines().count();
        // Parley may fold a run of blank lines, so the shaped line count is the
        // authority and the gutter must be built from it, not from a count of
        // `\n` in the source. A gutter longer than the layout would number lines
        // that do not exist; one shorter drops the tail of the file.
        assert_eq!(engine.code_gutter_layouts["code"].len(), count);
        // A folded blank line is exactly the case that made the numbers skip:
        // every source line still needs a number, so the gutter is built from
        // the source and each number lands on the line that owns it.
        let source_lines = node.text.split('\n').count();
        assert_eq!(
            engine.code_gutter_layouts["code"].len(),
            source_lines,
            "every source line needs a number: layout has {count}, source has {source_lines}"
        );
        assert!(
            count >= 4,
            "the sample must still shape into several lines, got {count}"
        );
        let source_baselines: Vec<f64> = layout
            .lines()
            .map(|line| f64::from(line.metrics().baseline))
            .collect();
        let gutters = &engine.code_gutter_layouts["code"];
        let offsets = code_gutter_y_offsets(layout, gutters);
        assert_eq!(offsets.len(), source_baselines.len());

        for (index, ((source_baseline, offset), gutter)) in source_baselines
            .iter()
            .zip(&offsets)
            .zip(gutters)
            .enumerate()
        {
            let gutter_baseline = f64::from(
                gutter
                    .lines()
                    .next()
                    .expect("gutter number has one line")
                    .metrics()
                    .baseline,
            );
            let painted_baseline = offset + gutter_baseline;
            assert!(
                (painted_baseline - source_baseline).abs() < 0.001,
                "line {} gutter baseline {painted_baseline} != source baseline {source_baseline}",
                index + 1
            );
        }

        let source_first_baseline = source_baselines[0];
        for gutter in gutters {
            let gutter_baseline = f64::from(
                gutter
                    .lines()
                    .next()
                    .expect("gutter number has one line")
                    .metrics()
                    .baseline,
            );
            assert!(
                (gutter_baseline - source_first_baseline).abs() < 0.001,
                "code and gutter must use identical relative baseline metrics: {gutter_baseline} != {source_first_baseline}"
            );
        }
    }

    #[test]
    fn code_gutter_paints_beside_source_with_optical_raster_alignment() {
        // Use the same glyph in the gutter and source so this checks the final
        // paint coordinates, not only Parley's abstract line metrics. This is
        // the regression that was visible in rich-content-view: a correct
        // line count can still look wrong when the two columns are translated
        // independently at paint time.
        let mut node: Node = serde_json::from_value(serde_json::json!({
            "id":"code", "kind":"code", "showLineNumbers":true,
            "text":"1\n2",
            "style":{"fontFamily":"Consolas","fontSize":13,"lineHeight":1.5}
        }))
        .unwrap();
        node.rich = Some(Arc::new(crate::rich::code(&node.text, None, None)));
        let mut engine = TextEngine::new();
        engine.prepare(&node);

        let mut target = ProbeTarget::default();
        let origin = (11.0, 17.0);
        engine.draw(
            &mut target,
            &node,
            TextDrawArea {
                origin,
                width: 200.0,
                visible_y: (0.0, 200.0),
                scroll_x: 0.0,
            },
            Color::from_rgb8(0, 0, 0),
            1.0,
        );

        assert_eq!(target.runs.len(), 4, "two gutter and two source glyph runs");
        let gutters = &engine.code_gutter_layouts["code"];
        for (line, gutter_layout) in gutters.iter().enumerate().take(2) {
            let gutter = &target.runs[line];
            let source = &target.runs[line + 2];
            let (gutter_id, _, gutter_y) = gutter.first_glyph.expect("gutter glyph");
            let (source_id, _, source_y) = source.first_glyph.expect("source glyph");
            assert_eq!(gutter_id, source_id, "same digit must use the same glyph");
            assert!(
                ((gutter_y - source_y) - CODE_GUTTER_OPTICAL_Y_PX).abs() < 0.001,
                "line {} gutter raster offset {} != optical offset {}",
                line + 1,
                gutter_y - source_y,
                CODE_GUTTER_OPTICAL_Y_PX
            );

            let gutter_right = gutter.origin.0 + f64::from(gutter_layout.width());
            let expected_gap = f64::from(CODE_GUTTER_PADDING) - CODE_GUTTER_OPTICAL_X;
            assert!(
                ((source.origin.0 - gutter_right) - expected_gap).abs() < 0.001,
                "line {} gutter gap {} != expected {expected_gap}",
                line + 1,
                source.origin.0 - gutter_right
            );
        }
        assert!(
            (target.runs[2].origin.0 - (origin.0 + f64::from(engine.code_gutter_width(&node))))
                .abs()
                < 0.001,
            "source column must start after the full gutter"
        );
    }

    #[test]
    fn scrolled_code_source_is_clipped_after_the_fixed_code_gutter() {
        let mut node: Node = serde_json::from_value(serde_json::json!({
            "id":"code", "kind":"code", "showLineNumbers":true,
            "text":"abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz",
            "style":{"fontFamily":"Consolas","fontSize":13,"lineHeight":1.5}
        }))
        .unwrap();
        node.rich = Some(Arc::new(crate::rich::code(&node.text, None, None)));
        let mut engine = TextEngine::new();
        engine.prepare(&node);

        let mut target = ProbeTarget::default();
        let origin = (11.0, 17.0);
        let width = 120.0;
        engine.draw(
            &mut target,
            &node,
            TextDrawArea {
                origin,
                width,
                visible_y: (0.0, 80.0),
                scroll_x: 48.0,
            },
            Color::from_rgb8(0, 0, 0),
            1.0,
        );

        let gutter = f64::from(engine.code_gutter_width(&node));
        assert_eq!(target.clips.len(), 1, "source needs one dedicated clip");
        let clip = target.clips[0];
        assert!((clip.x0 - (origin.0 + gutter)).abs() < 0.001);
        assert!((clip.x1 - (origin.0 + f64::from(width))).abs() < 0.001);
        assert_eq!(target.pops, 1, "source clip must be balanced");
        let source = target.runs.last().expect("source glyph run");
        assert!(
            source.origin.0 < clip.x0,
            "the regression sample must scroll source ink behind the clip boundary"
        );
    }

    #[test]
    fn code_gutter_width_comes_from_the_widest_shaped_number() {
        let text = (1..=120)
            .map(|line| format!("line {line}"))
            .collect::<Vec<_>>()
            .join("\n");
        let mut node: Node = serde_json::from_value(serde_json::json!({
            "id":"code", "kind":"code", "showLineNumbers":true,
            "text":text,
            "style":{"fontFamily":"Consolas","fontSize":13,"lineHeight":1.5}
        }))
        .unwrap();
        node.rich = Some(Arc::new(crate::rich::code(&node.text, None, None)));
        let mut engine = TextEngine::new();
        engine.prepare(&node);

        let gutters = &engine.code_gutter_layouts["code"];
        let widest_number = gutters.iter().map(Layout::width).fold(0.0_f32, f32::max);
        let expected = (widest_number + CODE_GUTTER_PADDING * 2.0).ceil();
        assert_eq!(engine.code_gutter_width(&node), expected);

        let right_edge =
            f64::from(expected) - f64::from(CODE_GUTTER_PADDING) + CODE_GUTTER_OPTICAL_X;
        for index in [0_usize, 9, 99, 119] {
            let gutter = &gutters[index];
            let x =
                f64::from(expected) - f64::from(gutter.width()) - f64::from(CODE_GUTTER_PADDING)
                    + CODE_GUTTER_OPTICAL_X;
            assert!(
                (x + f64::from(gutter.width()) - right_edge).abs() < 0.001,
                "line {} must right-align to the same gutter edge",
                index + 1
            );
        }
    }

    #[test]
    fn toggling_the_gutter_rebuilds_the_code_layout() {
        // The gutter is a node field, not a style key. If it stays out of the
        // layout signature, a node that switches it on keeps the unnumbered
        // geometry and the code paints underneath its own numbers.
        let mut engine = TextEngine::new();
        let build = |show: bool| Node {
            id: "code".into(),
            kind: "code".into(),
            show_line_numbers: show,
            text: "alpha\nbravo\ncharlie".into(),
            style: serde_json::json!({ "fontFamily": "Consolas", "fontSize": 13 }),
            ..serde_json::from_value(serde_json::json!({
                "id":"code", "kind":"code", "text":"alpha\nbravo\ncharlie"
            }))
            .unwrap()
        };
        let mut plain = build(false);
        plain.rich = Some(Arc::new(crate::rich::code(&plain.text, None, None)));
        engine.prepare(&plain);
        assert!(!engine.code_gutter_layouts.contains_key("code"));

        let mut guttered = build(true);
        guttered.rich = Some(Arc::new(crate::rich::code(&guttered.text, None, None)));
        engine.prepare(&guttered);
        assert_eq!(
            engine.code_gutter_layouts["code"].len(),
            3,
            "turning the gutter on must build a number per line"
        );
        // And back off again, so a toggle in either direction is safe.
        engine.prepare(&plain);
        assert!(!engine.code_gutter_layouts.contains_key("code"));
    }

    #[test]
    fn measuring_a_code_block_does_not_change_its_line_count() {
        // The measurement path re-breaks the layout. If that reflows a `Code`
        // block, the gutter — which numbers the lines it built at prepare time —
        // labels a different set of lines than the one paint draws, and the tail
        // of the file loses its numbers.
        let mut node: Node = serde_json::from_value(serde_json::json!({
            "id":"code", "kind":"code", "showLineNumbers":true,
            "text":"alpha\n\nbravo\ncharlie",
            "style":{"fontFamily":"Consolas","fontSize":13,"lineHeight":1.5}
        }))
        .unwrap();
        node.rich = Some(Arc::new(crate::rich::code(&node.text, None, None)));
        let mut engine = TextEngine::new();
        engine.prepare(&node);
        let before = engine.layouts["code"].lines().count();
        let gutters = engine.code_gutter_layouts["code"].len();
        assert_eq!(before, gutters);
        // Measure at several widths, exactly as layout and paint do.
        for width in [None, Some(200.0_f32), Some(1000.0), Some(40.0)] {
            let _ = engine.measure("code", width);
            assert_eq!(
                engine.layouts["code"].lines().count(),
                before,
                "measuring at {width:?} must not reflow a Code block"
            );
        }
    }

    #[test]
    fn two_line_code_measurement_covers_the_last_line_box() {
        let mut node: Node = serde_json::from_value(serde_json::json!({
            "id":"code", "kind":"code",
            "text":"const answer = 42;\nconsole.log(answer);",
            "style":{"fontFamily":"Consolas","fontSize":13,"lineHeight":1.5}
        }))
        .unwrap();
        node.rich = Some(Arc::new(crate::rich::code(&node.text, Some("js"), None)));
        let mut engine = TextEngine::new();
        engine.prepare(&node);
        let expected_bottom = engine.layouts["code"]
            .lines()
            .last()
            .expect("two-line code must shape lines")
            .metrics()
            .block_max_coord
            .ceil();
        let (_, measured_height) = engine.measure("code", Some(760.0));
        assert_eq!(measured_height, expected_bottom);
        assert!(
            measured_height >= 13.0 * 1.5 * 2.0 * 0.9,
            "two code lines were clipped into {measured_height}px"
        );
    }

    #[test]
    fn the_code_gutter_inset_is_reserved_by_measurement() {
        let mut with: Node = serde_json::from_value(serde_json::json!({
            "id":"a", "kind":"code", "showLineNumbers":true, "text":"alpha\nbravo",
            "style":{"fontFamily":"Consolas","fontSize":13}
        }))
        .unwrap();
        let mut without = with.clone();
        without.id = "b".into();
        without.show_line_numbers = false;
        with.rich = Some(Arc::new(crate::rich::code(&with.text, None, None)));
        without.rich = Some(Arc::new(crate::rich::code(&without.text, None, None)));
        let mut engine = TextEngine::new();
        engine.prepare(&with);
        engine.prepare(&without);
        let inset = engine.code_gutter_inset(&with);
        assert!(inset > 0.0, "a guttered block must reserve space");
        assert_eq!(engine.code_gutter_inset(&without), 0.0);
        // TextEngine measures only the source column. The tree adds the gutter
        // inset to that width when it measures the leaf and computes scrollMaxX.
        let source_width = engine.measure("a", None).0;
        let plain = engine.measure("b", None).0;
        assert_eq!(source_width, plain);
        let guttered = source_width + inset;
        assert!(
            guttered > plain,
            "gutter must widen the block: {guttered} vs {plain}"
        );
    }

    #[test]
    fn diff_column_measure_covers_shaped_wide_rows_without_shaping_every_row() {
        let mut node: Node = serde_json::from_value(serde_json::json!({
            "id":"diff", "kind":"diff", "style":{"fontFamily":"Segoe UI", "fontSize":16}
        }))
        .unwrap();
        let (_, rich) = crate::rich::diff("--- a/demo.txt\n+++ b/demo.txt\n@@ -0,0 +1,4 @@\n+WWWWWWWWWW\n+界界界界界\n+🙂🙂🙂🙂🙂\n+mm\tmm\n", None, None, true, &[], None).unwrap();
        node.rich = Some(Arc::new(rich));
        let mut engine = TextEngine::new();
        let (measured, _) = engine.measure_diff(&node);
        let RichContent::Diff {
            rows,
            max_line_number,
            ..
        } = node.rich.as_deref().unwrap()
        else {
            panic!("expected diff")
        };
        for row in rows.iter().filter(|row| row.kind == DiffRowKind::Added) {
            let mut layout = engine.build_diff_row(&node, row).content;
            layout.break_all_lines(None);
            assert!(
                f64::from(measured) - diff_content_inset(&node, *max_line_number)
                    >= f64::from(layout.width()),
                "estimated width clipped {}",
                row.text
            );
        }
    }
}
