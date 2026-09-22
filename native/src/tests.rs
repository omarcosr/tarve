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
        json!({
            "width":100,
            "height":36,
            "background":"#111111",
            "hover":{"background":"#eeeeee"},
            "active":{"background":"#22c55e"},
            "focus":{"outlineColor":"#8b5cf6","outlineWidth":2}
        }),
        vec![],
    );
    button.text = "Click".into();
    let mut tree = Tree::new(root(vec![button.clone()]));
    tree.compute(300.0, 200.0).unwrap();
    tree.scene(1.0);
    assert_eq!(
        tree.resolved_visual_string("button", "background", "#00000000"),
        "#111111"
    );
    tree.pointer_move(20.0, 15.0);
    assert_eq!(
        tree.resolved_visual_string("button", "background", "#00000000"),
        "#eeeeee"
    );
    assert!(tree.dirty.paint && !tree.dirty.layout && !tree.dirty.text);
    tree.pointer_down();
    assert_eq!(
        tree.resolved_visual_string("button", "background", "#00000000"),
        "#22c55e"
    );
    assert_eq!(
        tree.resolved_visual_string("button", "outlineColor", "#a1a1aa"),
        "#8b5cf6"
    );
    tree.scene(1.0);
    button.style["background"] = json!("#ffffff");
    tree.update(root(vec![button]));
    assert!(tree.dirty.paint && !tree.dirty.layout && !tree.dirty.text);
}

#[test]
fn disabled_state_overrides_other_visual_states() {
    let mut button = node(
        "disabled",
        "button",
        json!({
            "background":"#111111",
            "hover":{"background":"#eeeeee"},
            "active":{"background":"#22c55e"},
            "disabled":{"background":"#71717a","foreground":"#a1a1aa"}
        }),
        vec![],
    );
    button.disabled = true;
    let mut tree = Tree::new(root(vec![button]));
    tree.compute(300.0, 200.0).unwrap();
    assert_eq!(
        tree.resolved_visual_string("disabled", "background", "#00000000"),
        "#71717a"
    );
    assert_eq!(
        tree.resolved_visual_string("disabled", "foreground", "#18181b"),
        "#a1a1aa"
    );
}

#[test]
fn outline_updates_are_paint_only_and_do_not_affect_layout() {
    let panel = node(
        "panel",
        "view",
        json!({
            "width":120,
            "height":80,
            "radius":8,
            "outlineWidth":2,
            "outlineColor":"#8b5cf6",
            "outlineOffset":3
        }),
        vec![],
    );
    let mut tree = Tree::new(root(vec![panel.clone()]));
    tree.compute(300.0, 200.0).unwrap();
    tree.scene(1.0);
    let before = tree.entries["panel"].rect;
    let mut changed = panel;
    changed.style["outlineWidth"] = json!(5);
    changed.style["outlineOffset"] = json!(6);
    changed.style["outlineColor"] = json!("#22c55e");
    changed.style["outlineStyle"] = json!("dashed");
    tree.update(root(vec![changed]));
    assert!(tree.dirty.paint);
    assert!(!tree.dirty.layout);
    assert!(!tree.dirty.text);
    tree.compute(300.0, 200.0).unwrap();
    assert_eq!(tree.entries["panel"].rect, before);
}

#[test]
fn every_outline_style_renders_without_affecting_layout() {
    let styles = [
        "dotted", "dashed", "solid", "double", "groove", "ridge", "inset", "outset", "none",
        "hidden",
    ];
    let children = styles
        .iter()
        .enumerate()
        .map(|(index, style)| {
            node(
                &format!("outline-{style}"),
                "view",
                json!({
                    "width":80,
                    "height":30,
                    "margin":{"bottom":8},
                    "radius":6,
                    "outlineWidth":4,
                    "outlineOffset":2,
                    "outlineColor":"#71717a",
                    "outlineStyle":style,
                    "background": if index % 2 == 0 { "#ffffff" } else { "#f4f4f5" }
                }),
                vec![],
            )
        })
        .collect();
    let mut tree = Tree::new(root(children));
    tree.compute(300.0, 500.0).unwrap();
    let before: Vec<_> = styles
        .iter()
        .map(|style| tree.entries[&format!("outline-{style}")].rect)
        .collect();
    tree.scene(1.0);
    let after: Vec<_> = styles
        .iter()
        .map(|style| tree.entries[&format!("outline-{style}")].rect)
        .collect();
    assert_eq!(before, after);
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

#[test]
fn focusing_an_offscreen_control_scrolls_it_into_view() {
    let rows = (0..5)
        .map(|index| {
            node(
                &format!("row-{index}"),
                "button",
                json!({"height":30,"shrink":0}),
                vec![],
            )
        })
        .collect();
    let scroll = node("scroll", "scroll", json!({"height":60}), rows);
    let mut tree = Tree::new(root(vec![scroll]));
    tree.compute(200.0, 100.0).unwrap();
    assert_eq!(tree.entries["scroll"].scroll, 0.0);
    tree.focus("row-4");
    assert_eq!(tree.focused.as_deref(), Some("row-4"));
    assert!(tree.entries["scroll"].scroll > 0.0);
    let row = tree
        .snapshots()
        .into_iter()
        .find(|item| item["id"] == "row-4")
        .unwrap();
    assert!(row["y"].as_f64().unwrap() + row["height"].as_f64().unwrap() <= 60.0);
    assert!(!tree.dirty.layout && tree.dirty.paint);
}

#[test]
fn leaving_the_window_while_dragging_does_not_reset_a_slider() {
    let mut slider = node("slider", "slider", json!({"width":120,"height":24}), vec![]);
    slider.control = Some(
        serde_json::from_value(json!({
            "role":"slider","value":50,"min":0,"max":100,"step":1
        }))
        .unwrap(),
    );
    let mut tree = Tree::new(root(vec![slider]));
    tree.compute(200.0, 100.0).unwrap();
    tree.pointer_move(60.0, 12.0);
    tree.pointer_down();
    tree.pointer_move(100.0, 12.0);
    let before = tree.entries["slider"].node.control.as_ref().unwrap().value;
    assert!(before > 50.0);
    tree.pointer_leave();
    assert_eq!(
        tree.entries["slider"].node.control.as_ref().unwrap().value,
        before
    );
    assert_eq!(tree.hovered, None);
    tree.pointer_up();
}

#[test]
fn radio_groups_use_one_tab_stop_and_arrows_move_between_enabled_choices() {
    let mut radios = Vec::new();
    for (name, checked, disabled) in [
        ("first", false, false),
        ("second", true, false),
        ("third", false, true),
    ] {
        let mut radio = node(name, "pressable", json!({"height":28}), vec![]);
        radio.control = Some(
            serde_json::from_value(json!({
                "role":"radio","group":"choices","label":name,"checked":checked
            }))
            .unwrap(),
        );
        radio.disabled = disabled;
        radios.push(radio);
    }
    let group = node("choices", "column", json!({}), radios);
    let mut tree = Tree::new(root(vec![group]));
    tree.compute(200.0, 100.0).unwrap();
    tree.key("Tab");
    assert_eq!(tree.focused.as_deref(), Some("second"));
    let events = tree.key("ArrowRight");
    assert_eq!(events[0]["id"], "first");
    assert_eq!(tree.focused.as_deref(), Some("first"));
    tree.key("Tab");
    assert_eq!(
        tree.focused.as_deref(),
        Some("first"),
        "only the focused radio belongs in the tab order"
    );
}

#[test]
fn virtual_scroll_waits_for_new_rows_before_painting() {
    let mut scroll = node(
        "list",
        "scroll",
        json!({"height":60}),
        vec![node(
            "content",
            "view",
            json!({"height":600,"shrink":0}),
            vec![],
        )],
    );
    scroll.control = Some(serde_json::from_value(json!({"role":"virtualList","value":0})).unwrap());
    let mut tree = Tree::new(root(vec![scroll.clone()]));
    tree.compute(200.0, 100.0).unwrap();
    tree.scene(1.0);
    tree.pointer_move(20.0, 20.0);
    tree.scene(1.0);
    let events = tree.wheel(36.0);
    assert_eq!(events[0]["offset"], 36.0);
    assert!(
        !tree.dirty.paint,
        "old rows must not paint at the new scroll offset"
    );
    scroll.control.as_mut().unwrap().value = 36.0;
    scroll.children.clear();
    tree.patch(vec![scroll]).unwrap();
    assert!(
        tree.dirty.paint,
        "the matching virtual rows must schedule the frame"
    );
}
