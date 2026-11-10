//! Long texts (a text area, a `Code` block, a plain text) shaped in chunks of whole lines:
//! an edit or an append (a log that grows) shapes again only the chunks it touched, and
//! paint draws only the visible ones.
use super::shape::{spans_over, spans_sorted};
use super::*;

/// A text at least this long is shaped in chunks.
pub(super) const CHUNKED_TEXT_AREA_BYTES: usize = 16 * 1024;
/// Whole lines go into a chunk until it holds this much (a longer line is a chunk alone).
const CHUNK_BYTES: usize = 4 * 1024;

/// A wrap width's bits; `None` for unwrapped.
type WidthKey = Option<u32>;

pub(super) struct TextChunk {
    /// Bytes of the content, with the line break that ends it.
    pub(super) range: Range<usize>,
    /// `range.end` without that line break.
    content_end: usize,
    /// Hash of its text and of the spans over it.
    hash: u64,
    /// Line breaks in `range`, and the source line it starts on (from 0).
    breaks: usize,
    pub(super) first_line: usize,
    pub(super) layout: Layout<TextBrush>,
    /// The wrap width its lines are broken at.
    broken: Option<WidthKey>,
    /// Its size at the widths it was measured at.
    sizes: Vec<(WidthKey, (f32, f32))>,
    pub(super) y: f32,
    height: f32,
}

pub(super) struct ChunkedText {
    style: u64,
    align: parley::Alignment,
    /// A `Code` block: never wraps, and is as tall as its lines' boxes.
    code: bool,
    /// The content and spans the chunks were shaped from: the next content compares its
    /// leading part with them directly, without hashing it again.
    content: String,
    rich: Option<Arc<RichContent>>,
    pub(super) chunks: Vec<TextChunk>,
    /// The width the chunks' `y` were placed at.
    placed: Option<WidthKey>,
}

fn width_key(width: Option<f32>) -> WidthKey {
    width.map(|width| width.max(0.0).to_bits())
}

impl TextChunk {
    fn break_at(&mut self, key: WidthKey, align: parley::Alignment) {
        if self.broken == Some(key) {
            return;
        }
        self.layout.break_all_lines(key.map(f32::from_bits));
        self.layout
            .align(align, parley::AlignmentOptions::default());
        self.broken = Some(key);
    }
    fn size(&mut self, key: WidthKey, align: parley::Alignment) -> (f32, f32) {
        if let Some((_, size)) = self.sizes.iter().find(|(width, _)| *width == key) {
            return *size;
        }
        self.break_at(key, align);
        let size = (self.layout.width(), self.layout.height());
        if self.sizes.len() >= 4 {
            self.sizes.remove(0);
        }
        self.sizes.push((key, size));
        size
    }
    /// `index` (of the whole content) inside this chunk's layout.
    fn local(&self, index: usize) -> usize {
        index
            .saturating_sub(self.range.start)
            .min(self.content_end - self.range.start)
    }
}

impl ChunkedText {
    /// A `Code` block breaks at no width, whatever it is asked.
    fn key(&self, width: Option<f32>) -> WidthKey {
        if self.code { None } else { width_key(width) }
    }
    pub(super) fn place(&mut self, key: WidthKey) {
        if self.placed == Some(key) {
            return;
        }
        let mut y = 0.0;
        for chunk in &mut self.chunks {
            chunk.y = y;
            chunk.height = chunk.size(key, self.align).1;
            y += chunk.height;
        }
        self.placed = Some(key);
    }
    /// The chunk holding a caret at `index`: a line's start belongs to the chunk it begins.
    fn at_index(&self, index: usize) -> usize {
        self.chunks
            .partition_point(|chunk| chunk.range.end <= index)
            .min(self.chunks.len() - 1)
    }
    fn at_y(&self, y: f32) -> usize {
        self.chunks
            .partition_point(|chunk| y >= chunk.y + chunk.height)
            .min(self.chunks.len() - 1)
    }
}

impl TextEngine {
    /// Shaped in chunks: a long text area, `Code` block or wrapping plain text, start
    /// aligned, without inline runs, a text shadow, a line clamp or an ellipsis.
    pub(super) fn chunkable(&self, node: &Node, content: &str) -> bool {
        let kind_fits = match node.kind.as_str() {
            "textarea" => node.rich.is_none(),
            "code" => true,
            "text" => {
                node.rich.is_none()
                    && text_line_clamp(node).is_none()
                    && !text_ellipsis(node)
                    && !text_nowrap(node)
            }
            _ => false,
        };
        kind_fits
            && content.len() >= self.chunked_text_area_bytes
            && node.runs.as_array().is_none_or(Vec::is_empty)
            && node.style["textShadow"].is_null()
            && (node.kind == "code" || !text_nowrap(node))
            && matches!(
                alignment_for_node(node),
                parley::Alignment::Start | parley::Alignment::Left
            )
    }

    /// Hash of `range` of the content and of the node's spans over it, moved to its start.
    fn chunk_hash(node: &Node, content: &str, range: Range<usize>, sorted: bool) -> u64 {
        let mut hasher = std::hash::DefaultHasher::new();
        content[range.clone()].hash(&mut hasher);
        if let Some(rich) = &node.rich
            && let RichContent::Text { spans, .. } = rich.as_ref()
        {
            for span in spans_over(spans, range.clone(), sorted) {
                let start = span.range.start.max(range.start) - range.start;
                let end = span.range.end.min(range.end) - range.start;
                (start, end).hash(&mut hasher);
                span.syntax.map(|kind| kind.key()).hash(&mut hasher);
                span.role.map(|role| role.key()).hash(&mut hasher);
                span.size.map(f32::to_bits).hash(&mut hasher);
                span.weight.map(f32::to_bits).hash(&mut hasher);
                (span.italic, span.mono, span.underline, span.strike).hash(&mut hasher);
                span.font_family.hash(&mut hasher);
            }
        }
        hasher.finish()
    }

    /// Chunks of `content`, keeping the old chunks whose text is still at the start or at
    /// the end: an append shapes the last (short) chunk and the new lines, an edit the
    /// chunks it touched.
    pub(super) fn prepare_chunks(&mut self, node: &Node, content: &str, style: u64) {
        let align = alignment_for_node(node);
        let code = node.kind == "code";
        let sorted = match node.rich.as_deref() {
            Some(RichContent::Text { spans, .. }) => spans_sorted(spans),
            _ => true,
        };
        let previous = self
            .chunked
            .remove(&node.id)
            .filter(|old| old.style == style && old.align == align && old.code == code);
        // How far the text and the spans are unchanged from the start.
        let (common, span_common, old_spans) = match &previous {
            Some(old) => {
                let (old_spans, new_spans) = (
                    spans_of(old.rich.as_deref()),
                    spans_of(node.rich.as_deref()),
                );
                let span_common = match (&old.rich, &node.rich) {
                    (Some(a), Some(b)) if Arc::ptr_eq(a, b) => new_spans.len(),
                    _ => old_spans
                        .iter()
                        .zip(new_spans)
                        .take_while(|(a, b)| a == b)
                        .count(),
                };
                (
                    common_prefix(&old.content, content),
                    span_common,
                    old.rich.clone(),
                )
            }
            None => (0, 0, None),
        };
        let new_spans = spans_of(node.rich.as_deref());
        let old_spans = spans_of(old_spans.as_deref());
        // A chunk ending at `end` sees no changed span when every span starting before
        // `end` is in the unchanged prefix, in both.
        let spans_unchanged = |end: usize| {
            let in_new = new_spans.partition_point(|span| span.range.start < end);
            let in_old = old_spans.partition_point(|span| span.range.start < end);
            in_new == in_old && in_new <= span_common
        };
        let mut old = previous.map(|old| old.chunks).unwrap_or_default();
        // The empty line after a final line break is rebuilt.
        if old.last().is_some_and(|chunk| chunk.range.is_empty()) {
            old.pop();
        }
        let whole = |start: usize, end: usize| {
            (start == 0 || content.as_bytes()[start - 1] == b'\n')
                && (end == content.len() || content.as_bytes()[end - 1] == b'\n')
        };
        let mut prefix = 0;
        let mut start = 0;
        for chunk in &old {
            let end = start + chunk.range.len();
            let same = end <= common
                && whole(start, end)
                && if sorted {
                    spans_unchanged(end)
                } else {
                    Self::chunk_hash(node, content, start..end, sorted) == chunk.hash
                };
            if !same {
                break;
            }
            prefix += 1;
            start = end;
        }
        // A short last chunk takes the lines that follow it, so appending one line at a
        // time does not leave a chunk per line.
        if prefix > 0 && start < content.len() && old[prefix - 1].range.len() < CHUNK_BYTES {
            prefix -= 1;
            start -= old[prefix].range.len();
        }
        let mut suffix = 0;
        let mut end = content.len();
        while prefix + suffix < old.len() {
            let chunk = &old[old.len() - 1 - suffix];
            let len = chunk.range.len();
            if len > end - start {
                break;
            }
            let from = end - len;
            match content.get(from..end) {
                Some(_)
                    if whole(from, end)
                        && Self::chunk_hash(node, content, from..end, sorted) == chunk.hash => {}
                _ => break,
            }
            suffix += 1;
            end = from;
        }
        let mut chunks = Vec::with_capacity(old.len() + 1);
        let tail: Vec<TextChunk> = old.drain(old.len() - suffix..).collect();
        old.truncate(prefix);
        chunks.extend(old);
        let mut chunk_start = start;
        let mut position = start;
        for line in content[start..end].split_inclusive('\n') {
            position += line.len();
            if position - chunk_start >= CHUNK_BYTES {
                chunks.push(self.shape_chunk(node, content, sorted, chunk_start..position));
                chunk_start = position;
            }
        }
        if chunk_start < end {
            chunks.push(self.shape_chunk(node, content, sorted, chunk_start..end));
        }
        if let Some(first) = tail.first() {
            let from = first.range.start;
            for mut chunk in tail {
                let range = chunk.range.start - from + end..chunk.range.end - from + end;
                chunk.content_end = chunk.content_end - chunk.range.start + range.start;
                chunk.range = range;
                chunks.push(chunk);
            }
        }
        if content.is_empty() || content.ends_with('\n') {
            chunks.push(self.shape_chunk(node, content, sorted, content.len()..content.len()));
        }
        let mut line = 0;
        for chunk in &mut chunks {
            chunk.first_line = line;
            line += chunk.breaks;
        }
        self.chunked.insert(
            node.id.clone(),
            ChunkedText {
                style,
                align,
                code,
                content: content.to_string(),
                rich: node.rich.clone(),
                chunks,
                placed: None,
            },
        );
    }

    fn shape_chunk(
        &mut self,
        node: &Node,
        content: &str,
        sorted: bool,
        range: Range<usize>,
    ) -> TextChunk {
        let text = &content[range.clone()];
        let content_end = range.end - usize::from(text.ends_with('\n'));
        let local = &content[range.start..content_end];
        TextChunk {
            hash: Self::chunk_hash(node, content, range.clone(), sorted),
            breaks: text.bytes().filter(|byte| *byte == b'\n').count(),
            first_line: 0,
            layout: self.build_text_layout_at(
                node,
                local,
                local.len(),
                Some((range.start, sorted)),
            ),
            range,
            content_end,
            broken: None,
            sizes: Vec::new(),
            y: 0.0,
            height: 0.0,
        }
    }

    #[cfg(test)]
    pub(crate) fn chunk_count(&self, id: &str) -> usize {
        self.chunked.get(id).map_or(0, |text| text.chunks.len())
    }

    pub(super) fn measure_chunks(&mut self, id: &str, width: Option<f32>) -> Option<(f32, f32)> {
        let text = self.chunked.get_mut(id)?;
        let key = text.key(width);
        let (mut max_width, mut height) = (0.0f32, 0.0f32);
        for chunk in &mut text.chunks {
            let size = chunk.size(key, text.align);
            max_width = max_width.max(size.0);
            height += size.1;
        }
        // A `Code` block reaches the bottom of its last line's box (`code_content_height`).
        if text.code
            && let Some(last) = text.chunks.last_mut()
        {
            last.break_at(key, text.align);
            let layout = &last.layout;
            let bottom = layout
                .lines()
                .map(|line| line.metrics().block_max_coord)
                .fold(layout.height(), f32::max);
            height += bottom - layout.height();
        }
        Some((max_width.ceil(), height.ceil()))
    }

    /// Paints the chunks inside `area.visible_y` only; a `Code` block's line numbers too.
    pub(super) fn draw_chunks<P: PaintTarget>(
        &mut self,
        target: &mut P,
        node: &Node,
        area: &TextDrawArea,
        color: Color,
        scale: f64,
    ) {
        let gutter_width = self.code_gutter_width(node);
        let Some(text) = self.chunked.get_mut(&node.id) else {
            return;
        };
        let key = text.key(Some(area.width));
        text.place(key);
        let first = text
            .chunks
            .partition_point(|chunk| f64::from(chunk.y + chunk.height) < area.visible_y.0);
        let last = first
            + text.chunks[first..]
                .iter()
                .take_while(|chunk| f64::from(chunk.y) <= area.visible_y.1)
                .count();
        let align = text.align;
        for chunk in &mut text.chunks[first..last] {
            chunk.break_at(key, align);
        }
        if !text.code {
            for chunk in &text.chunks[first..last] {
                draw_layout(
                    target,
                    &chunk.layout,
                    (area.origin.0, area.origin.1 + f64::from(chunk.y)),
                    color,
                    scale,
                );
            }
            return;
        }
        // As `draw` paints one `Code` layout: the numbers on their lines' baselines (only
        // the visible ones), then the source, clipped right of the gutter and scrolled.
        let (origin, width, visible_y) = (area.origin, area.width, area.visible_y);
        if node.show_line_numbers
            && let Some(gutters) = self.code_gutter_layouts.get(&node.id)
        {
            let gutter_color = crate::tree::color(node.string("gutterColor", "#8b949e"));
            for chunk in &text.chunks[first..last] {
                for (index, line) in chunk.layout.lines().enumerate() {
                    let Some(gutter) = gutters.get(chunk.first_line + index) else {
                        break;
                    };
                    let Some(gutter_line) = gutter.lines().next() else {
                        continue;
                    };
                    let y = f64::from(chunk.y) + f64::from(line.metrics().baseline)
                        - f64::from(gutter_line.metrics().baseline);
                    if y > visible_y.1 || y + f64::from(line.metrics().line_height) < visible_y.0 {
                        continue;
                    }
                    let number_width = f64::from(gutter.width());
                    draw_layout(
                        target,
                        gutter,
                        (
                            origin.0 + f64::from(gutter_width)
                                - number_width
                                - f64::from(CODE_GUTTER_PADDING)
                                + CODE_GUTTER_OPTICAL_X,
                            origin.1 + y + CODE_GUTTER_OPTICAL_Y_PX / scale.max(0.01),
                        ),
                        gutter_color,
                        scale,
                    );
                }
            }
        }
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
        for chunk in &text.chunks[first..last] {
            draw_layout(
                target,
                &chunk.layout,
                (source_left - area.scroll_x, origin.1 + f64::from(chunk.y)),
                color,
                scale,
            );
        }
        target.pop_layer();
    }

    pub(super) fn chunk_caret_rect(
        &mut self,
        id: &str,
        index: usize,
        width: Option<f32>,
    ) -> Option<parley::BoundingBox> {
        let text = self.chunked.get_mut(id)?;
        let key = text.key(width);
        text.place(key);
        let align = text.align;
        let at = text.at_index(index);
        let chunk = &mut text.chunks[at];
        chunk.break_at(key, align);
        let mut rect =
            Cursor::from_byte_index(&chunk.layout, chunk.local(index), Affinity::Downstream)
                .geometry(&chunk.layout, 1.0);
        rect.y0 += f64::from(chunk.y);
        rect.y1 += f64::from(chunk.y);
        Some(rect)
    }

    pub(super) fn chunk_range_rects(
        &mut self,
        id: &str,
        start: usize,
        end: usize,
        width: Option<f32>,
    ) -> Vec<parley::BoundingBox> {
        let Some(text) = self.chunked.get_mut(id) else {
            return vec![];
        };
        let key = text.key(width);
        text.place(key);
        let align = text.align;
        let first = text.at_index(start);
        let last = text.chunks.partition_point(|chunk| chunk.range.start < end);
        let mut rects = Vec::new();
        for chunk in &mut text.chunks[first..last.max(first + 1)] {
            chunk.break_at(key, align);
            let (local_start, local_end) = (chunk.local(start), chunk.local(end));
            // A selection going on past this chunk takes its last line break too.
            let through = end > chunk.content_end;
            if local_start >= local_end && !through {
                continue;
            }
            let anchor = Cursor::from_byte_index(&chunk.layout, local_start, Affinity::Downstream);
            let focus = Cursor::from_byte_index(&chunk.layout, local_end, Affinity::Upstream);
            let y = f64::from(chunk.y);
            let mut geometry: Vec<_> = Selection::new(anchor, focus)
                .geometry(&chunk.layout)
                .into_iter()
                .map(|(rect, _)| {
                    parley::BoundingBox::new(rect.x0, rect.y0 + y, rect.x1, rect.y1 + y)
                })
                .collect();
            if through && geometry.is_empty() {
                // An empty line inside the selection: the caret's box, as wide as a space.
                let caret = Cursor::from_byte_index(&chunk.layout, local_end, Affinity::Downstream)
                    .geometry(&chunk.layout, 1.0);
                let space = (caret.y1 - caret.y0) / 4.0;
                geometry.push(parley::BoundingBox::new(
                    caret.x0,
                    caret.y0 + y,
                    caret.x0 + space,
                    caret.y1 + y,
                ));
            }
            rects.extend(geometry);
        }
        rects
    }

    pub(super) fn chunk_index_at(
        &mut self,
        id: &str,
        x: f32,
        y: f32,
        width: Option<f32>,
    ) -> Option<usize> {
        let text = self.chunked.get_mut(id)?;
        let key = text.key(width);
        text.place(key);
        let align = text.align;
        let at = text.at_y(y);
        let chunk = &mut text.chunks[at];
        chunk.break_at(key, align);
        let local = Cursor::from_point(&chunk.layout, x, (y - chunk.y).max(0.0)).index();
        Some((chunk.range.start + local).min(chunk.content_end))
    }

    pub(super) fn chunk_accessibility_lines(
        &mut self,
        id: &str,
        value: &str,
        width: Option<f32>,
    ) -> Vec<AccessibilityTextLine> {
        let Some(text) = self.chunked.get_mut(id) else {
            return vec![];
        };
        let key = text.key(width);
        text.place(key);
        let align = text.align;
        let mut result = Vec::new();
        let mut line_index = 0;
        for chunk in &mut text.chunks {
            chunk.break_at(key, align);
            let Some(local_value) = value.get(chunk.range.start..chunk.content_end) else {
                continue;
            };
            let mut lines = layout_accessibility_lines(&chunk.layout, local_value);
            for line in &mut lines {
                line.line_index += line_index;
                line.byte_range = line.byte_range.start + chunk.range.start
                    ..line.byte_range.end + chunk.range.start;
                line.y0 += f64::from(chunk.y);
                line.y1 += f64::from(chunk.y);
            }
            if chunk.range.end > chunk.content_end
                && let Some(last) = lines.last_mut()
            {
                last.byte_range.end = chunk.range.end;
                last.character_positions
                    .push(last.character_positions.last().copied().unwrap_or(0.0));
                last.character_widths.push(0.0);
            }
            line_index += chunk.layout.lines().count();
            result.extend(lines);
        }
        result
    }
}

fn spans_of(rich: Option<&RichContent>) -> &[Span] {
    match rich {
        Some(RichContent::Text { spans, .. }) => spans,
        _ => &[],
    }
}

/// Bytes `a` and `b` share from the start, compared a block at a time.
fn common_prefix(a: &str, b: &str) -> usize {
    const BLOCK: usize = 4096;
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let mut at = 0;
    let limit = a.len().min(b.len());
    while at + BLOCK <= limit && a[at..at + BLOCK] == b[at..at + BLOCK] {
        at += BLOCK;
    }
    at + a[at..limit]
        .iter()
        .zip(&b[at..limit])
        .take_while(|(x, y)| x == y)
        .count()
}
