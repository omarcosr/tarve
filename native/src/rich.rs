//! Parsed, styled content for native rich leaves. No TSX descendants are created.
use crate::syntax::{self, HighlightKind};
use comrak::{
    Arena, Options,
    nodes::{AstNode, ListType, NodeValue, TableAlignment},
    parse_document,
};
use diffy::patch_set::{ParseOptions, PatchSet};
use similar::{ChangeTag, TextDiff};
use std::{collections::HashMap, ops::Range};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

#[derive(Clone, Debug, PartialEq)]
pub struct Span {
    pub range: Range<usize>,
    pub size: Option<f32>,
    pub weight: Option<f32>,
    pub italic: bool,
    pub mono: bool,
    pub font_family: Option<String>,
    pub tone: Option<String>,
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
            tone: None,
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
    Hunk,
    Context,
    Added,
    Removed,
    Meta,
    ShowMore,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiffRow {
    pub text: String,
    pub range: Range<usize>,
    pub kind: DiffRowKind,
    pub emphasis: Vec<Range<usize>>,
    pub syntax: Vec<syntax::HighlightSpan>,
    pub old_line: Option<u32>,
    pub new_line: Option<u32>,
    pub file_path: Option<String>,
    pub hidden_lines: Option<usize>,
    pub file_header: bool,
}

impl DiffRow {
    pub fn content_offset(&self) -> usize {
        usize::from(matches!(
            self.kind,
            DiffRowKind::Added | DiffRowKind::Removed | DiffRowKind::Context
        ))
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
    let align_columns = widths
        .iter()
        .try_fold(0usize, |sum, width| sum.checked_add(*width))
        .and_then(|width| width.checked_mul(rows.len()))
        .is_some_and(|bytes| bytes <= 4 * 1024 * 1024);
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
            writer.push("│ ");
            let start = writer.text.len();
            render_children(node, writer, depth + 1);
            let mut span = Span::at(start..writer.text.len());
            span.italic = true;
            span.tone = Some("#64748b".into());
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
            span.tone = Some("#334155".into());
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
            span.tone = Some("#be185d".into());
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
                    span.tone = Some("#0969da".into());
                    span.href = Some(link.url);
                }
                NodeValue::Image(_) => {
                    span.tone = Some("#64748b".into());
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

    /// Text exposed to copy/selection consumers. Task markers are paint-only decoration.
    pub fn copy_text(&self, text: &str, range: Range<usize>) -> Option<String> {
        self.map_task_markers(text, range, |_| "", true)
    }

    /// Text exposed to assistive technology keeps task state without depending on symbol glyphs.
    pub fn accessibility_text(&self, text: &str, range: Range<usize>) -> Option<String> {
        self.map_task_markers(
            text,
            range,
            |checked| if checked { "[x]" } else { "[ ]" },
            false,
        )
    }

    pub fn display_text(&self) -> Option<String> {
        let RichContent::Diff { rows, .. } = self else {
            return None;
        };
        Some(
            rows.iter()
                .map(|row| row.text.as_str())
                .collect::<Vec<_>>()
                .join("\n"),
        )
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

fn emphasize_pair(old: &mut DiffRow, new: &mut DiffRow) {
    let old_body = old.text.strip_prefix('-').unwrap_or(&old.text);
    let new_body = new.text.strip_prefix('+').unwrap_or(&new.text);
    if old_body.len() > 65_536 || new_body.len() > 65_536 {
        return;
    }
    let diff = TextDiff::from_words(old_body, new_body);
    let (mut old_at, mut new_at) = (1, 1);
    for change in diff.iter_all_changes() {
        let len = change.value().len();
        match change.tag() {
            ChangeTag::Equal => {
                old_at += len;
                new_at += len;
            }
            ChangeTag::Delete => {
                old.emphasis.push(old_at..old_at + len);
                old_at += len;
            }
            ChangeTag::Insert => {
                new.emphasis.push(new_at..new_at + len);
                new_at += len;
            }
        }
    }
}

fn parse_hunk_starts(line: &str) -> Option<(u32, u32)> {
    let body = line.strip_prefix("@@ -")?;
    let (old, rest) = body.split_once(" +")?;
    let (new, _) = rest.split_once(" @@")?;
    let parse = |value: &str| value.split(',').next()?.parse::<u32>().ok();
    Some((parse(old)?, parse(new)?))
}

fn git_path(line: &str) -> Option<String> {
    if let Some(rest) = line.strip_prefix("diff --git ") {
        let (_, rest) = git_path_token(rest)?;
        let (right, _) = git_path_token(rest.trim_start())?;
        return Some(right.strip_prefix("b/").unwrap_or(&right).to_string());
    }
    let (path, _) = git_path_token(line.strip_prefix("+++ ")?.trim())?;
    Some(path.strip_prefix("b/").unwrap_or(&path).to_string())
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
    Some(path.strip_prefix("a/").unwrap_or(&path).to_string())
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

fn highlight_diff_rows(rows: &mut [DiffRow], old_paths: &HashMap<String, String>) {
    let mut start = 0;
    while start < rows.len() {
        let Some(path) = rows[start].file_path.clone() else {
            start += 1;
            continue;
        };
        let mut end = start + 1;
        while end < rows.len() && rows[end].file_path.as_deref() == Some(path.as_str()) {
            end += 1;
        }
        let file = &mut rows[start..end];
        highlight_diff_side(
            file,
            old_paths.get(&path).map(String::as_str).unwrap_or(&path),
            true,
        );
        highlight_diff_side(file, &path, false);
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
        (Some(old), Some(new)) => diffy::create_patch(old, new).to_string(),
        _ => source.to_string(),
    };
    let format = if patch.starts_with("diff --git ") {
        ParseOptions::gitdiff()
    } else {
        ParseOptions::unidiff()
    };
    for file in PatchSet::parse(&patch, format) {
        file.map_err(|error| error.to_string())?;
    }
    let mut rows = Vec::<DiffRow>::new();
    let mut current_path: Option<String> = None;
    let mut current_old_path: Option<String> = None;
    let mut old_paths = HashMap::new();
    let mut old_line = None::<u32>;
    let mut new_line = None::<u32>;
    let mut max_line_number = 0u32;
    let mut file_header: Option<usize> = None;
    let mut file_additions = 0usize;
    let mut file_deletions = 0usize;

    let finalize_file =
        |rows: &mut [DiffRow], header: Option<usize>, additions: usize, deletions: usize| {
            if let Some(index) = header
                && let Some(row) = rows.get_mut(index)
            {
                row.text = format!("{}    +{additions} −{deletions}", row.text);
            }
        };

    for raw in patch.lines() {
        let line = raw.trim_end_matches('\r');
        if line.starts_with("diff --git ") {
            finalize_file(&mut rows, file_header, file_additions, file_deletions);
            file_additions = 0;
            file_deletions = 0;
            current_path = git_path(line);
            current_old_path = None;
            let path = current_path.clone().unwrap_or_else(|| line.to_string());
            file_header = Some(rows.len());
            rows.push(DiffRow {
                text: path,
                range: 0..0,
                kind: DiffRowKind::Header,
                emphasis: Vec::new(),
                syntax: Vec::new(),
                old_line: None,
                new_line: None,
                file_path: current_path.clone(),
                hidden_lines: None,
                file_header: true,
            });
            continue;
        }
        if line.starts_with("--- ") {
            current_old_path = old_path(line);
        }
        if line.starts_with("+++ ") {
            current_path = git_path(line)
                .filter(|path| path != "/dev/null")
                .or(current_path)
                .or_else(|| current_old_path.clone());
            if let (Some(path), Some(old)) = (&current_path, &current_old_path) {
                old_paths.insert(path.clone(), old.clone());
            }
        }
        if let Some((old, new)) = parse_hunk_starts(line) {
            old_line = Some(old);
            new_line = Some(new);
        }
        let kind = diff_kind(line);
        let (row_old, row_new) = match kind {
            DiffRowKind::Removed => {
                let current = old_line;
                old_line = old_line.map(|line| line.saturating_add(1));
                file_deletions += 1;
                (current, None)
            }
            DiffRowKind::Added => {
                let current = new_line;
                new_line = new_line.map(|line| line.saturating_add(1));
                file_additions += 1;
                (None, current)
            }
            DiffRowKind::Context => {
                let old = old_line;
                let new = new_line;
                old_line = old_line.map(|line| line.saturating_add(1));
                new_line = new_line.map(|line| line.saturating_add(1));
                (old, new)
            }
            _ => (None, None),
        };
        max_line_number = max_line_number
            .max(row_old.unwrap_or(0))
            .max(row_new.unwrap_or(0));
        let row = DiffRow {
            text: line.to_string(),
            range: 0..0,
            kind,
            emphasis: Vec::new(),
            syntax: Vec::new(),
            old_line: row_old,
            new_line: row_new,
            file_path: current_path.clone(),
            hidden_lines: None,
            file_header: false,
        };
        rows.push(row);
    }
    finalize_file(&mut rows, file_header, file_additions, file_deletions);
    highlight_diff_rows(&mut rows, &old_paths);
    let mut index = 0;
    while word_diff && index < rows.len() {
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
        let count = (added_start - removed_start).min(index - added_start);
        for offset in 0..count {
            let (left, right) = rows.split_at_mut(added_start + offset);
            emphasize_pair(&mut left[removed_start + offset], &mut right[0]);
        }
    }
    if !collapsed_paths.is_empty() || max_lines.is_some() {
        let mut filtered = Vec::with_capacity(rows.len());
        let mut current_file: Option<String> = None;
        let mut collapsed = false;
        let mut visible_lines = 0usize;
        let mut hidden_lines = 0usize;
        let flush_hidden =
            |filtered: &mut Vec<DiffRow>, file: &Option<String>, hidden: &mut usize| {
                if *hidden == 0 {
                    return;
                }
                filtered.push(DiffRow {
                    text: format!("Show {} more lines", *hidden),
                    range: 0..0,
                    kind: DiffRowKind::ShowMore,
                    emphasis: Vec::new(),
                    syntax: Vec::new(),
                    old_line: None,
                    new_line: None,
                    file_path: file.clone(),
                    hidden_lines: Some(*hidden),
                    file_header: false,
                });
                *hidden = 0;
            };
        for row in rows {
            let file_changed = row.file_path != current_file && row.file_path.is_some();
            if file_changed {
                flush_hidden(&mut filtered, &current_file, &mut hidden_lines);
                current_file = row.file_path.clone();
                collapsed = current_file
                    .as_ref()
                    .is_some_and(|path| collapsed_paths.iter().any(|candidate| candidate == path));
                visible_lines = 0;
            }
            if row.kind == DiffRowKind::Header && row.file_path.is_some() {
                filtered.push(row);
                continue;
            }
            if collapsed {
                continue;
            }
            if matches!(
                row.kind,
                DiffRowKind::Added | DiffRowKind::Removed | DiffRowKind::Context
            ) {
                if max_lines.is_some_and(|limit| visible_lines >= limit) {
                    hidden_lines += 1;
                    continue;
                }
                visible_lines += 1;
            }
            filtered.push(row);
        }
        flush_hidden(&mut filtered, &current_file, &mut hidden_lines);
        rows = filtered;
    }
    let mut text_offset = 0usize;
    for row in &mut rows {
        row.range = text_offset..text_offset + row.text.len();
        text_offset = row.range.end.saturating_add(1);
    }
    let max_columns = rows
        .iter()
        .map(|row| display_columns(row.content_text()))
        .max()
        .unwrap_or(0);
    Ok((
        patch,
        RichContent::Diff {
            rows,
            max_columns,
            max_line_number,
        },
    ))
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
        assert_eq!(copied, display[first.range.start..last.range.end]);
        assert!(!copied.contains("diff --git"));
        assert!(!copied.contains("@@ -1"));
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
}
