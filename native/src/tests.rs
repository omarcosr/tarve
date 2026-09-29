use crate::{
    bridge,
    protocol::{self, Node, TreeMutation},
    renderer::{GraphicsFaultKind, SurfaceIssue, SurfaceRecoveryAction, surface_recovery_action},
    runtime::{
        CloseRequestAction, GraphicsFaultAction, GraphicsRecoveryCircuitAction,
        GraphicsRecoveryFailureAction, anchored_window_position, close_request_action,
        cursor_for_node, graphics_fault_action, graphics_recoveries_after_stability,
        graphics_recovery_circuit_action, graphics_recovery_delay,
        graphics_recovery_failure_action, ime_allowed_for_node, shortcut_name,
    },
    tree::Tree,
};
use base64::Engine as _;

#[test]
fn abi_and_json_protocol_versions_fail_independently() {
    assert_eq!(bridge::tarve_abi_version(), bridge::ABI_VERSION);
    assert_ne!(bridge::ABI_VERSION, protocol::VERSION);
    assert!(bridge::validate_protocol_version(protocol::VERSION).is_ok());
    assert_eq!(
        bridge::validate_protocol_version(protocol::VERSION + 1).unwrap_err(),
        "Protocol version mismatch"
    );
}
use serde_json::json;
use std::{io::Cursor, sync::Arc};
use winit::dpi::{PhysicalPosition, PhysicalSize};
use winit::keyboard::{Key, ModifiersState, NamedKey};
use winit::window::CursorIcon;

fn node(id: &str, kind: &str, style: serde_json::Value, children: Vec<Node>) -> Node {
    serde_json::from_value(json!({"id":id,"kind":kind,"style":style,"children":children})).unwrap()
}
fn root(children: Vec<Node>) -> Node {
    node("root", "window", json!({}), children)
}

#[test]
fn graphics_surface_failures_have_explicit_recovery_actions() {
    assert_eq!(
        surface_recovery_action(SurfaceIssue::Timeout),
        SurfaceRecoveryAction::RetryLater
    );
    assert_eq!(
        surface_recovery_action(SurfaceIssue::Occluded),
        SurfaceRecoveryAction::SuspendPresentation
    );
    assert_eq!(
        surface_recovery_action(SurfaceIssue::Outdated),
        SurfaceRecoveryAction::Reconfigure
    );
    assert_eq!(
        surface_recovery_action(SurfaceIssue::Lost),
        SurfaceRecoveryAction::RecreateSurface
    );
    assert_eq!(
        surface_recovery_action(SurfaceIssue::Validation),
        SurfaceRecoveryAction::Fatal
    );
}

#[test]
fn graphics_device_faults_distinguish_recovery_from_fatal_errors() {
    assert_eq!(
        graphics_fault_action(GraphicsFaultKind::DeviceLost),
        GraphicsFaultAction::RecoverDevice
    );
    assert_eq!(
        graphics_fault_action(GraphicsFaultKind::Internal),
        GraphicsFaultAction::RecoverDevice
    );
    assert_eq!(
        graphics_fault_action(GraphicsFaultKind::OutOfMemory),
        GraphicsFaultAction::Fatal
    );
    assert_eq!(
        graphics_fault_action(GraphicsFaultKind::Validation),
        GraphicsFaultAction::Fatal
    );
}

#[test]
fn graphics_recovery_retries_are_bounded_and_backed_off() {
    assert_eq!(
        graphics_recovery_delay(1),
        std::time::Duration::from_millis(100)
    );
    assert_eq!(
        graphics_recovery_delay(2),
        std::time::Duration::from_millis(250)
    );
    assert_eq!(
        graphics_recovery_failure_action(1),
        GraphicsRecoveryFailureAction::RetryAfter(std::time::Duration::from_millis(100))
    );
    assert_eq!(
        graphics_recovery_failure_action(2),
        GraphicsRecoveryFailureAction::RetryAfter(std::time::Duration::from_millis(250))
    );
    assert_eq!(
        graphics_recovery_failure_action(3),
        GraphicsRecoveryFailureAction::Fatal
    );
    assert_eq!(
        graphics_recovery_circuit_action(0),
        GraphicsRecoveryCircuitAction::Allow
    );
    assert_eq!(
        graphics_recovery_circuit_action(2),
        GraphicsRecoveryCircuitAction::Allow
    );
    assert_eq!(
        graphics_recovery_circuit_action(3),
        GraphicsRecoveryCircuitAction::Fatal
    );
}

#[test]
fn graphics_recovery_circuit_breaker_spans_generations_and_decays_after_stability() {
    let mut recovery_episodes = 0;
    for _generation in 1..=3 {
        assert_eq!(
            graphics_recovery_circuit_action(recovery_episodes),
            GraphicsRecoveryCircuitAction::Allow
        );
        recovery_episodes += 1;
    }
    assert_eq!(
        graphics_recovery_circuit_action(recovery_episodes),
        GraphicsRecoveryCircuitAction::Fatal,
        "a replacement device that immediately fails must not reset the global recovery budget"
    );
    assert_eq!(
        graphics_recoveries_after_stability(recovery_episodes, std::time::Duration::from_secs(29)),
        3
    );
    recovery_episodes =
        graphics_recoveries_after_stability(recovery_episodes, std::time::Duration::from_secs(30));
    assert_eq!(recovery_episodes, 0);
    assert_eq!(
        graphics_recovery_circuit_action(recovery_episodes),
        GraphicsRecoveryCircuitAction::Allow,
        "a sustained healthy period restores the recovery budget"
    );
}

#[test]
fn close_request_protocol_and_coalescing_are_explicit() {
    let plain = root(vec![]);
    assert!(!plain.close_intercept);
    let intercepted: Node = serde_json::from_value(json!({
        "id":"root","kind":"window","style":{},"children":[],"closeIntercept":true
    }))
    .unwrap();
    assert!(intercepted.close_intercept);

    let command: protocol::Command =
        serde_json::from_value(json!({"type":"cancelCloseRequest"})).unwrap();
    assert!(matches!(command, protocol::Command::CancelCloseRequest));

    let mut pending = false;
    assert_eq!(
        close_request_action(false, &mut pending),
        CloseRequestAction::Exit
    );
    assert!(!pending, "non-intercepted close should remain immediate");
    assert_eq!(
        close_request_action(true, &mut pending),
        CloseRequestAction::Emit
    );
    assert!(pending);
    assert_eq!(
        close_request_action(true, &mut pending),
        CloseRequestAction::Ignore,
        "repeated OS close requests must coalesce while JS decides"
    );
    pending = false;
    assert_eq!(
        close_request_action(true, &mut pending),
        CloseRequestAction::Emit,
        "canceling should allow a later close request through"
    );
}

#[test]
fn file_dialog_protocol_and_hotkey_names_are_explicit() {
    let command: protocol::Command = serde_json::from_value(json!({
        "type":"fileDialog",
        "mode":"openFiles",
        "requestId":"files-1",
        "options":{
            "title":"Choose files",
            "directory":"C:/tmp",
            "filters":[{"name":"Images","extensions":["png","jpg"]}]
        }
    }))
    .unwrap();
    match command {
        protocol::Command::FileDialog {
            mode,
            options,
            request_id,
        } => {
            assert_eq!(mode, "openFiles");
            assert_eq!(request_id, "files-1");
            assert_eq!(options.title.as_deref(), Some("Choose files"));
            assert_eq!(options.filters[0].extensions, ["png", "jpg"]);
        }
        _ => panic!("expected file dialog command"),
    }
    let invalid = protocol::FileDialogOptions {
        filters: vec![protocol::FileDialogFilter {
            name: "Bad".into(),
            extensions: vec!["*.exe".into()],
        }],
        ..Default::default()
    };
    assert!(protocol::validate_file_dialog("openFile", &invalid).is_err());

    let modifiers = ModifiersState::CONTROL | ModifiersState::SHIFT;
    assert_eq!(
        shortcut_name(&Key::Character("s".into()), modifiers).as_deref(),
        Some("Ctrl+Shift+S")
    );
    assert_eq!(
        shortcut_name(&Key::Named(NamedKey::F2), ModifiersState::empty()).as_deref(),
        Some("F2")
    );
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
    horizontal.control = Some(
        serde_json::from_value(json!({
            "role":"slider","orientation":"horizontal","value":50,"min":0,"max":100,"step":1
        }))
        .unwrap(),
    );
    let mut vertical = horizontal.clone();
    vertical.id = "vertical".into();
    vertical.control.as_mut().unwrap().orientation = "vertical".into();
    assert_eq!(cursor_for_node(Some(&horizontal)), CursorIcon::ColResize);
    assert_eq!(cursor_for_node(Some(&vertical)), CursorIcon::RowResize);
}

#[test]
fn ime_enablement_includes_input_and_textarea_only() {
    let input = node("input", "input", json!({}), vec![]);
    let textarea = node("textarea", "textarea", json!({}), vec![]);
    let button = node("button", "button", json!({}), vec![]);
    assert!(ime_allowed_for_node(Some(&input)));
    assert!(ime_allowed_for_node(Some(&textarea)));
    assert!(!ime_allowed_for_node(Some(&button)));
    assert!(!ime_allowed_for_node(None));
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
fn focus_visible_distinguishes_pointer_focus_from_keyboard_focus() {
    let mut button = node(
        "button",
        "button",
        json!({
            "width":100,
            "height":36,
            "focus":{"background":"#123456"},
            "focusVisible":{"outlineWidth":2,"outlineColor":"#8b5cf6"}
        }),
        vec![],
    );
    button.text = "Link-like control".into();
    let mut tree = Tree::new(root(vec![button]));
    tree.compute(300.0, 200.0).unwrap();

    tree.pointer_move(20.0, 15.0);
    tree.pointer_down();
    tree.pointer_up();
    assert_eq!(tree.focused.as_deref(), Some("button"));
    assert!(!tree.focus_visible);
    assert_eq!(
        tree.resolved_visual_string("button", "background", "#00000000"),
        "#123456",
        "ordinary focus styles still apply after pointer focus"
    );
    assert_eq!(
        tree.resolved_visual_number("button", "outlineWidth", 0.0),
        0.0,
        "pointer focus must not show the focus-visible ring"
    );

    tree.key("Tab");
    assert_eq!(tree.focused.as_deref(), Some("button"));
    assert!(tree.focus_visible);
    assert_eq!(
        tree.resolved_visual_number("button", "outlineWidth", 0.0),
        2.0,
        "keyboard focus must show the focus-visible ring"
    );

    tree.pointer_down();
    assert!(!tree.focus_visible, "pointer modality hides the ring again");
}

#[test]
fn semantic_link_foreground_and_hover_inherit_into_nested_text() {
    let root: Node = serde_json::from_value(json!({
        "id":"root","kind":"window","style":{},"children":[
            {
                "id":"link","kind":"pressable",
                "style":{
                    "width":180,"height":36,
                    "foreground":"#2563eb",
                    "hover":{"foreground":"#dc2626"}
                },
                "control":{"role":"link","label":"Documentation"},
                "children":[
                    {
                        "id":"row","kind":"row","style":{},"children":[
                            {"id":"label","kind":"text","text":"Documentation","style":{"foreground":"#18181b"},"children":[]}
                        ]
                    }
                ]
            }
        ]
    }))
    .unwrap();
    let mut tree = Tree::new(root);
    tree.compute(300.0, 120.0).unwrap();
    assert_eq!(tree.resolved_text_foreground("label", "#18181b"), "#2563eb");
    tree.pointer_move(20.0, 18.0);
    assert_eq!(tree.resolved_text_foreground("label", "#18181b"), "#dc2626");
}

#[test]
fn otp_slot_focus_follows_the_native_input_caret() {
    let mut input = node(
        "otp-input",
        "input",
        json!({"width":168,"height":42,"position":"absolute"}),
        vec![],
    );
    input.value = Some("12".into());
    let slots = (0..4)
        .map(|index| {
            let mut slot = node(
                &format!("slot-{index}"),
                "view",
                json!({
                    "width":36,
                    "height":42,
                    "focus":{
                        "outlineWidth":2,
                        "outlineOffset":2,
                        "outlineColor":"#a1a1aa",
                        "outlineStyle":"solid"
                    }
                }),
                vec![],
            );
            slot.control = Some(
                serde_json::from_value(json!({
                    "role":"otpSlot",
                    "group":"otp-input",
                    "value":index,
                    "max":3
                }))
                .unwrap(),
            );
            slot
        })
        .collect();
    let mut tree = Tree::new(root(vec![
        input,
        node("slots", "row", json!({"gap":8}), slots),
    ]));
    tree.compute(320.0, 120.0).unwrap();

    let _ = tree.focus("otp-input");
    assert_eq!(
        tree.resolved_visual_number("slot-2", "outlineWidth", 0.0),
        2.0
    );
    assert_eq!(
        tree.resolved_visual_number("slot-1", "outlineWidth", 0.0),
        0.0
    );

    tree.key("ArrowLeft");
    assert_eq!(
        tree.resolved_visual_number("slot-1", "outlineWidth", 0.0),
        2.0
    );
    assert_eq!(
        tree.resolved_visual_number("slot-2", "outlineWidth", 0.0),
        0.0
    );

    tree.key("Home");
    assert_eq!(
        tree.resolved_visual_number("slot-0", "outlineWidth", 0.0),
        2.0
    );
}

#[test]
fn password_input_masks_rendered_text_and_does_not_copy_selection() {
    let mut input = node(
        "password",
        "input",
        json!({"width":220,"height":38,"fontSize":14,"padding":{"left":12,"right":12}}),
        vec![],
    );
    input.input_type = "password".into();
    input.value = Some("é🙂a".into());
    assert_eq!(input.display_text(), "•••");

    let mut tree = Tree::new(root(vec![input]));
    tree.compute(300.0, 100.0).unwrap();
    let _ = tree.focus("password");
    tree.key("SelectAll");
    assert_eq!(tree.selected_text(), None);
    let snapshots = tree.snapshots();
    let password = snapshots
        .iter()
        .find(|entry| entry["id"] == "password")
        .unwrap();
    assert_eq!(password["text"], "•••");
}

#[test]
fn number_input_rejects_non_numeric_native_edits() {
    let mut input = node(
        "number",
        "input",
        json!({"width":220,"height":38,"fontSize":14}),
        vec![],
    );
    input.input_type = "number".into();
    input.value = Some("12".into());
    let mut tree = Tree::new(root(vec![input]));
    tree.compute(300.0, 100.0).unwrap();
    let _ = tree.focus("number");
    tree.key("End");
    assert!(tree.type_text("x").is_empty());
    assert_eq!(tree.entries["number"].node.value.as_deref(), Some("12"));
    let events = tree.type_text(".5");
    assert_eq!(tree.entries["number"].node.value.as_deref(), Some("12.5"));
    assert_eq!(events[0]["type"], "change");
}

#[test]
fn ime_preedit_replaces_selection_visually_and_commits_once() {
    let mut input = node(
        "field",
        "input",
        json!({"width":240,"height":40,"fontSize":16,"padding":8}),
        vec![],
    );
    input.value = Some("abcXYZdef".into());
    let mut tree = Tree::new(root(vec![input]));
    tree.compute(300.0, 100.0).unwrap();
    let _ = tree.focus("field");
    tree.key("Home");
    for _ in 0..3 {
        tree.key("ArrowRight");
    }
    for _ in 0..3 {
        tree.key("ShiftArrowRight");
    }

    tree.ime_preedit("field", "日本", Some((0, "日".len())));
    assert!(tree.ime_active());
    assert_eq!(tree.ime_display_text().as_deref(), Some("abc日本def"));
    assert_eq!(
        tree.entries["field"].node.value.as_deref(),
        Some("abcXYZdef")
    );

    tree.ime_preedit("field", "にほん", Some(("に".len(), "にほん".len())));
    assert_eq!(tree.ime_display_text().as_deref(), Some("abcにほんdef"));
    assert_eq!(
        tree.entries["field"].node.value.as_deref(),
        Some("abcXYZdef")
    );

    tree.ime_preedit("field", "", None);
    assert!(!tree.ime_active());
    assert_eq!(tree.ime_display_text(), None);
    let mut controlled = tree.entries["field"].node.clone();
    controlled.value = Some("server".into());
    tree.patch(vec![controlled]).unwrap();
    assert!(
        tree.ime_commit("field", "stale").is_empty(),
        "a controlled update between Winit's empty preedit and commit must reject that stale commit"
    );
    assert_eq!(tree.entries["field"].node.value.as_deref(), Some("server"));

    tree.key("SelectAll");
    tree.ime_preedit("field", "日本", Some((0, "日本".len())));
    tree.ime_preedit("field", "", None);
    let events = tree.ime_commit("field", "日本");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["type"], "change");
    assert_eq!(events[0]["value"], "日本");
    assert_eq!(tree.entries["field"].node.value.as_deref(), Some("日本"));
}

#[test]
fn ime_cancel_focus_change_and_controlled_reconciliation_reject_stale_commit() {
    let mut first = node("first", "input", json!({"width":180,"height":38}), vec![]);
    first.value = Some("hello".into());
    let mut second = node("second", "input", json!({"width":180,"height":38}), vec![]);
    second.value = Some("other".into());
    let mut tree = Tree::new(root(vec![first, second]));
    tree.compute(420.0, 100.0).unwrap();
    let _ = tree.focus("first");

    tree.ime_preedit("first", "世界", Some((0, "世界".len())));
    let same = tree.entries["first"].node.clone();
    tree.patch(vec![same]).unwrap();
    assert!(
        tree.ime_active(),
        "same controlled value must preserve preedit"
    );

    let mut changed = tree.entries["first"].node.clone();
    changed.value = Some("server".into());
    tree.patch(vec![changed]).unwrap();
    assert!(!tree.ime_active());
    tree.ime_preedit("first", "stale-preedit", Some((13, 13)));
    assert!(
        !tree.ime_active(),
        "late preedit from a rejected controlled session must stay blocked"
    );
    assert_eq!(tree.entries["first"].node.value.as_deref(), Some("server"));
    tree.ime_preedit("first", "", None);
    assert!(tree.ime_commit("first", "late").is_empty());
    assert_eq!(tree.entries["first"].node.value.as_deref(), Some("server"));

    tree.ime_enabled("first");
    tree.ime_preedit("first", "再", Some(("再".len(), "再".len())));
    assert!(tree.ime_active());
    let blurred = tree.focus("second");
    assert_eq!(blurred.as_deref(), Some("first"));
    assert!(!tree.ime_active());
    assert!(tree.ime_commit("first", "stale").is_empty());
    assert_eq!(tree.entries["second"].node.value.as_deref(), Some("other"));
}

#[test]
fn ime_new_composition_after_clear_uses_the_current_caret() {
    let mut input = node("field", "input", json!({"width":220,"height":38}), vec![]);
    input.value = Some("abcd".into());
    let mut tree = Tree::new(root(vec![input]));
    tree.compute(260.0, 80.0).unwrap();
    let _ = tree.focus("field");
    tree.key("Home");
    tree.key("ArrowRight");
    tree.ime_preedit("field", "旧", Some(("旧".len(), "旧".len())));
    tree.ime_preedit("field", "", None);

    tree.key("End");
    tree.ime_preedit("field", "", None);
    tree.ime_preedit("field", "新", Some(("新".len(), "新".len())));
    let events = tree.ime_commit("field", "新");
    assert_eq!(events[0]["value"], "abcd新");
    assert_eq!(tree.entries["field"].node.value.as_deref(), Some("abcd新"));
}

#[test]
fn ime_cursor_bytes_are_clamped_and_candidate_area_tracks_shaped_caret() {
    let mut input = node(
        "field",
        "input",
        json!({"width":260,"height":44,"fontSize":18,"padding":{"left":10,"right":10}}),
        vec![],
    );
    input.value = Some(String::new());
    let mut tree = Tree::new(root(vec![input]));
    tree.compute(320.0, 100.0).unwrap();
    let _ = tree.focus("field");

    tree.ime_preedit("field", "日本WWW", Some((2, usize::MAX)));
    let end_area = tree.ime_cursor_area().unwrap();
    assert!(end_area.width() >= 1.0 && end_area.height() >= 1.0);

    let combining = "e\u{301}x";
    tree.ime_preedit("field", combining, Some((1, 1)));
    assert_eq!(
        tree.ime_cursor_bytes(),
        Some((1, 1)),
        "Winit cursor offsets are UTF-8 byte offsets and valid char boundaries inside a grapheme must be preserved"
    );

    tree.ime_preedit("field", "日本WWW", Some((0, 0)));
    let start_area = tree.ime_cursor_area().unwrap();
    assert!(
        end_area.x0 > start_area.x0,
        "candidate area must move with the Parley-shaped preedit caret"
    );

    tree.ime_preedit("field", "日本WWW", None);
    assert!(tree.ime_cursor_area().is_some());
    tree.scene(1.0);
}

#[test]
fn textarea_ime_wraps_scrolls_and_uses_visible_composition_caret() {
    let mut area = node(
        "notes",
        "textarea",
        json!({
            "width":92,
            "height":40,
            "padding":4,
            "borderWidth":1,
            "fontSize":16,
            "lineHeight":1.4
        }),
        vec![],
    );
    area.value = Some(String::new());
    let mut tree = Tree::new(root(vec![area]));
    tree.compute(160.0, 90.0).unwrap();
    let _ = tree.focus("notes");

    let preedit = "日本語入力候補日本語入力候補日本語入力候補";
    tree.ime_preedit("notes", preedit, Some((preedit.len(), preedit.len())));
    assert_eq!(tree.entries["notes"].node.value.as_deref(), Some(""));
    assert!(tree.entries["notes"].scroll_max > 0.0);
    assert!(tree.entries["notes"].scroll > 0.0);
    let marked = tree.ime_marked_rects();
    assert!(
        marked.len() >= 2 && marked.iter().all(|rect| rect.width() > 0.0),
        "wrapped preedit must retain marked geometry on every visual line"
    );
    let caret = tree.ime_cursor_area().unwrap();
    let rect = tree.entries["notes"].rect;
    assert!(caret.y0 >= rect.y0 - 1.0 && caret.y1 <= rect.y1 + 1.0);

    let events = tree.ime_commit("notes", "日本語");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["value"], "日本語");
}

#[test]
fn textarea_ime_geometry_matches_text_alignment() {
    fn candidate_x(text_align: &str) -> (f64, f64) {
        let mut area = node(
            "notes",
            "textarea",
            json!({
                "width":220,
                "height":70,
                "padding":8,
                "borderWidth":1,
                "fontSize":18,
                "textAlign":text_align
            }),
            vec![],
        );
        area.value = Some(String::new());
        let mut tree = Tree::new(root(vec![area]));
        tree.compute(280.0, 110.0).unwrap();
        let _ = tree.focus("notes");
        tree.ime_preedit("notes", "abc", Some((3, 3)));
        let caret = tree.ime_cursor_area().unwrap();
        let marked = tree.ime_marked_rects();
        (caret.x0, marked[0].x0)
    }

    let (start_caret, start_mark) = candidate_x("start");
    let (end_caret, end_mark) = candidate_x("end");
    assert!(
        end_caret > start_caret + 80.0,
        "candidate caret must follow end-aligned rendered text"
    );
    assert!(
        end_mark > start_mark + 80.0,
        "marked preedit geometry must follow end-aligned rendered text"
    );
}

#[test]
fn ime_password_stays_masked_and_number_validation_happens_on_commit() {
    let mut password = node(
        "password-ime",
        "input",
        json!({"width":220,"height":38}),
        vec![],
    );
    password.input_type = "password".into();
    password.value = Some("secret".into());
    let mut tree = Tree::new(root(vec![password]));
    tree.compute(260.0, 80.0).unwrap();
    let _ = tree.focus("password-ime");
    tree.key("SelectAll");
    tree.ime_preedit("password-ime", "日本", Some((0, "日本".len())));
    let display = tree.ime_display_text().unwrap();
    assert_eq!(display, "••");
    assert!(!display.contains('日'));
    tree.ime_cancel();
    assert_eq!(
        tree.entries["password-ime"].node.value.as_deref(),
        Some("secret")
    );

    let mut number = node(
        "number-ime",
        "input",
        json!({"width":220,"height":38}),
        vec![],
    );
    number.input_type = "number".into();
    number.value = Some("12".into());
    let mut numbers = Tree::new(root(vec![number]));
    numbers.compute(260.0, 80.0).unwrap();
    let _ = numbers.focus("number-ime");
    numbers.ime_preedit("number-ime", "abc", Some((3, 3)));
    assert_eq!(numbers.ime_display_text().as_deref(), Some("12abc"));
    assert!(numbers.ime_commit("number-ime", "abc").is_empty());
    assert_eq!(
        numbers.entries["number-ime"].node.value.as_deref(),
        Some("12")
    );
    numbers.ime_preedit("number-ime", ".5", Some((2, 2)));
    let events = numbers.ime_commit("number-ime", ".5");
    assert_eq!(events[0]["value"], "12.5");
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
fn variable_virtual_list_measures_rows_and_anchors_growth_above_viewport() {
    let rows = ["a", "b", "c", "d", "e"]
        .into_iter()
        .map(|id| node(id, "row", json!({"height":40,"shrink":0}), vec![]))
        .collect();
    let mut scroll = node(
        "variable-list",
        "scroll",
        json!({"height":100}),
        vec![node(
            "variable-content",
            "column",
            json!({"width":"100%"}),
            rows,
        )],
    );
    scroll.control =
        Some(serde_json::from_value(json!({"role":"virtualList","value":60})).unwrap());
    scroll.virtual_list = Some(
        serde_json::from_value(json!({
            "estimatedItemHeight":40,
            "itemCount":5,
            "windowStart":0,
            "windowEnd":5,
            "renderedKeys":["s:a","s:b","s:c","s:d","s:e"]
        }))
        .unwrap(),
    );

    let mut tree = Tree::new(root(vec![scroll]));
    tree.compute(240.0, 180.0).unwrap();
    assert_eq!(tree.entries["variable-list"].scroll, 60.0);
    assert_eq!(tree.entries["variable-list"].scroll_max, 100.0);
    let initial = tree.take_layout_events();
    let measured = initial
        .iter()
        .find(|event| event["type"] == "virtualListLayout")
        .expect("variable rows emit native measurements");
    assert_eq!(measured["items"].as_array().unwrap().len(), 5);

    tree.patch(vec![node(
        "a",
        "row",
        json!({"height":60,"shrink":0}),
        vec![],
    )])
    .unwrap();
    tree.compute(240.0, 180.0).unwrap();

    assert_eq!(tree.entries["variable-list"].scroll_max, 120.0);
    assert_eq!(
        tree.entries["variable-list"].scroll, 80.0,
        "growing a row above the top anchor must preserve the same viewport position"
    );
    let events = tree.take_layout_events();
    assert!(events.iter().any(|event| {
        event["type"] == "scroll" && event["id"] == "variable-list" && event["offset"] == 80.0
    }));
    assert!(events.iter().any(|event| {
        event["type"] == "virtualListLayout"
            && event["id"] == "variable-list"
            && event["items"].as_array().is_some_and(|items| {
                items
                    .iter()
                    .any(|item| item["key"] == "s:a" && item["height"] == 60.0)
            })
    }));
}

#[test]
fn variable_virtual_list_retains_keyed_anchor_through_prepend_and_reorder() {
    fn list_patch(keys: &[&str], count: usize) -> Node {
        let mut scroll = node("variable-list", "scroll", json!({"height":80}), vec![]);
        scroll.control =
            Some(serde_json::from_value(json!({"role":"virtualList","value":60})).unwrap());
        scroll.virtual_list = Some(
            serde_json::from_value(json!({
                "estimatedItemHeight":40,
                "itemCount":count,
                "windowStart":0,
                "windowEnd":count,
                "renderedKeys":keys.iter().map(|key| format!("s:{key}")).collect::<Vec<_>>()
            }))
            .unwrap(),
        );
        scroll
    }

    let initial_rows = ["a", "b", "c", "d"]
        .into_iter()
        .map(|id| node(id, "row", json!({"height":40,"shrink":0}), vec![]))
        .collect();
    let mut scroll = list_patch(&["a", "b", "c", "d"], 4);
    scroll.children = vec![node(
        "variable-content",
        "column",
        json!({"width":"100%"}),
        initial_rows,
    )];
    let mut tree = Tree::new(root(vec![scroll]));
    tree.compute(240.0, 180.0).unwrap();
    tree.take_layout_events();
    assert_eq!(tree.entries["variable-list"].scroll, 60.0);

    tree.mutate(vec![
        TreeMutation::Create {
            node: Box::new(node("x", "row", json!({"height":30,"shrink":0}), vec![])),
        },
        TreeMutation::Patch {
            node: Box::new(list_patch(&["x", "a", "b", "c", "d"], 5)),
        },
        TreeMutation::Children {
            id: "variable-content".into(),
            children: ["x", "a", "b", "c", "d"]
                .into_iter()
                .map(str::to_string)
                .collect(),
        },
    ])
    .unwrap();
    tree.compute(240.0, 180.0).unwrap();
    assert_eq!(
        tree.entries["variable-list"].scroll, 90.0,
        "prepending 30 px before the retained b anchor must compensate by 30 px"
    );
    tree.take_layout_events();

    tree.mutate(vec![
        TreeMutation::Patch {
            node: Box::new(list_patch(&["x", "b", "a", "c", "d"], 5)),
        },
        TreeMutation::Children {
            id: "variable-content".into(),
            children: ["x", "b", "a", "c", "d"]
                .into_iter()
                .map(str::to_string)
                .collect(),
        },
    ])
    .unwrap();
    tree.compute(240.0, 180.0).unwrap();
    assert_eq!(
        tree.entries["variable-list"].scroll, 50.0,
        "reordering must keep the same b row at its previous intra-viewport offset"
    );
    assert!(tree.take_layout_events().iter().any(|event| {
        event["type"] == "scroll" && event["id"] == "variable-list" && event["offset"] == 50.0
    }));
}

#[test]
fn variable_virtual_list_follow_tail_stops_and_resumes_with_user_scroll() {
    fn tail_list(keys: &[&str], follow_tail: bool) -> Node {
        let rows = keys
            .iter()
            .map(|id| node(id, "row", json!({"height":40,"shrink":0}), vec![]))
            .collect();
        let mut scroll = node(
            "tail-list",
            "scroll",
            json!({"height":80}),
            vec![node(
                "tail-content",
                "column",
                json!({"width":"100%"}),
                rows,
            )],
        );
        scroll.control =
            Some(serde_json::from_value(json!({"role":"virtualList","value":0})).unwrap());
        scroll.virtual_list = Some(
            serde_json::from_value(json!({
                "estimatedItemHeight":40,
                "itemCount":keys.len(),
                "windowStart":0,
                "windowEnd":keys.len(),
                "renderedKeys":keys.iter().map(|key| format!("s:{key}")).collect::<Vec<_>>(),
                "alignment":"bottom",
                "followTail":follow_tail
            }))
            .unwrap(),
        );
        scroll
    }

    let mut tree = Tree::new(root(vec![tail_list(&["a", "b", "c", "d", "e"], true)]));
    tree.compute(240.0, 180.0).unwrap();
    assert_eq!(tree.entries["tail-list"].scroll_max, 120.0);
    assert_eq!(tree.entries["tail-list"].scroll, 120.0);
    assert!(tree.take_layout_events().iter().any(|event| {
        event["type"] == "scroll" && event["id"] == "tail-list" && event["offset"] == 120.0
    }));

    tree.update(root(vec![tail_list(&["a", "b", "c", "d", "e", "f"], true)]));
    tree.compute(240.0, 180.0).unwrap();
    assert_eq!(tree.entries["tail-list"].scroll, 160.0);
    tree.take_layout_events();

    let rect = tree.entries["tail-list"].rect;
    tree.pointer_move(rect.x0 + 20.0, rect.y0 + 20.0);
    let events = tree.wheel(-80.0);
    assert!(events.iter().any(|event| event["type"] == "scroll"));
    assert_eq!(tree.entries["tail-list"].scroll, 80.0);

    tree.update(root(vec![tail_list(
        &["a", "b", "c", "d", "e", "f", "g"],
        true,
    )]));
    tree.compute(240.0, 180.0).unwrap();
    assert_eq!(
        tree.entries["tail-list"].scroll, 80.0,
        "appending must not pull a user who scrolled away back to the tail"
    );

    tree.pointer_move(rect.x0 + 20.0, rect.y0 + 20.0);
    tree.wheel(10_000.0);
    assert_eq!(tree.entries["tail-list"].scroll, 200.0);
    tree.update(root(vec![tail_list(
        &["a", "b", "c", "d", "e", "f", "g", "h"],
        true,
    )]));
    tree.compute(240.0, 180.0).unwrap();
    assert_eq!(
        tree.entries["tail-list"].scroll, 240.0,
        "returning to the end must resume tail following"
    );
}

#[test]
fn variable_virtual_list_scroll_request_applies_each_generation_once_and_inspects_anchor() {
    fn requested_list(request: Option<(u64, f64)>) -> Node {
        let rows = ["a", "b", "c", "d", "e"]
            .into_iter()
            .map(|id| node(id, "row", json!({"height":40,"shrink":0}), vec![]))
            .collect();
        let mut scroll = node(
            "requested-list",
            "scroll",
            json!({"height":80}),
            vec![node(
                "requested-content",
                "column",
                json!({"width":"100%"}),
                rows,
            )],
        );
        scroll.control =
            Some(serde_json::from_value(json!({"role":"virtualList","value":0})).unwrap());
        let mut metadata = json!({
            "estimatedItemHeight":40,
            "itemCount":5,
            "windowStart":0,
            "windowEnd":5,
            "renderedKeys":["s:a","s:b","s:c","s:d","s:e"],
            "alignment":"top",
            "followTail":false
        });
        if let Some((generation, offset)) = request {
            metadata["scrollRequest"] = json!({"generation":generation,"offset":offset});
        }
        scroll.virtual_list = Some(serde_json::from_value(metadata).unwrap());
        scroll
    }

    let mut tree = Tree::new(root(vec![requested_list(None)]));
    tree.compute(240.0, 180.0).unwrap();
    tree.take_layout_events();
    assert_eq!(
        tree.request_virtual_scroll_to_item("requested-list", 3, 5.0)
            .unwrap(),
        vec![json!({
            "type":"virtualListScrollToItem", "id":"requested-list", "index":3, "offset":5.0
        })]
    );
    assert!(
        tree.request_virtual_scroll_to_item("requested-list", 5, 0.0)
            .is_err()
    );

    tree.update(root(vec![requested_list(Some((1, 125.0)))]));
    tree.compute(240.0, 180.0).unwrap();
    assert_eq!(tree.entries["requested-list"].scroll, 120.0);
    let applied = tree.take_layout_events();
    assert!(applied.iter().any(|event| {
        event["type"] == "scroll" && event["id"] == "requested-list" && event["offset"] == 120.0
    }));
    let snapshots = tree.snapshots();
    let list = snapshots
        .iter()
        .find(|snapshot| snapshot["id"] == "requested-list")
        .unwrap();
    assert_eq!(list["virtualListAnchor"]["index"], 3);
    assert_eq!(list["virtualListAnchor"]["key"], "s:d");
    assert_eq!(list["virtualListAnchor"]["offset"], 0.0);

    tree.update(root(vec![requested_list(Some((1, 40.0)))]));
    tree.compute(240.0, 180.0).unwrap();
    assert_eq!(
        tree.entries["requested-list"].scroll, 120.0,
        "an already-applied generation must not replay with a new offset"
    );
    assert!(
        !tree
            .take_layout_events()
            .iter()
            .any(|event| event["type"] == "scroll")
    );

    tree.update(root(vec![requested_list(Some((2, 40.0)))]));
    tree.compute(240.0, 180.0).unwrap();
    assert_eq!(tree.entries["requested-list"].scroll, 40.0);
}

#[test]
fn variable_virtual_list_reports_focused_row_key_and_clears_it_on_blur() {
    let mut editor = node(
        "focused-editor",
        "input",
        json!({"width":160,"height":32}),
        vec![],
    );
    editor.value = Some("edit".into());
    let row = node(
        "focused-row",
        "row",
        json!({"height":40,"shrink":0}),
        vec![editor],
    );
    let mut list = node(
        "focused-list",
        "scroll",
        json!({"height":80}),
        vec![node(
            "focused-content",
            "column",
            json!({"width":"100%"}),
            vec![row],
        )],
    );
    list.control = Some(serde_json::from_value(json!({"role":"virtualList","value":0})).unwrap());
    list.virtual_list = Some(
        serde_json::from_value(json!({
            "estimatedItemHeight":40,
            "itemCount":1,
            "windowStart":0,
            "windowEnd":1,
            "renderedKeys":["s:row"]
        }))
        .unwrap(),
    );

    let mut tree = Tree::new(root(vec![list]));
    tree.compute(240.0, 160.0).unwrap();
    let _ = tree.focus("focused-editor");
    assert_eq!(
        tree.take_interaction_events(),
        vec![json!({"type":"virtualListFocus","id":"focused-list","key":"s:row"})]
    );

    assert_eq!(tree.blur().as_deref(), Some("focused-editor"));
    assert_eq!(
        tree.take_interaction_events(),
        vec![json!({"type":"virtualListFocus","id":"focused-list","key":null})]
    );
}

#[test]
fn variable_virtual_list_parked_editor_retains_focus_value_and_caret_and_leaves_tab_order() {
    fn list_patch(retained: bool) -> Node {
        let mut list = node("parking-list", "scroll", json!({"height":80}), vec![]);
        list.control =
            Some(serde_json::from_value(json!({"role":"virtualList","value":0})).unwrap());
        list.virtual_list = Some(
            serde_json::from_value(if retained {
                json!({
                    "estimatedItemHeight":40,
                    "itemCount":5,
                    "windowStart":3,
                    "windowEnd":5,
                    "renderedKeys":["s:d","s:e"],
                    "retainedKey":"s:b"
                })
            } else {
                json!({
                    "estimatedItemHeight":40,
                    "itemCount":5,
                    "windowStart":0,
                    "windowEnd":2,
                    "renderedKeys":["s:a","s:b"]
                })
            })
            .unwrap(),
        );
        list
    }

    let mut editor = node(
        "parking-editor",
        "input",
        json!({"width":160,"height":32}),
        vec![],
    );
    editor.value = Some("abcd".into());
    let row_a = node("parking-a", "row", json!({"height":40,"shrink":0}), vec![]);
    let row_b = node(
        "parking-b",
        "row",
        json!({"height":40,"shrink":0}),
        vec![editor],
    );
    let after = node(
        "parking-after",
        "row",
        json!({"height":120,"shrink":0}),
        vec![],
    );
    let mut list = list_patch(false);
    list.children = vec![node(
        "parking-content",
        "column",
        json!({"width":"100%"}),
        vec![row_a, row_b, after],
    )];
    let mut next = node(
        "parking-next",
        "input",
        json!({"width":160,"height":32}),
        vec![],
    );
    next.value = Some(String::new());

    let mut tree = Tree::new(root(vec![list, next]));
    tree.compute(260.0, 180.0).unwrap();
    let _ = tree.focus("parking-editor");
    tree.take_interaction_events();
    tree.key("ArrowLeft");

    let parked_row = node(
        "parking-b",
        "row",
        json!({
            "position":"absolute",
            "top":-1_000_000,
            "left":0,
            "width":"100%",
            "shrink":0
        }),
        vec![],
    );
    tree.mutate(vec![
        TreeMutation::Create {
            node: Box::new(node(
                "parking-before",
                "row",
                json!({"height":120,"shrink":0}),
                vec![],
            )),
        },
        TreeMutation::Create {
            node: Box::new(node(
                "parking-d",
                "row",
                json!({"height":40,"shrink":0}),
                vec![],
            )),
        },
        TreeMutation::Create {
            node: Box::new(node(
                "parking-e",
                "row",
                json!({"height":40,"shrink":0}),
                vec![],
            )),
        },
        TreeMutation::Patch {
            node: Box::new(list_patch(true)),
        },
        TreeMutation::Patch {
            node: Box::new(parked_row),
        },
        TreeMutation::Children {
            id: "parking-content".into(),
            children: vec![
                "parking-before".into(),
                "parking-d".into(),
                "parking-e".into(),
                "parking-b".into(),
            ],
        },
        TreeMutation::Remove {
            id: "parking-a".into(),
        },
        TreeMutation::Remove {
            id: "parking-after".into(),
        },
    ])
    .unwrap();
    tree.compute(260.0, 180.0).unwrap();

    assert_eq!(tree.focused.as_deref(), Some("parking-editor"));
    assert!(tree.is_virtual_parked("parking-b"));
    assert!(tree.is_virtual_parked("parking-editor"));
    assert_eq!(
        tree.entries["parking-editor"].node.value.as_deref(),
        Some("abcd")
    );
    let change = tree.type_text("X");
    assert_eq!(
        tree.entries["parking-editor"].node.value.as_deref(),
        Some("abcXd"),
        "parking must preserve the native caret position"
    );
    assert_eq!(change[0]["id"], "parking-editor");

    tree.key("Tab");
    assert_eq!(
        tree.focused.as_deref(),
        Some("parking-next"),
        "parked descendants must be skipped by keyboard focus traversal"
    );
    assert_eq!(
        tree.take_interaction_events(),
        vec![json!({"type":"virtualListFocus","id":"parking-list","key":null})]
    );
}

#[test]
fn horizontal_scroll_uses_vertical_wheel_fallback_and_reports_2d_metrics() {
    let content = node(
        "content",
        "view",
        json!({"width":600,"height":60,"shrink":0}),
        vec![],
    );
    let mut scroll = node(
        "scroll",
        "scroll",
        json!({"width":120,"height":60}),
        vec![content],
    );
    scroll.scroll_orientation = "horizontal".into();
    let mut tree = Tree::new(root(vec![scroll]));
    tree.compute(240.0, 120.0).unwrap();
    assert!(tree.entries["scroll"].scroll_max_x > 0.0);
    assert_eq!(tree.entries["scroll"].scroll_max, 0.0);

    tree.pointer_move(40.0, 30.0);
    let events = tree.wheel_2d(0.0, 36.0);
    assert_eq!(tree.entries["scroll"].scroll_x, 36.0);
    assert_eq!(tree.entries["scroll"].scroll, 0.0);
    assert_eq!(events[0]["offset"], 36.0);
    assert_eq!(events[0]["offsetX"], 36.0);
    assert_eq!(events[0]["offsetY"], 0.0);
    assert_eq!(events[0]["max"], events[0]["maxX"]);
}

#[test]
fn bidirectional_scroll_tracks_trackpad_axes_and_snapshot_positions() {
    let content = node(
        "content",
        "view",
        json!({"width":500,"height":400,"shrink":0}),
        vec![],
    );
    let mut scroll = node(
        "scroll",
        "scroll",
        json!({"width":120,"height":90}),
        vec![content],
    );
    scroll.scroll_orientation = "both".into();
    let mut tree = Tree::new(root(vec![scroll]));
    tree.compute(240.0, 160.0).unwrap();
    tree.pointer_move(40.0, 30.0);
    let events = tree.wheel_2d(24.0, 36.0);
    assert_eq!(tree.entries["scroll"].scroll_x, 24.0);
    assert_eq!(tree.entries["scroll"].scroll, 36.0);
    assert_eq!(
        events[0]["offset"], 36.0,
        "legacy scalar remains vertical for both"
    );

    let content = tree
        .snapshots()
        .into_iter()
        .find(|item| item["id"] == "content")
        .unwrap();
    assert_eq!(content["x"], -24.0);
    assert_eq!(content["y"], -36.0);
}

#[test]
fn horizontal_scrollbar_drag_and_focus_scroll_into_view_use_x_axis() {
    let spacer = node(
        "spacer",
        "view",
        json!({"width":180,"height":40,"shrink":0}),
        vec![],
    );
    let target = node(
        "target",
        "button",
        json!({"width":40,"height":40,"shrink":0}),
        vec![],
    );
    let mut scroll = node(
        "scroll",
        "scroll",
        json!({"width":100,"height":50,"direction":"row"}),
        vec![spacer, target],
    );
    scroll.scroll_orientation = "horizontal".into();
    let mut tree = Tree::new(root(vec![scroll]));
    tree.compute(220.0, 100.0).unwrap();
    tree.scene(1.0);
    let rect = tree.entries["scroll"].rect;

    tree.pointer_move(rect.x0 + 15.0, rect.y1 - 5.0);
    tree.pointer_down();
    let events = tree.pointer_move(rect.x0 + 65.0, rect.y1 - 5.0);
    assert!(tree.entries["scroll"].scroll_x > 0.0);
    assert!(events.iter().any(|event| event["type"] == "scroll"));
    tree.pointer_up();

    tree.entries.get_mut("scroll").unwrap().scroll_x = 0.0;
    let _ = tree.focus("target");
    assert!(tree.entries["scroll"].scroll_x > 0.0);
    let target = tree.visible_rect("target").unwrap();
    let viewport = tree.visible_rect("scroll").unwrap();
    assert!(target.x1 <= viewport.x1 + 1e-6);
}

#[test]
fn grid_tracks_do_not_expand_to_horizontal_scroll_min_content() {
    let mut scroll = node(
        "scroll",
        "scroll",
        json!({"width":"100%","height":80}),
        vec![node(
            "content",
            "view",
            json!({"width":1120,"height":60,"shrink":0}),
            vec![],
        )],
    );
    scroll.scroll_orientation = "horizontal".into();
    let section = node(
        "section",
        "column",
        json!({"width":"100%","padding":20}),
        vec![scroll],
    );
    let grid = node(
        "grid",
        "view",
        json!({"display":"grid","columns":2,"gap":18}),
        vec![section, node("peer", "view", json!({"height":80}), vec![])],
    );
    let mut tree = Tree::new(root(vec![node(
        "container",
        "column",
        json!({"width":"100%","padding":28}),
        vec![grid],
    )]));

    tree.compute(900.0, 300.0).unwrap();
    let grid_width = tree.entries["grid"].rect.width();
    let section_width = tree.entries["section"].rect.width();
    let scroll_width = tree.entries["scroll"].rect.width();
    assert!(grid_width < 900.0);
    assert!(
        section_width <= (grid_width - 18.0) / 2.0 + 1.0,
        "1fr grid track must behave like minmax(0, 1fr)"
    );
    assert!(
        scroll_width <= section_width + 1e-6,
        "100% ScrollArea must remain bounded by its grid parent"
    );
    assert!(
        tree.entries["scroll"].scroll_max_x > 0.0,
        "wide content should create horizontal overflow instead of widening the grid track"
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
fn user_select_none_blocks_selection_but_keeps_input_editable() {
    let mut input = node(
        "input",
        "input",
        json!({
            "width":220,"height":38,"padding":{"left":8,"right":8},"fontSize":14,
            "userSelect":"none"
        }),
        vec![],
    );
    input.value = Some("hello world".into());
    let mut tree = Tree::new(root(vec![input]));
    tree.compute(260.0, 80.0).unwrap();
    tree.scene(1.0);
    let rect = tree.entries["input"].rect;

    tree.pointer_move(rect.x0 + 10.0, rect.y0 + 18.0);
    tree.pointer_down();
    tree.pointer_move(rect.x0 + 90.0, rect.y0 + 18.0);
    tree.pointer_up();
    assert_eq!(tree.selected_text(), None);

    tree.key("SelectAll");
    assert_eq!(tree.selected_text(), None);
    assert!(
        tree.accessibility_set_text_selection("input", 0, 5)
            .is_empty()
    );
    assert_eq!(tree.selected_text(), None);

    tree.key("End");
    tree.type_text("!");
    assert_eq!(
        tree.entries["input"].node.value.as_deref(),
        Some("hello world!")
    );
}

#[test]
fn user_select_all_makes_input_selection_atomic() {
    let mut input = node(
        "input",
        "input",
        json!({
            "width":220,"height":38,"padding":{"left":8,"right":8},"fontSize":14,
            "userSelect":"all"
        }),
        vec![],
    );
    input.value = Some("hello world".into());
    let mut tree = Tree::new(root(vec![input]));
    tree.compute(260.0, 80.0).unwrap();
    tree.scene(1.0);
    let rect = tree.entries["input"].rect;

    tree.pointer_move(rect.x0 + 48.0, rect.y0 + 18.0);
    tree.pointer_down();
    tree.pointer_up();
    assert_eq!(tree.selected_text().as_deref(), Some("hello world"));

    tree.type_text("replacement");
    assert_eq!(
        tree.entries["input"].node.value.as_deref(),
        Some("replacement")
    );
}

#[test]
fn user_select_auto_text_and_all_work_for_static_text() {
    let mut first = node("first", "text", json!({"width":160,"fontSize":14}), vec![]);
    first.text = "First selectable text".into();
    let mut second = node("second", "text", json!({"width":160,"fontSize":14}), vec![]);
    second.text = "Second selectable text".into();
    let group = node(
        "group",
        "column",
        json!({"width":180,"gap":8,"userSelect":"all"}),
        vec![first, second],
    );
    let mut tree = Tree::new(root(vec![group]));
    tree.compute(240.0, 140.0).unwrap();
    tree.scene(1.0);

    assert_eq!(
        tree.user_select_mode("first"),
        crate::tree::UserSelectMode::All
    );
    let rect = tree.entries["first"].rect;
    tree.pointer_move(rect.x0 + 20.0, rect.y0 + 8.0);
    tree.pointer_down();
    tree.pointer_up();
    assert_eq!(
        tree.selected_text().as_deref(),
        Some("First selectable text\nSecond selectable text")
    );

    tree.entries.get_mut("first").unwrap().node.style["userSelect"] = json!("text");
    assert_eq!(
        tree.user_select_mode("first"),
        crate::tree::UserSelectMode::Text
    );
}

#[test]
fn user_select_defaults_to_none_and_explicit_text_opts_in() {
    let mut default_text = node("default", "text", json!({"width":160}), vec![]);
    default_text.text = "Native default".into();
    let mut auto_text = node(
        "auto",
        "text",
        json!({"width":160,"userSelect":"auto"}),
        vec![],
    );
    auto_text.text = "Auto default".into();
    let mut selectable_text = node(
        "selectable",
        "text",
        json!({"width":160,"userSelect":"text"}),
        vec![],
    );
    selectable_text.text = "Selectable".into();
    let mut input = node("input", "input", json!({"width":160}), vec![]);
    input.value = Some("Editable".into());
    let tree = Tree::new(root(vec![default_text, auto_text, selectable_text, input]));

    assert_eq!(
        tree.user_select_mode("default"),
        crate::tree::UserSelectMode::None
    );
    assert_eq!(
        tree.user_select_mode("auto"),
        crate::tree::UserSelectMode::None
    );
    assert_eq!(
        tree.user_select_mode("selectable"),
        crate::tree::UserSelectMode::Text
    );
    assert_eq!(
        tree.user_select_mode("input"),
        crate::tree::UserSelectMode::Text
    );
}

#[test]
fn user_select_text_supports_partial_static_selection_and_blocking_layers() {
    let mut text = node(
        "text",
        "text",
        json!({"width":220,"fontSize":14,"userSelect":"text"}),
        vec![],
    );
    text.text = "hello selectable world".into();
    let mut tree = Tree::new(root(vec![text]));
    tree.compute(260.0, 80.0).unwrap();
    tree.scene(1.0);
    let rect = tree.entries["text"].rect;
    tree.pointer_move(rect.x0 + 8.0, rect.y0 + 8.0);
    tree.pointer_down();
    tree.pointer_move(rect.x0 + 70.0, rect.y0 + 8.0);
    tree.pointer_up();
    let selected = tree.selected_text().unwrap();
    assert!(!selected.is_empty());
    assert_ne!(selected, "hello selectable world");

    let mut behind = node("behind", "text", json!({"width":220,"fontSize":14}), vec![]);
    behind.text = "must not select through overlay".into();
    let overlay = node(
        "overlay",
        "view",
        json!({"position":"absolute","width":220,"height":30,"pointerEvents":"block","zIndex":10}),
        vec![],
    );
    let mut blocked = Tree::new(root(vec![behind, overlay]));
    blocked.compute(260.0, 80.0).unwrap();
    blocked.scene(1.0);
    let rect = blocked.entries["behind"].rect;
    blocked.pointer_move(rect.x0 + 10.0, rect.y0 + 8.0);
    blocked.pointer_down();
    blocked.pointer_move(rect.x0 + 80.0, rect.y0 + 8.0);
    blocked.pointer_up();
    assert_eq!(blocked.selected_text(), None);
}

#[test]
fn user_select_none_inherits_through_auto_and_explicit_text_can_override_it() {
    let mut inherited = node("inherited", "text", json!({"width":120}), vec![]);
    inherited.text = "Inherited".into();
    let mut override_text = node(
        "override",
        "text",
        json!({"width":120,"userSelect":"text"}),
        vec![],
    );
    override_text.text = "Override".into();
    let parent = node(
        "parent",
        "column",
        json!({"userSelect":"none"}),
        vec![inherited, override_text],
    );
    let tree = Tree::new(root(vec![parent]));
    assert_eq!(
        tree.user_select_mode("inherited"),
        crate::tree::UserSelectMode::None
    );
    assert_eq!(
        tree.user_select_mode("override"),
        crate::tree::UserSelectMode::Text
    );
}

#[test]
fn native_markdown_and_code_retain_single_nodes_and_select_rendered_text() {
    let mut markdown = node(
        "markdown",
        "markdown",
        json!({"width":240,"userSelect":"text"}),
        vec![],
    );
    markdown.source = "# Hello **world**\n\nA [link](https://example.com).".into();
    let mut code = node(
        "code",
        "code",
        json!({"width":240,"userSelect":"text"}),
        vec![],
    );
    code.text = "const answer = 42;".into();
    code.language = "js".into();
    let mut tree = Tree::new(root(vec![markdown, code]));
    tree.compute(320.0, 200.0).unwrap();
    tree.scene(1.0);
    assert_eq!(tree.layout_node_count(), 3);
    assert!(tree.entries["markdown"].node.text.contains("Hello world"));
    assert!(!tree.entries["markdown"].node.text.contains("**"));
    assert!(tree.text.layouts.contains_key("markdown"));
    assert!(tree.text.layouts.contains_key("code"));

    let rect = tree.entries["code"].rect;
    tree.pointer_move(rect.x0 + 2.0, rect.y0 + 8.0);
    tree.pointer_down();
    tree.pointer_move(rect.x0 + 95.0, rect.y0 + 8.0);
    tree.pointer_up();
    assert!(
        tree.selected_text()
            .is_some_and(|text| text.starts_with("const"))
    );
    let previous_shapes = tree.text.shapes;
    let mut updated = node(
        "markdown",
        "markdown",
        json!({"width":240,"userSelect":"text"}),
        vec![],
    );
    updated.source = "# Updated document".into();
    tree.patch(vec![updated]).unwrap();
    tree.compute(320.0, 200.0).unwrap();
    assert_eq!(tree.entries["markdown"].node.text, "Updated document");
    assert_eq!(tree.text.shapes, previous_shapes + 1);
    assert_eq!(tree.layout_node_count(), 3);
}

#[test]
fn native_diff_shapes_only_visible_lines_and_reuses_leaf_identity() {
    let old = String::new();
    let new = (0..2500).map(|i| format!("line {i}\n")).collect::<String>();
    let mut diff = node("diff", "diff", json!({"shrink":0}), vec![]);
    diff.old_text = Some(old);
    diff.new_text = Some(new);
    let scroll = node("scroll", "scroll", json!({"height":120}), vec![diff]);
    let mut tree = Tree::new(root(vec![scroll]));
    tree.compute(420.0, 180.0).unwrap();
    tree.scene(1.0);
    assert_eq!(tree.layout_node_count(), 3);
    let first: Vec<_> = tree.text.diff_layouts["diff"].keys().copied().collect();
    assert!(!first.is_empty() && first.len() < 30);
    tree.pointer_move(20.0, 40.0);
    tree.wheel(80_000.0);
    tree.scene(1.0);
    let second = &tree.text.diff_layouts["diff"];
    assert!(!second.is_empty() && second.len() < 30);
    assert!(second.keys().all(|index| !first.contains(index)));
    assert_eq!(tree.layout_node_count(), 3);
}

#[test]
fn native_diff_gutter_selection_copies_content_without_line_numbers() {
    let mut diff = node(
        "diff",
        "diff",
        json!({"width":460,"userSelect":"text"}),
        vec![],
    );
    diff.source = "--- a/demo.rs\n+++ b/demo.rs\n@@ -1 +1 @@\n-old value\n+new value\n".into();
    let mut tree = Tree::new(root(vec![diff]));
    tree.compute(500.0, 160.0).unwrap();
    tree.scene(1.0);
    let rect = tree.entries["diff"].rect;
    let line_height = 13.0 * 1.5;
    // The rows are hunk, removed, added: the `---`/`+++` headers are file
    // metadata and are never painted.
    let removed_index = diff_row_index(&tree, "diff", crate::rich::DiffRowKind::Removed);
    let added_index = diff_row_index(&tree, "diff", crate::rich::DiffRowKind::Added);
    let removed_y = rect.y0 + line_height * removed_index as f64 + line_height / 2.0;
    let added_y = rect.y0 + line_height * added_index as f64 + line_height / 2.0;
    tree.pointer_move(rect.x0 + 4.0, removed_y);
    tree.pointer_down();
    tree.pointer_move(rect.x0 + 440.0, added_y);
    tree.pointer_up();
    let selected = tree.selected_text().unwrap();
    // Copy carries the source text only: no gutter numbers, no +/- markers and
    // no hunk banner.
    assert_eq!(selected, "old value\nnew value");
}

/// Row index of the first row with this kind, read from the parsed model rather
/// than hardcoded, so a parse change does not silently move a click target.
fn diff_row_index(tree: &Tree, id: &str, kind: crate::rich::DiffRowKind) -> usize {
    match tree.entries[id].node.rich.as_deref().unwrap() {
        crate::rich::RichContent::Diff { rows, .. } => rows
            .iter()
            .position(|row| row.kind == kind)
            .expect("row kind present"),
        _ => panic!("expected diff"),
    }
}

#[test]
fn native_diff_file_toggle_and_show_more_emit_events_from_one_leaf() {
    let mut diff = node(
        "diff",
        "diff",
        json!({"width":460,"userSelect":"text"}),
        vec![],
    );
    diff.source = "diff --git a/demo.rs b/demo.rs\n--- a/demo.rs\n+++ b/demo.rs\n@@ -1,2 +1,2 @@\n-old\n+new\n same\n".into();
    diff.max_lines = Some(1);
    let mut tree = Tree::new(root(vec![diff]));
    tree.compute(500.0, 200.0).unwrap();
    tree.scene(1.0);
    assert_eq!(tree.layout_node_count(), 2);
    let rect = tree.entries["diff"].rect;
    let line_height = 13.0 * 1.5;
    let header_index = diff_row_index(&tree, "diff", crate::rich::DiffRowKind::Header);
    tree.pointer_move(
        rect.x0 + 8.0,
        rect.y0 + line_height * header_index as f64 + line_height / 2.0,
    );
    tree.pointer_down();
    let events = tree.pointer_up();
    assert!(
        events
            .iter()
            .any(|event| event == &json!({"type":"diffToggleFile","id":"diff","path":"demo.rs"}))
    );
    let show_more = match tree.entries["diff"].node.rich.as_deref().unwrap() {
        crate::rich::RichContent::Diff { rows, .. } => rows
            .iter()
            .position(|row| row.kind == crate::rich::DiffRowKind::ShowMore)
            .unwrap(),
        _ => panic!("expected diff"),
    };
    tree.pointer_move(
        rect.x0 + 8.0,
        rect.y0 + line_height * (show_more as f64 + 0.5),
    );
    tree.pointer_down();
    let events = tree.pointer_up();
    assert!(
        events.iter().any(|event| event
            == &json!({"type":"diffShowMore","id":"diff","hidden":2,"path":"demo.rs"}))
    );
}

#[test]
fn inherited_highlight_matches_across_adjacent_text_and_rich_leaves() {
    let mut first = node("first", "text", json!({}), vec![]);
    first.text = "Hello ".into();
    let mut second = node("second", "text", json!({}), vec![]);
    second.text = "Tommy".into();
    let mut code = node("code", "code", json!({}), vec![]);
    code.text = "const needle = 1;".into();
    let mut markdown = node("markdown", "markdown", json!({}), vec![]);
    markdown.source = "**needle**".into();
    let mut diff = node("diff", "diff", json!({}), vec![]);
    diff.source = "--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-old\n+needle\n".into();
    let row = node("row", "row", json!({}), vec![first, second]);
    let mut scene_root = root(vec![row, code, markdown, diff]);
    scene_root.highlight =
        Some(serde_json::from_value(json!({"query":"needle","activeIndex":1})).unwrap());
    let mut tree = Tree::new(scene_root);
    tree.compute(600.0, 260.0).unwrap();
    assert!(tree.take_layout_events().iter().any(|event| event
        == &json!({
            "type":"highlight", "id":"root", "matchCount":3,
            "query":"needle", "caseSensitive":false, "wholeWord":false
        })));
    tree.scene(1.0);
    assert_eq!(tree.highlight_ranges["code"][0].range, 6..12);
    assert_eq!(tree.highlight_ranges["markdown"][0].range, 0..6);
    // The diff match sits in the added row, addressed through the same display
    // text the leaf paints, so the offset is derived rather than hardcoded.
    let diff_display = tree.entries["diff"].node.text.clone();
    let needle = diff_display
        .find("needle")
        .expect("needle in the diff text");
    assert_eq!(tree.highlight_ranges["diff"][0].range, needle..needle + 6);

    let mut cross_root = root(vec![node(
        "row",
        "row",
        json!({}),
        vec![
            {
                let mut value = node("a", "text", json!({}), vec![]);
                value.text = "Hello ".into();
                value
            },
            {
                let mut value = node("b", "text", json!({}), vec![]);
                value.text = "Tommy".into();
                value
            },
        ],
    )]);
    cross_root.highlight = Some(serde_json::from_value(json!({"query":"Hello Tommy"})).unwrap());
    let mut tree = Tree::new(cross_root);
    tree.compute(600.0, 100.0).unwrap();
    tree.scene(1.0);
    assert_eq!(tree.highlight_ranges["a"][0].range, 0..6);
    assert_eq!(tree.highlight_ranges["b"][0].range, 0..5);
}

#[test]
fn virtual_list_search_excludes_the_parked_retained_row() {
    let mut visible_text = node("visible-text", "text", json!({}), vec![]);
    visible_text.text = "needle visible".into();
    let visible_row = node(
        "visible-row",
        "row",
        json!({"height":40,"shrink":0}),
        vec![visible_text],
    );
    let after = node("after", "row", json!({"height":40,"shrink":0}), vec![]);
    let mut parked_text = node("parked-text", "text", json!({}), vec![]);
    parked_text.text = "needle parked".into();
    let parked_row = node(
        "parked-row",
        "row",
        json!({
            "position":"absolute",
            "top":-1_000_000,
            "left":0,
            "width":"100%",
            "height":40,
            "shrink":0
        }),
        vec![parked_text],
    );
    let content = node(
        "content",
        "column",
        json!({"width":"100%"}),
        vec![visible_row, after, parked_row],
    );
    let mut list = node(
        "list",
        "scroll",
        json!({"width":240,"height":80}),
        vec![content],
    );
    list.control = Some(serde_json::from_value(json!({"role":"virtualList","value":0})).unwrap());
    list.virtual_list = Some(
        serde_json::from_value(json!({
            "estimatedItemHeight":40,
            "itemCount":2,
            "windowStart":0,
            "windowEnd":1,
            "renderedKeys":["s:visible"],
            "retainedKey":"s:parked"
        }))
        .unwrap(),
    );
    list.highlight = Some(serde_json::from_value(json!({"query":"needle"})).unwrap());

    let mut tree = Tree::new(root(vec![list]));
    tree.compute(300.0, 140.0).unwrap();
    assert!(tree.is_virtual_parked("parked-row"));
    assert!(tree.is_virtual_parked("parked-text"));
    tree.scene(1.0);

    assert_eq!(tree.highlight_ranges["visible-text"].len(), 1);
    assert!(!tree.highlight_ranges.contains_key("parked-text"));
    assert!(tree.take_layout_events().contains(&json!({
        "type":"highlight",
        "id":"list",
        "matchCount":1,
        "query":"needle",
        "caseSensitive":false,
        "wholeWord":false
    })));
}

#[test]
fn whole_word_highlight_skips_embedded_words() {
    let mut text = node("text", "text", json!({}), vec![]);
    text.text = "Cat catalog cat_ cat!".into();
    text.highlight = Some(serde_json::from_value(json!({"query":"cat","wholeWord":true})).unwrap());
    let mut tree = Tree::new(root(vec![text]));
    tree.compute(300.0, 80.0).unwrap();
    assert_eq!(tree.highlight_ranges["text"].len(), 2);
    assert!(
        tree.take_layout_events()
            .contains(&json!({"type":"highlight","id":"text","matchCount":2,"query":"cat","caseSensitive":false,"wholeWord":true}))
    );
}

#[test]
fn active_highlight_scrolls_into_view_and_navigation_reveals_another_match() {
    let mut code = node("code", "code", json!({"width":300,"height":300}), vec![]);
    code.text = format!("target\n{}target", "filler\n".repeat(12));
    code.highlight =
        Some(serde_json::from_value(json!({"query":"target","activeIndex":1})).unwrap());
    let scroll = node(
        "scroll",
        "scroll",
        json!({"width":160,"height":65}),
        vec![code.clone()],
    );
    let mut tree = Tree::new(root(vec![scroll]));
    tree.compute(300.0, 120.0).unwrap();
    assert!(tree.entries["scroll"].scroll > 100.0);
    let before = tree.entries["scroll"].scroll;
    code.highlight =
        Some(serde_json::from_value(json!({"query":"target","activeIndex":0})).unwrap());
    tree.patch(vec![code]).unwrap();
    tree.compute(300.0, 120.0).unwrap();
    assert!(tree.entries["scroll"].scroll < before);
}

#[test]
fn active_highlight_reveals_horizontal_code_and_diff_rows() {
    let mut code = node("code", "code", json!({"width":90}), vec![]);
    code.text = format!("{}target", "prefix_".repeat(20));
    code.highlight =
        Some(serde_json::from_value(json!({"query":"target","activeIndex":0})).unwrap());
    let mut tree = Tree::new(root(vec![code]));
    tree.compute(180.0, 70.0).unwrap();
    assert!(tree.entries["code"].scroll_x > 0.0);

    let mut diff = node("diff", "diff", json!({"width":240,"height":400}), vec![]);
    diff.source = format!(
        "--- a/demo.txt\n+++ b/demo.txt\n@@ -1,14 +1,15 @@\n{}+target\n",
        " context\n".repeat(14)
    );
    diff.highlight =
        Some(serde_json::from_value(json!({"query":"target","activeIndex":0})).unwrap());
    let scroll = node(
        "scroll",
        "scroll",
        json!({"width":240,"height":65}),
        vec![diff],
    );
    let mut tree = Tree::new(root(vec![scroll]));
    tree.compute(300.0, 120.0).unwrap();
    assert!(tree.entries["scroll"].scroll > 100.0);
}

#[test]
fn horizontal_wheel_scrolls_a_wide_code_leaf() {
    let mut code = node(
        "code",
        "code",
        json!({"width":180,"fontFamily":"Consolas","fontSize":13}),
        vec![],
    );
    code.show_line_numbers = true;
    code.text = format!("let value = {};", "very_long_expression + ".repeat(40));
    let mut tree = Tree::new(root(vec![code]));
    tree.compute(240.0, 100.0).unwrap();
    let rect = tree.entries["code"].rect;
    assert!(
        tree.entries["code"].scroll_max_x > 0.0,
        "fixture must produce a horizontally scrollable Code"
    );
    tree.pointer_move(rect.x0 + 80.0, rect.y0 + rect.height() / 2.0);
    tree.wheel_2d(120.0, 0.0);
    assert!(
        tree.entries["code"].scroll_x > 0.0,
        "horizontal wheel must target the Code leaf"
    );
}

#[test]
fn inherited_active_highlight_reveals_a_long_diff() {
    let mut diff = node("diff", "diff", json!({"height":40000}), vec![]);
    diff.old_text = Some(String::new());
    diff.new_text = Some(format!("{}answer\n", "line\n".repeat(2000)));
    let scroll = node("scroll", "scroll", json!({"height":80}), vec![diff]);
    let mut scene = root(vec![scroll]);
    scene.highlight =
        Some(serde_json::from_value(json!({"query":"answer","activeIndex":0})).unwrap());
    let mut tree = Tree::new(scene);
    tree.compute(300.0, 120.0).unwrap();
    assert!(tree.entries["scroll"].scroll > 1000.0);
}

#[test]
fn patching_inherited_active_index_reveals_later_diff_match() {
    let mut top = node("top", "text", json!({}), vec![]);
    top.text = "answer answer answer".into();
    let mut diff = node("diff", "diff", json!({"height":40000}), vec![]);
    diff.old_text = Some(String::new());
    diff.new_text = Some(format!("{}answer\n", "line\n".repeat(2000)));
    let scroll = node("scroll", "scroll", json!({"height":80}), vec![diff]);
    let mut scene = root(vec![top, scroll]);
    scene.highlight =
        Some(serde_json::from_value(json!({"query":"answer","activeIndex":0})).unwrap());
    let mut tree = Tree::new(scene.clone());
    tree.compute(300.0, 120.0).unwrap();
    assert_eq!(tree.entries["scroll"].scroll, 0.0);
    scene.highlight =
        Some(serde_json::from_value(json!({"query":"answer","activeIndex":3})).unwrap());
    scene.children.clear();
    tree.patch(vec![scene]).unwrap();
    tree.compute(300.0, 120.0).unwrap();
    assert!(tree.entries["scroll"].scroll > 1000.0);
}

#[test]
fn a_code_gutter_numbers_every_line_including_blanks() {
    // The reported bug: with `showLineNumbers` the code painted underneath its
    // own numbers and only some of the numbers appeared, because the gutter was
    // positioned by an arithmetic pitch while the shaped layout gives a blank
    // line different metrics. This drives the real tree so the whole path —
    // measure, prepare, paint — is covered.
    let mut code = node(
        "code",
        "code",
        json!({"fontSize":13,"lineHeight":1.5,"fontFamily":"Consolas"}),
        vec![],
    );
    code.show_line_numbers = true;
    // The exact sample from the rich-content example, which reported numbers
    // only on lines 1, 2, 3 and 4 of eight.
    code.text = [
        "export interface Project {",
        "  name: string;",
        "  status: \"ready\" | \"building\";",
        "}",
        "",
        "export function label(project: Project): string {",
        "  return `${project.name}: ${project.status}`;",
        "}",
    ]
    .join("\n");
    let mut tree = Tree::new(root(vec![code]));
    tree.compute(600.0, 220.0).unwrap();
    tree.scene(1.0);
    let engine = &tree.text;
    // The gutter is built from what the layout shapes, and the layout comes from
    // the node's own text. A mismatch between the two is the bug: the numbers
    // then label the wrong lines, and the tail of the file loses its numbers.
    let shaped = engine.layouts["code"].lines().count();
    assert_eq!(
        shaped, 8,
        "Parley must keep one visual line per source line, got {shaped}"
    );
    assert_eq!(
        engine.code_gutter_layouts["code"].len(),
        shaped,
        "one number per shaped line"
    );
    // The code column is pushed past the gutter, so the first glyph cannot sit
    // under the numbers.
    let inset = engine.code_gutter_inset(&tree.entries["code"].node);
    assert!(inset > 0.0);
    // Each number is drawn on the baseline of the line it labels, so the
    // baselines must advance for every one of the eight lines.
    let baselines: Vec<f64> = engine.layouts["code"]
        .lines()
        .map(|line| f64::from(line.metrics().baseline))
        .collect();
    assert_eq!(baselines.len(), 8);
    assert!(
        baselines.windows(2).all(|pair| pair[1] > pair[0]),
        "every number needs a distinct, advancing baseline: {baselines:?}"
    );
}

#[test]
fn explicit_highlight_ranges_use_utf16_boundaries() {
    let mut text = node("text", "text", json!({}), vec![]);
    text.text = "a😀b".into();
    text.highlight = Some(
        serde_json::from_value(json!({
            "ranges":[{"start":2,"end":3},{"start":3,"end":4}]
        }))
        .unwrap(),
    );
    let mut tree = Tree::new(root(vec![text]));
    tree.compute(300.0, 80.0).unwrap();
    tree.scene(1.0);
    assert_eq!(tree.highlight_ranges["text"].len(), 1);
    assert_eq!(tree.highlight_ranges["text"][0].range, 5..6);
}

#[test]
fn diff_explicit_highlights_are_sorted_for_visible_row_lookup() {
    let mut diff = node("diff", "diff", json!({"width":300}), vec![]);
    diff.source = "--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-old\n+new\n".into();
    let mut tree = Tree::new(root(vec![diff.clone()]));
    tree.compute(350.0, 150.0).unwrap();
    let display = tree.entries["diff"].node.text.clone();
    let old = display.find("old").unwrap();
    let new = display.find("new").unwrap();
    diff.highlight = Some(
        serde_json::from_value(json!({
            "ranges":[
                {"start":new,"end":new+3},
                {"start":old,"end":old+3},
                {"start":old+1,"end":new+1}
            ]
        }))
        .unwrap(),
    );
    tree.patch(vec![diff]).unwrap();
    tree.compute(350.0, 150.0).unwrap();
    let ranges = &tree.highlight_ranges["diff"];
    // The explicit ranges arrive unsorted on purpose. Each one is looked up
    // against the visible row that owns it, so the result must come back
    // ordered by start even though the input was not.
    assert!(ranges.len() >= 2, "{ranges:?}");
    assert!(
        ranges
            .windows(2)
            .all(|pair| pair[0].range.start <= pair[1].range.start)
    );
    tree.scene(1.0);
}

#[test]
fn highlight_patches_update_paint_without_rebuilding_text_layout() {
    let mut text = node("text", "text", json!({}), vec![]);
    text.text = "alpha beta".into();
    text.highlight = Some(serde_json::from_value(json!({"query":"alpha"})).unwrap());
    let mut tree = Tree::new(root(vec![text.clone()]));
    tree.compute(300.0, 80.0).unwrap();
    tree.scene(1.0);
    let shapes = tree.text.shapes;
    let searches = tree.highlight_searches;
    assert_eq!(tree.highlight_ranges["text"][0].range, 0..5);
    tree.take_layout_events();
    text.highlight.as_mut().unwrap().active_index = Some(0);
    text.highlight.as_mut().unwrap().color = Some("#ffff00".into());
    tree.patch(vec![text.clone()]).unwrap();
    tree.compute(300.0, 80.0).unwrap();
    assert_eq!(tree.highlight_searches, searches);
    text.highlight = Some(serde_json::from_value(json!({"query":"beta"})).unwrap());
    tree.patch(vec![text]).unwrap();
    tree.compute(300.0, 80.0).unwrap();
    tree.scene(1.0);
    assert_eq!(tree.highlight_ranges["text"][0].range, 6..10);
    assert_eq!(tree.highlight_searches, searches + 1);
    assert_eq!(tree.text.shapes, shapes);
    assert!(
        tree.take_layout_events()
            .contains(&json!({"type":"highlight","id":"text","matchCount":1,"query":"beta","caseSensitive":false,"wholeWord":false}))
    );
    let mut missing = node("text", "text", json!({}), vec![]);
    missing.text = "alpha beta".into();
    missing.highlight = Some(serde_json::from_value(json!({"query":"absent"})).unwrap());
    tree.patch(vec![missing]).unwrap();
    tree.compute(300.0, 80.0).unwrap();
    assert!(tree.take_layout_events().iter().any(|event| event
        == &json!({
            "type":"highlight", "id":"text", "matchCount":0,
            "query":"absent", "caseSensitive":false, "wholeWord":false
        })));
}

#[test]
fn unrelated_control_updates_do_not_repeat_text_search() {
    let mut text = node("text", "searchable", json!({}), vec![]);
    text.text = "alpha beta gamma".into();
    text.highlight = Some(serde_json::from_value(json!({"query":"beta"})).unwrap());
    let button = node("button", "button", json!({}), vec![]);
    let mut tree = Tree::new(root(vec![text, button.clone()]));
    tree.compute(320.0, 100.0).unwrap();
    let searches = tree.highlight_searches;
    let mut updated = button;
    updated.disabled = true;
    tree.patch(vec![updated]).unwrap();
    tree.compute(320.0, 100.0).unwrap();
    assert_eq!(tree.highlight_searches, searches);
}

#[test]
fn syntax_theme_patch_rebuilds_paint_layout_without_reparsing_rich_content() {
    let mut diff = node("diff", "diff", json!({"width":460}), vec![]);
    diff.source = "--- a/demo.rs\n+++ b/demo.rs\n@@ -1 +1 @@\n-old\n+new\n".into();
    let mut tree = Tree::new(root(vec![diff.clone()]));
    tree.compute(500.0, 160.0).unwrap();
    tree.scene(1.0);
    let parsed = tree.entries["diff"].node.rich.as_ref().unwrap().clone();
    assert!(!tree.text.diff_layouts["diff"].is_empty());
    diff.syntax_theme = json!({"keyword":"#ff00aa"});
    tree.patch(vec![diff]).unwrap();
    assert!(Arc::ptr_eq(
        &parsed,
        tree.entries["diff"].node.rich.as_ref().unwrap()
    ));
    assert!(!tree.text.diff_layouts.contains_key("diff"));
    tree.compute(500.0, 160.0).unwrap();
    tree.scene(1.0);
    assert!(!tree.text.diff_layouts["diff"].is_empty());
}

#[test]
fn markdown_link_click_emits_url_without_interrupting_text_selection() {
    let mut markdown = node(
        "markdown",
        "markdown",
        json!({"width":250,"userSelect":"text"}),
        vec![],
    );
    markdown.source = "Go [here](https://example.com).".into();
    let mut tree = Tree::new(root(vec![markdown]));
    tree.compute(300.0, 80.0).unwrap();
    let rect = tree.entries["markdown"].rect;
    let link_rect = tree
        .text
        .range_rects("markdown", 3, 7, Some(rect.width() as f32))[0];
    let x = rect.x0 + (link_rect.x0 + link_rect.x1) * 0.5;
    let y = rect.y0 + (link_rect.y0 + link_rect.y1) * 0.5;
    tree.pointer_move(x, y);
    tree.pointer_down();
    let events = tree.pointer_up();
    assert!(events.iter().any(|event| event
        == &json!({
            "type":"markdownLink", "id":"markdown", "href":"https://example.com"
        })));
}

#[test]
fn wide_markdown_blocks_scroll_within_one_leaf_and_keep_text_positions() {
    let mut markdown = node(
        "markdown",
        "markdown",
        json!({"width":140,"userSelect":"text"}),
        vec![],
    );
    markdown.source = "Before the block.\n\n```txt\n0123456789abcdefghijklmnopqrstuvwxyz\n```\n\nAfter the block.".into();
    let mut tree = Tree::new(root(vec![markdown]));
    tree.compute(180.0, 300.0).unwrap();
    let display = tree.entries["markdown"].node.text.clone();
    let rect = tree.entries["markdown"].rect;
    let width = rect.width() as f32;
    let lines = tree
        .text
        .accessibility_lines("markdown", &display, Some(width));
    let code = display.find("0123456789").unwrap();
    let code_line = lines
        .iter()
        .find(|line| line.byte_range.start <= code && code < line.byte_range.end)
        .unwrap();
    let y = ((code_line.y0 + code_line.y1) / 2.0) as f32;
    let before = tree
        .text
        .index_at("markdown", 50.0, y, Some(width))
        .unwrap();
    tree.pointer_move(rect.x0 + 50.0, rect.y0 + f64::from(y));
    tree.wheel_2d(70.0, 0.0);
    let after = tree
        .text
        .index_at("markdown", 50.0, y, Some(width))
        .unwrap();
    assert!(
        after > before,
        "horizontal wheel must move the code block hit target"
    );
    let lines_after = tree
        .text
        .accessibility_lines("markdown", &display, Some(width));
    assert_eq!(
        lines_after
            .iter()
            .map(|line| line.byte_range.clone())
            .collect::<Vec<_>>(),
        lines
            .iter()
            .map(|line| line.byte_range.clone())
            .collect::<Vec<_>>()
    );
    assert!(
        tree.text
            .reveal_markdown_range("markdown", code, code + 4, width)
    );
    assert_eq!(
        tree.text
            .index_at("markdown", 50.0, y, Some(width))
            .unwrap(),
        before
    );
    assert_eq!(tree.entries["markdown"].children.len(), 0);
}

#[test]
fn wide_markdown_table_scrolls_without_moving_following_paragraph() {
    let mut markdown = node(
        "markdown",
        "markdown",
        json!({"width":130,"userSelect":"text"}),
        vec![],
    );
    markdown.source = "| Name | Value |\n| --- | ---: |\n| A | 123456789012345678901234567890 |\n\nThe following paragraph stays in place.".into();
    let mut tree = Tree::new(root(vec![markdown]));
    tree.compute(180.0, 300.0).unwrap();
    let display = tree.entries["markdown"].node.text.clone();
    let width = tree.entries["markdown"].rect.width() as f32;
    let lines = tree
        .text
        .accessibility_lines("markdown", &display, Some(width));
    let table_byte = display.find("1234567890").unwrap();
    let table_y = lines
        .iter()
        .find(|line| line.byte_range.start <= table_byte && table_byte < line.byte_range.end)
        .unwrap()
        .y0 as f32
        + 8.0;
    let paragraph_byte = display.find("following paragraph").unwrap();
    let paragraph_y = lines
        .iter()
        .find(|line| {
            line.byte_range.start <= paragraph_byte && paragraph_byte < line.byte_range.end
        })
        .unwrap()
        .y0 as f32
        + 8.0;
    let before_table = tree
        .text
        .index_at("markdown", 50.0, table_y, Some(width))
        .unwrap();
    let before_paragraph = tree
        .text
        .index_at("markdown", 50.0, paragraph_y, Some(width))
        .unwrap();
    assert!(
        tree.text
            .scroll_markdown_block("markdown", table_y, width, 80.0)
    );
    assert!(
        tree.text
            .index_at("markdown", 50.0, table_y, Some(width))
            .unwrap()
            > before_table
    );
    assert_eq!(
        tree.text
            .index_at("markdown", 50.0, paragraph_y, Some(width))
            .unwrap(),
        before_paragraph
    );
}

#[test]
fn long_markdown_paints_only_visible_lines_in_one_leaf() {
    let mut markdown = node("markdown", "markdown", json!({"width":240}), vec![]);
    markdown.source = (0..5_000)
        .map(|index| format!("Line {index} in a large document.\n\n"))
        .collect();
    markdown.highlight = Some(serde_json::from_value(json!({"query":"Line"})).unwrap());
    let scroll = node(
        "scroll",
        "scroll",
        json!({"width":260,"height":140}),
        vec![markdown],
    );
    let mut tree = Tree::new(root(vec![scroll]));
    tree.compute(300.0, 200.0).unwrap();
    assert!(tree.entries["scroll"].scroll_max > 10_000.0);
    assert_eq!(tree.highlight_ranges["markdown"].len(), 5_000);
    tree.scene(1.0);
    assert!(
        tree.text.markdown_painted_lines < 20,
        "offscreen Markdown lines must not emit glyph commands"
    );
    assert_eq!(tree.entries["markdown"].children.len(), 0);
}

#[test]
fn markdown_accessibility_keeps_bidi_runs_and_global_offsets() {
    let mut markdown = node(
        "markdown",
        "markdown",
        json!({"width":260,"userSelect":"text"}),
        vec![],
    );
    markdown.source = "English שלום world\n\n```txt\ncode sample\n```".into();
    let mut tree = Tree::new(root(vec![markdown]));
    tree.compute(300.0, 200.0).unwrap();
    let display = tree.entries["markdown"].node.text.clone();
    let lines = tree
        .text
        .accessibility_lines("markdown", &display, Some(260.0));
    assert!(lines.iter().any(|line| line.right_to_left));
    assert!(lines.iter().any(|line| !line.right_to_left));
    let code = display.find("code sample").unwrap();
    assert!(
        lines
            .iter()
            .any(|line| line.byte_range.start <= code && code < line.byte_range.end)
    );
    assert!(
        lines
            .windows(2)
            .all(|pair| pair[0].byte_range.start <= pair[1].byte_range.start)
    );
}

#[test]
fn active_search_reveals_match_inside_wide_markdown_fence() {
    let mut markdown = node("markdown", "markdown", json!({"width":140}), vec![]);
    markdown.source = format!("```txt\n{}target\n```", "a".repeat(100));
    markdown.highlight =
        Some(serde_json::from_value(json!({"query":"target","activeIndex":0})).unwrap());
    let mut tree = Tree::new(root(vec![markdown]));
    tree.compute(180.0, 100.0).unwrap();
    let display = &tree.entries["markdown"].node.text;
    let start = display.find("target").unwrap();
    let wash = tree
        .text
        .range_rects("markdown", start, start + 6, Some(140.0));
    assert!(
        !wash.is_empty(),
        "active result must be visible after horizontal reveal"
    );
    assert!(wash.iter().all(|rect| rect.x0 >= 0.0 && rect.x1 <= 140.0));
}

#[test]
fn protocol_rejects_duplicate_ids() {
    let leaf = node("same", "view", json!({}), vec![]);
    assert!(protocol::validate(&root(vec![leaf.clone(), leaf])).is_err());
}

#[test]
fn protocol_rejects_invalid_user_select_values() {
    let invalid = node("bad", "text", json!({"userSelect":"maybe"}), vec![]);
    assert!(protocol::validate(&root(vec![invalid])).is_err());
}

#[test]
fn protocol_validates_variable_virtual_list_metadata() {
    let mut valid = node("list", "scroll", json!({"height":80}), vec![]);
    valid.control = Some(serde_json::from_value(json!({"role":"virtualList","value":0})).unwrap());
    valid.virtual_list = Some(
        serde_json::from_value(json!({
            "estimatedItemHeight":40,
            "itemCount":3,
            "windowStart":1,
            "windowEnd":3,
            "renderedKeys":["s:b","s:c"]
        }))
        .unwrap(),
    );
    assert!(protocol::validate(&root(vec![valid.clone()])).is_ok());

    let mut retained = valid.clone();
    retained.virtual_list.as_mut().unwrap().retained_key = Some("s:a".into());
    assert!(protocol::validate(&root(vec![retained])).is_ok());

    let mut empty_retained = valid.clone();
    empty_retained.virtual_list.as_mut().unwrap().retained_key = Some(String::new());
    assert!(protocol::validate(&root(vec![empty_retained])).is_err());

    let mut duplicate_retained = valid.clone();
    duplicate_retained
        .virtual_list
        .as_mut()
        .unwrap()
        .retained_key = Some("s:b".into());
    assert!(protocol::validate(&root(vec![duplicate_retained])).is_err());

    valid.virtual_list.as_mut().unwrap().rendered_keys = vec!["s:b".into(), "s:b".into()];
    assert!(protocol::validate(&root(vec![valid])).is_err());
}

#[test]
fn protocol_validates_text_decoration_values_and_keeps_updates_paint_only() {
    for decoration in ["none", "underline", "overline", "line-through"] {
        let mut label = node(
            "label",
            "text",
            json!({"width":180,"fontSize":16,"textDecoration":decoration}),
            vec![],
        );
        label.text = "Decorated text".into();
        assert!(protocol::validate(&root(vec![label])).is_ok());
    }
    let invalid = node("bad", "text", json!({"textDecoration":"blink"}), vec![]);
    assert!(protocol::validate(&root(vec![invalid])).is_err());
    let invalid_hover = node(
        "bad-hover",
        "text",
        json!({"hover":{"textDecoration":"wavy"}}),
        vec![],
    );
    assert!(protocol::validate(&root(vec![invalid_hover])).is_err());

    let mut label = node(
        "label",
        "text",
        json!({"width":180,"fontSize":16,"textDecoration":"underline"}),
        vec![],
    );
    label.text = "Decorated text".into();
    let mut tree = Tree::new(root(vec![label.clone()]));
    tree.compute(240.0, 100.0).unwrap();
    tree.scene(1.0);
    label.style["textDecoration"] = json!("line-through");
    tree.update(root(vec![label]));
    assert!(tree.dirty.paint);
    assert!(!tree.dirty.layout);
    assert!(!tree.dirty.text);
    tree.scene(1.0);
}

#[test]
fn semantic_links_activate_with_enter_but_not_space() {
    let link: Node = serde_json::from_value(json!({
        "id":"link",
        "kind":"pressable",
        "style":{},
        "children":[],
        "control":{"role":"link","label":"Docs"}
    }))
    .unwrap();
    let mut tree = Tree::new(root(vec![link]));
    tree.compute(240.0, 100.0).unwrap();
    tree.focus("link");
    assert!(tree.key("Space").is_empty());
    assert_eq!(tree.key("Enter"), vec![json!({"type":"click","id":"link"})]);
}

#[test]
fn external_targets_require_absolute_uri_syntax() {
    assert!(bridge::validate_external_target("https://example.com").is_ok());
    assert!(bridge::validate_external_target("mailto:hello@example.com").is_ok());
    assert!(bridge::validate_external_target("tel:+5511999999999").is_ok());
    assert!(bridge::validate_external_target("relative/path").is_err());
    assert!(bridge::validate_external_target("1invalid:value").is_err());
    assert!(bridge::validate_external_target("https://example.com\0bad").is_err());
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
fn structural_mutations_retain_stable_layout_focus_and_support_reparenting() {
    let item = node("item", "button", json!({"height":24}), vec![]);
    let left = node("left", "column", json!({"width":120}), vec![item]);
    let right = node("right", "column", json!({"width":120}), vec![]);
    let mut tree = Tree::new(root(vec![left, right]));
    tree.compute(300.0, 160.0).unwrap();
    let created = tree.layout_nodes_created;
    tree.focus("item");

    tree.mutate(vec![
        TreeMutation::Children {
            id: "left".into(),
            children: vec![],
        },
        TreeMutation::Children {
            id: "right".into(),
            children: vec!["item".into()],
        },
    ])
    .unwrap();
    tree.compute(300.0, 160.0).unwrap();

    assert_eq!(tree.entries["item"].parent.as_deref(), Some("right"));
    assert_eq!(tree.focused.as_deref(), Some("item"));
    assert_eq!(
        tree.layout_nodes_created, created,
        "reparenting stable keyed nodes must reuse their Taffy identity"
    );
}

#[test]
fn structural_mutations_create_remove_and_reorder_without_rebuilding_stable_nodes() {
    let a = node("a", "view", json!({"height":20}), vec![]);
    let b = node("b", "view", json!({"height":20}), vec![]);
    let parent = node("parent", "column", json!({}), vec![a, b]);
    let mut tree = Tree::new(root(vec![parent]));
    tree.compute(300.0, 160.0).unwrap();
    let created = tree.layout_nodes_created;

    let c = node("c", "view", json!({"height":20}), vec![]);
    tree.mutate(vec![
        TreeMutation::Create { node: Box::new(c) },
        TreeMutation::Children {
            id: "parent".into(),
            children: vec!["b".into(), "c".into()],
        },
        TreeMutation::Remove { id: "a".into() },
    ])
    .unwrap();
    tree.compute(300.0, 160.0).unwrap();

    assert_eq!(tree.entries["parent"].children, vec!["b", "c"]);
    assert!(!tree.entries.contains_key("a"));
    assert_eq!(tree.layout_nodes_created, created + 1);
    assert_eq!(
        tree.layout_node_count(),
        4,
        "root + parent + b + c must remain"
    );
}

#[test]
fn invalid_structural_mutation_batch_is_atomic() {
    let a = node("a", "view", json!({"height":20}), vec![]);
    let parent = node("parent", "column", json!({}), vec![a]);
    let mut tree = Tree::new(root(vec![parent]));
    tree.compute(300.0, 160.0).unwrap();
    let order = tree.order.clone();
    let children = tree.entries["parent"].children.clone();
    let count = tree.layout_node_count();

    let result = tree.mutate(vec![TreeMutation::Children {
        id: "parent".into(),
        children: vec!["missing".into()],
    }]);

    assert!(result.is_err());
    assert_eq!(tree.order, order);
    assert_eq!(tree.entries["parent"].children, children);
    assert_eq!(tree.layout_node_count(), count);
    assert!(tree.entries.contains_key("a"));
}

#[test]
fn structural_mutations_preserve_scroll_and_uncontrolled_input_state() {
    let rows = (0..12)
        .map(|index| {
            node(
                &format!("row-{index}"),
                "view",
                json!({"height":24,"shrink":0}),
                vec![],
            )
        })
        .collect::<Vec<_>>();
    let list = node("list", "scroll", json!({"height":96,"width":200}), rows);
    let mut input = node("input", "input", json!({"width":160,"height":32}), vec![]);
    input.value = None;
    let mut tree = Tree::new(root(vec![list, input]));
    tree.compute(300.0, 180.0).unwrap();
    tree.entries.get_mut("list").unwrap().scroll = 48.0;
    tree.entries.get_mut("input").unwrap().node.value = Some("native edit".into());

    let new_row = node("row-new", "view", json!({"height":24,"shrink":0}), vec![]);
    let mut children = (0..12)
        .map(|index| format!("row-{index}"))
        .collect::<Vec<_>>();
    children.push("row-new".into());
    tree.mutate(vec![
        TreeMutation::Create {
            node: Box::new(new_row),
        },
        TreeMutation::Children {
            id: "list".into(),
            children,
        },
    ])
    .unwrap();

    assert_eq!(tree.entries["list"].scroll, 48.0);
    assert_eq!(
        tree.entries["input"].node.value.as_deref(),
        Some("native edit")
    );
    tree.compute(300.0, 180.0).unwrap();
    assert_eq!(tree.entries["list"].scroll, 48.0);
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
fn raw_rgba_updates_replace_pixels_under_a_stable_cache_key() {
    let mut dynamic = node("dynamic", "image", json!({"width":1,"height":1}), vec![]);
    dynamic.image = Some(
        serde_json::from_value(json!({
            "kind":"rgba",
            "key":"live-preview",
            "data":"/wAA/w==",
            "width":1,
            "height":1
        }))
        .unwrap(),
    );
    let mut tree = Tree::new(root(vec![dynamic.clone()]));
    assert_eq!(
        tree.image_cache_bytes("live-preview"),
        Some(vec![255, 0, 0, 255])
    );

    dynamic.image = Some(
        serde_json::from_value(json!({
            "kind":"rgba",
            "key":"live-preview",
            "data":"AP8A/w==",
            "width":1,
            "height":1
        }))
        .unwrap(),
    );
    tree.update(root(vec![dynamic]));
    assert_eq!(tree.image_cache_len(), 1);
    assert_eq!(
        tree.image_cache_bytes("live-preview"),
        Some(vec![0, 255, 0, 255])
    );
    assert!(tree.warnings.is_empty());
}

#[test]
fn encoded_png_bytes_decode_without_a_filesystem_source() {
    let pixels = image::RgbaImage::from_raw(1, 1, vec![12, 34, 56, 255]).unwrap();
    let mut encoded = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(pixels)
        .write_to(&mut encoded, image::ImageFormat::Png)
        .unwrap();
    let data = base64::engine::general_purpose::STANDARD.encode(encoded.into_inner());
    let mut inline = node("inline", "image", json!({"width":1,"height":1}), vec![]);
    inline.image = Some(
        serde_json::from_value(json!({
            "kind":"encoded",
            "key":"inline-png",
            "data":data,
            "mediaType":"image/png"
        }))
        .unwrap(),
    );

    let tree = Tree::new(root(vec![inline]));
    assert_eq!(
        tree.image_cache_bytes("inline-png"),
        Some(vec![12, 34, 56, 255])
    );
    assert!(tree.warnings.is_empty());
}

#[test]
fn dynamic_images_reject_oversized_dimensions_before_entering_the_cache() {
    let mut oversized = node("oversized", "image", json!({"width":1,"height":1}), vec![]);
    oversized.image = Some(
        serde_json::from_value(json!({
            "kind":"rgba",
            "key":"oversized",
            "data":"/wAA/w==",
            "width":20000,
            "height":1
        }))
        .unwrap(),
    );
    let tree = Tree::new(root(vec![oversized]));
    assert_eq!(tree.image_cache_len(), 0);
    assert!(
        tree.warnings
            .iter()
            .any(|warning| warning.contains("dimensions"))
    );
}

#[test]
fn svg_images_decode_into_the_retained_image_cache() {
    let path = std::env::temp_dir().join(format!("tarve-svg-image-{}.svg", std::process::id()));
    std::fs::write(
        &path,
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16" viewBox="0 0 24 16"><rect width="24" height="16" rx="3" fill="#18181b"/><path d="M4 9l4 3 8-8" fill="none" stroke="#fafafa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>"##,
    )
    .unwrap();
    let mut image = node("svg", "image", json!({"width":24,"height":16}), vec![]);
    image.src = path.to_string_lossy().into_owned();
    let mut tree = Tree::new(root(vec![image]));
    tree.compute(24.0, 16.0).unwrap();
    assert_eq!(tree.image_cache_len(), 1);
    assert!(
        tree.warnings.is_empty(),
        "SVG decode warnings: {:?}",
        tree.warnings
    );
    tree.scene(1.0);
    std::fs::remove_file(path).unwrap();
    tree.dirty.paint = true;
    tree.scene(1.0);
    assert_eq!(
        tree.image_cache_len(),
        1,
        "decoded SVG pixels must remain CPU-owned"
    );
}

#[test]
fn declarative_svg_is_parsed_by_usvg_once_and_reconciled_by_source() {
    let source_a = r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" color="#000000" data-tarve-current-color="1" fill="none" stroke="currentColor"><path d="M4 12h16"/></svg>"##;
    let source_b = r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" color="#000000" data-tarve-current-color="1" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="8"/></svg>"##;

    let mut vector = node("vector", "svg", json!({"width":24,"height":24}), vec![]);
    vector.svg = source_a.to_string();
    let mut tree = Tree::new(root(vec![vector.clone()]));
    assert_eq!(tree.svg_cache_len(), 1);
    assert!(tree.warnings.is_empty());
    let first = tree.svg_cache_scene("vector").unwrap();

    tree.update(root(vec![vector.clone()]));
    let same_source = tree.svg_cache_scene("vector").unwrap();
    assert!(
        Arc::ptr_eq(&same_source, &first),
        "unchanged SVG source must reuse its parsed usvg tree"
    );

    vector.svg = source_b.to_string();
    tree.update(root(vec![vector]));
    let changed = tree.svg_cache_scene("vector").unwrap();
    assert!(
        !Arc::ptr_eq(&changed, &first),
        "changed SVG source must be reparsed"
    );

    tree.update(root(vec![]));
    assert_eq!(
        tree.svg_cache_len(),
        0,
        "removed SVG nodes must release cached usvg trees"
    );
}

#[test]
fn repaint_after_graphics_epoch_preserves_cpu_ui_and_decoded_images() {
    let path = std::env::temp_dir().join(format!(
        "tarve-gpu-recovery-image-{}.png",
        std::process::id()
    ));
    image::RgbaImage::new(8, 8).save(&path).unwrap();
    let mut cached_image = node(
        "cached-image",
        "image",
        json!({"width":8,"height":8}),
        vec![],
    );
    cached_image.src = path.to_string_lossy().into_owned();
    let scroll = node(
        "recovery-scroll",
        "scroll",
        json!({"height":60}),
        vec![node(
            "recovery-content",
            "column",
            json!({"height":240,"shrink":0}),
            vec![
                node("recovery-focus", "button", json!({"height":40}), vec![]),
                cached_image,
                node("recovery-tail", "button", json!({"height":160}), vec![]),
            ],
        )],
    );
    let mut tree = Tree::new(root(vec![scroll]));
    tree.compute(240.0, 120.0).unwrap();
    let _ = tree.focus("recovery-focus");
    tree.pointer_move(20.0, 20.0);
    tree.wheel(10_000.0);
    tree.scene(1.0);
    let scroll_before = tree.entries["recovery-scroll"].scroll;
    assert!(scroll_before > 0.0);
    assert_eq!(tree.image_cache_len(), 1);

    std::fs::remove_file(&path).unwrap();
    tree.dirty.paint = true;
    tree.scene(1.0);

    assert_eq!(
        tree.image_cache_len(),
        1,
        "decoded image bytes must remain CPU-owned"
    );
    assert_eq!(tree.focused.as_deref(), Some("recovery-focus"));
    assert_eq!(tree.entries["recovery-scroll"].scroll, scroll_before);
    assert!(
        !path.exists(),
        "repaint must not need the original image file"
    );
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
fn nested_modal_restores_focus_one_scope_at_a_time() {
    let trigger = node("trigger", "button", json!({"height":36}), vec![]);
    let mut tree = Tree::new(root(vec![trigger.clone()]));
    tree.compute(320.0, 220.0).unwrap();
    let _ = tree.focus("trigger");

    let outer_button = node("outer-button", "button", json!({"height":30}), vec![]);
    let mut outer = node(
        "outer",
        "column",
        json!({"position":"absolute","top":0,"right":0,"bottom":0,"left":0}),
        vec![outer_button.clone()],
    );
    outer.modal = true;
    outer.focusable = false;
    tree.update(root(vec![trigger.clone(), outer.clone()]));
    tree.compute(320.0, 220.0).unwrap();
    assert_eq!(tree.focused.as_deref(), Some("outer-button"));

    let inner_button = node("inner-button", "button", json!({"height":30}), vec![]);
    let mut inner = node(
        "inner",
        "column",
        json!({"position":"absolute","top":20,"left":20,"width":160,"height":100}),
        vec![inner_button],
    );
    inner.modal = true;
    inner.focusable = false;
    outer.children.push(inner);
    tree.update(root(vec![trigger.clone(), outer.clone()]));
    tree.compute(320.0, 220.0).unwrap();
    assert_eq!(tree.focused.as_deref(), Some("inner-button"));

    outer.children.retain(|child| child.id != "inner");
    tree.update(root(vec![trigger.clone(), outer]));
    tree.compute(320.0, 220.0).unwrap();
    assert_eq!(tree.focused.as_deref(), Some("outer-button"));

    tree.update(root(vec![trigger]));
    tree.compute(320.0, 220.0).unwrap();
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
fn scroll_speed_scales_wheel_delta() {
    let content = node("content", "view", json!({"height":600,"shrink":0}), vec![]);
    let mut scroll = node("scroll", "scroll", json!({"height":100}), vec![content]);
    scroll.scroll_speed = 2.5;
    let mut tree = Tree::new(root(vec![scroll]));
    tree.compute(200.0, 120.0).unwrap();
    tree.pointer_move(50.0, 50.0);
    let events = tree.wheel(20.0);
    assert!((tree.entries["scroll"].scroll - 50.0).abs() < 0.001);
    assert_eq!(events[0]["type"], "scroll");
    assert_eq!(events[0]["offset"], 50.0);
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
    assert!(
        (tree.entries["splitter"]
            .node
            .control
            .as_ref()
            .unwrap()
            .value
            - 70.0)
            .abs()
            < 1.0
    );
    tree.pointer_up();

    let _ = tree.focus("splitter");
    let before = tree.entries["splitter"]
        .node
        .control
        .as_ref()
        .unwrap()
        .value;
    tree.key("ArrowRight");
    assert_eq!(
        tree.entries["splitter"]
            .node
            .control
            .as_ref()
            .unwrap()
            .value,
        before + 1.0
    );

    tree.entries
        .get_mut("splitter")
        .unwrap()
        .node
        .control
        .as_mut()
        .unwrap()
        .orientation = "vertical".into();
    let before = tree.entries["splitter"]
        .node
        .control
        .as_ref()
        .unwrap()
        .value;
    tree.key("ArrowDown");
    assert_eq!(
        tree.entries["splitter"]
            .node
            .control
            .as_ref()
            .unwrap()
            .value,
        before + 1.0
    );
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
    let mut first = node(
        "first",
        "pressable",
        json!({"width":60,"height":30}),
        vec![],
    );
    first.control = Some(
        serde_json::from_value(json!({
            "role":"menuitem","group":"nav","label":"First","checked":true
        }))
        .unwrap(),
    );
    let mut second = node(
        "second",
        "pressable",
        json!({"width":60,"height":30}),
        vec![],
    );
    second.control = Some(
        serde_json::from_value(json!({
            "role":"menuitem","group":"nav","label":"Second","checked":false
        }))
        .unwrap(),
    );
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
    assert!(
        events
            .iter()
            .any(|event| event["type"] == "click" && event["id"] == "first")
    );
}

#[test]
fn tree_and_grid_items_use_vertical_roving_focus() {
    let mut first = node(
        "tree-first",
        "pressable",
        json!({"width":80,"height":30}),
        vec![],
    );
    first.control = Some(
        serde_json::from_value(json!({
            "role":"treeitem","group":"tree","label":"First","checked":true
        }))
        .unwrap(),
    );
    let mut second = node(
        "tree-second",
        "pressable",
        json!({"width":80,"height":30}),
        vec![],
    );
    second.control = Some(
        serde_json::from_value(json!({
            "role":"treeitem","group":"tree","label":"Second","checked":false
        }))
        .unwrap(),
    );
    let mut tree = Tree::new(root(vec![first, second]));
    tree.compute(200.0, 100.0).unwrap();
    let _ = tree.focus("tree-first");
    let events = tree.key("ArrowRight");
    assert_eq!(tree.focused.as_deref(), Some("tree-first"));
    assert!(
        events
            .iter()
            .any(|event| event["type"] == "key" && event["key"] == "ArrowRight")
    );
    let events = tree.key("ArrowDown");
    assert_eq!(tree.focused.as_deref(), Some("tree-second"));
    assert!(!events.iter().any(|event| event["type"] == "click"));

    let mut row_one = node(
        "row-one",
        "pressable",
        json!({"width":80,"height":30}),
        vec![],
    );
    row_one.control =
        Some(serde_json::from_value(json!({"role":"row","group":"grid","checked":true})).unwrap());
    let mut row_two = node(
        "row-two",
        "pressable",
        json!({"width":80,"height":30}),
        vec![],
    );
    row_two.control =
        Some(serde_json::from_value(json!({"role":"row","group":"grid","checked":false})).unwrap());
    let mut grid = Tree::new(root(vec![row_one, row_two]));
    grid.compute(200.0, 100.0).unwrap();
    let _ = grid.focus("row-one");
    grid.key("End");
    assert_eq!(grid.focused.as_deref(), Some("row-two"));
    let events = grid.key("Space");
    assert!(
        events
            .iter()
            .any(|event| event["type"] == "click" && event["id"] == "row-two")
    );
}

#[test]
fn toggle_groups_roam_focus_without_toggling_on_arrows() {
    let mut first = node(
        "first",
        "pressable",
        json!({"width":60,"height":30}),
        vec![],
    );
    first.control = Some(
        serde_json::from_value(json!({
            "role":"toggle","group":"toggles","label":"First","checked":true
        }))
        .unwrap(),
    );
    let mut second = node(
        "second",
        "pressable",
        json!({"width":60,"height":30}),
        vec![],
    );
    second.control = Some(
        serde_json::from_value(json!({
            "role":"toggle","group":"toggles","label":"Second","checked":false
        }))
        .unwrap(),
    );
    let mut tree = Tree::new(root(vec![first, second]));
    tree.compute(200.0, 100.0).unwrap();
    let _ = tree.focus("first");
    let events = tree.key("ArrowRight");
    assert_eq!(tree.focused.as_deref(), Some("second"));
    assert!(!events.iter().any(|event| event["type"] == "click"));
    let events = tree.key("Space");
    assert!(
        events
            .iter()
            .any(|event| event["type"] == "click" && event["id"] == "second")
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

#[test]
fn native_motion_interpolates_layout_and_stops_scheduling_after_completion() {
    let panel: Node = serde_json::from_value(json!({
        "id":"panel",
        "kind":"view",
        "style":{
            "width":200,
            "height":40,
            "opacity":1,
            "radius":12,
            "transition":{
                "width":{"duration":100,"easing":"linear"},
                "opacity":{"duration":100,"easing":"linear"},
                "radius":{"duration":100,"easing":"linear"}
            }
        },
        "motionFrom":{"width":100,"opacity":0,"radius":0},
        "children":[]
    }))
    .unwrap();
    let mut tree = Tree::new(root(vec![panel]));
    tree.compute(400.0, 200.0).unwrap();
    assert!((tree.entries["panel"].rect.width() - 100.0).abs() < 0.01);
    assert_eq!(tree.active_motion_count(), 3);
    assert!(tree.next_motion_tick_ms().is_some());

    tree.advance_motion(50.0);
    tree.compute(400.0, 200.0).unwrap();
    assert!((tree.entries["panel"].rect.width() - 150.0).abs() < 0.05);
    assert_eq!(tree.active_motion_count(), 3);

    tree.advance_motion(100.0);
    tree.compute(400.0, 200.0).unwrap();
    assert!((tree.entries["panel"].rect.width() - 200.0).abs() < 0.01);
    assert_eq!(tree.active_motion_count(), 0);
    assert_eq!(tree.next_motion_tick_ms(), None);
    let mut properties: Vec<String> = tree
        .take_motion_events()
        .into_iter()
        .filter_map(|event| event["property"].as_str().map(str::to_string))
        .collect();
    properties.sort();
    assert_eq!(properties, vec!["opacity", "radius", "width"]);
}

#[test]
fn native_motion_retargets_from_the_current_visual_value_without_a_jump() {
    let mut tree = Tree::new(root(vec![node(
        "panel",
        "view",
        json!({"width":100,"height":40}),
        vec![],
    )]));
    tree.compute(400.0, 200.0).unwrap();

    tree.patch(vec![node(
        "panel",
        "view",
        json!({"width":200,"height":40,"transition":{"width":{"duration":100,"easing":"linear"}}}),
        vec![],
    )])
    .unwrap();
    tree.advance_motion(40.0);
    tree.compute(400.0, 200.0).unwrap();
    assert!((tree.entries["panel"].rect.width() - 140.0).abs() < 0.05);

    tree.patch(vec![node(
        "panel",
        "view",
        json!({"width":300,"height":40,"transition":{"width":{"duration":100,"easing":"linear"}}}),
        vec![],
    )])
    .unwrap();
    tree.compute(400.0, 200.0).unwrap();
    assert!((tree.entries["panel"].rect.width() - 140.0).abs() < 0.05);

    tree.advance_motion(70.0);
    tree.compute(400.0, 200.0).unwrap();
    assert!((tree.entries["panel"].rect.width() - 188.0).abs() < 0.1);
    tree.advance_motion(140.0);
    tree.compute(400.0, 200.0).unwrap();
    assert!((tree.entries["panel"].rect.width() - 300.0).abs() < 0.01);
    assert_eq!(tree.active_motion_count(), 0);
}

#[test]
fn native_motion_honors_delay_and_treats_zero_duration_as_immediate() {
    let mut tree = Tree::new(root(vec![node(
        "panel",
        "view",
        json!({"width":100,"height":40}),
        vec![],
    )]));
    tree.compute(400.0, 200.0).unwrap();

    tree.patch(vec![node(
        "panel",
        "view",
        json!({"width":200,"height":40,"transition":{"width":{"duration":100,"delay":50,"easing":"linear"}}}),
        vec![],
    )])
    .unwrap();
    tree.advance_motion(49.0);
    tree.compute(400.0, 200.0).unwrap();
    assert!((tree.entries["panel"].rect.width() - 100.0).abs() < 0.01);
    tree.advance_motion(100.0);
    tree.compute(400.0, 200.0).unwrap();
    assert!((tree.entries["panel"].rect.width() - 150.0).abs() < 0.05);
    tree.advance_motion(150.0);
    tree.compute(400.0, 200.0).unwrap();
    assert!((tree.entries["panel"].rect.width() - 200.0).abs() < 0.01);

    tree.patch(vec![node(
        "panel",
        "view",
        json!({"width":260,"height":40,"transition":{"width":{"duration":0,"easing":"linear"}}}),
        vec![],
    )])
    .unwrap();
    tree.compute(400.0, 200.0).unwrap();
    assert!((tree.entries["panel"].rect.width() - 260.0).abs() < 0.01);
    assert_eq!(tree.active_motion_count(), 0);
}

#[test]
fn removing_a_node_cancels_its_motion_without_a_stale_completion() {
    let mut tree = Tree::new(root(vec![node(
        "panel",
        "view",
        json!({"width":100,"height":40}),
        vec![],
    )]));
    tree.compute(400.0, 200.0).unwrap();
    tree.patch(vec![node(
        "panel",
        "view",
        json!({"width":200,"height":40,"transition":{"width":{"duration":100,"easing":"linear"}}}),
        vec![],
    )])
    .unwrap();
    tree.advance_motion(40.0);
    assert_eq!(tree.active_motion_count(), 1);

    tree.mutate(vec![
        TreeMutation::Children {
            id: "root".into(),
            children: vec![],
        },
        TreeMutation::Remove { id: "panel".into() },
    ])
    .unwrap();
    tree.advance_motion(200.0);
    assert_eq!(tree.active_motion_count(), 0);
    assert!(tree.take_motion_events().is_empty());
}

#[test]
fn protocol_rejects_invalid_native_motion_values_without_tightening_static_opacity() {
    let clamped_static_opacity = root(vec![node("panel", "view", json!({"opacity":1.5}), vec![])]);
    protocol::validate(&clamped_static_opacity).unwrap();

    let invalid_transition = root(vec![node(
        "panel",
        "view",
        json!({"transition":{"opacity":{"duration":100,"easing":"spring"}}}),
        vec![],
    )]);
    assert!(
        protocol::validate(&invalid_transition)
            .unwrap_err()
            .contains("Unsupported transition easing")
    );
}

fn editor_tree(kind: &str, value: &str) -> Tree {
    let mut field = node(
        "field",
        kind,
        json!({"width":240,"height":80,"fontSize":14,"userSelect":"text"}),
        vec![],
    );
    field.value = Some(value.into());
    let mut tree = Tree::new(root(vec![field]));
    tree.compute(300.0, 120.0).unwrap();
    let _ = tree.focus("field");
    tree
}

fn field_value(tree: &Tree) -> &str {
    tree.entries["field"].node.value.as_deref().unwrap()
}

#[test]
fn native_undo_redo_coalesces_typing_and_restores_caret() {
    let mut tree = editor_tree("input", "");
    for ch in ["h", "i", " "] {
        tree.type_text(ch);
    }
    tree.advance_motion(10.0);
    for ch in ["y", "o"] {
        tree.type_text(ch);
    }
    assert_eq!(field_value(&tree), "hi yo");

    let events = tree.key("Undo");
    assert_eq!(
        events,
        vec![json!({"type":"change", "id":"field", "value":"hi "})]
    );
    tree.key("Undo");
    assert_eq!(field_value(&tree), "");
    assert!(tree.key("Undo").is_empty());

    tree.key("Redo");
    assert_eq!(field_value(&tree), "hi ");
    tree.key("Redo");
    assert_eq!(field_value(&tree), "hi yo");
    tree.type_text("!");
    assert_eq!(field_value(&tree), "hi yo!");

    tree.key("Undo");
    tree.key("Backspace");
    assert!(
        tree.key("Redo").is_empty(),
        "a new edit clears the redo stack"
    );
    tree.key("Undo");
    assert_eq!(field_value(&tree), "hi yo");
    tree.type_text("Z");
    assert_eq!(field_value(&tree), "hi yoZ", "caret is restored to the end");
}

#[test]
fn native_undo_separates_deletes_pastes_and_pauses() {
    let mut tree = editor_tree("textarea", "abc");
    tree.key("End");
    tree.key("Backspace");
    tree.key("Backspace");
    tree.type_text("pasted text");
    tree.advance_motion(5_000.0);
    tree.type_text("x");
    assert_eq!(field_value(&tree), "apasted textx");
    tree.key("Undo");
    assert_eq!(field_value(&tree), "apasted text");
    tree.key("Undo");
    assert_eq!(field_value(&tree), "a");
    tree.key("Undo");
    assert_eq!(field_value(&tree), "abc");
}

#[test]
fn native_undo_history_resets_after_external_value_change() {
    let mut tree = editor_tree("input", "one");
    tree.key("End");
    tree.type_text("!");
    let mut replaced = node(
        "field",
        "input",
        json!({"width":240,"height":80,"fontSize":14}),
        vec![],
    );
    replaced.value = Some("server".into());
    tree.update(root(vec![replaced]));
    assert!(tree.key("Undo").is_empty());
    assert_eq!(field_value(&tree), "server");
}

#[test]
fn frame_overlay_records_samples_without_scheduling_frames() {
    let mut tree = editor_tree("input", "abc");
    tree.compute(400.0, 300.0).unwrap();
    let _ = tree.scene(1.0);
    tree.record_frame_time(4.0);
    assert!(tree.frame_samples().is_none());
    assert!(tree.set_frame_overlay(true));
    assert!(!tree.set_frame_overlay(true));
    let _ = tree.scene(1.0);
    for index in 0..(crate::tree::FRAME_OVERLAY_SAMPLES + 5) {
        tree.record_frame_time(index as f64);
    }
    tree.record_frame_time(f64::NAN);
    assert!(!tree.dirty.paint);
    let samples = tree.frame_samples().unwrap();
    assert_eq!(samples.len(), crate::tree::FRAME_OVERLAY_SAMPLES);
    assert_eq!(samples[0], 5.0);
    let _ = tree.scene(1.0);
    assert!(tree.set_frame_overlay(false));
    assert!(tree.frame_samples().is_none());
}

#[test]
fn native_undo_history_resets_when_controlled_value_returns_to_previous() {
    let mut tree = editor_tree("input", "");
    tree.type_text("x");
    let controlled = |value: &str| {
        let mut field = node(
            "field",
            "input",
            json!({"width":240,"height":80,"fontSize":14,"userSelect":"text"}),
            vec![],
        );
        field.value = Some(value.into());
        root(vec![field])
    };
    tree.update(controlled("x"));
    tree.update(controlled("server"));
    tree.update(controlled("x"));
    assert!(tree.key("Undo").is_empty());
    assert_eq!(field_value(&tree), "x");
}

#[test]
fn rejected_controlled_edit_keeps_earlier_undo_steps() {
    let mut tree = editor_tree("input", "");
    tree.type_text("a ");
    tree.type_text("b");
    let controlled = |value: &str| {
        let mut field = node(
            "field",
            "input",
            json!({"width":240,"height":80,"fontSize":14,"userSelect":"text"}),
            vec![],
        );
        field.value = Some(value.into());
        root(vec![field])
    };
    tree.update(controlled("a "));
    assert_eq!(field_value(&tree), "a ");
    assert!(!tree.key("Undo").is_empty());
    assert_eq!(field_value(&tree), "");
}

#[test]
fn input_clock_does_not_step_motion_tracks() {
    let mut tree = editor_tree("input", "abc");
    tree.advance_clock(600.0);
    assert!(!tree.caret_visible());
    assert_eq!(tree.motion_time_ms(), 600.0);
    tree.advance_clock(f64::NAN);
    assert_eq!(tree.motion_time_ms(), 600.0);
}

#[test]
fn input_and_textarea_emit_explicit_submit_events() {
    let mut input = editor_tree("input", "query");
    let submit = json!({"type":"submit", "id":"field", "value":"query"});
    assert_eq!(input.key("Enter"), vec![submit.clone()]);
    assert_eq!(input.key("ShiftEnter"), vec![submit.clone()]);
    assert_eq!(input.key("ModEnter"), vec![submit]);

    let mut textarea = editor_tree("textarea", "a");
    textarea.key("End");
    assert_eq!(textarea.key("Enter")[0]["type"], "change");
    assert_eq!(textarea.key("ShiftEnter")[0]["type"], "change");
    assert_eq!(field_value(&textarea), "a\n\n");
    assert_eq!(textarea.key("ModEnter")[0]["type"], "submit");

    let mut chat = node(
        "field",
        "textarea",
        json!({"width":240,"height":80}),
        vec![],
    );
    chat.value = Some("hi".into());
    chat.submit_on_enter = true;
    let mut chat_tree = Tree::new(root(vec![chat]));
    chat_tree.compute(300.0, 120.0).unwrap();
    let _ = chat_tree.focus("field");
    chat_tree.key("End");
    assert_eq!(chat_tree.key("Enter")[0]["type"], "submit");
    assert_eq!(chat_tree.key("ShiftEnter")[0]["type"], "change");
    assert_eq!(field_value(&chat_tree), "hi\n");
}

#[test]
fn modified_enter_still_activates_buttons() {
    let mut tree = Tree::new(root(vec![node(
        "ok",
        "button",
        json!({"width":80,"height":30}),
        vec![],
    )]));
    tree.compute(200.0, 100.0).unwrap();
    let _ = tree.focus("ok");
    assert_eq!(
        tree.key("ShiftEnter"),
        vec![json!({"type":"click", "id":"ok"})]
    );
}

#[test]
fn caret_blinks_after_activity_and_settles_without_idle_frames() {
    let mut tree = editor_tree("input", "abc");
    assert!(tree.caret_visible());
    assert_eq!(tree.next_caret_blink_ms(), Some(530.0));
    assert_eq!(tree.next_clock_tick_ms(), Some(530.0));
    assert_eq!(tree.next_motion_tick_ms(), None, "blink is not a motion");

    tree.dirty.paint = false;
    tree.advance_motion(530.0);
    assert!(!tree.caret_visible());
    assert!(tree.dirty.paint);

    tree.type_text("d");
    assert!(tree.caret_visible(), "editing resets the blink phase");
    assert_eq!(tree.next_caret_blink_ms(), Some(1_060.0));

    tree.advance_motion(530.0 + 10_000.0);
    assert!(tree.caret_visible());
    assert_eq!(tree.next_caret_blink_ms(), None);
    assert_eq!(tree.next_clock_tick_ms(), None);

    tree.key("ArrowLeft");
    assert!(
        tree.next_caret_blink_ms().is_some(),
        "navigation wakes the blink"
    );
    tree.blur();
    assert_eq!(tree.next_caret_blink_ms(), None);
}

#[test]
fn find_literal_matches_regex_semantics_without_regex() {
    use crate::tree::find_literal;
    assert_eq!(find_literal("aaaa", "aa", true), vec![0..2, 2..4]);
    assert_eq!(find_literal("Foo foo FOO", "foo", true), vec![4..7]);
    assert_eq!(
        find_literal("Foo foo FOO", "foo", false),
        vec![0..3, 4..7, 8..11]
    );
    assert_eq!(
        find_literal("ÉCOLE école", "école", false),
        vec![0..6, 7..13]
    );
    assert_eq!(find_literal("ΟΔΟΣ οδος", "οδοσ", false), vec![0..8, 9..17]);
    assert_eq!(
        find_literal("KELVIN \u{212A}", "k", false),
        vec![0..1, 7..10]
    );
    assert_eq!(find_literal("İx", "x", false), vec![2..3]);
    assert_eq!(
        find_literal("abc", "", false),
        Vec::<std::ops::Range<usize>>::new()
    );
}

#[test]
fn word_boundaries_skip_whitespace_and_respect_unicode_words() {
    use crate::tree::{next_word_boundary, previous_word_boundary};
    let text = "hello  wörld, foo.bar";
    assert_eq!(
        previous_word_boundary(text, text.len()),
        15,
        "foo.bar is one UAX #29 word"
    );
    assert_eq!(previous_word_boundary(text, 7), 0);
    assert_eq!(previous_word_boundary(text, 0), 0);
    assert_eq!(next_word_boundary(text, 0), 5);
    assert_eq!(next_word_boundary(text, 5), 13);
    assert_eq!(next_word_boundary(text, text.len()), text.len());
}

#[test]
fn word_keys_move_select_and_delete_by_word() {
    let changed = |events: Vec<serde_json::Value>| events[0]["value"].as_str().unwrap().to_owned();
    let mut tree = editor_tree("input", "one two three");
    tree.key("End");
    tree.key("WordLeft");
    assert_eq!(changed(tree.key("WordBackspace")), "one three");

    let mut tree = editor_tree("input", "one two three");
    tree.key("Home");
    assert_eq!(changed(tree.key("WordDelete")), " two three");

    let mut tree = editor_tree("input", "one two three");
    tree.key("End");
    tree.key("ShiftWordLeft");
    assert_eq!(tree.selected_text().as_deref(), Some("three"));
    tree.key("ShiftWordLeft");
    assert_eq!(tree.selected_text().as_deref(), Some("two three"));
}

#[test]
#[ignore = "manual performance probe: cargo test --release --lib perf_probe -- --ignored --nocapture"]
fn perf_probe() {
    use std::time::Instant;
    let rows = 2000;
    let build = |revision: usize| {
        let children = (0..rows)
            .map(|index| {
                let label: Node = serde_json::from_value(json!({
                    "id": format!("label-{index}"), "kind": "text",
                    "style": {"flex": 1, "fontSize": 14},
                    "text": if index == 0 { format!("Record {index} rev {revision}") } else { format!("Record {index}: native layout and text") },
                    "children": []
                }))
                .unwrap();
                let button: Node = serde_json::from_value(json!({
                    "id": format!("open-{index}"), "kind": "button",
                    "style": {"height": 28, "paddingLeft": 10, "paddingRight": 10, "backgroundColor": "#18181b", "color": "#fafafa", "radius": 6},
                    "text": "Open", "children": []
                }))
                .unwrap();
                node(&format!("row-{index}"), "row", json!({"height": 36, "shrink": 0, "gap": 12}), vec![label, button])
            })
            .collect();
        let list = node("list", "column", json!({}), children);
        let scroll = node("scroll", "scroll", json!({"flex": 1}), vec![list]);
        root(vec![node(
            "main",
            "column",
            json!({"padding": 16, "gap": 12, "flex": 1}),
            vec![scroll],
        )])
    };
    let median = |mut v: Vec<f64>| {
        v.sort_by(f64::total_cmp);
        v[v.len() / 2]
    };
    let (mut cold, mut update, mut paint) = (vec![], vec![], vec![]);
    for iteration in 0..25 {
        let document = build(0);
        let start = Instant::now();
        let mut tree = Tree::new(document);
        tree.compute(1024.0, 760.0).unwrap();
        let elapsed = start.elapsed().as_secs_f64() * 1e3;
        let mut scene = vello::Scene::new();
        let mut update_times = vec![];
        let mut paint_times = vec![];
        for revision in 1..=12 {
            let next = build(revision);
            let start = Instant::now();
            tree.update(next);
            tree.compute(1024.0, 760.0).unwrap();
            update_times.push(start.elapsed().as_secs_f64() * 1e3);
            scene.reset();
            let start = Instant::now();
            tree.paint(1.0, &mut scene);
            paint_times.push(start.elapsed().as_secs_f64() * 1e3);
        }
        if iteration >= 5 {
            cold.push(elapsed);
            update.push(median(update_times));
            paint.push(median(paint_times));
        }
    }
    println!(
        "PERF mimalloc={} fxhash={} cold_ms={:.2} update_ms={:.2} paint_ms={:.3}",
        cfg!(feature = "mimalloc"),
        cfg!(feature = "fxhash"),
        median(cold),
        median(update),
        median(paint)
    );
}

#[derive(Default)]
struct PaintRecorder {
    strokes: Vec<(f64, bool, vello::peniko::Color)>,
    glyphs: Vec<(vello::peniko::Color, vello::kurbo::Affine)>,
    clips: Vec<Option<vello::kurbo::Rect>>,
    glyph_clips: Vec<Option<vello::kurbo::Rect>>,
}

impl crate::paint::PaintTarget for PaintRecorder {
    fn fill<S: vello::kurbo::Shape>(
        &mut self,
        _: vello::peniko::Fill,
        _: vello::kurbo::Affine,
        _: vello::peniko::Color,
        _: &S,
    ) {
    }
    fn stroke<S: vello::kurbo::Shape>(
        &mut self,
        stroke: &vello::kurbo::Stroke,
        _: vello::kurbo::Affine,
        color: vello::peniko::Color,
        _: &S,
    ) {
        self.strokes
            .push((stroke.width, !stroke.dash_pattern.is_empty(), color));
    }
    fn push_clip<S: vello::kurbo::Shape>(
        &mut self,
        _: vello::peniko::Fill,
        _: vello::kurbo::Affine,
        shape: &S,
    ) {
        self.clips.push(Some(shape.bounding_box()));
    }
    fn push_opacity<S: vello::kurbo::Shape>(&mut self, _: f32, _: vello::kurbo::Affine, _: &S) {
        self.clips.push(None);
    }
    fn pop_layer(&mut self) {
        self.clips.pop();
    }
    fn draw_image(&mut self, _: &str, _: &vello::peniko::ImageData, _: vello::kurbo::Affine) {}
    fn draw_glyphs(
        &mut self,
        _: &vello::peniko::FontData,
        _: f32,
        _: &[i16],
        transform: vello::kurbo::Affine,
        color: vello::peniko::Color,
        _: &[crate::paint::PaintGlyph],
    ) {
        self.glyphs.push((color, transform));
        self.glyph_clips
            .push(self.clips.iter().rev().find_map(|clip| *clip));
    }
}

fn painted(children: Vec<Node>) -> PaintRecorder {
    let mut tree = Tree::new(root(children));
    tree.compute(400.0, 200.0).unwrap();
    let mut recorder = PaintRecorder::default();
    tree.paint(1.0, &mut recorder);
    recorder
}

fn text_node(id: &str, style: serde_json::Value) -> Node {
    serde_json::from_value(
        json!({"id": id, "kind": "text", "style": style, "text": "Shadow", "children": []}),
    )
    .unwrap()
}

#[test]
fn border_style_paints_dashed_borders_and_can_be_hidden() {
    let border = crate::tree::color("#ff0000");
    let style = |border_style: &str| json!({"width": 80, "height": 40, "borderWidth": 3, "borderColor": "#ff0000", "borderStyle": border_style});
    let dashed = painted(vec![node("box", "view", style("dashed"), vec![])]);
    assert!(
        dashed
            .strokes
            .iter()
            .any(|(width, dashed, color)| *width == 3.0 && *dashed && *color == border)
    );
    let solid = painted(vec![node("box", "view", style("solid"), vec![])]);
    assert!(
        solid
            .strokes
            .iter()
            .any(|(width, dashed, color)| *width == 3.0 && !*dashed && *color == border)
    );
    let hidden = painted(vec![node("box", "view", style("none"), vec![])]);
    assert!(hidden.strokes.iter().all(|(_, _, color)| *color != border));
}

#[test]
fn text_shadow_paints_an_offset_copy_under_the_text() {
    let shadow = crate::tree::color("#ff0000");
    let recorder = painted(vec![text_node(
        "label",
        json!({"fontSize": 16, "foreground": "#000000", "textShadow": {"x": 2, "y": 3, "color": "#ff0000"}}),
    )]);
    assert_eq!(recorder.glyphs.len(), 2, "shadow pass plus the real text");
    let (shadow_color, shadow_at) = recorder.glyphs[0];
    let (text_color, text_at) = recorder.glyphs[1];
    assert_eq!(shadow_color, shadow);
    assert_ne!(text_color, shadow);
    let delta = shadow_at.translation() - text_at.translation();
    assert_eq!((delta.x, delta.y), (2.0, 3.0));

    let shadow_clip = recorder.glyph_clips[0].expect("shadow is clipped");
    let text_clip = recorder.glyph_clips[1].expect("text is clipped");
    assert_eq!(
        (shadow_clip.x1 - text_clip.x1, shadow_clip.y1 - text_clip.y1),
        (2.0, 3.0),
        "the shadow clip grows by its offset so the last glyph is not cut"
    );

    let plain = painted(vec![text_node("label", json!({"fontSize": 16}))]);
    assert_eq!(plain.glyphs.len(), 1);
}

#[test]
fn text_shadow_rejects_blur_and_malformed_values() {
    for shadow in [
        json!({"x": 1, "y": 1, "blur": 4, "color": "#000000"}),
        json!({"x": 1}),
        json!("2px 2px red"),
    ] {
        let error = protocol::validate(&root(vec![text_node(
            "label",
            json!({"textShadow": shadow}),
        )]))
        .unwrap_err();
        assert!(error.contains("textShadow"), "{error}");
    }
}
