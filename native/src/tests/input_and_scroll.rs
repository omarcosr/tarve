use super::*;

#[test]
pub(super) fn system_file_drops_resolve_to_the_innermost_enabled_file_target() {
    let target = |id: &str, size: f32, children: Vec<Node>| -> Node {
        let mut zone = node(id, "view", json!({"width": size, "height": size}), children);
        zone.file_drop_target = true;
        zone
    };
    let inner = target("inner", 40.0, vec![]);
    let mut off = target("off", 100.0, vec![]);
    off.disabled = true;
    let mut plain = node(
        "plain",
        "view",
        json!({"width": 100, "height": 100}),
        vec![],
    );
    plain.drop_target = true;
    let zones = vec![target("outer", 100.0, vec![inner]), off, plain];
    let mut tree = Tree::new(node("root", "window", json!({"direction": "row"}), zones));
    tree.compute(400.0, 200.0).unwrap();
    assert_eq!(
        tree.file_drop_target_at((10.0, 10.0)).as_deref(),
        Some("inner")
    );
    assert_eq!(
        tree.file_drop_target_at((80.0, 80.0)).as_deref(),
        Some("outer")
    );
    assert_eq!(
        tree.file_drop_target_at((150.0, 50.0)),
        None,
        "a disabled target takes no files"
    );
    assert_eq!(
        tree.file_drop_target_at((250.0, 50.0)),
        None,
        "a pointer drop target is not a file target"
    );
    assert_eq!(tree.file_drop_target_at((350.0, 50.0)), None);
}

pub(super) fn drag_fixture(disabled_b: bool) -> Tree {
    let card: Node = serde_json::from_value(json!({
        "id": "card", "kind": "pressable", "draggable": true, "children": [],
        "style": {"width": 60, "height": 40}
    }))
    .unwrap();
    let target = |id: &str, size: f32, children: Vec<Node>| -> Node {
        let mut lane = node(id, "view", json!({"width": size, "height": size}), children);
        lane.drop_target = true;
        lane
    };
    let slot = target("a-slot", 50.0, vec![]);
    let mut b = target("b", 100.0, vec![]);
    b.disabled = disabled_b;
    let lanes = vec![card, target("a", 100.0, vec![slot]), b];
    let mut tree = Tree::new(node("root", "window", json!({"direction": "row"}), lanes));
    tree.compute(400.0, 200.0).unwrap();
    tree
}

#[test]
pub(super) fn pointer_drag_waits_for_the_threshold_and_a_short_press_still_clicks() {
    let mut tree = drag_fixture(false);
    tree.pointer_move(10.0, 10.0);
    tree.pointer_down();
    assert!(
        tree.pointer_move(12.0, 11.0)
            .iter()
            .all(|event| event["type"] != "dragStart")
    );
    assert_eq!(
        tree.pointer_up(),
        vec![json!({"type":"click", "id":"card"})]
    );
}

#[test]
pub(super) fn pointer_drag_reports_the_innermost_target_and_drops_without_clicking() {
    let mut tree = drag_fixture(false);
    tree.pointer_move(10.0, 10.0);
    tree.pointer_down();
    let events = tree.pointer_move(30.0, 10.0);
    assert_eq!(
        events[events.len() - 2],
        json!({"type":"dragStart", "id":"card", "x":10.0, "y":10.0})
    );
    assert_eq!(
        events.last().unwrap()["over"],
        serde_json::Value::Null,
        "the source is not its own target"
    );
    let over = |events: Vec<serde_json::Value>| events.last().unwrap()["over"].clone();
    assert_eq!(
        over(tree.pointer_move(80.0, 20.0)),
        json!("a-slot"),
        "nested targets resolve inward"
    );
    assert_eq!(over(tree.pointer_move(80.0, 80.0)), json!("a"));
    assert_eq!(over(tree.pointer_move(200.0, 50.0)), json!("b"));
    assert_eq!(
        over(tree.pointer_move(300.0, 50.0)),
        serde_json::Value::Null
    );
    tree.pointer_move(200.0, 50.0);
    assert_eq!(
        tree.pointer_up(),
        vec![json!({"type":"drop", "id":"card", "target":"b", "x":200.0, "y":50.0})]
    );
    assert!(
        tree.pointer_move(220.0, 50.0)
            .iter()
            .all(|event| event["type"] != "dragMove")
    );
}

#[test]
pub(super) fn pointer_drag_cancels_on_escape_and_skips_disabled_targets() {
    let mut tree = drag_fixture(true);
    tree.pointer_move(10.0, 10.0);
    tree.pointer_down();
    let events = tree.pointer_move(200.0, 50.0);
    assert_eq!(events.last().unwrap()["over"], serde_json::Value::Null);
    assert_eq!(
        tree.key("Escape"),
        vec![json!({"type":"dragCancel", "id":"card"})]
    );
    assert!(
        tree.pointer_up().is_empty(),
        "a cancelled drag neither drops nor clicks"
    );
    assert!(tree.cancel_pointer_drag().is_empty());
}

#[test]
pub(super) fn pointer_delegate_sends_presses_on_a_group_to_its_field_and_shares_its_focus() {
    let icon = node("icon", "view", json!({"width":16,"height":16}), vec![]);
    let mut field = node("field", "input", json!({"flex":1,"height":30}), vec![]);
    field.value = Some("abc".into());
    let kbd = node("kbd", "view", json!({"width":20,"height":20}), vec![]);
    let group = node(
        "group",
        "row",
        json!({"width":300,"height":40,"padding":{"left":10,"right":10},"gap":8,"align":"center","pointerEvents":"delegate","focus":{"borderColor":"#ff0000"}}),
        vec![icon, field, kbd],
    );
    let plain = node(
        "plain",
        "row",
        json!({"width":300,"height":40}),
        vec![node(
            "other",
            "view",
            json!({"width":16,"height":16}),
            vec![],
        )],
    );
    let mut tree = Tree::new(root(vec![group, plain]));
    tree.compute(400.0, 200.0).unwrap();
    let group_rect = tree.entries["group"].rect;
    let press = |tree: &mut Tree, x: f64, y: f64| {
        tree.compute(400.0, 200.0).unwrap();
        tree.pointer_move(x, y);
        tree.pointer_down();
        tree.pointer_up();
    };
    press(&mut tree, group_rect.x0 + 4.0, group_rect.y0 + 20.0);
    assert_eq!(
        tree.focused.as_deref(),
        Some("field"),
        "the prefix side reaches the field"
    );
    assert_eq!(
        tree.type_text("X")[0]["value"],
        "Xabc",
        "the caret starts at the beginning"
    );
    assert!(tree.delegate_focused("group"));
    press(&mut tree, group_rect.x1 - 4.0, group_rect.y0 + 20.0);
    assert_eq!(
        tree.focused.as_deref(),
        Some("field"),
        "the suffix side reaches the field"
    );
    assert_eq!(
        tree.type_text("Y")[0]["value"],
        "XabcY",
        "pressing past the text puts the caret at the end"
    );
    let plain_rect = tree.entries["plain"].rect;
    press(&mut tree, plain_rect.x0 + 4.0, plain_rect.y0 + 20.0);
    assert_ne!(
        tree.focused.as_deref(),
        Some("field"),
        "other rows do not delegate"
    );
    assert!(!tree.delegate_focused("group"));
}

#[test]
pub(super) fn motion_clock_runs_on_a_fixed_grid_at_the_requested_rate() {
    let spinner = node(
        "spinner",
        "view",
        json!({"width":20,"height":20,"spin":1000}),
        vec![],
    );
    let mut tree = Tree::new(root(vec![spinner]));
    tree.compute(100.0, 100.0).unwrap();
    tree.advance_motion(0.0);
    assert_eq!(tree.next_clock_tick_ms(), Some(1000.0 / 60.0));
    // A frame that wakes 5ms late keeps the next one on the 60 Hz grid.
    tree.advance_motion(1000.0 / 60.0 + 5.0);
    let next = tree.next_clock_tick_ms().unwrap();
    assert!((next - 2000.0 / 60.0).abs() < 1e-9, "next {next}");
    tree.set_motion_frame_ms(1000.0 / 240.0);
    tree.advance_motion(100.0);
    let next = tree.next_clock_tick_ms().unwrap();
    assert!((next - 25.0 * 1000.0 / 240.0).abs() < 1e-9, "next {next}");
    tree.set_motion_frame_ms(f64::NAN);
    tree.set_motion_frame_ms(0.0);
    let next = tree.next_clock_tick_ms().unwrap();
    assert!(
        (next - 25.0 * 1000.0 / 240.0).abs() < 1e-9,
        "invalid rates are ignored"
    );
}

#[cfg(not(feature = "mimalloc"))]
#[test]
#[ignore = "memory probe: cargo test --no-default-features memory_per_node -- --ignored --nocapture"]
pub(super) fn memory_per_node() {
    use crate::counting_alloc::LIVE;
    use std::sync::atomic::Ordering;
    let live = || LIVE.load(Ordering::Relaxed);
    eprintln!(
        "size_of Node {} Entry {}",
        std::mem::size_of::<Node>(),
        std::mem::size_of::<crate::tree::Entry>()
    );
    for (label, make) in [
        (
            "view",
            Box::new(|i: usize| {
                node(
                    &format!("r{i}"),
                    "row",
                    json!({"height":12,"shrink":0,"background":"#eeeeee"}),
                    vec![],
                )
            }) as Box<dyn Fn(usize) -> Node>,
        ),
        (
            "text",
            Box::new(|i: usize| {
                let mut n = node(&format!("t{i}"), "text", json!({"fontSize":14}), vec![]);
                n.text = format!("Record {i}: native layout and text");
                n
            }),
        ),
    ] {
        let rows: Vec<Node> = (0..6000).map(&make).collect();
        let json_bytes = serde_json::to_vec(&root(rows.clone())).unwrap().len();
        let base = live();
        let parsed: Node =
            serde_json::from_slice(&serde_json::to_vec(&root(rows)).unwrap()).unwrap();
        let after_parse = live();
        let mut tree = Tree::new(parsed);
        let after_new = live();
        tree.compute(1024.0, 760.0).unwrap();
        let after_layout = live();
        eprintln!(
            "{label}: json {:.0} B/node | parsed Node {:.0} B/node | Tree::new +{:.0} B/node | layout +{:.0} B/node | total {:.0} B/node",
            json_bytes as f64 / 6000.0,
            (after_parse - base) as f64 / 6000.0,
            (after_new - after_parse) as f64 / 6000.0,
            (after_layout - after_new) as f64 / 6000.0,
            (after_layout - base) as f64 / 6000.0,
        );
        drop(tree);
    }
}

#[test]
pub(super) fn translucent_window_border_blends_over_the_background_for_dwm() {
    use crate::runtime::opaque_border_rgb;
    assert_eq!(opaque_border_rgb("#ffffff14", "#030303"), 0x171717);
    assert_eq!(opaque_border_rgb("#27272a", "#000000"), 0x27272a);
    assert_eq!(opaque_border_rgb("red", "#000000"), 0xe4e4e7);
}

/// A column of auto height whose child grows from a zero basis (`flex: 1`) is
/// as tall as its content, as in Chromium (143px here), also when its row sits
/// in a sized parent (fixed in vendor/taffy).
#[test]
pub(super) fn flex_one_child_counts_toward_an_auto_height_column() {
    let leaf = node("leaf", "view", json!({"width":50,"height":87}), vec![]);
    let body = node(
        "body",
        "row",
        json!({"direction":"row","flex":1}),
        vec![leaf],
    );
    let head = node("head", "view", json!({"height":22}), vec![]);
    let card = node(
        "card",
        "column",
        json!({"direction":"column","flex":1,"gap":10,"padding":12}),
        vec![head, body],
    );
    let row = node(
        "row",
        "row",
        json!({"direction":"row","align":"center","minHeight":190}),
        vec![card],
    );
    let mut tree = Tree::new(node("root", "window", json!({}), vec![row]));
    tree.compute(780.0, 600.0).unwrap();
    assert_eq!(tree.entries["card"].rect.height().round(), 143.0);
}

#[test]
pub(super) fn font_variant_numeric_switches_digit_widths() {
    crate::text::app_fonts::register(
        include_bytes!("../../../packages/headless/fonts/InterVariable.ttf").to_vec(),
    );
    let width = |text: &str, numeric: &str| {
        let n = node(
            "t",
            "text",
            json!({"fontFamily":"Inter Variable","fontSize":20,"fontVariantNumeric":numeric}),
            vec![],
        );
        let mut n = n;
        n.text = text.into();
        let mut tree = Tree::new(node("root", "window", json!({}), vec![n]));
        tree.compute(800.0, 200.0).unwrap();
        tree.text.measure("t", None).0
    };
    assert!(
        (width("1111", "tabular-nums") - width("0000", "tabular-nums")).abs() < 0.01,
        "tabular digits share one advance"
    );
    assert!(
        (width("1111", "proportional-nums") - width("0000", "proportional-nums")).abs() > 1.0,
        "proportional ones are narrower"
    );
}

#[test]
pub(super) fn scrollbar_width_none_hides_the_bar_but_keeps_scrolling() {
    let grab = |width: &str| {
        let tall = node("tall", "view", json!({"height":400,"shrink":0}), vec![]);
        let mut scroll = node(
            "s",
            "scroll",
            json!({"height":100,"width":100,"scrollbarWidth":width}),
            vec![tall],
        );
        scroll.scroll_orientation = "vertical".into();
        let mut tree = Tree::new(root(vec![scroll]));
        tree.compute(300.0, 300.0).unwrap();
        tree.scene(1.0);
        assert!(tree.entries["s"].scroll_max > 0.0, "scrollable");
        tree.mouse = (97.0, 50.0);
        tree.scrollbar_at_pointer().is_some()
    };
    assert!(grab("auto"), "the default bar can be grabbed");
    assert!(!grab("none"), "no bar to grab");
}

#[test]
pub(super) fn pointer_move_reports_local_position_to_the_innermost_listener() {
    let dot = node("dot", "view", json!({"width":20,"height":20}), vec![]);
    let mut chart = node(
        "chart",
        "view",
        json!({"width":200,"height":50,"margin":{"left":30,"top":10}}),
        vec![dot],
    );
    chart.report_pointer = true;
    let mut tree = Tree::new(root(vec![chart]));
    tree.compute(300.0, 200.0).unwrap();
    let events = tree.pointer_move(45.0, 22.0);
    let moved: Vec<_> = events
        .iter()
        .filter(|e| e["type"] == "pointerMove")
        .collect();
    assert_eq!(moved.len(), 1, "{events:?}");
    assert_eq!(moved[0]["id"], "chart");
    assert_eq!(moved[0]["x"], 15.0);
    assert_eq!(moved[0]["y"], 12.0);
    assert!(
        tree.pointer_move(45.0, 22.0)
            .iter()
            .all(|e| e["type"] != "pointerMove"),
        "unchanged position is not resent"
    );
    let left = tree.pointer_move(280.0, 150.0);
    assert!(
        left.iter().all(|e| e["type"] != "pointerMove"),
        "outside the node"
    );
    assert!(
        left.iter()
            .any(|e| e["type"] == "pointerLeave" && e["id"] == "chart"),
        "{left:?}"
    );
}

#[test]
pub(super) fn glass_params_hash_the_merge_key_and_clamp_the_blend() {
    let plain = crate::tree::glass_params(&serde_json::json!({ "blur": 8 })).unwrap();
    assert_eq!((plain.merge, plain.blend), (0, 0.0));
    let dock =
        crate::tree::glass_params(&serde_json::json!({ "blur": 8, "merge": "dock", "blend": 48 }))
            .unwrap();
    let same =
        crate::tree::glass_params(&serde_json::json!({ "blur": 2, "merge": "dock" })).unwrap();
    let other =
        crate::tree::glass_params(&serde_json::json!({ "blur": 2, "merge": "tray" })).unwrap();
    assert_ne!(dock.merge, 0);
    assert_eq!(dock.merge, same.merge);
    assert_ne!(dock.merge, other.merge);
    assert_eq!(dock.blend, 48.0);
    let empty =
        crate::tree::glass_params(&serde_json::json!({ "blur": 2, "merge": "", "blend": 1000 }))
            .unwrap();
    assert_eq!((empty.merge, empty.blend), (0, 128.0));
    assert!(crate::tree::glass_params(&serde_json::json!({ "merge": "dock" })).is_none());
}

#[test]
pub(super) fn the_pointer_is_on_a_text_area_scrollbar_only_over_its_track_and_while_dragging_it() {
    let text: String = (0..200).map(|line| format!("line {line}\n")).collect();
    let root: Node = serde_json::from_value(json!({
        "id":"root","kind":"window","children":[
            {"id":"editor","kind":"textarea","value":text,"style":{"width":200,"height":100},"children":[]}
        ]
    }))
    .unwrap();
    let mut tree = Tree::new(root);
    tree.compute(240.0, 120.0).unwrap();
    tree.pointer_move(50.0, 50.0);
    assert!(
        !tree.pointer_on_scrollbar(),
        "over the text: the caret cursor"
    );
    tree.pointer_move(196.0, 20.0);
    assert!(tree.pointer_on_scrollbar(), "over the scrollbar: the arrow");
    tree.pointer_down();
    tree.pointer_move(50.0, 60.0);
    assert!(
        tree.pointer_on_scrollbar(),
        "dragging the thumb keeps the arrow off the track"
    );
    tree.pointer_up();
    assert!(!tree.pointer_on_scrollbar());
}

#[test]
pub(super) fn a_text_area_draws_tabs_as_wide_spaces_and_pasted_crlf_as_one_break() {
    let root: Node = serde_json::from_value(json!({
        "id":"root","kind":"window","children":[
            {"id":"editor","kind":"textarea","value":"a","style":{"width":400,"height":100},"children":[]}
        ]
    }))
    .unwrap();
    let mut tree = Tree::new(root);
    tree.compute(440.0, 120.0).unwrap();
    tree.focus("editor");
    tree.key("End");
    tree.type_text("\tb\r\nc\rd");
    assert_eq!(
        tree.entries["editor"].node.value.as_deref(),
        Some("a\tb\nc\nd"),
        "tabs kept, \r\n and \r are one \n"
    );
}

#[test]
pub(super) fn a_wheel_notch_over_a_text_area_eases_too() {
    let text: String = (0..200).map(|line| format!("line {line}\n")).collect();
    let root: Node = serde_json::from_value(json!({
        "id":"root","kind":"window","children":[
            {"id":"editor","kind":"textarea","value":text,"style":{"width":200,"height":100},"children":[]}
        ]
    }))
    .unwrap();
    let mut tree = Tree::new(root);
    tree.compute(240.0, 120.0).unwrap();
    tree.pointer_move(20.0, 20.0);
    assert!(
        tree.entries["editor"].scroll_max > 100.0,
        "the text is taller than the area"
    );
    tree.advance_motion(1000.0);
    tree.wheel_notch(0.0, 100.0);
    assert_eq!(
        tree.entries["editor"].scroll, 0.0,
        "no jump on the notch itself"
    );
    tree.advance_motion(1000.0 + 1000.0 / 60.0);
    let first = tree.entries["editor"].scroll;
    assert!(
        first > 0.0 && first < 100.0,
        "the first frame is part of the way: {first}"
    );
    for frame in 2..=30 {
        tree.advance_motion(1000.0 + frame as f64 * 1000.0 / 60.0);
    }
    assert_eq!(tree.entries["editor"].scroll, 100.0);
}

#[test]
pub(super) fn a_wheel_notch_eases_to_its_offset_and_notches_that_follow_extend_the_trip() {
    let root: Node = serde_json::from_value(json!({
        "id":"root","kind":"window","children":[
            {"id":"scroll","kind":"scroll","style":{"width":200,"height":100},"children":[
                {"id":"content","kind":"view","style":{"width":200,"height":2000,"shrink":0},"children":[]}
            ]}
        ]
    }))
    .unwrap();
    let mut tree = Tree::new(root);
    tree.compute(240.0, 120.0).unwrap();
    tree.pointer_move(20.0, 20.0);
    let offset = |tree: &Tree| tree.entries["scroll"].scroll;
    tree.advance_motion(1000.0);
    assert!(
        tree.wheel_notch(0.0, 100.0).is_empty(),
        "the notch scrolls on the next frames"
    );
    assert_eq!(offset(&tree), 0.0);
    assert!(
        tree.next_motion_tick_ms().is_some(),
        "an eased notch schedules frames"
    );
    let mut last = 0.0;
    let mut frames = 0;
    for frame in 1..=20 {
        tree.advance_motion(1000.0 + frame as f64 * 1000.0 / 60.0);
        let now = offset(&tree);
        assert!(now >= last, "eases forward only: {last} -> {now}");
        if frame == 1 {
            assert!(now > 20.0, "the first frame already moves: {now}");
        }
        if now < 100.0 {
            frames += 1;
        }
        last = now;
    }
    assert_eq!(last, 100.0);
    assert!(
        frames >= 4,
        "eased over several frames, not one jump ({frames})"
    );
    assert!(tree.next_motion_tick_ms().is_none());

    // A second notch mid-trip continues from where the first was headed.
    tree.wheel_notch(0.0, 100.0);
    tree.advance_motion(2000.0);
    tree.wheel_notch(0.0, 100.0);
    for frame in 1..=20 {
        tree.advance_motion(2000.0 + frame as f64 * 1000.0 / 60.0);
    }
    assert_eq!(offset(&tree), 300.0);
    // Past the end it stops at the end.
    tree.wheel_notch(0.0, 5000.0);
    for frame in 1..=20 {
        tree.advance_motion(3000.0 + frame as f64 * 1000.0 / 60.0);
    }
    assert_eq!(offset(&tree), 1900.0);
}
