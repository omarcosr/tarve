use crate::protocol::Node;
use parley::{
    FontContext, FontFamily, FontWeight, Layout, LayoutContext, LineHeight, PositionedLayoutItem,
    StyleProperty,
    layout::{Affinity, Cursor},
};
use std::collections::HashMap;
use vello::{
    Glyph, Scene,
    kurbo::Affine,
    peniko::{Color, Fill},
};

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
}
impl TextEngine {
    pub fn new() -> Self {
        Self {
            fonts: FontContext::new(),
            context: LayoutContext::new(),
            layouts: HashMap::new(),
            shapes: 0,
            signatures: HashMap::new(),
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
        self.shapes += 1;
    }
    pub fn retain(&mut self, mut keep: impl FnMut(&str) -> bool) {
        self.layouts.retain(|id, _| keep(id));
        self.signatures
            .retain(|id, _| self.layouts.contains_key(id));
    }
    pub fn measure(&mut self, id: &str, width: Option<f32>) -> (f32, f32) {
        let Some(layout) = self.layouts.get_mut(id) else {
            return (0.0, 0.0);
        };
        layout.break_all_lines(width.map(|w| w.max(0.0)));
        (layout.width().ceil(), layout.height().ceil())
    }
    pub fn draw(
        &mut self,
        scene: &mut Scene,
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
        let align = match node.string("textAlign", "start") {
            "center" => parley::Alignment::Center,
            "end" => parley::Alignment::End,
            _ => parley::Alignment::Start,
        };
        layout.align(align, parley::AlignmentOptions::default());
        for line in layout.lines() {
            for item in line.items() {
                if let PositionedLayoutItem::GlyphRun(glyph_run) = item {
                    let run = glyph_run.run();
                    scene
                        .draw_glyphs(run.font())
                        .font_size(run.font_size())
                        .normalized_coords(run.normalized_coords())
                        .transform(Affine::scale(scale) * Affine::translate(origin))
                        .brush(color)
                        .draw(
                            Fill::NonZero,
                            glyph_run.positioned_glyphs().map(|g| Glyph {
                                id: g.id,
                                x: g.x,
                                y: g.y,
                            }),
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
        let layout = self.layouts.get_mut(id)?;
        layout.break_all_lines(width.map(|width| width.max(0.0)));
        Some(Cursor::from_byte_index(layout, index, Affinity::Downstream).geometry(layout, 1.0))
    }
    pub fn index_at(&mut self, id: &str, x: f32, y: f32, width: Option<f32>) -> Option<usize> {
        let layout = self.layouts.get_mut(id)?;
        layout.break_all_lines(width.map(|width| width.max(0.0)));
        Some(Cursor::from_point(layout, x, y).index())
    }
}
