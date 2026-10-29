//! CSS inheritance in the native tree: pointer-events, currentColor, percent transforms.
use super::*;

#[test]
fn pointer_events_inherit_so_an_auto_child_of_a_none_parent_takes_the_pointer() {
    let video = node(
        "video",
        "pressable",
        json!({"width": 300, "height": 200}),
        vec![],
    );
    let volume = node(
        "volume",
        "pressable",
        json!({"width": 40, "height": 40, "pointerEvents": "auto"}),
        vec![],
    );
    let label = node(
        "label",
        "pressable",
        json!({"width": 40, "height": 40}),
        vec![],
    );
    let bar = node(
        "bar",
        "row",
        json!({"position": "absolute", "left": 0, "top": 0, "width": 300, "height": 40, "pointerEvents": "none"}),
        vec![volume, label],
    );
    let stack = node(
        "stack",
        "view",
        json!({"position": "relative", "width": 300, "height": 200}),
        vec![video, bar],
    );
    let mut tree = Tree::new(root(vec![stack]));
    tree.compute(400.0, 400.0).unwrap();
    tree.pointer_move(20.0, 20.0);
    assert_eq!(
        tree.hovered.as_deref(),
        Some("volume"),
        "auto re-enables the child"
    );
    assert!(
        tree.hover_path().contains(&"bar".to_string()),
        "its muted parent is :hover too"
    );
    tree.pointer_move(60.0, 20.0);
    assert_eq!(
        tree.hovered.as_deref(),
        Some("video"),
        "a child without a value inherits none"
    );
    tree.pointer_move(200.0, 20.0);
    assert_eq!(
        tree.hovered.as_deref(),
        Some("video"),
        "the muted bar itself falls through"
    );
}

#[test]
fn current_color_foreground_follows_the_nearest_ancestor_and_its_hover() {
    let root: Node = serde_json::from_value(json!({
        "id":"root","kind":"window","style":{},"children":[
            {
                "id":"button","kind":"pressable",
                "style":{"width":180,"height":36,"foreground":"#71717a","hover":{"foreground":"#ffffff"}},
                "children":[
                    {"id":"row","kind":"row","style":{},"children":[
                        {"id":"icon","kind":"svg","svg":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\"/>","style":{"width":24,"height":24,"foreground":"currentColor"},"children":[]},
                        {"id":"label","kind":"text","text":"Play","style":{"foreground":"currentColor"},"children":[]}
                    ]}
                ]
            }
        ]
    }))
    .unwrap();
    let mut tree = Tree::new(root);
    tree.compute(300.0, 120.0).unwrap();
    assert_eq!(tree.current_foreground("icon", "currentColor"), "#71717a");
    assert_eq!(tree.resolved_text_foreground("label", "#18181b"), "#71717a");
    assert_eq!(tree.current_foreground("icon", "#123456"), "#123456");
    tree.pointer_move(20.0, 18.0);
    assert_eq!(tree.current_foreground("icon", "currentColor"), "#ffffff");
    assert_eq!(tree.resolved_text_foreground("label", "#18181b"), "#ffffff");
}

#[test]
fn percent_translation_is_of_the_box_own_size() {
    let shimmer = node(
        "shimmer",
        "view",
        json!({"width": 80, "height": 40, "transform": {"x": 4, "xPercent": -100, "yPercent": 50}}),
        vec![],
    );
    let mut tree = Tree::new(root(vec![shimmer]));
    tree.compute(400.0, 300.0).unwrap();
    let transform = tree
        .node_transform("shimmer", vello::kurbo::Vec2::ZERO)
        .unwrap();
    assert_eq!(
        transform.translation(),
        vello::kurbo::Vec2::new(-76.0, 20.0)
    );
}
