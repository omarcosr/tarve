use crate::{
    protocol::{self, Node},
    runtime::{anchored_window_position, cursor_for_node},
    tree::Tree,
};
use serde_json::json;
use winit::dpi::{PhysicalPosition, PhysicalSize};
use winit::window::CursorIcon;

fn node(id: &str, kind: &str, style: serde_json::Value, children: Vec<Node>) -> Node {
    serde_json::from_value(json!({"id":id,"kind":kind,"style":style,"children":children})).unwrap()
}
fn root(children: Vec<Node>) -> Node {
    node("root", "window", json!({}), children)
}

#[test]
fn window_position_protocol_accepts_presets_and_logical_coordinates() {
    let base = json!({
        "title":"Positioned",
        "width":800,
        "height":600,
        "minWidth":320,
        "minHeight":240,
        "background":"#000000"
    });
    for preset in [
        "top-left",
        "top",
        "top-right",
        "left",
        "center",
        "right",
        "bottom-left",
        "bottom",
        "bottom-right",
    ] {
        let mut positioned = base.clone();
        positioned["position"] = json!(preset);
        let positioned: protocol::WindowOptions = serde_json::from_value(positioned).unwrap();
        assert!(matches!(
            positioned.position,
            Some(protocol::WindowPosition::Preset(_))
        ));
    }

    let mut exact = base;
    exact["position"] = json!({"x":-240,"y":96});
    let exact: protocol::WindowOptions = serde_json::from_value(exact).unwrap();
    match exact.position {
        Some(protocol::WindowPosition::Coordinates { x, y }) => {
            assert_eq!(x, -240.0);
            assert_eq!(y, 96.0);
        }
        _ => panic!("expected coordinate window position"),
    }
}

#[test]
fn splitter_cursor_matches_resize_axis() {
    let mut horizontal = node("horizontal", "splitter", json!({}), vec![]);
    horizontal.control = Some(serde_json::from_value(json!({
        "role":"slider","orientation":"horizontal","value":50,"min":0,"max":100,"step":1
    })).unwrap());
    let mut vertical = horizontal.clone();
    vertical.id = "vertical".into();
    vertical.control.as_mut().unwrap().orientation = "vertical".into();
    assert_eq!(cursor_for_node(Some(&horizontal)), CursorIcon::ColResize);
    assert_eq!(cursor_for_node(Some(&vertical)), CursorIcon::RowResize);
}

#[test]
fn window_position_presets_anchor_to_all_nine_monitor_positions() {
    use protocol::WindowPositionPreset::*;
    let monitor_position = PhysicalPosition::new(-1920, 100);
    let monitor_size = PhysicalSize::new(1920, 1080);
    let window_size = PhysicalSize::new(800, 600);
    let cases = [
        (TopLeft, (-1920, 100)),
        (Top, (-1360, 100)),
        (TopRight, (-800, 100)),
        (Left, (-1920, 340)),
        (Center, (-1360, 340)),
        (Right, (-800, 340)),
        (BottomLeft, (-1920, 580)),
        (Bottom, (-1360, 580)),
        (BottomRight, (-800, 580)),
    ];
    for (preset, expected) in cases {
        let position =
            anchored_window_position(&preset, monitor_position, monitor_size, window_size);
        assert_eq!((position.x, position.y), expected);
    }
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
fn taffy_aspect_ratio_and_reverse_direction_are_native_layout_features() {
    let mut ratio_tree = Tree::new(root(vec![node(
        "ratio",
        "view",
        json!({"width":160,"aspectRatio":2}),
        vec![],
    )]));
    ratio_tree.compute(300.0, 200.0).unwrap();
    assert!((ratio_tree.entries["ratio"].rect.width() - 160.0).abs() < 0.1);
    assert!((ratio_tree.entries["ratio"].rect.height() - 80.0).abs() < 0.1);

    let mut reverse_tree = Tree::new(root(vec![node(
        "reverse",
        "row",
        json!({"width":200,"height":60,"direction":"row-reverse"}),
        vec![
            node("first", "view", json!({"width":40,"height":20}), vec![]),
            node("second", "view", json!({"width":40,"height":20}), vec![]),
        ],
    )]));
    reverse_tree.compute(300.0, 200.0).unwrap();
    assert!(reverse_tree.entries["first"].rect.x0 > reverse_tree.entries["second"].rect.x0);
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
fn custom_window_chrome_border_is_suppressed_when_maximized_or_fullscreen() {
    let child = node(
        "child",
        "view",
        json!({"width":"100%","height":"100%"}),
        vec![],
    );
    let mut tree = Tree::new(node(
        "root",
        "window",
        json!({"borderWidth":1,"borderColor":"#27272a","radius":8}),
        vec![child],
    ));

    tree.compute(100.0, 80.0).unwrap();
    assert!((tree.entries["child"].rect.x0 - 1.0).abs() < 0.1);
    assert!((tree.entries["child"].rect.width() - 98.0).abs() < 0.1);

    assert!(tree.set_window_chrome_suppressed(true));
    tree.compute(100.0, 80.0).unwrap();
    tree.scene(1.0);
    assert!(tree.entries["child"].rect.x0.abs() < 0.1);
    assert!((tree.entries["child"].rect.width() - 100.0).abs() < 0.1);
    assert_eq!(tree.entries["root"].node.number("radius", 0.0), 8.0);
    assert_eq!(tree.entries["root"].node.insets("borderWidth"), [1.0; 4]);

    assert!(tree.set_window_chrome_suppressed(false));
    tree.compute(100.0, 80.0).unwrap();
    assert!((tree.entries["child"].rect.x0 - 1.0).abs() < 0.1);
    assert!((tree.entries["child"].rect.width() - 98.0).abs() < 0.1);
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
fn dragging_scrollbar_moves_virtual_list_and_emits_scroll_event() {
    let mut scroll = node(
        "list",
        "scroll",
        json!({"height":200}),
        vec![node(
            "content",
            "view",
            json!({"height":2000,"shrink":0}),
            vec![],
        )],
    );
    scroll.control = Some(serde_json::from_value(json!({"role":"virtualList","value":0})).unwrap());
    let mut tree = Tree::new(root(vec![scroll]));
    tree.compute(300.0, 300.0).unwrap();
    tree.scene(1.0);
    let rect = tree.entries["list"].rect;
    tree.pointer_move(rect.x1 - 5.0, rect.y0 + 15.0);
    tree.pointer_down();
    let events = tree.pointer_move(rect.x1 - 5.0, rect.y0 + 100.0);
    assert!(tree.entries["list"].scroll > 0.0);
    assert!(
        events
            .iter()
            .any(|event| event["type"] == "scroll" && event["id"] == "list")
    );
    assert!(
        !tree.dirty.paint,
        "virtual rows should be painted after the matching update"
    );
    tree.pointer_up();
    let stopped = tree.entries["list"].scroll;
    tree.pointer_move(rect.x1 - 5.0, rect.y0 + 140.0);
    assert_eq!(
        tree.entries["list"].scroll, stopped,
        "dragging must stop on mouse release"
    );
}
#[test]
fn input_deletes_unicode_graphemes_and_disabled_button_never_clicks() {
    let mut input = node("input", "input", json!({"height":38}), vec![]);
    input.value = Some("Olá👩‍💻".into());
    let mut button = node("disabled", "button", json!({"height":36}), vec![]);
    button.disabled = true;
    let mut tree = Tree::new(root(vec![input, button]));
    tree.compute(300.0, 200.0).unwrap();
    let _ = tree.focus("input");
    tree.key("Backspace");
    assert_eq!(tree.entries["input"].node.value.as_deref(), Some("Olá"));
    tree.key("End");
    tree.key("ShiftArrowLeft");
    assert_eq!(tree.selected_text().as_deref(), Some("á"));
    tree.type_text("a");
    assert_eq!(tree.entries["input"].node.value.as_deref(), Some("Ola"));
    tree.key("SelectAll");
    tree.type_text("Novo");
    assert_eq!(tree.entries["input"].node.value.as_deref(), Some("Novo"));
    tree.pointer_move(10.0, 50.0);
    tree.pointer_down();
    assert!(tree.pointer_up().is_empty());
}

#[test]
fn pointer_drag_selects_partial_input_text() {
    let mut input = node(
        "input",
        "input",
        json!({"width":220,"height":38,"padding":{"left":8,"right":8},"fontSize":14}),
        vec![],
    );
    input.value = Some("hello world".into());
    let mut tree = Tree::new(root(vec![input]));
    tree.compute(260.0, 80.0).unwrap();
    tree.scene(1.0);
    let rect = tree.entries["input"].rect;
    tree.pointer_move(rect.x0 + 10.0, rect.y0 + 18.0);
    tree.pointer_down();
    tree.pointer_move(rect.x0 + 48.0, rect.y0 + 18.0);
    tree.pointer_up();
    let selected = tree.selected_text().unwrap();
    assert!(!selected.is_empty());
    assert_ne!(selected, "hello world");
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
fn closing_modal_restores_focus_to_previous_control() {
    let trigger = node("trigger", "button", json!({"height":36}), vec![]);
    let mut tree = Tree::new(root(vec![trigger.clone()]));
    tree.compute(300.0, 200.0).unwrap();
    let _ = tree.focus("trigger");

    let close = node("close", "button", json!({"height":30}), vec![]);
    let panel = node(
        "panel",
        "column",
        json!({"width":180,"height":100}),
        vec![close],
    );
    let mut modal = node(
        "modal",
        "pressable",
        json!({"position":"absolute","top":0,"right":0,"bottom":0,"left":0}),
        vec![panel],
    );
    modal.modal = true;
    modal.focusable = false;
    tree.update(root(vec![trigger.clone(), modal]));
    tree.compute(300.0, 200.0).unwrap();
    assert_eq!(tree.focused.as_deref(), Some("close"));

    tree.update(root(vec![trigger]));
    tree.compute(300.0, 200.0).unwrap();
    assert_eq!(tree.focused.as_deref(), Some("trigger"));
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
    let _ = tree.focus("row-4");
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
fn splitter_drag_uses_parent_axis_and_keyboard_matches_split_direction() {
    let first = node("first", "view", json!({"flex":50,"height":"100%"}), vec![]);
    let mut splitter = node(
        "splitter",
        "splitter",
        json!({"width":10,"height":"100%","shrink":0}),
        vec![],
    );
    splitter.control = Some(
        serde_json::from_value(json!({
            "role":"slider","orientation":"horizontal","value":50,"min":10,"max":90,"step":1
        }))
        .unwrap(),
    );
    let second = node("second", "view", json!({"flex":50,"height":"100%"}), vec![]);
    let panels = node(
        "panels",
        "row",
        json!({"width":200,"height":80}),
        vec![first, splitter, second],
    );
    let mut tree = Tree::new(root(vec![panels]));
    tree.compute(240.0, 120.0).unwrap();
    let handle = tree.entries["splitter"].rect;
    tree.pointer_move(handle.center().x, handle.center().y);
    tree.pointer_down();
    let events = tree.pointer_move(150.0, 40.0);
    assert!(events.iter().any(|event| event["type"] == "valueChange"));
    assert!((tree.entries["splitter"].node.control.as_ref().unwrap().value - 70.0).abs() < 1.0);
    tree.pointer_up();

    let _ = tree.focus("splitter");
    let before = tree.entries["splitter"].node.control.as_ref().unwrap().value;
    tree.key("ArrowRight");
    assert_eq!(tree.entries["splitter"].node.control.as_ref().unwrap().value, before + 1.0);

    tree.entries.get_mut("splitter").unwrap().node.control.as_mut().unwrap().orientation = "vertical".into();
    let before = tree.entries["splitter"].node.control.as_ref().unwrap().value;
    tree.key("ArrowDown");
    assert_eq!(tree.entries["splitter"].node.control.as_ref().unwrap().value, before + 1.0);
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
fn navigation_menuitems_use_roving_focus_and_arrow_activation() {
    let mut first = node("first", "pressable", json!({"width":60,"height":30}), vec![]);
    first.control = Some(serde_json::from_value(json!({
        "role":"menuitem","group":"nav","label":"First","checked":true
    })).unwrap());
    let mut second = node("second", "pressable", json!({"width":60,"height":30}), vec![]);
    second.control = Some(serde_json::from_value(json!({
        "role":"menuitem","group":"nav","label":"Second","checked":false
    })).unwrap());
    let mut tree = Tree::new(root(vec![first, second]));
    tree.compute(200.0, 100.0).unwrap();
    let _ = tree.focus("first");
    let events = tree.key("ArrowRight");
    assert_eq!(tree.focused.as_deref(), Some("second"));
    assert!(!events.iter().any(|event| event["type"] == "click"));
    let events = tree.key("Home");
    assert_eq!(tree.focused.as_deref(), Some("first"));
    assert!(!events.iter().any(|event| event["type"] == "click"));
    let events = tree.key("Space");
    assert!(events.iter().any(|event| event["type"] == "click" && event["id"] == "first"));
}

#[test]
fn toggle_groups_roam_focus_without_toggling_on_arrows() {
    let mut first = node("first", "pressable", json!({"width":60,"height":30}), vec![]);
    first.control = Some(serde_json::from_value(json!({
        "role":"toggle","group":"toggles","label":"First","checked":true
    })).unwrap());
    let mut second = node("second", "pressable", json!({"width":60,"height":30}), vec![]);
    second.control = Some(serde_json::from_value(json!({
        "role":"toggle","group":"toggles","label":"Second","checked":false
    })).unwrap());
    let mut tree = Tree::new(root(vec![first, second]));
    tree.compute(200.0, 100.0).unwrap();
    let _ = tree.focus("first");
    let events = tree.key("ArrowRight");
    assert_eq!(tree.focused.as_deref(), Some("second"));
    assert!(!events.iter().any(|event| event["type"] == "click"));
    let events = tree.key("Space");
    assert!(events.iter().any(|event| event["type"] == "click" && event["id"] == "second"));
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

#[test]
fn textarea_edits_multiple_lines_and_scrolls_the_caret_into_view() {
    let mut area = node(
        "notes",
        "textarea",
        json!({
            "width":180,
            "height":56,
            "padding":4,
            "borderWidth":1,
            "fontSize":14,
            "lineHeight":1.5
        }),
        vec![],
    );
    area.value = Some("first".into());
    let mut tree = Tree::new(root(vec![area]));
    tree.compute(220.0, 100.0).unwrap();
    let _ = tree.focus("notes");

    let enter = tree.key("Enter");
    assert_eq!(enter[0]["value"], "first\n");
    let typed = tree.type_text("second\nthird\nfourth\nfifth");
    assert_eq!(typed[0]["type"], "change");
    assert_eq!(
        tree.entries["notes"].node.value.as_deref(),
        Some("first\nsecond\nthird\nfourth\nfifth")
    );

    tree.compute(220.0, 100.0).unwrap();
    assert!(tree.entries["notes"].scroll_max > 0.0);
    assert!(
        tree.entries["notes"].scroll > 0.0,
        "caret at the end must stay visible"
    );
    tree.scene(1.0);

    let before = tree.entries["notes"].scroll;
    let rect = tree.entries["notes"].rect;
    tree.pointer_move(rect.x0 + 20.0, rect.y0 + 20.0);
    let wheel = tree.wheel(-24.0);
    assert_eq!(wheel[0]["id"], "notes");
    assert!(tree.entries["notes"].scroll < before);

    let _ = tree.focus("notes");
    let old = tree.entries["notes"].node.value.as_ref().unwrap().len();
    let deleted = tree.key("Backspace");
    assert_eq!(deleted[0]["type"], "change");
    assert!(tree.entries["notes"].node.value.as_ref().unwrap().len() < old);
}

#[test]
fn select_trigger_forwards_navigation_keys_to_bun() {
    let mut trigger = node("select-trigger", "pressable", json!({"height":38}), vec![]);
    trigger.control = Some(
        serde_json::from_value(json!({
            "role":"select","label":"Team","checked":true
        }))
        .unwrap(),
    );
    let mut tree = Tree::new(root(vec![trigger]));
    tree.compute(220.0, 100.0).unwrap();
    let _ = tree.focus("select-trigger");
    for key in ["ArrowDown", "ArrowUp", "Home", "End", "Escape"] {
        let events = tree.key(key);
        assert_eq!(events[0]["type"], "key");
        assert_eq!(events[0]["id"], "select-trigger");
        assert_eq!(events[0]["key"], key);
    }
}

#[test]
fn changing_focus_emits_blur_for_the_previous_control() {
    let first = node(
        "first",
        "pressable",
        json!({"width":80,"height":30}),
        vec![],
    );
    let second = node(
        "second",
        "pressable",
        json!({"width":80,"height":30}),
        vec![],
    );
    let mut tree = Tree::new(root(vec![first, second]));
    tree.compute(200.0, 100.0).unwrap();
    let _ = tree.focus("first");
    let events = tree.key("Tab");
    assert_eq!(tree.focused.as_deref(), Some("second"));
    assert_eq!(events[0]["type"], "blur");
    assert_eq!(events[0]["id"], "first");
}

#[test]
fn z_index_controls_overlapping_hit_order_without_affecting_layout() {
    let high = node(
        "high",
        "pressable",
        json!({
            "position":"absolute","left":0,"top":0,"width":80,"height":40,"zIndex":10
        }),
        vec![],
    );
    let low = node(
        "low",
        "pressable",
        json!({
            "position":"absolute","left":0,"top":0,"width":80,"height":40
        }),
        vec![],
    );
    let mut tree = Tree::new(root(vec![node(
        "stack",
        "view",
        json!({"position":"relative","width":100,"height":60}),
        vec![high, low],
    )]));
    tree.compute(120.0, 80.0).unwrap();
    let before = tree.entries["high"].rect;
    tree.pointer_move(20.0, 20.0);
    assert_eq!(tree.hovered.as_deref(), Some("high"));
    assert_eq!(tree.entries["high"].rect, before);
}

#[test]
fn portal_escapes_scroll_clip_for_paint_and_hit_testing() {
    let button = node(
        "portal-button",
        "button",
        json!({"width":100,"height":30}),
        vec![],
    );
    let mut portal = node(
        "portal",
        "column",
        json!({"position":"absolute","top":80,"left":0,"width":100,"height":30,"zIndex":1000}),
        vec![button],
    );
    portal.portal = true;
    let scroll = node(
        "scroll",
        "scroll",
        json!({"width":200,"height":60}),
        vec![node(
            "content",
            "column",
            json!({"width":200,"height":160,"shrink":0}),
            vec![portal],
        )],
    );
    let mut tree = Tree::new(root(vec![scroll]));
    tree.compute(240.0, 140.0).unwrap();
    tree.scene(1.0);
    tree.pointer_move(20.0, 90.0);
    assert_eq!(tree.hovered.as_deref(), Some("portal-button"));
}

#[test]
fn dismissible_portal_emits_outside_without_clicking_through() {
    let button = node(
        "popup-button",
        "button",
        json!({"width":80,"height":30}),
        vec![],
    );
    let mut popup = node(
        "popup",
        "column",
        json!({"position":"absolute","top":40,"left":20,"width":80,"height":30,"zIndex":1000}),
        vec![button],
    );
    popup.portal = true;
    popup.dismiss_on_outside = true;
    let background = node(
        "background",
        "button",
        json!({"width":200,"height":120}),
        vec![],
    );
    let mut tree = Tree::new(root(vec![background, popup]));
    tree.compute(220.0, 140.0).unwrap();
    tree.pointer_move(180.0, 100.0);
    let down = tree.pointer_down();
    assert_eq!(down[0]["type"], "outside");
    assert_eq!(down[0]["id"], "popup");
    assert!(
        tree.pointer_up().is_empty(),
        "outside dismissal must not click through"
    );
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
