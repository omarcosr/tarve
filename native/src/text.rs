use crate::{
    paint::{PaintGlyph, PaintTarget},
    protocol::Node,
};
use parley::{
    FontContext, FontFamily, FontWeight, Layout, LayoutContext, LineHeight, PositionedLayoutItem,
    StyleProperty,
    layout::{Affinity, Cursor, Selection},
};
use std::{collections::HashMap, ops::Range};
use unicode_segmentation::UnicodeSegmentation;
use vello::{kurbo::Affine, peniko::Color};

pub const TEXT_KEYS: &[&str] = &[
    "fontSize",
    "fontWeight",
    "fontFamily",
    "lineHeight",
    "textAlign",
];
pub struct TextEngine {
    fonts: FontContext,
    context: LayoutContext<()>,
    pub layouts: HashMap<String, Layout<()>>,
    pub shapes: u64,
    signatures: HashMap<String, (String, Vec<serde_json::Value>)>,
    alignments: HashMap<String, parley::Alignment>,
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

fn alignment_for_node(node: &Node) -> parley::Alignment {
    match node.string("textAlign", "start") {
        "center" => parley::Alignment::Center,
        "end" => parley::Alignment::End,
        _ => parley::Alignment::Start,
    }
}

impl TextEngine {
    pub fn new() -> Self {
        Self {
            fonts: FontContext::new(),
            context: LayoutContext::new(),
            layouts: HashMap::new(),
            shapes: 0,
            signatures: HashMap::new(),
            alignments: HashMap::new(),
        }
    }
    pub fn prepare(&mut self, node: &Node) {
        if !node.is_text() {
            return;
        }
        let content = node.display_text();
        let signature = (content.clone(), node.signature(TEXT_KEYS));
        if self.layouts.contains_key(&node.id) && self.signatures.get(&node.id) == Some(&signature)
        {
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
        let mut layout = builder.build(&content);
        layout.break_all_lines(None);
        self.layouts.insert(node.id.clone(), layout);
        self.signatures.insert(node.id.clone(), signature);
        self.alignments
            .insert(node.id.clone(), alignment_for_node(node));
        self.shapes += 1;
    }
    pub fn retain(&mut self, mut keep: impl FnMut(&str) -> bool) {
        self.layouts.retain(|id, _| keep(id));
        self.signatures
            .retain(|id, _| self.layouts.contains_key(id));
        self.alignments
            .retain(|id, _| self.layouts.contains_key(id));
    }
    pub fn measure(&mut self, id: &str, width: Option<f32>) -> (f32, f32) {
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
        origin: (f64, f64),
        width: f32,
        color: Color,
        scale: f64,
    ) {
        let Some(layout) = self.layouts.get_mut(&node.id) else {
            return;
        };
        layout.break_all_lines(if matches!(node.kind.as_str(), "text" | "textarea") {
            Some(width.max(0.0))
        } else {
            None
        });
        let align = alignment_for_node(node);
        layout.align(align, parley::AlignmentOptions::default());
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
                    target.draw_glyphs(
                        run.font(),
                        run.font_size(),
                        run.normalized_coords(),
                        Affine::scale(scale) * Affine::translate(origin),
                        color,
                        &glyphs,
                    );
                }
            }
        }
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
        if start >= end {
            return vec![];
        }
        let anchor = Cursor::from_byte_index(layout, start, Affinity::Downstream);
        let focus = Cursor::from_byte_index(layout, end, Affinity::Upstream);
        Selection::new(anchor, focus)
            .geometry(layout)
            .into_iter()
            .map(|(rect, _)| rect)
            .collect()
    }
    pub fn index_at(&mut self, id: &str, x: f32, y: f32, width: Option<f32>) -> Option<usize> {
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
