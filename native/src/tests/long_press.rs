use super::*;

fn long_press_tree() -> Tree {
    let mut target = node(
        "hold",
        "pressable",
        json!({"width":100,"height":40}),
        vec![node("label", "text", json!({}), vec![])],
    );
    target.long_press = true;
    let mut tree = Tree::new(root(vec![target]));
    tree.compute(200.0, 100.0).unwrap();
    tree.pointer_move(20.0, 20.0);
    tree
}

#[test]
fn held_press_long_presses_and_its_release_does_not_click() {
    let mut tree = long_press_tree();
    tree.pointer_down();
    assert!(tree.long_press_pending());
    let events = tree.fire_long_press();
    assert_eq!(events, vec![json!({"type":"longPress", "id":"hold"})]);
    assert!(
        tree.pointer_up()
            .iter()
            .all(|event| event["type"] != "click")
    );
    // The next tap clicks again.
    tree.pointer_down();
    let up = tree.pointer_up();
    assert_eq!(up[0]["type"], "click");
    assert!(
        !tree.long_press_pending(),
        "a release ends the pending long press"
    );
}

#[test]
fn a_press_that_travels_is_not_a_long_press() {
    let mut tree = long_press_tree();
    tree.pointer_down();
    tree.pointer_move(23.0, 22.0);
    assert!(tree.long_press_pending(), "small jitter keeps it");
    tree.pointer_move(40.0, 20.0);
    assert!(!tree.long_press_pending());
    assert!(tree.fire_long_press().is_empty());
}

#[test]
fn presses_without_long_press_handlers_never_wait() {
    let target = node("tap", "pressable", json!({"width":100,"height":40}), vec![]);
    let mut tree = Tree::new(root(vec![target]));
    tree.compute(200.0, 100.0).unwrap();
    tree.pointer_move(20.0, 20.0);
    tree.pointer_down();
    assert!(!tree.long_press_pending());
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
