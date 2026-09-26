use crate::{
    paint::{PaintGlyph, PaintTarget},
    protocol::Node,
    rich::{DiffRow, DiffRowKind, MarkdownBlock, MarkdownBlockKind, RichContent, Span, TaskMarker},
    syntax::HighlightKind,
};
use parley::{
    FontContext, FontFamily, FontStyle, FontWeight, Layout, LayoutContext, LineHeight,
    PositionedLayoutItem, StyleProperty,
    layout::{Affinity, Cursor, Selection},
};
use std::{collections::HashMap, ops::Range};
use unicode_segmentation::UnicodeSegmentation;
use vello::{
    kurbo::{Affine, BezPath, Rect, RoundedRect, Stroke},
    peniko::{Color, Fill},
};

#[derive(Clone, Debug, Default, PartialEq)]
pub struct TextBrush(pub Option<String>);

pub struct DiffPaintArea {
    pub rect: Rect,
    pub clip: Rect,
    pub origin: (f64, f64),
}

pub struct TextDrawArea {
    pub origin: (f64, f64),
    pub width: f32,
    pub visible_y: (f64, f64),
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
];
pub struct TextEngine {
    fonts: FontContext,
    context: LayoutContext<TextBrush>,
    pub layouts: HashMap<String, Layout<TextBrush>>,
    markdown_lines: HashMap<String, Vec<MarkdownLine>>,
    markdown_scroll: HashMap<(String, usize), f32>,
    markdown_metrics: HashMap<String, (Option<f32>, (f32, f32))>,
    markdown_block_widths: HashMap<String, HashMap<usize, f32>>,
    pub(crate) diff_layouts: HashMap<String, HashMap<usize, DiffRowLayouts>>,
    code_gutter_layouts: HashMap<String, Vec<Layout<TextBrush>>>,
    diff_column_widths: HashMap<String, (String, f32, f32)>,
    pub shapes: u64,
    #[cfg(test)]
    pub markdown_painted_lines: usize,
    signatures: HashMap<String, (String, Vec<serde_json::Value>)>,
    alignments: HashMap<String, parley::Alignment>,
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
            StyleProperty::FontFamily(FontFamily::Source("Consolas".into())),
            range.clone(),
        );
    }
    if let Some(font_family) = &span.font_family {
        builder.push(
            StyleProperty::FontFamily(FontFamily::Source(font_family.clone().into())),
            range.clone(),
        );
    }
    if let Some(kind) = span.syntax {
        builder.push(
            StyleProperty::Brush(TextBrush(Some(syntax_color(node, kind).to_string()))),
            range.clone(),
        );
    } else if let Some(tone) = &span.tone {
        builder.push(
            StyleProperty::Brush(TextBrush(Some(tone.clone()))),
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
    for line in layout.lines() {
        for item in line.items() {
            if let PositionedLayoutItem::GlyphRun(glyph_run) = item {
                let run = glyph_run.run();
                let glyphs: Vec<_> = glyph_run
                    .positioned_glyphs()
                    .map(|glyph| PaintGlyph {
                        id: glyph.id,
                        x: glyph.x,
                        y: glyph.y,
                    })
                    .collect();
                let color = glyph_run
                    .style()
                    .brush
                    .0
                    .as_deref()
                    .map(crate::tree::color)
                    .unwrap_or(fallback);
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
                    if glyph_run.style().underline.is_some() {
                        let y = baseline + thickness;
                        target.fill(
                            Fill::NonZero,
                            Affine::scale(scale),
                            color,
                            &Rect::new(x0, y, x1, y + thickness),
                        );
                    }
                    if glyph_run.style().strikethrough.is_some() {
                        let y = baseline - f64::from(run.font_size() * 0.3);
                        target.fill(
                            Fill::NonZero,
                            Affine::scale(scale),
                            color,
                            &Rect::new(x0, y, x1, y + thickness),
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

fn diff_content_inset(node: &Node, max_line_number: u32) -> f64 {
    f64::from(diff_gutter_width(node, max_line_number)) * 2.0
        + DIFF_ACCENT_WIDTH
        + DIFF_MARKER_WIDTH
}

fn diff_colors(kind: DiffRowKind) -> (Option<&'static str>, Option<&'static str>) {
    match kind {
        DiffRowKind::Header => (Some("#f6f8fa"), Some("#57606a")),
        DiffRowKind::Hunk => (Some("#ddf4ff"), Some("#0969da")),
        DiffRowKind::Added => (Some("#dafbe1"), Some("#116329")),
        DiffRowKind::Removed => (Some("#ffebe9"), Some("#cf222e")),
        DiffRowKind::Context | DiffRowKind::Meta | DiffRowKind::ShowMore => (None, None),
    }
}

impl TextEngine {
    pub fn new() -> Self {
        Self {
            fonts: FontContext::new(),
            context: LayoutContext::new(),
            layouts: HashMap::new(),
            markdown_lines: HashMap::new(),
            markdown_scroll: HashMap::new(),
            markdown_metrics: HashMap::new(),
            markdown_block_widths: HashMap::new(),
            diff_layouts: HashMap::new(),
            code_gutter_layouts: HashMap::new(),
            diff_column_widths: HashMap::new(),
            shapes: 0,
            #[cfg(test)]
            markdown_painted_lines: 0,
            signatures: HashMap::new(),
            alignments: HashMap::new(),
        }
    }
    pub fn prepare(&mut self, node: &Node) {
        if !node.is_text() {
            return;
        }
        let content = node.display_text();
        let mut style_signature = node.signature(TEXT_KEYS);
        style_signature.push(node.syntax_theme.clone());
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
        let mut builder = self
            .context
            .ranged_builder(&mut self.fonts, &content, 1.0, true);
        builder.push_default(StyleProperty::FontSize(node.number("fontSize", 14.0)));
        builder.push_default(StyleProperty::FontWeight(FontWeight::new(
            node.number("fontWeight", 400.0),
        )));
        builder.push_default(StyleProperty::FontFamily(FontFamily::Source(
            node.string("fontFamily", "Segoe UI").into(),
        )));
        builder.push_default(StyleProperty::LineHeight(LineHeight::FontSizeRelative(
            node.number("lineHeight", 1.5),
        )));
        if let Some(rich) = &node.rich
            && let RichContent::Text { spans, .. } = rich.as_ref()
        {
            for span in spans {
                push_span(&mut builder, span, node, node.number("fontSize", 14.0));
            }
        }
        let mut layout = builder.build(&content);
        layout.break_all_lines(None);
        if node.kind == "code" && node.show_line_numbers {
            let gutter_size = (node.number("fontSize", 13.0) * 0.88).max(9.0);
            let family = node.string("fontFamily", "Consolas").to_string();
            let line_count = content.split('\n').count().max(1);
            let mut gutters = Vec::with_capacity(line_count);
            for line in 1..=line_count {
                let number = line.to_string();
                let mut gutter = self
                    .context
                    .ranged_builder(&mut self.fonts, &number, 1.0, true);
                gutter.push_default(StyleProperty::FontSize(gutter_size));
                gutter.push_default(StyleProperty::FontFamily(FontFamily::Source(
                    family.clone().into(),
                )));
                let mut gutter = gutter.build(&number);
                gutter.break_all_lines(None);
                gutters.push(gutter);
            }
            self.code_gutter_layouts.insert(node.id.clone(), gutters);
        } else {
            self.code_gutter_layouts.remove(&node.id);
        }
        self.layouts.insert(node.id.clone(), layout);
        self.markdown_lines.remove(&node.id);
        self.signatures.insert(node.id.clone(), signature);
        self.alignments
            .insert(node.id.clone(), alignment_for_node(node));
        self.shapes += 1;
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
            builder.push_default(StyleProperty::FontFamily(FontFamily::Source(
                node.string("fontFamily", "Segoe UI").into(),
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
        let mut y = 0.0;
        let mut max_width: f32 = 0.0;
        let mut block_widths = HashMap::<usize, f32>::new();
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
        layout.break_all_lines(width.map(|w| w.max(0.0)));
        (layout.width().ceil(), layout.height().ceil())
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
        let Some(layout) = self.layouts.get_mut(&node.id) else {
            return;
        };
        layout.break_all_lines(
            if matches!(node.kind.as_str(), "text" | "markdown" | "textarea") {
                Some(width.max(0.0))
            } else {
                None
            },
        );
        let align = alignment_for_node(node);
        layout.align(align, parley::AlignmentOptions::default());
        if node.kind == "code" && node.show_line_numbers {
            let gutter_width = code_gutter_width(node);
            let line_height = f64::from(
                (node.number("fontSize", 13.0) * node.number("lineHeight", 1.5)).max(1.0),
            );
            let gutter_color = crate::tree::color(node.string("gutterColor", "#8b949e"));
            if let Some(gutters) = self.code_gutter_layouts.get(&node.id) {
                for (index, gutter) in gutters.iter().enumerate() {
                    let width = f64::from(gutter.width());
                    draw_layout(
                        target,
                        gutter,
                        (
                            origin.0 + f64::from(gutter_width) - width - 8.0,
                            origin.1 + index as f64 * line_height,
                        ),
                        gutter_color,
                        scale,
                    );
                }
            }
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
        } = rich.as_ref()
        else {
            return (0.0, 0.0);
        };
        let line_height = diff_line_height(node);
        let gutter = diff_gutter_width(node, *max_line_number);
        let family = node.string("fontFamily", "Consolas");
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
                builder.push_default(StyleProperty::FontFamily(FontFamily::Source(family.into())));
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
        let RichContent::Diff {
            rows,
            max_line_number,
            ..
        } = rich.as_ref()
        else {
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
            let (background, text_color) = diff_colors(row.kind);
            if let Some(background) = background {
                target.fill(
                    Fill::NonZero,
                    Affine::scale(scale),
                    crate::tree::color(background),
                    &Rect::new(area.rect.x0, y, area.rect.x1, y + line_height),
                );
            }
            let gutter = f64::from(diff_gutter_width(node, *max_line_number));
            let marker_width = DIFF_MARKER_WIDTH;
            let accent_width = DIFF_ACCENT_WIDTH;
            let old_x = area.origin.0 + accent_width;
            let new_x = old_x + gutter;
            let marker_x = new_x + gutter;
            let text_x = marker_x + marker_width;
            if matches!(row.kind, DiffRowKind::Added | DiffRowKind::Removed) {
                target.fill(
                    Fill::NonZero,
                    Affine::scale(scale),
                    crate::tree::color(if row.kind == DiffRowKind::Added {
                        "#2da44e"
                    } else {
                        "#cf222e"
                    }),
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
                        "#acf2bd"
                    } else {
                        "#ffd8d3"
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
        builder.push_default(StyleProperty::FontFamily(FontFamily::Source(
            node.string("fontFamily", "Consolas").into(),
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
                StyleProperty::Brush(TextBrush(Some(syntax_color(node, span.kind).to_string()))),
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
        builder.push_default(StyleProperty::FontFamily(FontFamily::Source(
            node.string("fontFamily", "Consolas").into(),
        )));
        builder.push_default(StyleProperty::LineHeight(LineHeight::FontSizeRelative(
            node.number("lineHeight", 1.5),
        )));
        builder.build(value)
    }

    pub fn diff_index_at(&mut self, node: &Node, x: f32, y: f32) -> Option<usize> {
        let RichContent::Diff {
            rows,
            max_line_number,
            ..
        } = node.rich.as_ref()?.as_ref()
        else {
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
        let content_inset = diff_content_inset(node, *max_line_number) as f32;
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
        let layout = self.layouts.get_mut(id)?;
        layout.break_all_lines(width.map(|width| width.max(0.0)));
        layout.align(align, parley::AlignmentOptions::default());
        Some(Cursor::from_byte_index(layout, index, Affinity::Downstream).geometry(layout, 1.0))
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
            .map(|(rect, _)| rect)
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
}

pub fn code_gutter_width(node: &Node) -> f32 {
    if node.kind != "code" || !node.show_line_numbers {
        return 0.0;
    }
    let digits = node.text.split('\n').count().max(1).to_string().len() as f32;
    (digits * node.number("fontSize", 13.0) * 0.62 + 16.0).max(32.0)
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
