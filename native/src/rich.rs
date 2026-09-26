//! Parsed, styled content for native rich leaves. No TSX descendants are created.
use crate::syntax::{self, HighlightKind};
use comrak::{
    Arena, Options,
    nodes::{AstNode, ListType, NodeValue, TableAlignment},
    parse_document,
};
use diffy::create_patch;
use std::ops::Range;
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

/// A semantic role resolved to a colour at paint time.
///
/// The parser never bakes a hex literal: a role keeps the same document
/// correct under a light and a dark theme, and a style override can retint it
/// without reparsing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToneRole {
    /// Fenced code block body.
    Code,
    /// Inline `code` span.
    InlineCode,
    /// Hyperlink text.
    Link,
    /// Block quote body.
    Quote,
    /// Image alt text and other de-emphasised prose.
    Muted,
}

impl ToneRole {
    pub fn key(self) -> &'static str {
        match self {
            Self::Code => "markdownCodeColor",
            Self::InlineCode => "markdownInlineCodeColor",
            Self::Link => "markdownLinkColor",
            Self::Quote => "markdownQuoteColor",
            Self::Muted => "markdownMutedColor",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Span {
    pub range: Range<usize>,
    pub size: Option<f32>,
    pub weight: Option<f32>,
    pub italic: bool,
    pub mono: bool,
    pub font_family: Option<String>,
    pub role: Option<ToneRole>,
    pub syntax: Option<HighlightKind>,
    pub underline: bool,
    pub strike: bool,
    pub href: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskMarker {
    pub range: Range<usize>,
    pub checked: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MarkdownBlockKind {
    Table {
        rows: Vec<Range<usize>>,
        header: Option<usize>,
    },
    Code,
    Quote,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MarkdownBlock {
    pub range: Range<usize>,
    pub kind: MarkdownBlockKind,
}

impl Span {
    fn at(range: Range<usize>) -> Self {
        Self {
            range,
            size: None,
            weight: None,
            italic: false,
            mono: false,
            font_family: None,
            role: None,
            syntax: None,
            underline: false,
            strike: false,
            href: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiffRowKind {
    Header,
    Notice,
    Hunk,
    Context,
    Added,
    Removed,
    Meta,
    ShowMore,
}

impl DiffRowKind {
    /// Content rows carry a `+`/`-`/space marker and real source text. Every
    /// other kind is chrome: a header, a hunk banner, a notice or the
    /// show-more affordance.
    pub fn is_content(self) -> bool {
        matches!(self, Self::Context | Self::Added | Self::Removed)
    }
}

/// What the patch says happened to the file. Drives the notice rows and lets a
/// deleted or renamed file keep a usable path for collapse and highlighting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiffFileStatus {
    Added,
    Deleted,
    Modified,
    Renamed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiffFile {
    /// Display path: the post-change side, with the `b/` prefix stripped.
    pub path: String,
    /// Pre-change path, present when a rename or a delete moves the file.
    pub old_path: Option<String>,
    pub status: DiffFileStatus,
    /// A binary file has no line rows to show, only a notice.
    pub binary: bool,
    /// Largest line number on either side. Sizes this file's gutter so a
    /// five-digit file does not widen the gutter of every other file.
    pub max_line: u32,
}

impl DiffFile {
    /// Human-readable rows derived from the status, the binary flag and the
    /// rename source.
    pub fn notices(&self) -> Vec<String> {
        let mut notices = Vec::new();
        match self.status {
            DiffFileStatus::Added => notices.push("New file".into()),
            DiffFileStatus::Deleted => notices.push("Deleted file".into()),
            DiffFileStatus::Renamed => {
                let from = self.old_path.as_deref().unwrap_or("?");
                notices.push(format!("Renamed from {from}"));
            }
            DiffFileStatus::Modified => {}
        }
        if self.binary {
            notices.push("Binary file — contents not shown".into());
        }
        notices
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiffRow {
    pub text: String,
    pub range: Range<usize>,
    pub kind: DiffRowKind,
    /// Byte ranges inside `text` that changed against the paired line.
    pub emphasis: Vec<Range<usize>>,
    pub syntax: Vec<syntax::HighlightSpan>,
    pub old_line: Option<u32>,
    pub new_line: Option<u32>,
    pub file_path: Option<String>,
    pub hidden_lines: Option<usize>,
    pub file_header: bool,
    /// Gutter digits for the owning file, so each file sizes its own gutter.
    pub gutter_digits: u8,
}

impl DiffRow {
    pub fn content_offset(&self) -> usize {
        usize::from(self.kind.is_content())
    }

    pub fn content_text(&self) -> &str {
        &self.text[self.content_offset()..]
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum RichContent {
    Text {
        spans: Vec<Span>,
        task_markers: Vec<TaskMarker>,
        blocks: Vec<MarkdownBlock>,
    },
    Diff {
        rows: Vec<DiffRow>,
        /// Per-file metadata, in patch order. A row's `file_path` indexes here
        /// for gutter sizing; an absent path means the row precedes any file.
        files: Vec<DiffFile>,
        max_columns: usize,
        max_line_number: u32,
    },
}

struct Writer {
    text: String,
    spans: Vec<Span>,
    task_markers: Vec<TaskMarker>,
    blocks: Vec<MarkdownBlock>,
}

impl Writer {
    fn new() -> Self {
        Self {
            text: String::new(),
            spans: Vec::new(),
            task_markers: Vec::new(),
            blocks: Vec::new(),
        }
    }
    fn push(&mut self, value: &str) {
        self.text.push_str(value);
    }
    fn breaks(&mut self, count: usize) {
        if self.text.is_empty() {
            return;
        }
        let present = self.text.bytes().rev().take_while(|b| *b == b'\n').count();
        for _ in present..count {
            self.text.push('\n');
        }
    }
    fn span(&mut self, span: Span) {
        if span.range.start < span.range.end {
            self.spans.push(span);
        }
    }
    fn task_marker(&mut self, range: Range<usize>, checked: bool) {
        if range.start < range.end {
            self.task_markers.push(TaskMarker { range, checked });
        }
    }
}

fn render_children<'a>(node: &'a AstNode<'a>, writer: &mut Writer, depth: usize) {
    for child in node.children() {
        render_node(child, writer, depth);
    }
}

fn render_table<'a>(
    node: &'a AstNode<'a>,
    writer: &mut Writer,
    depth: usize,
    alignment: &[TableAlignment],
) {
    let mut rows = Vec::new();
    let mut widths = Vec::<usize>::new();
    for row in node.children() {
        let header = matches!(row.data.borrow().value, NodeValue::TableRow(true));
        let mut cells = Vec::new();
        for (column, cell) in row.children().enumerate() {
            let mut content = Writer::new();
            render_children(cell, &mut content, depth);
            let width = content
                .text
                .lines()
                .map(UnicodeWidthStr::width)
                .max()
                .unwrap_or(0);
            if column >= widths.len() {
                widths.push(width);
            } else {
                widths[column] = widths[column].max(width);
            }
            cells.push(content);
        }
        rows.push((header, cells));
    }
    writer.breaks(2);
    let table_start = writer.text.len();
    // Column padding is bounded by a total budget. Past it the table keeps its
    // separators but drops the padding, which is ugly but honest, rather than
    // silently pretending the columns still line up.
    const ALIGNMENT_BUDGET: usize = 4 * 1024 * 1024;
    let align_columns = widths
        .iter()
        .try_fold(0usize, |sum, width| sum.checked_add(*width))
        .and_then(|width| width.checked_mul(rows.len()))
        .is_some_and(|bytes| bytes <= ALIGNMENT_BUDGET);
    let mut row_ranges = Vec::new();
    let mut header_row = None;
    for (header, cells) in rows {
        let row_start = writer.text.len();
        for (column, cell) in cells.into_iter().enumerate() {
            if column > 0 {
                writer.push("  │  ");
            }
            let width = cell
                .text
                .lines()
                .map(UnicodeWidthStr::width)
                .max()
                .unwrap_or(0);
            let padding = if align_columns {
                widths[column].saturating_sub(width)
            } else {
                0
            };
            let left = match alignment.get(column) {
                Some(TableAlignment::Right) => padding,
                Some(TableAlignment::Center) => padding / 2,
                _ => 0,
            };
            writer.push(&" ".repeat(left));
            let start = writer.text.len();
            writer.push(&cell.text);
            for mut span in cell.spans {
                span.range = (span.range.start + start)..(span.range.end + start);
                writer.span(span);
            }
            for mut marker in cell.task_markers {
                marker.range = (marker.range.start + start)..(marker.range.end + start);
                writer.task_markers.push(marker);
            }
            writer.push(&" ".repeat(padding - left));
        }
        if header {
            header_row = Some(row_ranges.len());
            let mut span = Span::at(row_start..writer.text.len());
            span.weight = Some(650.0);
            writer.span(span);
        }
        row_ranges.push(row_start..writer.text.len());
        writer.breaks(1);
    }
    writer.blocks.push(MarkdownBlock {
        range: table_start..writer.text.len(),
        kind: MarkdownBlockKind::Table {
            rows: row_ranges,
            header: header_row,
        },
    });
    let mut span = Span::at(table_start..writer.text.len());
    span.mono = true;
    writer.span(span);
    writer.breaks(2);
}

fn render_node<'a>(node: &'a AstNode<'a>, writer: &mut Writer, depth: usize) {
    let value = node.data.borrow().value.clone();
    match value {
        NodeValue::Document => render_children(node, writer, depth),
        NodeValue::Heading(heading) => {
            writer.breaks(2);
            let start = writer.text.len();
            render_children(node, writer, depth);
            let mut span = Span::at(start..writer.text.len());
            // Sizes are multiples of the leaf font size, so a document keeps its
            // proportions at any base size and a style override still wins.
            span.size = Some(match heading.level {
                1 => 2.0,
                2 => 1.7,
                3 => 1.45,
                4 => 1.25,
                _ => 1.1,
            });
            span.weight = Some(700.0);
            writer.span(span);
            writer.breaks(2);
        }
        NodeValue::Paragraph => {
            render_children(node, writer, depth);
            writer.breaks(if depth > 0 { 1 } else { 2 });
        }
        NodeValue::BlockQuote => {
            writer.breaks(2);
            let block_start = writer.text.len();
            let start = writer.text.len();
            // No `│` marker glyph. The accent bar is painted from the block
            // extent, so a written marker would sit on the first line only,
            // stay behind on every wrapped line, and leak into copy and screen
            // readers as a stray pipe.
            render_children(node, writer, depth + 1);
            let mut span = Span::at(start..writer.text.len());
            span.italic = true;
            span.role = Some(ToneRole::Quote);
            writer.span(span);
            writer.blocks.push(MarkdownBlock {
                range: block_start..writer.text.len(),
                kind: MarkdownBlockKind::Quote,
            });
            writer.breaks(2);
        }
        NodeValue::List(list) => {
            writer.breaks(1);
            for (index, child) in node.children().enumerate() {
                writer.push(&"  ".repeat(depth));
                match &child.data.borrow().value {
                    NodeValue::TaskItem(task) => {
                        let start = writer.text.len();
                        let checked = task.symbol.is_some();
                        // Reserve exactly one em in text layout, then paint the checkbox natively.
                        // This keeps wrapping deterministic without depending on a symbol font.
                        writer.push("\u{2003}");
                        writer.task_marker(start..writer.text.len(), checked);
                        writer.push(" ");
                    }
                    _ => match list.list_type {
                        ListType::Bullet => writer.push("• "),
                        ListType::Ordered => writer.push(&format!("{}. ", list.start + index)),
                    },
                }
                render_children(child, writer, depth + 1);
                writer.breaks(1);
            }
            writer.breaks(2);
        }
        NodeValue::Item(_) | NodeValue::DescriptionItem(_) => render_children(node, writer, depth),
        NodeValue::Table(table) => render_table(node, writer, depth, &table.alignments),
        NodeValue::TableRow(header) => {
            let start = writer.text.len();
            for (index, cell) in node.children().enumerate() {
                if index > 0 {
                    writer.push("  │  ");
                }
                render_children(cell, writer, depth);
            }
            if header {
                let mut span = Span::at(start..writer.text.len());
                span.weight = Some(650.0);
                writer.span(span);
            }
            writer.breaks(1);
        }
        NodeValue::TableCell => render_children(node, writer, depth),
        NodeValue::CodeBlock(block) => {
            writer.breaks(2);
            let start = writer.text.len();
            let literal = block.literal.trim_end_matches('\n');
            writer.push(literal);
            let mut span = Span::at(start..writer.text.len());
            span.mono = true;
            // A role, not a hex literal: the same document has to stay legible
            // under a light and a dark theme, and a style override must be able
            // to retint it without reparsing.
            span.role = Some(ToneRole::Code);
            writer.span(span);
            let language = block.info.split_whitespace().next().unwrap_or("");
            for mut span in code_spans(literal, (!language.is_empty()).then_some(language), None) {
                span.range = (span.range.start + start)..(span.range.end + start);
                writer.span(span);
            }
            writer.blocks.push(MarkdownBlock {
                range: start..writer.text.len(),
                kind: MarkdownBlockKind::Code,
            });
            writer.breaks(2);
        }
        NodeValue::ThematicBreak => {
            writer.breaks(2);
            writer.push("────────────────");
            writer.breaks(2);
        }
        NodeValue::Text(value) => writer.push(&value),
        NodeValue::Code(code) => {
            let start = writer.text.len();
            writer.push(&code.literal);
            let mut span = Span::at(start..writer.text.len());
            span.mono = true;
            span.role = Some(ToneRole::InlineCode);
            writer.span(span);
        }
        NodeValue::Emph
        | NodeValue::Strong
        | NodeValue::Strikethrough
        | NodeValue::Link(_)
        | NodeValue::Image(_) => {
            let start = writer.text.len();
            render_children(node, writer, depth);
            let mut span = Span::at(start..writer.text.len());
            match value {
                NodeValue::Emph => span.italic = true,
                NodeValue::Strong => span.weight = Some(700.0),
                NodeValue::Strikethrough => span.strike = true,
                NodeValue::Link(link) => {
                    span.underline = true;
                    span.role = Some(ToneRole::Link);
                    span.href = Some(link.url);
                }
                NodeValue::Image(_) => {
                    span.role = Some(ToneRole::Muted);
                }
                _ => unreachable!(),
            }
            writer.span(span);
        }
        NodeValue::TaskItem(_) => render_children(node, writer, depth),
        NodeValue::SoftBreak => writer.push(" "),
        NodeValue::LineBreak => writer.push("\n"),
        NodeValue::HtmlBlock(block) => {
            writer.breaks(2);
            let start = writer.text.len();
            writer.push(block.literal.trim_end_matches('\n'));
            let mut span = Span::at(start..writer.text.len());
            span.mono = true;
            writer.span(span);
            writer.breaks(2);
        }
        NodeValue::HtmlInline(literal) => writer.push(&literal),
        _ => render_children(node, writer, depth),
    }
}

pub fn markdown(source: &str) -> (String, RichContent) {
    let arena = Arena::new();
    let mut options = Options::default();
    options.extension.table = true;
    options.extension.tasklist = true;
    options.extension.strikethrough = true;
    options.extension.autolink = true;
    let root = parse_document(&arena, source, &options);
    let mut writer = Writer::new();
    render_node(root, &mut writer, 0);
    let len = writer.text.trim_end_matches('\n').len();
    writer.text.truncate(len);
    for span in &mut writer.spans {
        span.range.start = span.range.start.min(len);
        span.range.end = span.range.end.min(len);
    }
    for marker in &mut writer.task_markers {
        marker.range.start = marker.range.start.min(len);
        marker.range.end = marker.range.end.min(len);
    }
    for block in &mut writer.blocks {
        block.range.start = block.range.start.min(len);
        block.range.end = block.range.end.min(len);
        if let MarkdownBlockKind::Table { rows, .. } = &mut block.kind {
            for row in rows {
                row.start = row.start.min(len);
                row.end = row.end.min(len);
            }
        }
    }
    writer
        .spans
        .retain(|span| span.range.start < span.range.end);
    writer
        .task_markers
        .retain(|marker| marker.range.start < marker.range.end);
    writer
        .blocks
        .retain(|block| block.range.start < block.range.end);
    (
        writer.text,
        RichContent::Text {
            spans: writer.spans,
            task_markers: writer.task_markers,
            blocks: writer.blocks,
        },
    )
}

fn code_spans(code: &str, language: Option<&str>, path: Option<&str>) -> Vec<Span> {
    let Some(document) = syntax::highlight_cached(code, language, path) else {
        return Vec::new();
    };
    let mut spans = Vec::new();
    let mut line_start = 0usize;
    for (line_index, line) in code.split_inclusive('\n').enumerate() {
        if let Some(line_spans) = document.lines.get(line_index) {
            spans.extend(line_spans.iter().map(|highlight| {
                let mut span =
                    Span::at(line_start + highlight.range.start..line_start + highlight.range.end);
                span.syntax = Some(highlight.kind);
                span
            }));
        }
        line_start += line.len();
    }
    spans
}

pub fn code(code: &str, language: Option<&str>, path: Option<&str>) -> RichContent {
    RichContent::Text {
        spans: code_spans(code, language, path),
        task_markers: Vec::new(),
        blocks: Vec::new(),
    }
}

impl RichContent {
    fn map_task_markers(
        &self,
        text: &str,
        range: Range<usize>,
        replacement: impl Fn(bool) -> &'static str,
        consume_separator: bool,
    ) -> Option<String> {
        let mut result = text.get(range.clone())?.to_string();
        let RichContent::Text { task_markers, .. } = self else {
            return Some(result);
        };
        for marker in task_markers.iter().rev() {
            if marker.range.start >= range.start && marker.range.end <= range.end {
                let relative_start = marker.range.start - range.start;
                let mut relative_end = marker.range.end - range.start;
                if consume_separator
                    && marker.range.end < range.end
                    && text.as_bytes().get(marker.range.end) == Some(&b' ')
                {
                    relative_end += 1;
                }
                result.replace_range(relative_start..relative_end, replacement(marker.checked));
            }
        }
        Some(result)
    }

    /// Text exposed to copy/selection consumers. Paint-only decoration is
    /// dropped: task markers, and for a diff the `+`/`-`/space markers, the
    /// line-number gutters and every chrome row.
    pub fn copy_text(&self, text: &str, range: Range<usize>) -> Option<String> {
        let RichContent::Diff { rows, .. } = self else {
            return self.map_task_markers(text, range, |_| "", true);
        };
        let mut lines = Vec::new();
        for row in rows.iter().filter(|row| {
            row.kind.is_content() && row.range.end > range.start && row.range.start < range.end
        }) {
            // A partially selected line contributes only the selected part.
            let start = range.start.max(row.range.start + row.content_offset()) - row.range.start;
            let end = range.end.min(row.range.end) - row.range.start;
            if let Some(slice) = row.text.get(start..end) {
                lines.push(slice.to_string());
            }
        }
        (!lines.is_empty()).then(|| lines.join("\n"))
    }

    /// Text exposed to assistive technology keeps task state without depending
    /// on symbol glyphs, and speaks a diff line with its side and number.
    pub fn accessibility_text(&self, text: &str, range: Range<usize>) -> Option<String> {
        let RichContent::Diff { rows, .. } = self else {
            return self.map_task_markers(
                text,
                range,
                |checked| if checked { "[x]" } else { "[ ]" },
                false,
            );
        };
        let mut lines = Vec::new();
        for row in rows.iter().filter(|row| {
            row.kind.is_content() && row.range.end > range.start && row.range.start < range.end
        }) {
            let side = match row.kind {
                DiffRowKind::Added => "added",
                DiffRowKind::Removed => "removed",
                _ => "context",
            };
            let number = row.new_line.or(row.old_line).unwrap_or(0);
            lines.push(format!("{side} line {number}: {}", row.content_text()));
        }
        (!lines.is_empty()).then(|| lines.join("\n"))
    }

    /// The joined display text that selection, search and copy all address.
    pub fn display_text(&self) -> Option<String> {
        let RichContent::Diff { rows, .. } = self else {
            return None;
        };
        let mut text = String::new();
        for row in rows {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(&row.text);
        }
        Some(text)
    }
}

fn diff_kind(line: &str) -> DiffRowKind {
    if line.starts_with("diff --git ") || line.starts_with("--- ") || line.starts_with("+++ ") {
        DiffRowKind::Header
    } else if line.starts_with("@@") {
        DiffRowKind::Hunk
    } else if line.starts_with('+') {
        DiffRowKind::Added
    } else if line.starts_with('-') {
        DiffRowKind::Removed
    } else if line.starts_with(' ') {
        DiffRowKind::Context
    } else {
        DiffRowKind::Meta
    }
}

/// Annotate paired delete/add runs with the byte ranges that actually changed.
///
/// Only runs of the same length are paired. Pairing an unequal run by index
/// compares line 3 against line 7 and produces a confident, wrong highlight,
/// which is worse than no highlight at all.
fn emphasize_pairs(rows: &mut [DiffRow]) {
    let mut index = 0;
    while index < rows.len() {
        if rows[index].kind != DiffRowKind::Removed {
            index += 1;
            continue;
        }
        let removed_start = index;
        while index < rows.len() && rows[index].kind == DiffRowKind::Removed {
            index += 1;
        }
        let added_start = index;
        while index < rows.len() && rows[index].kind == DiffRowKind::Added {
            index += 1;
        }
        let removed = removed_start..added_start;
        let added = added_start..index;
        if removed.len() == added.len() {
            for offset in 0..removed.len() {
                let old_body = rows[removed.start + offset]
                    .text
                    .strip_prefix('-')
                    .unwrap_or(&rows[removed.start + offset].text)
                    .to_string();
                let new_body = rows[added.start + offset]
                    .text
                    .strip_prefix('+')
                    .unwrap_or(&rows[added.start + offset].text)
                    .to_string();
                let (old_ranges, new_ranges) = word_diff(&old_body, &new_body);
                rows[removed.start + offset].emphasis = old_ranges;
                rows[added.start + offset].emphasis = new_ranges;
            }
        }
    }
}

/// Byte ranges that differ between two lines, as (old ranges, new ranges).
///
/// A common-prefix / common-suffix trim on token boundaries. Not a full LCS:
/// for single-line edits the trim produces the same answer far more cheaply,
/// and a diff viewer runs this on every changed pair. The prefix and suffix are
/// trimmed on whole tokens, so a changed word is never split down the middle.
///
/// Each side collapses to a single span: the changed tokens of one line are
/// contiguous once the common affixes are removed, and a one-element `Vec` per
/// side is what the paint layer consumes.
fn word_diff(old: &str, new: &str) -> (Vec<Range<usize>>, Vec<Range<usize>>) {
    if old == new {
        return (Vec::new(), Vec::new());
    }
    let old_words = split_words(old);
    let new_words = split_words(new);
    let mut prefix = 0;
    while prefix < old_words.len()
        && prefix < new_words.len()
        && old[old_words[prefix].clone()] == new[new_words[prefix].clone()]
    {
        prefix += 1;
    }
    let mut suffix = 0;
    while suffix < old_words.len() - prefix
        && suffix < new_words.len() - prefix
        && old[old_words[old_words.len() - 1 - suffix].clone()]
            == new[new_words[new_words.len() - 1 - suffix].clone()]
    {
        suffix += 1;
    }
    // The changed tokens of one line are contiguous once the common affixes are
    // removed, so each side is at most one span.
    let collapse = |words: &[Range<usize>]| -> Option<Range<usize>> {
        let changed = &words[prefix..words.len() - suffix];
        match (changed.first(), changed.last()) {
            (Some(first), Some(last)) => Some(first.start..last.end),
            _ => None,
        }
    };
    (
        collapse(&old_words).into_iter().collect(),
        collapse(&new_words).into_iter().collect(),
    )
}

/// Byte ranges of the tokens in a line. A run of word characters is one token;
/// every other character is its own token, so `foo(x)` and `foo(y)` differ in
/// exactly the two bracket tokens instead of the whole expression.
fn split_words(line: &str) -> Vec<Range<usize>> {
    let mut words = Vec::new();
    let mut start: Option<usize> = None;
    for (index, character) in line.char_indices() {
        let is_word = character.is_alphanumeric() || character == '_';
        match (is_word, start) {
            (true, None) => start = Some(index),
            (false, Some(begin)) => {
                words.push(begin..index);
                start = None;
                words.push(index..index + character.len_utf8());
            }
            (false, None) => words.push(index..index + character.len_utf8()),
            (true, Some(_)) => {}
        }
    }
    if let Some(begin) = start {
        words.push(begin..line.len());
    }
    words
}

fn parse_hunk_starts(line: &str) -> Option<(u32, u32)> {
    let body = line.strip_prefix("@@ -")?;
    let (old, rest) = body.split_once(" +")?;
    let (new, _) = rest.split_once(" @@")?;
    let parse = |value: &str| value.split(',').next()?.parse::<u32>().ok();
    Some((parse(old)?, parse(new)?))
}

/// Split a `diff --git a/… b/…` tail into its two paths.
///
/// Git only quotes a path when it contains control characters, unusual bytes
/// or a `"`, so **spaces are normally left unquoted**. Splitting on the first
/// whitespace therefore truncates `a/my file.txt b/my file.txt` to `my`, which
/// then breaks collapse, extension-based language detection and per-file
/// highlighting. The unquoted case splits on the last ` b/`, which is git's own
/// convention: a path may contain spaces but the two sides are still separable
/// from the right.
fn git_diff_paths(rest: &str) -> Option<(String, String)> {
    if rest.starts_with('"') {
        let (left, tail) = git_path_token(rest)?;
        let (right, _) = git_path_token(tail.trim_start())?;
        return Some((left, right));
    }
    if let Some(index) = rest.rfind(" b/") {
        let (left, right) = rest.split_at(index);
        return Some((left.trim().to_string(), right.trim_start().to_string()));
    }
    // A single unquoted path, or a pair with no `b/` prefix.
    let mut parts = rest.split_whitespace();
    let left = parts.next()?.to_string();
    match parts.next() {
        Some(right) => Some((left, right.to_string())),
        None => Some((left.clone(), left)),
    }
}

fn strip_side_prefix(path: &str, prefix: &str) -> String {
    path.strip_prefix(prefix).unwrap_or(path).to_string()
}

fn git_path(line: &str) -> Option<String> {
    if let Some(rest) = line.strip_prefix("diff --git ") {
        let (_, right) = git_diff_paths(rest)?;
        return Some(strip_side_prefix(&right, "b/"));
    }
    let (path, _) = git_path_token(line.strip_prefix("+++ ")?.trim())?;
    Some(strip_side_prefix(&path, "b/"))
}

fn git_path_token(input: &str) -> Option<(String, &str)> {
    if let Some(rest) = input.strip_prefix('"') {
        let mut value = Vec::new();
        let bytes = rest.as_bytes();
        let mut index = 0;
        while index < bytes.len() {
            if bytes[index] == b'"' {
                return Some((String::from_utf8(value).ok()?, &rest[index + 1..]));
            }
            if bytes[index] == b'\\' {
                index += 1;
                let escaped = *bytes.get(index)?;
                if (b'0'..=b'7').contains(&escaped) {
                    let mut number = u16::from(escaped - b'0');
                    for _ in 0..2 {
                        if let Some(next @ b'0'..=b'7') = bytes.get(index + 1).copied() {
                            index += 1;
                            number = number * 8 + u16::from(next - b'0');
                        } else {
                            break;
                        }
                    }
                    value.push(u8::try_from(number).ok()?);
                } else {
                    value.push(match escaped {
                        b'n' => b'\n',
                        b'r' => b'\r',
                        b't' => b'\t',
                        b'a' => 7,
                        b'b' => 8,
                        b'f' => 12,
                        b'v' => 11,
                        other => other,
                    });
                }
            } else {
                value.push(bytes[index]);
            }
            index += 1;
        }
        return None;
    }
    let end = input.find(char::is_whitespace).unwrap_or(input.len());
    (end > 0).then(|| (input[..end].to_string(), &input[end..]))
}

fn display_columns(text: &str) -> usize {
    let mut columns = 0usize;
    for grapheme in text.graphemes(true) {
        if grapheme == "\t" {
            columns += 4 - columns % 4;
        } else {
            columns += UnicodeWidthStr::width(grapheme);
        }
    }
    columns
}

fn old_path(line: &str) -> Option<String> {
    let (path, _) = git_path_token(line.strip_prefix("--- ")?.trim())?;
    Some(strip_side_prefix(&path, "a/"))
}

fn highlight_diff_side(rows: &mut [DiffRow], path: &str, old: bool) {
    let mut source = String::new();
    let mut indexes = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        let include = if old {
            row.old_line.is_some()
        } else {
            row.new_line.is_some()
        };
        if !include {
            continue;
        }
        let body = row.text.strip_prefix(['+', '-', ' ']).unwrap_or(&row.text);
        if source.len() + body.len() + 1 > syntax::DEFAULT_MAX_SOURCE_BYTES {
            return;
        }
        source.push_str(body);
        source.push('\n');
        indexes.push(index);
    }
    if source.is_empty() {
        return;
    }
    let Some(document) = syntax::highlight_cached(&source, None, Some(path)) else {
        return;
    };
    for (index, spans) in indexes.into_iter().zip(&document.lines) {
        let row = &mut rows[index];
        if row.kind == DiffRowKind::Context && old {
            continue;
        }
        row.syntax = spans
            .iter()
            .map(|span| syntax::HighlightSpan {
                range: span.range.start + 1..span.range.end + 1,
                kind: span.kind,
            })
            .collect();
    }
}

/// Highlight both sides of the diff, per file.
///
/// A diff interleaves two versions of one file, so each side is reconstructed
/// from its own rows and highlighted separately. A deleted line then gets the
/// colours its own version of the file implies, which a single joined parse
/// cannot produce.
///
/// Only the visible rows are joined. Padding the gaps between hunks with blank
/// lines would keep the indexes aligned but not the parser state, and a hunk at
/// line 600,000 would blow past the syntax byte limit and leave the whole file
/// unhighlighted. Syntax state that the patch never contained — a block comment
/// opened above the first hunk — is inherently unrecoverable.
fn highlight_files(rows: &mut [DiffRow], files: &[ParsedFile]) {
    let mut start = 0usize;
    while start < rows.len() {
        let Some(path) = rows[start].file_path.clone() else {
            start += 1;
            continue;
        };
        if rows[start].kind == DiffRowKind::ShowMore {
            start += 1;
            continue;
        }
        let mut end = start + 1;
        while end < rows.len() && rows[end].file_path.as_deref() == Some(path.as_str()) {
            end += 1;
        }
        let Some(parsed) = files.iter().find(|file| file.file.path == path) else {
            start = end;
            continue;
        };
        let file = &mut rows[start..end];
        highlight_diff_side(file, &parsed.old_path_for_syntax, true);
        highlight_diff_side(file, &parsed.file.path, false);
        start = end;
    }
}

pub fn diff(
    source: &str,
    old_text: Option<&str>,
    new_text: Option<&str>,
    word_diff: bool,
    collapsed_paths: &[String],
    max_lines: Option<usize>,
) -> Result<(String, RichContent), String> {
    let patch = match (old_text, new_text) {
        // A patch wins whenever there is one. `oldText`/`newText` default to
        // empty strings so the protocol can carry them unconditionally, and an
        // empty default must not be mistaken for a request to diff two empty
        // texts and discard the patch the caller actually passed.
        (Some(_), Some(_)) if !source.is_empty() => source.to_string(),
        (Some(old), Some(new)) => create_patch(old, new).to_string(),
        _ => source.to_string(),
    };
    // A patch is a stream and a truncated one is normal while `git diff` is
    // still writing, so accept whatever parsed instead of discarding the
    // document. Only text with no hunk at all is rejected.
    let files = parse_patch(&patch);
    if files.is_empty() && !patch.trim().is_empty() {
        return Err("no unified diff hunk was found".into());
    }
    let mut rows = flatten_rows(&files, collapsed_paths, max_lines);
    highlight_files(&mut rows, &files);
    if word_diff {
        emphasize_pairs(&mut rows);
    }
    assign_ranges(&mut rows);

    let max_columns = rows
        .iter()
        .filter(|row| row.kind.is_content())
        .map(|row| display_columns(row.content_text()))
        .max()
        .unwrap_or(0);
    let max_line_number = files
        .iter()
        .map(|file| file.file.max_line)
        .max()
        .unwrap_or(0);
    Ok((
        patch,
        RichContent::Diff {
            rows,
            files: files.into_iter().map(|file| file.file).collect(),
            max_columns,
            max_line_number,
        },
    ))
}

/// Everything one `diff --git` section contributes, before rows are flattened.
struct ParsedFile {
    file: DiffFile,
    /// Path used to detect the language of the pre-change side. A rename or a
    /// delete means it differs from `file.path`.
    old_path_for_syntax: String,
    rows: Vec<DiffRow>,
    additions: usize,
    deletions: usize,
}

impl ParsedFile {
    fn new(path: String, old_path: Option<String>) -> Self {
        let old_path_for_syntax = old_path.clone().unwrap_or_else(|| path.clone());
        Self {
            file: DiffFile {
                path,
                old_path,
                status: DiffFileStatus::Modified,
                binary: false,
                max_line: 0,
            },
            old_path_for_syntax,
            rows: Vec::new(),
            additions: 0,
            deletions: 0,
        }
    }

    /// Gutter width for this file alone, so a five-digit file does not widen
    /// the gutter of every other file in the patch.
    fn digits(&self) -> u8 {
        digit_count(self.file.max_line)
    }
}

fn digit_count(value: u32) -> u8 {
    let mut digits = 1u8;
    let mut remaining = value;
    while remaining >= 10 {
        remaining /= 10;
        digits += 1;
    }
    digits
}

/// Parse a patch into per-file sections. Tolerates a missing `diff --git`
/// preamble, quoted paths, renames, binary markers and a truncated tail.
fn parse_patch(patch: &str) -> Vec<ParsedFile> {
    let mut files: Vec<ParsedFile> = Vec::new();
    let mut old_line: Option<u32> = None;
    let mut new_line: Option<u32> = None;
    let mut pending_new_path: Option<String> = None;
    let mut pending_old_path: Option<String> = None;
    let mut in_hunk = false;

    for raw in patch.lines() {
        let line = raw.trim_end_matches('\r');
        if line.starts_with("diff --git ") {
            let (old, new) = git_diff_paths(line.trim_start_matches("diff --git "))
                .unwrap_or_else(|| (String::new(), String::new()));
            let mut file = ParsedFile::new(
                strip_side_prefix(&new, "b/"),
                Some(strip_side_prefix(&old, "a/")),
            );
            if file.file.path.is_empty() {
                file.file.path = file.file.old_path.clone().unwrap_or_default();
            }
            files.push(file);
            pending_new_path = None;
            pending_old_path = None;
            old_line = None;
            new_line = None;
            in_hunk = false;
            continue;
        }

        // A patch with no `diff --git` preamble still needs a home for its rows.
        if files.is_empty() && (line.starts_with("@@") || line.starts_with("--- ")) {
            files.push(ParsedFile::new(String::new(), None));
        }
        let Some(file) = files.last_mut() else {
            continue;
        };

        if let Some((old, new)) = parse_hunk_starts(line) {
            old_line = Some(old);
            new_line = Some(new);
            in_hunk = true;
            file.push_row(DiffRowKind::Hunk, line, None, None, 1);
            continue;
        }

        // Inside a hunk, `+`/`-`/space are content and `\` is a marker. Anything
        // else means the hunk ended and the line starts a new header.
        if in_hunk {
            let marker = line.chars().next();
            if matches!(marker, Some('+') | Some('-') | Some(' ') | Some('\\')) {
                let kind = diff_kind(line);
                let (row_old, row_new) = match kind {
                    DiffRowKind::Added => {
                        let current = new_line;
                        new_line = new_line.map(|value| value.saturating_add(1));
                        file.additions += 1;
                        (None, current)
                    }
                    DiffRowKind::Removed => {
                        let current = old_line;
                        old_line = old_line.map(|value| value.saturating_add(1));
                        file.deletions += 1;
                        (current, None)
                    }
                    DiffRowKind::Context => {
                        let current = (old_line, new_line);
                        old_line = old_line.map(|value| value.saturating_add(1));
                        new_line = new_line.map(|value| value.saturating_add(1));
                        (current.0, current.1)
                    }
                    _ => (None, None),
                };
                file.file.max_line = file
                    .file
                    .max_line
                    .max(row_old.unwrap_or(0))
                    .max(row_new.unwrap_or(0));
                file.push_row(kind, line, row_old, row_new, 1);
                continue;
            }
            in_hunk = false;
        }
        read_file_header(file, line, &mut pending_new_path, &mut pending_old_path);
    }
    files
}

/// Read one non-hunk patch line as file metadata.
///
/// `index`, `old mode`, `new mode` and `similarity index` are plumbing with
/// nothing to show, so they are dropped instead of painted as if they were
/// source lines.
fn read_file_header(
    file: &mut ParsedFile,
    line: &str,
    pending_new_path: &mut Option<String>,
    pending_old_path: &mut Option<String>,
) {
    if line.starts_with("--- ") {
        let path = old_path(line);
        // `--- /dev/null` is how git spells "this file did not exist before".
        if path.is_none() {
            file.file.status = DiffFileStatus::Added;
        } else {
            *pending_old_path = path;
        }
    } else if line.starts_with("+++ ") {
        *pending_new_path = git_path(line).filter(|path| path != "/dev/null");
    } else if line.starts_with("new file mode") {
        file.file.status = DiffFileStatus::Added;
    } else if line.starts_with("deleted file mode") {
        file.file.status = DiffFileStatus::Deleted;
    } else if let Some(from) = line.strip_prefix("rename from ") {
        file.file.old_path = Some(from.trim().to_string());
        file.file.status = DiffFileStatus::Renamed;
    } else if let Some(to) = line.strip_prefix("rename to ") {
        file.file.path = to.trim().to_string();
        file.file.status = DiffFileStatus::Renamed;
    } else if line.starts_with("Binary files") || line.starts_with("GIT binary patch") {
        file.file.binary = true;
    }
    // A rename carries its own authoritative pair, so the `---`/`+++` lines
    // must not overwrite it.
    if file.file.status != DiffFileStatus::Renamed
        && let Some(path) = pending_old_path.clone()
    {
        file.file.old_path = Some(path);
    }
    if let Some(path) = pending_new_path.clone() {
        file.file.path = path;
    } else if file.file.path.is_empty()
        && let Some(path) = file.file.old_path.clone()
    {
        // A deleted file has no `+++` side, so its own path is the only label
        // collapse and language detection can use.
        file.file.path = path;
    }
}

impl ParsedFile {
    fn push_row(
        &mut self,
        kind: DiffRowKind,
        text: &str,
        old_line: Option<u32>,
        new_line: Option<u32>,
        gutter_digits: u8,
    ) {
        let path = self.file.path.clone();
        self.rows.push(DiffRow {
            text: text.to_string(),
            range: 0..0,
            kind,
            emphasis: Vec::new(),
            syntax: Vec::new(),
            old_line,
            new_line,
            file_path: Some(path),
            hidden_lines: None,
            file_header: false,
            gutter_digits,
        });
    }
}

/// Flatten files into paint rows.
///
/// Collapsing a file **removes** its body rows rather than hiding them, so a
/// collapsed ten-thousand-line file costs exactly one row. `max_lines` is a
/// preview of the whole patch: once the budget is spent the remaining files
/// are not emitted and a single show-more row reports what is left.
fn flatten_rows(
    files: &[ParsedFile],
    collapsed_paths: &[String],
    max_lines: Option<usize>,
) -> Vec<DiffRow> {
    let mut rows = Vec::new();
    let mut budget = max_lines;
    let mut truncated_at: Option<(usize, String)> = None;

    'files: for parsed in files {
        let collapsed = is_collapsed(parsed, collapsed_paths);
        let digits = parsed.digits();
        let mut header = DiffRow {
            text: parsed.file.path.clone(),
            range: 0..0,
            kind: DiffRowKind::Header,
            emphasis: Vec::new(),
            syntax: Vec::new(),
            old_line: None,
            new_line: None,
            file_path: Some(parsed.file.path.clone()),
            hidden_lines: None,
            file_header: true,
            gutter_digits: digits,
        };
        if parsed.additions > 0 || parsed.deletions > 0 {
            header.text = format!(
                "{}    +{} −{}",
                header.text, parsed.additions, parsed.deletions
            );
        }
        rows.push(header);
        if collapsed {
            continue;
        }

        for notice in parsed.file.notices() {
            rows.push(DiffRow {
                text: notice,
                range: 0..0,
                kind: DiffRowKind::Notice,
                emphasis: Vec::new(),
                syntax: Vec::new(),
                old_line: None,
                new_line: None,
                file_path: Some(parsed.file.path.clone()),
                hidden_lines: None,
                file_header: false,
                gutter_digits: digits,
            });
        }

        for row in &parsed.rows {
            if budget == Some(0) {
                truncated_at = Some((rows.len(), parsed.file.path.clone()));
                break 'files;
            }
            let mut row = row.clone();
            row.gutter_digits = digits;
            if row.kind.is_content() {
                budget = budget.map(|value| value - 1);
            }
            rows.push(row);
        }
    }

    if let Some((index, path)) = truncated_at {
        let hidden = count_hidden_lines(files, collapsed_paths, max_lines.unwrap_or(0));
        rows.truncate(index);
        if hidden > 0 {
            rows.push(DiffRow {
                text: format!("Show {hidden} more lines"),
                range: 0..0,
                kind: DiffRowKind::ShowMore,
                emphasis: Vec::new(),
                syntax: Vec::new(),
                old_line: None,
                new_line: None,
                // The owning file travels with the row so the click event can
                // name the patch the reader is looking at.
                file_path: (!path.is_empty()).then_some(path),
                hidden_lines: Some(hidden),
                file_header: false,
                gutter_digits: 1,
            });
        }
    }
    rows
}

fn is_collapsed(parsed: &ParsedFile, collapsed_paths: &[String]) -> bool {
    !parsed.file.path.is_empty()
        && collapsed_paths
            .iter()
            .any(|candidate| candidate == &parsed.file.path)
}

/// Content rows the budget did not show, across every file it did not reach.
fn count_hidden_lines(files: &[ParsedFile], collapsed_paths: &[String], budget: usize) -> usize {
    let mut seen = 0usize;
    let mut hidden = 0usize;
    for parsed in files {
        if is_collapsed(parsed, collapsed_paths) {
            continue;
        }
        for row in &parsed.rows {
            if !row.kind.is_content() {
                continue;
            }
            if seen < budget {
                seen += 1;
            } else {
                hidden += 1;
            }
        }
    }
    hidden
}

/// Give every row its slice of the joined display text, which is what
/// selection, search, copy and accessibility all address.
fn assign_ranges(rows: &mut [DiffRow]) {
    let mut offset = 0usize;
    for row in rows.iter_mut() {
        row.range = offset..offset + row.text.len();
        offset = row.range.end.saturating_add(1);
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_keeps_gfm_structure_and_styled_ranges() {
        let (text, content) = markdown(
            "# Title\n\n- [x] **Done** and [link](https://example.com)\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n`inline`\n",
        );
        assert!(text.contains("Title"));
        assert!(text.contains("\u{2003} Done and link"), "{text:?}");
        assert!(text.contains("A  │  B"));
        assert!(text.contains("1  │  2"));
        let RichContent::Text {
            spans,
            task_markers,
            blocks,
        } = content
        else {
            panic!("expected styled text")
        };
        assert_eq!(task_markers.len(), 1);
        assert!(task_markers[0].checked);
        assert!(
            blocks
                .iter()
                .any(|block| matches!(block.kind, MarkdownBlockKind::Table { .. }))
        );
        let rich = RichContent::Text {
            spans: spans.clone(),
            task_markers: task_markers.clone(),
            blocks,
        };
        assert!(
            rich.accessibility_text(&text, 0..text.len())
                .unwrap()
                .contains("[x] Done and link")
        );
        assert!(
            rich.copy_text(&text, 0..text.len())
                .unwrap()
                .contains("Done and link")
        );
        assert!(
            !rich
                .copy_text(&text, 0..text.len())
                .unwrap()
                .contains('\u{2003}')
        );
        assert!(
            spans.iter().any(
                |span| span.weight == Some(700.0) && text[span.range.clone()].contains("Title")
            )
        );
        assert!(
            spans
                .iter()
                .any(|span| span.underline && &text[span.range.clone()] == "link")
        );
        assert!(
            spans
                .iter()
                .any(|span| span.mono && &text[span.range.clone()] == "inline")
        );
    }

    #[test]
    fn markdown_preserves_raw_html_as_literal_text() {
        let (text, _) = markdown("Before <span>inline</span>\n\n<div>block</div>\n");
        assert!(text.contains("<span>inline</span>"));
        assert!(text.contains("<div>block</div>"));
    }

    #[test]
    fn markdown_table_uses_display_columns_and_gfm_alignment() {
        let (text, _) = markdown("| Left | Right |\n|:-----|------:|\n| 漢 | 1 |\n| x | 20 |\n");
        assert!(text.contains("漢    │"), "{text:?}");
        assert!(text.contains("x     │"), "{text:?}");
        assert!(text.contains("│      1"), "{text:?}");
    }

    #[test]
    fn code_uses_syntect_ranges_for_known_language() {
        let RichContent::Text {
            spans,
            task_markers,
            ..
        } = code("const answer = 42;\n", Some("js"), None)
        else {
            panic!("expected code spans")
        };
        assert!(task_markers.is_empty());
        assert!(
            spans
                .iter()
                .any(|span| span.syntax.is_some() && span.range.start < span.range.end)
        );
    }

    #[test]
    fn markdown_table_columns_align_with_monospace_ranges() {
        let (
            text,
            RichContent::Text {
                spans,
                task_markers,
                ..
            },
        ) = markdown("| Long | B |\n|---|---|\n| X | Wider |\n")
        else {
            panic!("expected styled table")
        };
        assert!(task_markers.is_empty());
        assert!(text.contains("Long  │  B    \nX     │  Wider"), "{text:?}");
        assert!(
            spans
                .iter()
                .any(|span| span.mono && text[span.range.clone()].contains("Wider"))
        );
    }

    #[test]
    fn markdown_long_table_cells_keep_columns_aligned_without_truncating_copy() {
        let long = "A".repeat(160);
        let source = format!("| {long} | B |\n|---|---|\n| x | Y |\n");
        let (text, _) = markdown(&source);
        let lines: Vec<_> = text.lines().collect();
        assert_eq!(lines[0].find('│'), lines[1].find('│'));
        assert!(text.contains(&long));
    }

    #[test]
    fn markdown_records_code_quote_and_table_paint_ranges_inside_one_text_leaf() {
        let (text, content) = markdown(
            "> Quoted line\n\n```ts\nconst n = 1;\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n",
        );
        let RichContent::Text { blocks, .. } = content else {
            panic!("expected one styled text leaf");
        };
        assert!(
            blocks
                .iter()
                .any(|block| matches!(block.kind, MarkdownBlockKind::Quote))
        );
        assert!(
            blocks
                .iter()
                .any(|block| matches!(block.kind, MarkdownBlockKind::Code))
        );
        assert!(
            blocks
                .iter()
                .any(|block| matches!(block.kind, MarkdownBlockKind::Table { .. }))
        );
        assert!(
            blocks
                .iter()
                .all(|block| text.get(block.range.clone()).is_some())
        );
    }

    #[test]
    fn unified_and_generated_diffs_have_word_ranges() {
        let (patch, rich) =
            diff("", Some("old word\n"), Some("new word\n"), true, &[], None).unwrap();
        assert!(patch.contains("@@"));
        let RichContent::Diff {
            rows, max_columns, ..
        } = rich
        else {
            panic!("expected diff rows")
        };
        assert!(max_columns >= "new word".chars().count());
        assert!(
            rows.iter()
                .any(|row| row.kind == DiffRowKind::Added && !row.emphasis.is_empty())
        );
        assert!(
            rows.iter()
                .any(|row| row.kind == DiffRowKind::Removed && !row.emphasis.is_empty())
        );
        assert!(diff(&patch, None, None, true, &[], None).is_ok());
        assert!(diff("", Some("same\n"), Some("same\n"), true, &[], None).is_ok());
        assert!(diff("not a patch", None, None, true, &[], None).is_err());
    }

    #[test]
    fn git_style_diff_parses_multiple_files() {
        let patch = "diff --git a/one.txt b/one.txt\n--- a/one.txt\n+++ b/one.txt\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/two.txt b/two.txt\n--- a/two.txt\n+++ b/two.txt\n@@ -1 +1 @@\n-left\n+right\n";
        let (_, RichContent::Diff { rows, .. }) = diff(patch, None, None, true, &[], None).unwrap()
        else {
            panic!("expected diff rows")
        };
        assert_eq!(
            rows.iter()
                .filter(|row| row.kind == DiffRowKind::Hunk)
                .count(),
            2
        );
        assert_eq!(
            rows.iter()
                .filter(|row| row.kind == DiffRowKind::Added)
                .count(),
            2
        );
    }

    #[test]
    fn diff_highlights_multiline_syntax_and_rename_sides_per_file() {
        let patch = "diff --git a/old.js b/new.py\n--- a/old.js\n+++ b/new.py\n@@ -1,3 +1 @@\n-const value = 1;\n-/* opening\n-continuation */\n+def value(): pass\n";
        let (_, RichContent::Diff { rows, .. }) =
            diff(patch, None, None, false, &[], None).unwrap()
        else {
            panic!("expected diff rows");
        };
        let removed_keyword = rows
            .iter()
            .find(|row| row.text == "-const value = 1;")
            .unwrap();
        assert!(
            removed_keyword
                .syntax
                .iter()
                .any(|span| span.kind == HighlightKind::Keyword
                    && span.range.start <= 1
                    && span.range.end >= 6)
        );
        let continuation = rows
            .iter()
            .find(|row| row.text == "-continuation */")
            .unwrap();
        assert!(
            continuation
                .syntax
                .iter()
                .any(|span| span.kind == HighlightKind::Comment)
        );
        let added = rows
            .iter()
            .find(|row| row.text == "+def value(): pass")
            .unwrap();
        assert!(
            added
                .syntax
                .iter()
                .any(|span| span.kind == HighlightKind::Keyword)
        );
    }

    #[test]
    fn diff_display_ranges_copy_only_content_and_keep_filtered_rows_aligned() {
        let patch = "diff --git a/demo.rs b/demo.rs\n--- a/demo.rs\n+++ b/demo.rs\n@@ -1,3 +1,3 @@\n one\n-old\n+new\n last\n";
        let (_, rich) = diff(patch, None, None, true, &[], Some(2)).unwrap();
        let display = rich.display_text().unwrap();
        let RichContent::Diff { rows, .. } = &rich else {
            panic!("expected diff rows");
        };
        assert!(rows.iter().any(|row| row.kind == DiffRowKind::ShowMore));
        for row in rows {
            assert_eq!(display.get(row.range.clone()), Some(row.text.as_str()));
        }
        let first = rows
            .iter()
            .find(|row| row.kind == DiffRowKind::Removed)
            .unwrap();
        let last = rows
            .iter()
            .find(|row| row.kind == DiffRowKind::ShowMore)
            .unwrap();
        let copied = rich
            .copy_text(&display, first.range.start..last.range.end)
            .unwrap();
        // Only the source line reaches the clipboard: no `+`/`-` marker, no
        // gutter, no hunk banner, no file name and no show-more chrome.
        assert_eq!(copied, "old");
        assert!(!copied.contains("Show"));
        assert!(!copied.contains("@@"));
        assert!(!copied.contains("demo.rs"));
    }

    #[test]
    fn diff_copy_spans_lines_and_skips_chrome() {
        let patch = "diff --git a/demo.rs b/demo.rs\n--- a/demo.rs\n+++ b/demo.rs\n@@ -1,3 +1,3 @@\n one\n-old\n+new\n last\n";
        let (_, rich) = diff(patch, None, None, false, &[], None).unwrap();
        let display = rich.display_text().unwrap();
        let RichContent::Diff { rows, .. } = &rich else {
            panic!("expected diff rows");
        };
        let span = |kind: DiffRowKind| {
            rows.iter()
                .find(|row| row.kind == kind)
                .expect("row kind present")
                .range
                .clone()
        };
        let copied = rich
            .copy_text(
                &display,
                span(DiffRowKind::Context).start..span(DiffRowKind::Removed).end,
            )
            .unwrap();
        assert_eq!(copied, "one\nold");
        let spoken = rich.accessibility_text(&display, 0..display.len()).unwrap();
        assert!(spoken.contains("context line 1: one"), "{spoken}");
        assert!(spoken.contains("removed line 2: old"), "{spoken}");
        assert!(spoken.contains("added line 2: new"), "{spoken}");
        // A selection that touches only chrome copies nothing at all.
        assert!(
            rich.copy_text(&display, 0..span(DiffRowKind::Hunk).start)
                .is_none()
        );
    }

    #[test]
    fn deleted_file_keeps_its_real_path_for_collapse_and_syntax() {
        let patch = "diff --git a/gone.rs b/gone.rs\ndeleted file mode 100644\n--- a/gone.rs\n+++ /dev/null\n@@ -1 +0,0 @@\n-let gone = true;\n";
        let (_, rich) = diff(patch, None, None, true, &[], None).unwrap();
        let RichContent::Diff { rows, .. } = rich else {
            panic!("expected diff")
        };
        let removed = rows
            .iter()
            .find(|row| row.kind == DiffRowKind::Removed)
            .unwrap();
        assert_eq!(removed.file_path.as_deref(), Some("gone.rs"));
        assert!(
            removed
                .syntax
                .iter()
                .any(|span| span.kind == HighlightKind::Keyword)
        );
        let (_, collapsed) = diff(patch, None, None, true, &["gone.rs".into()], None).unwrap();
        let RichContent::Diff { rows, .. } = collapsed else {
            panic!("expected diff")
        };
        assert!(!rows.iter().any(|row| row.kind == DiffRowKind::Removed));
    }

    #[test]
    fn git_quoted_paths_and_unidiff_headers_decode_spaces() {
        assert_eq!(
            git_path("diff --git \"a/old name.rs\" \"b/new name.rs\""),
            Some("new name.rs".into())
        );
        assert_eq!(
            git_path("+++ \"b/new name.rs\""),
            Some("new name.rs".into())
        );
        assert_eq!(
            old_path("--- \"a/old name.rs\""),
            Some("old name.rs".into())
        );
        assert_eq!(
            git_path("diff --git \"a/espa\\303\\247o.rs\" \"b/espa\\303\\247o.rs\""),
            Some("espaço.rs".into())
        );
    }

    #[test]
    fn diff_width_counts_wide_graphemes_and_tab_stops() {
        assert_eq!(display_columns("漢"), 2);
        assert_eq!(display_columns("a\tb"), 5);
        assert_eq!(display_columns("👩‍💻"), 2);
    }

    #[test]
    fn unquoted_git_paths_with_spaces_split_on_the_last_b_slash() {
        // Git does not quote a path just because it has a space, so the naive
        // "split on the first whitespace" parse truncates the name to "my".
        assert_eq!(
            git_path("diff --git a/my file.txt b/my file.txt"),
            Some("my file.txt".into())
        );
        assert_eq!(
            git_path("diff --git a/src/my notes.md b/src/my notes.md"),
            Some("src/my notes.md".into())
        );
        assert_eq!(
            git_path("diff --git a/only.txt only.txt"),
            Some("only.txt".into())
        );
    }

    #[test]
    fn word_diff_isolates_the_changed_token_only() {
        let (old, new) = word_diff("const b = 2", "const b = 3");
        assert_eq!(old.len(), 1);
        assert_eq!(new.len(), 1);
        assert_eq!(&"const b = 2"[old[0].clone()], "2");
        assert_eq!(&"const b = 3"[new[0].clone()], "3");
        // Punctuation is its own token, so only the argument is highlighted.
        let (old, new) = word_diff("call(x)", "call(y)");
        assert_eq!(&"call(x)"[old[0].clone()], "x");
        assert_eq!(&"call(y)"[new[0].clone()], "y");
        assert!(word_diff("same", "same").0.is_empty());
    }

    #[test]
    fn word_diff_pairs_only_runs_of_equal_length() {
        // One deletion and three insertions: pairing by index would compare the
        // removed line against an unrelated addition and paint a wrong answer.
        let patch = "diff --git a/demo.rs b/demo.rs\n--- a/demo.rs\n+++ b/demo.rs\n@@ -1,2 +1,4 @@\n one\n-gone\n+alpha\n+beta\n+gamma\n";
        let (_, rich) = diff(patch, None, None, true, &[], None).unwrap();
        let RichContent::Diff { rows, .. } = rich else {
            panic!("expected diff")
        };
        let removed = rows
            .iter()
            .find(|row| row.kind == DiffRowKind::Removed)
            .unwrap();
        assert!(removed.emphasis.is_empty());
        // Equal-length runs still get the highlight.
        let patch = "diff --git a/demo.rs b/demo.rs\n--- a/demo.rs\n+++ b/demo.rs\n@@ -1,2 +1,2 @@\n one\n-gone value\n+new value\n";
        let (_, rich) = diff(patch, None, None, true, &[], None).unwrap();
        let RichContent::Diff { rows, .. } = rich else {
            panic!("expected diff")
        };
        let removed = rows
            .iter()
            .find(|row| row.kind == DiffRowKind::Removed)
            .unwrap();
        assert!(!removed.emphasis.is_empty());
    }

    #[test]
    fn diff_reports_added_deleted_renamed_and_binary_files() {
        let patch = concat!(
            "diff --git a/new.rs b/new.rs\nnew file mode 100644\n--- /dev/null\n+++ b/new.rs\n@@ -0,0 +1 @@\n+added\n",
            "diff --git a/gone.rs b/gone.rs\ndeleted file mode 100644\n--- a/gone.rs\n+++ /dev/null\n@@ -1 +0,0 @@\n-removed\n",
            "diff --git a/old.rs b/new-name.rs\nrename from old.rs\nrename to new-name.rs\n--- a/old.rs\n+++ b/new-name.rs\n@@ -1 +1 @@\n-a\n+b\n",
            "diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n",
        );
        let (_, rich) = diff(patch, None, None, false, &[], None).unwrap();
        let RichContent::Diff { rows, files, .. } = rich else {
            panic!("expected diff")
        };
        assert_eq!(files.len(), 4);
        assert_eq!(files[0].status, DiffFileStatus::Added);
        assert_eq!(files[1].status, DiffFileStatus::Deleted);
        // A deleted file has no `+++` side, so it keeps its own path.
        assert_eq!(files[1].path, "gone.rs");
        assert_eq!(files[2].status, DiffFileStatus::Renamed);
        assert_eq!(files[2].path, "new-name.rs");
        assert_eq!(files[2].old_path.as_deref(), Some("old.rs"));
        assert!(files[3].binary);
        let notices: Vec<_> = rows
            .iter()
            .filter(|row| row.kind == DiffRowKind::Notice)
            .map(|row| row.text.as_str())
            .collect();
        assert!(notices.contains(&"New file"), "{notices:?}");
        assert!(notices.contains(&"Deleted file"), "{notices:?}");
        assert!(notices.contains(&"Renamed from old.rs"), "{notices:?}");
        assert!(
            notices.iter().any(|notice| notice.contains("Binary file")),
            "{notices:?}"
        );
        // `index`, mode and other plumbing lines are never painted.
        assert!(!rows.iter().any(|row| row.text.starts_with("index ")));
    }

    #[test]
    fn each_file_sizes_its_own_gutter() {
        let patch = concat!(
            "diff --git a/small.rs b/small.rs\n--- a/small.rs\n+++ b/small.rs\n@@ -1 +1 @@\n-a\n+b\n",
            "diff --git a/big.rs b/big.rs\n--- a/big.rs\n+++ b/big.rs\n@@ -90000 +90000 @@\n-c\n+d\n",
        );
        let (_, rich) = diff(patch, None, None, false, &[], None).unwrap();
        let RichContent::Diff { rows, .. } = rich else {
            panic!("expected diff")
        };
        let digits = |path: &str| {
            rows.iter()
                .find(|row| row.file_path.as_deref() == Some(path) && row.kind.is_content())
                .map(|row| row.gutter_digits)
        };
        assert_eq!(digits("small.rs"), Some(1));
        assert_eq!(digits("big.rs"), Some(5));
    }

    #[test]
    fn max_lines_is_a_whole_patch_preview_that_reports_the_remainder() {
        let patch = concat!(
            "diff --git a/one.txt b/one.txt\n--- a/one.txt\n+++ b/one.txt\n@@ -1,2 +1,2 @@\n-a\n+b\n c\n",
            "diff --git a/two.txt b/two.txt\n--- a/two.txt\n+++ b/two.txt\n@@ -1,2 +1,2 @@\n-d\n+e\n f\n",
        );
        let (_, rich) = diff(patch, None, None, false, &[], Some(1)).unwrap();
        let RichContent::Diff { rows, .. } = rich else {
            panic!("expected diff")
        };
        let content = rows.iter().filter(|row| row.kind.is_content()).count();
        assert_eq!(content, 1, "the budget is spent after one line");
        let show_more = rows
            .iter()
            .find(|row| row.kind == DiffRowKind::ShowMore)
            .expect("a show-more row");
        // The patch holds six content rows and the budget is one, so five were
        // cut: the rest of the first file plus both lines of the second.
        assert_eq!(show_more.hidden_lines, Some(5));
        // The show-more row names its file so the click event can report it.
        assert_eq!(show_more.file_path.as_deref(), Some("one.txt"));
        // A file the budget never reached is not emitted at all.
        assert!(!rows.iter().any(|row| row.text.contains("two.txt")));
    }

    #[test]
    fn a_truncated_patch_keeps_what_parsed() {
        // `git diff` is a stream: a half-written patch must still render.
        let patch = "diff --git a/demo.rs b/demo.rs\n--- a/demo.rs\n+++ b/demo.rs\n@@ -1,3 +1,3 @@\n one\n-old\n";
        let (_, rich) = diff(patch, None, None, false, &[], None).unwrap();
        let RichContent::Diff { rows, .. } = rich else {
            panic!("expected diff")
        };
        assert!(rows.iter().any(|row| row.kind == DiffRowKind::Context));
        assert!(rows.iter().any(|row| row.kind == DiffRowKind::Removed));
        // Text with no hunk at all is still an error worth reporting.
        assert!(diff("not a patch at all", None, None, false, &[], None).is_err());
        assert!(diff("", None, None, false, &[], None).is_ok());
    }
}
