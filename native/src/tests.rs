use crate::{
    protocol::{self, Node},
    tree::Tree,
};
use serde_json::json;

fn node(id: &str, kind: &str, style: serde_json::Value, children: Vec<Node>) -> Node {
    serde_json::from_value(json!({"id":id,"kind":kind,"style":style,"children":children})).unwrap()
}
fn root(children: Vec<Node>) -> Node {
    node("root", "window", json!({}), children)
}

#[test]
fn taffy_grid_and_parley_measurement_reflow_on_resize() {
    let mut text = node("text", "text", json!({"fontSize":18}), vec![]);
    text.text = "A long line of shaped text should wrap inside a narrow native column.".into();
    let mut tree = Tree::new(root(vec![node(
        "grid",
        "view",
        json!({"display":"grid","columns":2,"gap":12}),
        vec![
            text.clone(),
            node("box", "view", json!({"height":30}), vec![]),
        ],
    )]));
    tree.compute(600.0, 300.0).unwrap();
    let wide_height = tree.entries["text"].rect.height();
    let shapes = tree.text.shapes;
    assert!((tree.entries["box"].rect.width() - 294.0).abs() < 1.0);
    tree.dirty.layout = true;
    tree.compute(300.0, 300.0).unwrap();
    assert!(tree.entries["text"].rect.height() > wide_height);
    assert_eq!(
        tree.text.shapes, shapes,
        "resize should rebreak cached text without reshaping"
    );
}

#[test]
fn per_side_border_width_affects_layout_independently() {
    let child = node(
        "child",
        "view",
        json!({"width":"100%","height":"100%"}),
        vec![],
    );
    let panel = node(
        "panel",
        "view",
        json!({
            "width":120,
            "height":100,
            "borderWidth":{"top":3,"right":11,"bottom":13,"left":7}
        }),
        vec![child],
    );
    let mut tree = Tree::new(root(vec![panel]));
    tree.compute(300.0, 200.0).unwrap();
    let panel = tree.entries["panel"].rect;
    let child = tree.entries["child"].rect;
    assert!((child.x0 - (panel.x0 + 7.0)).abs() < 0.1);
    assert!((child.y0 - (panel.y0 + 3.0)).abs() < 0.1);
    assert!((child.width() - (panel.width() - 7.0 - 11.0)).abs() < 0.1);
    assert!((child.height() - (panel.height() - 3.0 - 13.0)).abs() < 0.1);
}
#[test]
fn hover_and_color_update_do_not_invalidate_layout_or_text() {
    let mut button = node(
        "button",
        "button",
        json!({"width":100,"height":36,"hoverBackground":"#eeeeee"}),
        vec![],
    );
    button.text = "Click".into();
    let mut tree = Tree::new(root(vec![button.clone()]));
    tree.compute(300.0, 200.0).unwrap();
    tree.scene(1.0);
    tree.pointer_move(20.0, 15.0);
    assert!(tree.dirty.paint && !tree.dirty.layout && !tree.dirty.text);
    tree.scene(1.0);
    button.style["background"] = json!("#ffffff");
    tree.update(root(vec![button]));
    assert!(tree.dirty.paint && !tree.dirty.layout && !tree.dirty.text);
}
#[test]
fn scroll_clamps_and_hit_test_respects_viewport() {
    let buttons = (0..5)
        .map(|i| node(&format!("b{i}"), "button", json!({"height":40}), vec![]))
        .collect();
    let mut tree = Tree::new(root(vec![node(
        "scroll",
        "scroll",
        json!({"height":80}),
        buttons,
    )]));
    tree.compute(300.0, 200.0).unwrap();
    tree.scene(1.0);
    tree.pointer_move(20.0, 100.0);
    assert!(
        tree.hovered.is_none(),
        "clipped button must not accept input"
    );
    tree.pointer_move(20.0, 20.0);
    tree.wheel(10_000.0);
    assert_eq!(
        tree.entries["scroll"].scroll,
        tree.entries["scroll"].scroll_max
    );
    assert!(
        !tree.dirty.layout && !tree.dirty.text,
        "scroll only repaints"
    );
    tree.pointer_move(20.0, 20.0);
    assert_ne!(tree.hovered.as_deref(), Some("b0"));
}
#[test]
fn input_deletes_unicode_graphemes_and_disabled_button_never_clicks() {
    let mut input = node("input", "input", json!({"height":38}), vec![]);
    input.value = Some("Olá👩‍💻".into());
    let mut button = node("disabled", "button", json!({"height":36}), vec![]);
    button.disabled = true;
    let mut tree = Tree::new(root(vec![input, button]));
    tree.compute(300.0, 200.0).unwrap();
    tree.pointer_move(10.0, 10.0);
    tree.pointer_down();
    tree.key("Backspace");
    assert_eq!(tree.entries["input"].node.value.as_deref(), Some("Olá"));
    tree.key("SelectAll");
    tree.type_text("Novo");
    assert_eq!(tree.entries["input"].node.value.as_deref(), Some("Novo"));
    tree.pointer_move(10.0, 50.0);
    tree.pointer_down();
    assert!(tree.pointer_up().is_empty());
}
#[test]
fn protocol_rejects_duplicate_ids() {
    let leaf = node("same", "view", json!({}), vec![]);
    assert!(protocol::validate(&root(vec![leaf.clone(), leaf])).is_err());
}

#[test]
fn text_updates_retain_layout_nodes_and_removals_release_them() {
    let mut label = node("label", "text", json!({"fontSize":14}), vec![]);
    label.text = "Short".into();
    let sibling = node("sibling", "view", json!({"height":20}), vec![]);
    let mut tree = Tree::new(root(vec![label.clone(), sibling.clone()]));
    tree.compute(300.0, 200.0).unwrap();
    let created = tree.layout_nodes_created;
    let old_width = tree.entries["label"].rect.width();
    label.text = "A much longer text that needs more room".into();
    label.style["width"] = json!("auto");
    tree.update(root(vec![label.clone(), sibling.clone()]));
    tree.compute(600.0, 200.0).unwrap();
    assert_eq!(
        tree.layout_nodes_created, created,
        "text/style changes must reuse Taffy nodes"
    );
    assert!(tree.entries["label"].rect.width() > old_width);
    tree.update(root(vec![sibling, label]));
    tree.compute(600.0, 200.0).unwrap();
    assert!(tree.entries["label"].rect.y0 > tree.entries["sibling"].rect.y0);
    tree.update(root(vec![]));
    tree.compute(600.0, 200.0).unwrap();
    assert_eq!(
        tree.layout_node_count(),
        1,
        "removed nodes must leave the retained layout tree"
    );
}

#[test]
fn scrolling_a_large_tree_encodes_only_visible_subtrees() {
    let rows = (0..2000)
        .map(|i| {
            let mut row = node(
                &format!("row-{i}"),
                "button",
                json!({"height":32,"shrink":0}),
                vec![],
            );
            row.text = format!("Row {i}");
            row
        })
        .collect();
    let mut tree = Tree::new(root(vec![node(
        "list",
        "scroll",
        json!({"height":128}),
        rows,
    )]));
    tree.compute(400.0, 200.0).unwrap();
    tree.scene(1.0);
    assert!(
        tree.painted_nodes < 12,
        "offscreen rows must not generate glyphs or display-list paths"
    );
    let nodes_created = tree.layout_nodes_created;
    tree.pointer_move(20.0, 20.0);
    tree.wheel(100_000.0);
    tree.scene(1.0);
    assert!(tree.painted_nodes < 12);
    assert_eq!(tree.layout_nodes_created, nodes_created);
    tree.pointer_move(20.0, 112.0);
    assert_eq!(tree.hovered.as_deref(), Some("row-1999"));
}

#[test]
fn property_patches_preserve_children_and_reject_invalid_batches_atomically() {
    let mut label = node("label", "text", json!({}), vec![]);
    label.text = "Before".into();
    let mut tree = Tree::new(root(vec![node(
        "column",
        "column",
        json!({}),
        vec![label.clone()],
    )]));
    tree.compute(400.0, 200.0).unwrap();
    let created = tree.layout_nodes_created;
    label.text = "After".into();
    let missing = node("missing", "text", json!({}), vec![]);
    assert!(tree.patch(vec![label.clone(), missing]).is_err());
    assert_eq!(tree.entries["label"].node.text, "Before");
    tree.patch(vec![
        label,
        node("column", "column", json!({"padding":20}), vec![]),
    ])
    .unwrap();
    tree.compute(400.0, 200.0).unwrap();
    assert_eq!(tree.entries["label"].node.text, "After");
    assert_eq!(tree.entries["label"].rect.x0, 20.0);
    assert_eq!(tree.layout_nodes_created, created);
    assert_eq!(tree.layout_node_count(), 3);
}

#[test]
fn removed_images_are_released_from_cache() {
    let path = std::env::temp_dir().join(format!("tarve-image-cache-{}.png", std::process::id()));
    image::RgbaImage::new(4, 4).save(&path).unwrap();
    let mut image = node("image", "image", json!({"width":4,"height":4}), vec![]);
    image.src = path.to_string_lossy().into_owned();
    let mut tree = Tree::new(root(vec![image]));
    assert_eq!(tree.image_cache_len(), 1);
    tree.update(root(vec![]));
    assert_eq!(tree.image_cache_len(), 0);
    let _ = std::fs::remove_file(path);
}

#[test]
fn modal_overlay_is_absolute_blocks_background_and_traps_focus() {
    let trigger = node("trigger", "button", json!({"height":36}), vec![]);
    let background_scroll = node(
        "background-scroll",
        "scroll",
        json!({"height":264}),
        vec![node(
            "tall",
            "view",
            json!({"height":600,"shrink":0}),
            vec![],
        )],
    );
    let close = node(
        "close",
        "button",
        json!({"position":"absolute","top":8,"right":8,"width":30,"height":30}),
        vec![],
    );
    let panel = node(
        "panel",
        "column",
        json!({"width":200,"height":120,"pointerEvents":"block"}),
        vec![close],
    );
    let mut modal = node(
        "modal",
        "pressable",
        json!({
            "position":"absolute","top":0,"right":0,"bottom":0,"left":0,
            "align":"center","justify":"center"
        }),
        vec![panel],
    );
    modal.modal = true;
    modal.focusable = false;
    let mut tree = Tree::new(root(vec![trigger, background_scroll, modal]));
    tree.compute(400.0, 300.0).unwrap();
    assert_eq!(tree.entries["modal"].rect.width(), 400.0);
    assert_eq!(tree.entries["modal"].rect.height(), 300.0);
    assert_eq!(
        tree.entries["trigger"].rect.y0, 0.0,
        "absolute modal must not move page content"
    );
    assert_eq!(
        tree.focused.as_deref(),
        Some("close"),
        "modal should focus its first control"
    );
    tree.key("Tab");
    assert_eq!(
        tree.focused.as_deref(),
        Some("close"),
        "Tab must not escape the active modal"
    );

    tree.pointer_move(200.0, 150.0);
    assert_eq!(
        tree.hovered.as_deref(),
        Some("panel"),
        "blank panel area must block the backdrop"
    );
    tree.pointer_down();
    assert!(tree.pointer_up().is_empty());

    tree.pointer_move(10.0, 10.0);
    tree.pointer_down();
    let events = tree.pointer_up();
    assert_eq!(events[0]["type"], "click");
    assert_eq!(events[0]["id"], "modal");

    tree.pointer_move(10.0, 250.0);
    tree.wheel(120.0);
    assert_eq!(
        tree.entries["background-scroll"].scroll, 0.0,
        "wheel input must not reach scroll containers behind a modal"
    );
}
