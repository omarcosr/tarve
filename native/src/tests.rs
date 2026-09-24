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
use std::sync::Arc;
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
