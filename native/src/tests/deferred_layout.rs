//! A layout that leaves offscreen text changes for after the frame (`defer_offscreen`,
//! `finish_deferred_layout`) ends exactly where a whole layout does.
use super::*;

fn list(label: &dyn Fn(usize) -> String) -> Node {
    let rows = (0..60)
        .map(|i| {
            let mut text = node(
                &format!("t{i}"),
                "text",
                json!({"flex":1,"fontSize":14}),
                vec![],
            );
            text.text = label(i);
            let mut button = node(
                &format!("b{i}"),
                "button",
                json!({"height":28,"shrink":0}),
                vec![],
            );
            button.text = "Open".into();
            node(
                &format!("r{i}"),
                "row",
                json!({"direction":"row","align":"center","gap":12,"height":36,"shrink":0}),
                vec![text, button],
            )
        })
        .collect();
    let column = node("c", "column", json!({"direction":"column"}), rows);
    let scroll = node("s", "scroll", json!({"flex":1,"minHeight":0}), vec![column]);
    root(vec![node(
        "main",
        "column",
        json!({"direction":"column","flex":1}),
        vec![scroll],
    )])
}

fn texts(label: &dyn Fn(usize) -> String) -> Vec<Node> {
    (0..60)
        .map(|i| {
            let mut text = node(
                &format!("t{i}"),
                "text",
                json!({"flex":1,"fontSize":14}),
                vec![],
            );
            text.text = label(i);
            text
        })
        .collect()
}

fn rects(tree: &Tree) -> Vec<(String, [i64; 4])> {
    let mut out: Vec<_> = tree
        .entries
        .iter()
        .map(|(id, entry)| {
            let r = entry.rect;
            (
                id.clone(),
                [r.x0, r.y0, r.x1, r.y1].map(|v| (v * 100.0).round() as i64),
            )
        })
        .collect();
    out.sort();
    out
}

#[test]
fn offscreen_texts_lay_out_after_the_frame_as_a_whole_layout_would() {
    let first = |i: usize| format!("Record {i}");
    let mut whole = Tree::new(list(&first));
    let mut deferred = Tree::new(list(&first));
    for tree in [&mut whole, &mut deferred] {
        tree.compute(400.0, 300.0).unwrap();
        tree.scene(1.0);
    }
    // Every label changes, some wrapping onto a second line inside their row.
    let second = |i: usize| {
        if i.is_multiple_of(7) {
            "a much longer label that no longer fits on the single line of its row".repeat(2)
        } else {
            format!("Record {i}: changed")
        }
    };
    whole.patch(texts(&second)).unwrap();
    deferred.patch(texts(&second)).unwrap();
    whole.compute(400.0, 300.0).unwrap();
    deferred.defer_offscreen = true;
    deferred.compute(400.0, 300.0).unwrap();
    deferred.defer_offscreen = false;
    // Rows below the window wait; the visible ones are laid out already.
    assert!(!deferred.deferred_boundaries.is_empty());
    assert!(!deferred.deferred_boundaries.contains(&"r0".to_string()));
    assert!(deferred.deferred_boundaries.contains(&"r50".to_string()));
    let visible = |tree: &Tree| tree.entries["t1"].rect;
    assert_eq!(visible(&whole), visible(&deferred));
    assert!(deferred.finish_deferred_layout().unwrap());
    assert!(!deferred.finish_deferred_layout().unwrap());
    assert_eq!(rects(&whole), rects(&deferred));
    for i in [0, 7, 49, 56] {
        let id = format!("t{i}");
        assert_eq!(
            whole.text.measure(&id, None),
            deferred.text.measure(&id, None),
            "{id}"
        );
    }
    // A scroll after it shows the new texts.
    deferred.scene(1.0);
}

#[test]
fn a_compute_lays_out_what_was_deferred_before_anything_new() {
    let first = |i: usize| format!("Record {i}");
    let mut tree = Tree::new(list(&first));
    tree.compute(400.0, 300.0).unwrap();
    tree.patch(texts(&|i| format!("Second {i}"))).unwrap();
    tree.defer_offscreen = true;
    tree.compute(400.0, 300.0).unwrap();
    tree.defer_offscreen = false;
    assert!(!tree.deferred_boundaries.is_empty());
    tree.patch(texts(&|i| format!("Third {i}"))).unwrap();
    tree.compute(400.0, 300.0).unwrap();
    assert!(tree.deferred_boundaries.is_empty() && tree.deferred_texts.is_empty());
    let mut fresh = Tree::new(list(&|i| format!("Third {i}")));
    fresh.compute(400.0, 300.0).unwrap();
    assert_eq!(rects(&tree), rects(&fresh));
}

#[test]
fn texts_far_offscreen_drop_their_layouts_and_paint_the_same_when_back() {
    let label = |i: usize| format!("Record {i}");
    let mut tree = Tree::new(list(&label));
    tree.compute(400.0, 300.0).unwrap();
    tree.scene(1.0);
    let rects_before = rects(&tree);
    assert!(tree.evict_offscreen_texts());
    // Rows on screen (and a window's height around) keep theirs; the far ones are dropped.
    assert!(tree.text.layouts.contains_key("t0"));
    assert!(!tree.text.layouts.contains_key("t55"));
    assert!(tree.text.evicted.contains_key("t55"));
    // Nothing new shaped: a second call does nothing.
    assert!(!tree.evict_offscreen_texts());
    // A whole layout answers from the kept sizes and leaves every box where it was.
    tree.dirty.full = true;
    tree.dirty.layout = true;
    tree.compute(400.0, 300.0).unwrap();
    assert_eq!(rects(&tree), rects_before);
    assert!(
        !tree.text.layouts.contains_key("t55"),
        "sizes came from the cache"
    );
    // Scrolled to the end, the dropped rows shape again and paint like a tree that never dropped them.
    let mut fresh = Tree::new(list(&label));
    fresh.compute(400.0, 300.0).unwrap();
    for tree in [&mut tree, &mut fresh] {
        tree.scroll_to_2d("s", 0.0, 10_000.0);
        tree.compute(400.0, 300.0).unwrap();
        tree.scene(1.0);
    }
    assert!(tree.text.layouts.contains_key("t55"));
    assert_eq!(rects(&tree), rects(&fresh));
    // A new text in a dropped row measures right.
    tree.patch(texts(&|i| {
        if i == 2 {
            "a much longer label that wraps inside its row ".repeat(3)
        } else {
            label(i)
        }
    }))
    .unwrap();
    fresh
        .patch(texts(&|i| {
            if i == 2 {
                "a much longer label that wraps inside its row ".repeat(3)
            } else {
                label(i)
            }
        }))
        .unwrap();
    tree.compute(400.0, 300.0).unwrap();
    fresh.compute(400.0, 300.0).unwrap();
    assert_eq!(rects(&tree), rects(&fresh));
}

#[test]
fn a_document_style_table_gives_nodes_their_styles() {
    let json = r##"{"styles":[{"background":"#fff"},{"flex":1,"fontSize":14}],"version":64,
        "window":{"title":"w","width":100.0,"height":100.0,"minWidth":10.0,"minHeight":10.0,"background":"#fff"},
        "root":{"id":"root","kind":"window","style":0,"children":[
          {"id":"a","kind":"text","style":1,"children":[],"text":"a","runs":[{"start":0,"end":1,"style":{"fontWeight":700}}]},
          {"id":"b","kind":"text","style":{"flex":1,"fontSize":14},"children":[],"text":"b"}]}}"##;
    let document: crate::protocol::Document = serde_json::from_str(json).unwrap();
    crate::protocol::clear_style_table();
    let root = &document.root;
    assert_eq!(root.style["background"], json!("#fff"));
    assert_eq!(root.children[0].style["fontSize"], json!(14));
    // Equal styles are one (interned) whether written by index or inline.
    assert!(std::sync::Arc::ptr_eq(
        root.children[0].style.shared(),
        root.children[1].style.shared()
    ));
    assert_eq!(root.children[0].runs[0]["style"]["fontWeight"], json!(700));
    // An index past the table is an error, not a default style.
    let bad = json.replace(r#""style":1"#, r#""style":7"#);
    assert!(serde_json::from_str::<crate::protocol::Document>(&bad).is_err());
    crate::protocol::clear_style_table();
}
