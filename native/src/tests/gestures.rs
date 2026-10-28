use super::*;

#[test]
fn pinch_reports_a_cumulative_scale_to_the_pinchable_ancestor() {
    let mut map = node(
        "map",
        "view",
        json!({"width":200,"height":100}),
        vec![node(
            "tile",
            "view",
            json!({"width":50,"height":50}),
            vec![],
        )],
    );
    map.pinch = true;
    let mut tree = Tree::new(root(vec![map]));
    tree.compute(240.0, 140.0).unwrap();
    tree.pointer_move(20.0, 20.0);
    let start = tree.pinch("start", 0.0);
    assert_eq!(
        start,
        vec![json!({"type":"pinch", "id":"map", "phase":"start", "scale":1.0, "x":20.0, "y":20.0})]
    );
    tree.pinch("move", 1.0);
    let moved = tree.pinch("move", -0.25);
    assert_eq!(moved[0]["scale"], 1.5);
    assert_eq!(tree.pinch("end", 0.0)[0]["phase"], "end");
    // Nothing pinchable under the pointer: no events.
    tree.pointer_move(220.0, 120.0);
    assert!(tree.pinch("start", 0.0).is_empty());
    assert!(tree.pinch("move", 0.5).is_empty());
}

#[test]
fn right_click_emits_context_event_with_pointer_position() {
    let target = node(
        "target",
        "pressable",
        json!({"width":100,"height":40}),
        vec![],
    );
    let mut tree = Tree::new(root(vec![target]));
    tree.compute(200.0, 100.0).unwrap();
    tree.pointer_move(24.0, 16.0);
    let events = tree.pointer_context();
    assert_eq!(events[0]["type"], "context");
    assert_eq!(events[0]["id"], "target");
    assert_eq!(events[0]["x"], 24.0);
    assert_eq!(events[0]["y"], 16.0);
}
