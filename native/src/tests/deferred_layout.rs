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
            let mut button = node(&format!("b{i}"), "button", json!({"height":28,"shrink":0}), vec![]);
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
    root(vec![node("main", "column", json!({"direction":"column","flex":1}), vec![scroll])])
}

fn texts(label: &dyn Fn(usize) -> String) -> Vec<Node> {
    (0..60)
        .map(|i| {
            let mut text = node(&format!("t{i}"), "text", json!({"flex":1,"fontSize":14}), vec![]);
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
            (id.clone(), [r.x0, r.y0, r.x1, r.y1].map(|v| (v * 100.0).round() as i64))
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
        if i % 7 == 0 {
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
        assert_eq!(whole.text.measure(&id, None), deferred.text.measure(&id, None), "{id}");
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
