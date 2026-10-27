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
        spans
            .iter()
            .any(|span| span.weight == Some(700.0) && text[span.range.clone()].contains("Title"))
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
    let (text, content) =
        markdown("> Quoted line\n\n```ts\nconst n = 1;\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n");
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
    let (patch, rich) = diff("", Some("old word\n"), Some("new word\n"), true, &[], None).unwrap();
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
    let (_, RichContent::Diff { rows, .. }) = diff(patch, None, None, false, &[], None).unwrap()
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
    // Ranges index the row text, marker included: the painter slices it so.
    assert_eq!(&removed.text[removed.emphasis[0].clone()], "gone");
    let added = rows
        .iter()
        .find(|row| row.kind == DiffRowKind::Added)
        .unwrap();
    assert_eq!(&added.text[added.emphasis[0].clone()], "new");
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
