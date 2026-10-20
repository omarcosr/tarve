//! Text shaping for TextEngine: one text's layout, and many texts shaped ahead on worker threads.
use super::*;

/// Content hash, style hash and whether the text is a button's.
pub(super) type ShapeKey = (u64, u64, bool);
/// A layout shaped ahead, broken into unwrapped lines, with its min-content size.
pub(super) type Preshaped = (Layout<TextBrush>, Option<(f32, f32)>);

impl TextEngine {
    /// Shapes the plain texts among `nodes` that `prepare` would shape, on several threads:
    /// a first frame with thousands of texts spends most of its layout here.
    pub fn preshape<'a>(&mut self, nodes: impl Iterator<Item = &'a Node>) {
        const MIN: usize = 256;
        let mut pending: Vec<(ShapeKey, &Node, String)> = Vec::new();
        let mut seen = HashSet::default();
        for node in nodes {
            if !matches!(node.kind.as_str(), "text" | "button") || node.rich.is_some() {
                continue;
            }
            let content = node.display_text();
            if content.contains('\t') {
                continue;
            }
            let signature = (hash_text(&content), text_style_hash(node));
            if self.layouts.contains_key(&node.id)
                && self.signatures.get(&node.id) == Some(&signature)
            {
                continue;
            }
            let key = (signature.0, signature.1, node.kind == "button");
            let shared = self.shaped_by.get(&key).is_some_and(|id| {
                self.signatures.get(id) == Some(&signature) && self.layouts.contains_key(id)
            });
            if shared || self.preshaped.contains_key(&key) || !seen.insert(key) {
                continue;
            }
            pending.push((key, node, content));
        }
        let threads = std::thread::available_parallelism()
            .map_or(1, |n| n.get())
            .min(8);
        if pending.len() < MIN || threads < 2 {
            return;
        }
        let threads = threads.min(pending.len() / 64).max(2);
        while self.workers.len() < threads {
            self.workers
                .push((self.fonts.clone(), LayoutContext::new()));
        }
        let chunk = pending.len().div_ceil(threads);
        let results: Vec<Vec<(ShapeKey, Preshaped)>> = std::thread::scope(|scope| {
            let handles: Vec<_> = self
                .workers
                .iter_mut()
                .zip(pending.chunks(chunk))
                .map(|((fonts, context), part)| {
                    scope.spawn(move || {
                        part.iter()
                            .map(|(key, node, content)| {
                                let mut layout =
                                    shape_text(fonts, context, node, content, content.len(), None);
                                // Layout asks a text for its min-content size (wrapped at 0) first.
                                let min_content = (node.kind == "text"
                                    && !text_nowrap(node)
                                    && text_line_clamp(node).is_none())
                                .then(|| {
                                    layout.break_all_lines(Some(0.0));
                                    let mut height = layout.height();
                                    if let Some(extents) = shifted_line_extents(&layout) {
                                        height += shifted_line_offsets(&extents).1;
                                    }
                                    (layout.width().ceil(), height.ceil())
                                });
                                layout.break_all_lines(None);
                                (*key, (layout, min_content))
                            })
                            .collect()
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap_or_default())
                .collect()
        });
        for (key, layout) in results.into_iter().flatten() {
            self.preshaped.insert(key, layout);
        }
    }
    pub fn clear_preshaped(&mut self) {
        self.preshaped.clear();
    }
    /// Prepares the texts that need it, shaping long lists of them in parallel first.
    pub fn prepare_dirty<'a>(&mut self, nodes: impl Iterator<Item = &'a Node> + Clone) {
        self.preshape(nodes.clone());
        for node in nodes {
            self.prepare(node);
        }
        self.clear_preshaped();
    }
    /// Shapes `content` with the node's text style, its rich spans and the runs
    /// that start before `run_limit` (a truncated copy keeps its prefix runs).
    pub(super) fn build_text_layout(
        &mut self,
        node: &Node,
        content: &str,
        run_limit: usize,
    ) -> Layout<TextBrush> {
        // A tab has no glyph (fonts draw it as a missing-glyph box): shape it as a
        // space, one byte as well so offsets stay those of `content`, widened to
        // `tabSize` spaces (CSS `tab-size`, default 8).
        let tab_spacing = content
            .contains('\t')
            .then(|| self.space_advance(node) * (node.number("tabSize", 8.0).max(1.0) - 1.0));
        let tabs: Vec<usize> = if tab_spacing.is_some() {
            content
                .match_indices('\t')
                .map(|(index, _)| index)
                .collect()
        } else {
            Vec::new()
        };
        let shaped = if tab_spacing.is_some() {
            std::borrow::Cow::Owned(content.replace('\t', " "))
        } else {
            std::borrow::Cow::Borrowed(content)
        };
        let content = shaped.as_ref();
        shape_text(
            &mut self.fonts,
            &mut self.context,
            node,
            content,
            run_limit,
            tab_spacing.map(|spacing| (spacing, tabs)),
        )
    }
    /// The advance of a space in the node's font, for tab widths.
    pub(super) fn space_advance(&mut self, node: &Node) -> f32 {
        let size = node.number("fontSize", 14.0);
        let mut builder = self.context.ranged_builder(&mut self.fonts, " ", 1.0, true);
        builder.push_default(StyleProperty::FontSize(size));
        builder.push_default(StyleProperty::FontFamily(node_font_family(
            node,
            default_ui_generic_family(),
        )));
        let mut layout: Layout<TextBrush> = builder.build(" ");
        layout.break_all_lines(None);
        let width = layout.full_width();
        if width > 0.0 { width } else { size * 0.5 }
    }
}

/// Shapes `content` (tabs already spaces; their indices and extra spacing in `tabs`) with the
/// node's text style, rich spans and runs. A free function so worker threads shape with their own contexts.
pub(super) fn shape_text(
    fonts: &mut FontContext,
    context: &mut LayoutContext<TextBrush>,
    node: &Node,
    content: &str,
    run_limit: usize,
    tabs: Option<(f32, Vec<usize>)>,
) -> Layout<TextBrush> {
    let mut builder = context.ranged_builder(fonts, content, 1.0, true);
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
    if let Some(features) = font_features(&node.style) {
        builder.push_default(StyleProperty::FontFeatures(parley::FontFeatures::Source(
            std::borrow::Cow::Owned(features),
        )));
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
    if let Some((spacing, tabs)) = tabs {
        let base = node.style["letterSpacing"].as_f64().unwrap_or(0.0) as f32;
        for index in tabs {
            builder.push(
                StyleProperty::LetterSpacing(base + spacing),
                index..index + 1,
            );
        }
    }
    compact(builder.build(content))
}
