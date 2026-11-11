//! CSS `align-items: baseline`: text lines up by its first line's baseline, not its bottom edge.
use super::*;

fn text(id: &str, value: &str, style: serde_json::Value) -> Node {
    let mut text = node(id, "text", style, vec![]);
    text.text = value.into();
    text
}

/// Lays `children` out in a baseline-aligned row and returns each one's baseline in window space.
fn baselines(children: Vec<Node>) -> Vec<f64> {
    let ids: Vec<String> = children.iter().map(|child| child.id.clone()).collect();
    let row = node(
        "row",
        "row",
        json!({"gap": 10, "align": "baseline"}),
        children,
    );
    let mut tree = Tree::new(root(vec![row]));
    tree.compute(600.0, 400.0).unwrap();
    ids.iter()
        .map(|id| {
            let entry = &tree.entries[id.as_str()];
            let top = entry.rect.y0;
            let padding = entry
                .node
                .style
                .get("padding")
                .and_then(|p| p.get("top"))
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(0.0);
            top + padding + f64::from(tree.text.first_baseline(id).expect("text has a first line"))
        })
        .collect()
}

fn assert_aligned(case: &str, lines: &[f64]) {
    for line in &lines[1..] {
        assert!(
            (line - lines[0]).abs() < 0.5,
            "{case}: baselines differ: {lines:?}"
        );
    }
}

#[test]
fn baseline_row_lines_up_different_text_sizes() {
    assert_aligned(
        "20 next to 13",
        &baselines(vec![
            text(
                "big",
                "Known hosts",
                json!({"fontSize": 20, "fontWeight": 650}),
            ),
            text("small", "2", json!({"fontSize": 13})),
        ]),
    );
    assert_aligned(
        "32 next to 12",
        &baselines(vec![
            text("title", "Title", json!({"fontSize": 32})),
            text("count", "12 items", json!({"fontSize": 12})),
        ]),
    );
}

#[test]
fn baseline_row_keeps_padded_texts_on_one_baseline() {
    // Bottom-edge alignment would lift the text with bottom padding by 8px.
    for padding in [
        json!({"top": 8}),
        json!({"bottom": 8}),
        json!({"top": 4, "bottom": 12}),
    ] {
        assert_aligned(
            &format!("padding {padding}"),
            &baselines(vec![
                text("padded", "A", json!({"fontSize": 16, "padding": padding})),
                text("plain", "B", json!({"fontSize": 16})),
            ]),
        );
    }
}

#[test]
fn baseline_row_uses_the_first_line_of_wrapped_text() {
    let lines = baselines(vec![
        text(
            "wrapped",
            "a long wrapped label",
            json!({"fontSize": 16, "width": 60}),
        ),
        text("x", "x", json!({"fontSize": 16})),
    ]);
    assert_aligned("wrapped", &lines);
}
