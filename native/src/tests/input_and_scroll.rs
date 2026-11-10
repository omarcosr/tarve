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

/// A text area under an overlay that covers the window; `overlay` adds to the overlay
/// node (its `style`, `modal`).
fn text_area_under(overlay: serde_json::Value) -> Tree {
    let text: String = (0..200).map(|line| format!("line {line}\n")).collect();
    let mut cover = json!({
        "id":"overlay","kind":"view","children":[],
        "style":{"position":"absolute","top":0,"right":0,"bottom":0,"left":0}
    });
    if let Some(style) = overlay.get("style").and_then(|s| s.as_object()) {
        for (key, value) in style {
            cover["style"][key] = value.clone();
        }
    }
    if let Some(modal) = overlay.get("modal") {
        cover["modal"] = modal.clone();
    }
    let root: Node = serde_json::from_value(json!({
        "id":"root","kind":"window","children":[
            {"id":"editor","kind":"textarea","value":text,"style":{"width":200,"height":100},"children":[]},
            cover
        ]
    }))
    .unwrap();
    let mut tree = Tree::new(root);
    tree.compute(240.0, 120.0).unwrap();
    tree.scene(1.0);
    assert!(
        tree.entries["editor"].scroll_max > 100.0,
        "the text area scrolls"
    );
    tree
}

/// Wheel, scrollbar hover and a thumb drag over the text area: (scroll after the
/// wheel, bar under the pointer, scroll the drag added).
fn poke_text_area(tree: &mut Tree) -> (f64, bool, f64) {
    tree.pointer_move(50.0, 50.0);
    tree.wheel_2d(0.0, 40.0);
    let wheeled = tree.entries["editor"].scroll;
    tree.pointer_move(196.0, 20.0);
    let on_bar = tree.pointer_on_scrollbar();
    tree.pointer_down();
    tree.pointer_move(196.0, 90.0);
    tree.pointer_up();
    (wheeled, on_bar, tree.entries["editor"].scroll - wheeled)
}

#[test]
pub(super) fn a_plain_box_over_a_text_area_lets_wheel_and_scrollbar_through() {
    // Unlike CSS, where `pointer-events: auto` stops at the frontmost box, a plain
    // view takes no pointer: the text area behind it still scrolls.
    let mut tree = text_area_under(json!({"style":{"background":"#00000080"}}));
    let (wheeled, on_bar, dragged) = poke_text_area(&mut tree);
    assert_eq!(wheeled, 40.0, "the wheel reaches the text area");
    assert!(on_bar, "its scrollbar is hit through the box");
    assert!(dragged > 0.0, "and can be dragged");
}

#[test]
pub(super) fn a_blocking_overlay_makes_the_text_area_behind_it_untouchable() {
    for (label, overlay) in [
        (
            "pointerEvents: block",
            json!({"style":{"pointerEvents":"block"}}),
        ),
        ("modal", json!({"modal": true})),
        (
            "the core Modal overlay",
            json!({"modal": true, "style":{"pointerEvents":"block","background":"#00000080"}}),
        ),
    ] {
        let mut tree = text_area_under(overlay);
        let (wheeled, on_bar, dragged) = poke_text_area(&mut tree);
        assert_eq!(wheeled, 0.0, "{label}: the wheel stops at the overlay");
        assert!(!on_bar, "{label}: no scrollbar under the overlay");
        assert_eq!(dragged, 0.0, "{label}: no thumb drag through it");
    }
}

fn editor(extra: serde_json::Value, value: &str) -> Tree {
    let mut area = json!({"id":"editor","kind":"textarea","value":value,"style":{"width":200,"height":100},"children":[]});
    for (key, field) in extra.as_object().unwrap() {
        area[key] = field.clone();
    }
    let root: Node =
        serde_json::from_value(json!({"id":"root","kind":"window","children":[area]})).unwrap();
    let mut tree = Tree::new(root);
    tree.compute(240.0, 120.0).unwrap();
    tree.focus("editor");
    tree
}

#[test]
pub(super) fn a_read_only_text_area_keeps_its_value() {
    let mut tree = editor(json!({"readOnly": true}), "hello");
    tree.key("End");
    assert!(tree.type_text("x").is_empty(), "typing is dropped");
    assert!(tree.key("Backspace").is_empty(), "so is deleting");
    assert!(tree.key("Enter").is_empty(), "and a new line");
    assert_eq!(tree.entries["editor"].node.value.as_deref(), Some("hello"));
    assert!(
        !crate::runtime::ime_allowed_for_node(Some(&tree.entries["editor"].node)),
        "no IME composition"
    );
}

#[test]
pub(super) fn max_length_cuts_a_paste_to_fit_and_drops_typing_past_it() {
    let mut tree = editor(json!({"maxLength": 5}), "ab");
    tree.key("End");
    tree.type_text("çdefgh");
    assert_eq!(
        tree.entries["editor"].node.value.as_deref(),
        Some("abçde"),
        "cut to five characters"
    );
    assert!(tree.type_text("z").is_empty(), "full: typing is dropped");
    tree.key("Backspace");
    tree.type_text("z");
    assert_eq!(tree.entries["editor"].node.value.as_deref(), Some("abçdz"));
    // A longer value from the app is kept and can still shrink.
    let mut long = editor(json!({"maxLength": 3}), "abcdef");
    long.key("End");
    assert!(long.type_text("x").is_empty());
    long.key("Backspace");
    assert_eq!(long.entries["editor"].node.value.as_deref(), Some("abcde"));
}

#[test]
pub(super) fn a_follow_tail_text_area_keeps_its_end_in_view_as_the_value_grows() {
    let lines =
        |count: usize| -> String { (0..count).map(|line| format!("line {line}\n")).collect() };
    let node_with = |count: usize| -> Node {
        serde_json::from_value(json!({"id":"root","kind":"window","children":[
            {"id":"log","kind":"textarea","readOnly":true,"followTail":true,"value":lines(count),"style":{"width":200,"height":100},"children":[]}
        ]}))
        .unwrap()
    };
    let mut tree = Tree::new(node_with(3));
    tree.compute(240.0, 120.0).unwrap();
    assert_eq!(tree.entries["log"].scroll, 0.0, "short: nothing to scroll");
    tree.update(node_with(50));
    tree.compute(240.0, 120.0).unwrap();
    let max = tree.entries["log"].scroll_max;
    assert!(max > 0.0);
    assert_eq!(tree.entries["log"].scroll, max, "it followed the new lines");
    tree.pointer_move(50.0, 50.0);
    tree.wheel_2d(0.0, -60.0);
    let away = tree.entries["log"].scroll;
    assert!(away < max);
    tree.update(node_with(80));
    tree.compute(240.0, 120.0).unwrap();
    assert_eq!(tree.entries["log"].scroll, away, "scrolled up: it stays");
}

#[test]
#[ignore = "benchmark: cargo test --lib bench_text_area_append -- --ignored --nocapture"]
pub(super) fn bench_text_area_append() {
    let doc = |value: &str| -> Node {
        serde_json::from_value(json!({"id":"root","kind":"window","children":[
            {"id":"log","kind":"textarea","readOnly":true,"followTail":true,"value":value,"style":{"width":600,"height":400},"children":[]}
        ]}))
        .unwrap()
    };
    for lines in [1_000usize, 5_000, 20_000] {
        let mut value: String = (0..lines)
            .map(|i| format!("[{i:06}] INFO request handled in 12ms path=/api/items?page={i}\n"))
            .collect();
        let mut tree = Tree::new(doc(&value));
        tree.compute(640.0, 440.0).unwrap();
        tree.scene(1.0);
        let rounds = 20;
        let (mut update, mut compute, mut scene) = (0.0, 0.0, 0.0);
        let start = std::time::Instant::now();
        for round in 0..rounds {
            value.push_str(&format!("[append {round}] new line\n"));
            let t = std::time::Instant::now();
            tree.update(doc(&value));
            update += t.elapsed().as_secs_f64();
            let t = std::time::Instant::now();
            tree.compute(640.0, 440.0).unwrap();
            compute += t.elapsed().as_secs_f64();
            let t = std::time::Instant::now();
            tree.scene(1.0);
            scene += t.elapsed().as_secs_f64();
        }
        let ms = |s: f64| s * 1000.0 / rounds as f64;
        let per = ms(start.elapsed().as_secs_f64());
        println!(
            "{lines:>6} lines ({:>5} KB): {per:.2} ms per append (update {:.2}, compute {:.2}, scene {:.2})",
            value.len() / 1024,
            ms(update),
            ms(compute),
            ms(scene)
        );
    }
}

/// A text area long enough to be shaped in chunks, laid out with or without them.
fn long_text_area(value: &str, chunked: bool) -> Tree {
    let root: Node = serde_json::from_value(json!({"id":"root","kind":"window","children":[
        {"id":"log","kind":"textarea","value":value,"style":{"width":300,"height":200},"children":[]}
    ]}))
    .unwrap();
    let mut tree = Tree::new(root);
    if !chunked {
        tree.text.chunked_text_area_bytes = usize::MAX;
    }
    tree.compute(340.0, 240.0).unwrap();
    tree.scene(1.0);
    tree
}

fn log_lines(range: std::ops::Range<usize>) -> String {
    range
        .map(|i| {
            if i % 7 == 0 {
                "\n".to_string()
            } else {
                format!(
                    "[{i:05}] a line long enough to wrap at three hundred pixels wide, number {i}\n"
                )
            }
        })
        .collect()
}

#[test]
pub(super) fn a_chunked_text_area_lays_out_like_one_layout() {
    let value = log_lines(0..1200);
    assert!(value.len() > 3 * crate::text::CHUNKED_TEXT_AREA_BYTES_FOR_TESTS);
    let mut chunked = long_text_area(&value, true);
    let mut whole = long_text_area(&value, false);
    let width = Some(chunked.entries["log"].rect.width() as f32);
    for w in [width, None] {
        assert_eq!(
            chunked.text.measure("log", w),
            whole.text.measure("log", w),
            "size at {w:?}"
        );
    }
    assert_eq!(
        chunked.entries["log"].scroll_max,
        whole.entries["log"].scroll_max
    );
    let close = |a: f64, b: f64| (a - b).abs() < 0.01;
    let breaks = value.match_indices('\n').map(|(i, _)| i);
    let some_breaks: Vec<usize> = breaks
        .clone()
        .step_by(97)
        .chain(breaks.clone().rev().take(3))
        .collect();
    let indices: Vec<usize> = [
        0,
        1,
        80,
        81,
        4095,
        4096,
        4097,
        9000,
        value.len() / 2,
        value.len(),
    ]
    .into_iter()
    // Line starts; a caret on a line break itself is left out: one long layout puts
    // some of those at the end of the text (a Parley lookup), a chunk where they are.
    .chain(some_breaks.iter().map(|i| *i + 1))
    .filter(|i| value.as_bytes().get(*i) != Some(&b'\n'))
    // One Parley layout puts every caret past about 60,000 characters at the end of
    // the text; chunks, each far shorter, do not.
    .filter(|i| *i < 50_000)
    .collect();
    for index in indices {
        let index = (0..=index)
            .rev()
            .find(|i| value.is_char_boundary(*i))
            .unwrap();
        let a = chunked.text.caret_rect("log", index, width).unwrap();
        let b = whole.text.caret_rect("log", index, width).unwrap();
        assert!(
            close(a.x0, b.x0) && close(a.y0, b.y0) && close(a.y1, b.y1),
            "caret {index}: {a:?} vs {b:?}"
        );
        let (x, y) = (a.x0 as f32 + 0.5, (a.y0 + a.y1) as f32 / 2.0);
        assert_eq!(
            chunked.text.index_at("log", x, y, width),
            whole.text.index_at("log", x, y, width),
            "hit at {index}"
        );
    }
    // Past 65,536 bytes one layout's offsets wrap around: compare the lines above that.
    let limit = chunked.text.caret_rect("log", 50_000, width).unwrap().y0;
    let lines = |tree: &mut Tree| -> Vec<(std::ops::Range<usize>, i64)> {
        tree.text
            .accessibility_lines("log", &value, width)
            .into_iter()
            .filter(|line| line.byte_range.end < 50_000 && line.y0 < limit)
            .map(|line| (line.byte_range, (line.y0 * 100.0).round() as i64))
            .collect()
    };
    assert_eq!(lines(&mut chunked), lines(&mut whole));
}

#[test]
pub(super) fn appending_to_a_chunked_text_area_shapes_only_its_end() {
    let mut value = log_lines(0..1200);
    let mut tree = long_text_area(&value, true);
    let doc = |value: &str| -> Node {
        serde_json::from_value(json!({"id":"root","kind":"window","children":[
            {"id":"log","kind":"textarea","value":value,"style":{"width":300,"height":200},"children":[]}
        ]}))
        .unwrap()
    };
    for round in 0..50 {
        value.push_str(&format!("appended {round}\n"));
        tree.update(doc(&value));
        tree.compute(340.0, 240.0).unwrap();
        tree.scene(1.0);
    }
    // A mid edit and an edit at the start reuse the rest too.
    value.insert_str(value.len() / 2, "inserted ");
    value.insert_str(0, "first ");
    tree.update(doc(&value));
    tree.compute(340.0, 240.0).unwrap();
    let whole = long_text_area(&value, false);
    assert_eq!(
        tree.entries["log"].scroll_max, whole.entries["log"].scroll_max,
        "the reused chunks lay out as the whole text"
    );
    let width = Some(tree.entries["log"].rect.width() as f32);
    let mut whole = whole;
    for index in [0, 6, 20_000, 45_000] {
        let index = (0..=index)
            .rev()
            .find(|i| value.is_char_boundary(*i))
            .unwrap();
        let a = tree.text.caret_rect("log", index, width).unwrap();
        let b = whole.text.caret_rect("log", index, width).unwrap();
        assert!(
            (a.y0 - b.y0).abs() < 0.01 && (a.x0 - b.x0).abs() < 0.01,
            "caret {index}: {a:?} vs {b:?}"
        );
    }
    let height = tree.text.measure("log", width).1 as f64;
    let end = tree.text.caret_rect("log", value.len(), width).unwrap();
    assert!(
        (end.y1 - height).abs() < 1.0,
        "the caret at the end is on the last line: {end:?}, {height}"
    );
    assert!(tree.text.chunk_count("log") > 1, "chunked");
    assert!(
        tree.text.chunk_count("log") < value.len() / 1024,
        "one-line appends merge into chunks: {}",
        tree.text.chunk_count("log")
    );
}

#[test]
#[ignore = "benchmark: cargo test --lib bench_rich_append -- --ignored --nocapture"]
pub(super) fn bench_rich_append() {
    fn time(
        label: &str,
        lines: usize,
        make: &dyn Fn(&str) -> serde_json::Value,
        line: &dyn Fn(usize) -> String,
    ) {
        let mut value: String = (0..lines).map(line).collect();
        let doc = |value: &str| -> Node {
            let mut n = make(value);
            n["id"] = json!("n");
            n["children"] = json!([]);
            serde_json::from_value(json!({"id":"root","kind":"window","children":[
                {"id":"s","kind":"scroll","style":{"width":600,"height":400},"children":[n]}
            ]}))
            .unwrap()
        };
        let mut tree = Tree::new(doc(&value));
        tree.compute(640.0, 440.0).unwrap();
        tree.scene(1.0);
        let rounds = 10;
        let (mut update, mut compute, mut scene) = (0.0, 0.0, 0.0);
        for round in 0..rounds {
            value.push_str(&line(lines + round));
            let t = std::time::Instant::now();
            tree.update(doc(&value));
            update += t.elapsed().as_secs_f64();
            let t = std::time::Instant::now();
            tree.compute(640.0, 440.0).unwrap();
            compute += t.elapsed().as_secs_f64();
            let t = std::time::Instant::now();
            tree.scene(1.0);
            scene += t.elapsed().as_secs_f64();
        }
        let ms = |s: f64| s * 1000.0 / rounds as f64;
        println!(
            "{label:<14} {lines:>6} lines ({:>5} KB): {:.2} ms (update {:.2}, compute {:.2}, scene {:.2})",
            value.len() / 1024,
            ms(update + compute + scene),
            ms(update),
            ms(compute),
            ms(scene)
        );
    }
    let log =
        |i: usize| format!("[{i:06}] INFO request handled in 12ms path=/api/items?page={i}\n");
    let rust =
        |i: usize| format!("    let value_{i} = compute(\"item\", {i}) + offset; // step {i}\n");
    let md = |i: usize| {
        if i.is_multiple_of(10) {
            format!("\n## Section {i}\n\n")
        } else {
            format!("Paragraph {i} with **bold**, `code` and a [link](https://x.y/{i}).\n")
        }
    };
    for lines in [1_000usize, 5_000] {
        time(
            "text",
            lines,
            &|v| json!({"kind":"text","text":v,"style":{"width":580}}),
            &log,
        );
        time(
            "code",
            lines,
            &|v| json!({"kind":"code","text":v,"language":"rust"}),
            &rust,
        );
        time(
            "code+gutter",
            lines,
            &|v| json!({"kind":"code","text":v,"language":"rust","showLineNumbers":true}),
            &rust,
        );
        time(
            "markdown",
            lines,
            &|v| json!({"kind":"markdown","source":v,"style":{"width":580}}),
            &md,
        );
        time(
            "diff",
            lines,
            &|v| {
                let old: String = v.lines().step_by(2).map(|l| format!("{l}\n")).collect();
                json!({"kind":"diff","oldText":old,"newText":v,"path":"a.rs"})
            },
            &rust,
        );
    }
}

/// A long leaf (`code`, `text`) in a scroll area, shaped in chunks or as one layout.
fn long_leaf(leaf: serde_json::Value, chunked: bool) -> Tree {
    let mut leaf = leaf;
    leaf["id"] = json!("leaf");
    leaf["children"] = json!([]);
    let root: Node = serde_json::from_value(json!({"id":"root","kind":"window","children":[
        {"id":"s","kind":"scroll","style":{"width":400,"height":300},"children":[leaf]}
    ]}))
    .unwrap();
    let mut tree = Tree::new(root);
    if !chunked {
        tree.text.chunked_text_area_bytes = usize::MAX;
    }
    tree.compute(440.0, 340.0).unwrap();
    tree.scene(1.0);
    tree
}

fn same_geometry(leaf: serde_json::Value, value: &str, width: Option<f32>) {
    let mut chunked = long_leaf(leaf.clone(), true);
    let mut whole = long_leaf(leaf, false);
    assert!(chunked.text.chunk_count("leaf") > 1, "chunked");
    assert_eq!(whole.text.chunk_count("leaf"), 0);
    for w in [width, None] {
        assert_eq!(
            chunked.text.measure("leaf", w),
            whole.text.measure("leaf", w),
            "size at {w:?}"
        );
    }
    assert_eq!(chunked.entries["leaf"].rect, whole.entries["leaf"].rect);
    let close = |a: f64, b: f64| (a - b).abs() < 0.01;
    let breaks = value.match_indices('\n').map(|(i, _)| i + 1);
    let indices: Vec<usize> = [0, 1, 80, 4095, 4096, 9000, 30_000]
        .into_iter()
        .chain(breaks.step_by(53))
        .filter(|i| *i < 50_000 && *i <= value.len() && value.as_bytes().get(*i) != Some(&b'\n'))
        .collect();
    for index in indices {
        let index = (0..=index)
            .rev()
            .find(|i| value.is_char_boundary(*i))
            .unwrap();
        let a = chunked.text.caret_rect("leaf", index, width).unwrap();
        let b = whole.text.caret_rect("leaf", index, width).unwrap();
        assert!(
            close(a.x0, b.x0) && close(a.y0, b.y0) && close(a.y1, b.y1),
            "caret {index}: {a:?} vs {b:?}"
        );
        let (x, y) = (a.x0 as f32 + 0.5, (a.y0 + a.y1) as f32 / 2.0);
        assert_eq!(
            chunked.text.index_at("leaf", x, y, width),
            whole.text.index_at("leaf", x, y, width),
            "hit at {index}"
        );
        let end = (index + 30).min(value.len());
        let end = (0..=end)
            .rev()
            .find(|i| value.is_char_boundary(*i))
            .unwrap();
        let ra = chunked.text.range_rects("leaf", index, end, width);
        let rb = whole.text.range_rects("leaf", index, end, width);
        let rows = |rects: &[parley::BoundingBox]| -> Vec<(i64, i64)> {
            rects
                .iter()
                .filter(|r| r.x1 > r.x0)
                .map(|r| ((r.y0 * 10.0).round() as i64, (r.x1 * 10.0).round() as i64))
                .collect()
        };
        assert_eq!(rows(&ra), rows(&rb), "selection {index}..{end}");
    }
}

#[test]
pub(super) fn a_chunked_code_block_lays_out_like_one_layout() {
    let value: String = (0..900)
        .map(|i| match i % 9 {
            0 => format!("/* block comment {i}\n"),
            1 => "   still a comment */\n".to_string(),
            2 => "\n".to_string(),
            3 => format!("\tlet tabbed_{i} = \"tab\";\n"),
            _ => format!("    let value_{i} = compute(\"item\", {i}) + offset; // step {i}\n"),
        })
        .collect();
    for numbers in [false, true] {
        same_geometry(
            json!({"kind":"code","text":value,"language":"rust","showLineNumbers":numbers}),
            &value,
            None,
        );
    }
    let mut tree = long_leaf(
        json!({"kind":"code","text":value,"language":"rust","showLineNumbers":true}),
        true,
    );
    assert_eq!(
        tree.text.code_gutter_layouts["leaf"].len(),
        value.split('\n').count()
    );
    // Growing reuses the numbers and the chunks before the end.
    let grown = format!("{value}fn appended() {{}}\n");
    tree.update(serde_json::from_value(json!({"id":"root","kind":"window","children":[
        {"id":"s","kind":"scroll","style":{"width":400,"height":300},"children":[
            {"id":"leaf","kind":"code","text":grown,"language":"rust","showLineNumbers":true,"children":[]}
        ]}
    ]})).unwrap());
    tree.compute(440.0, 340.0).unwrap();
    let whole = long_leaf(
        json!({"kind":"code","text":grown,"language":"rust","showLineNumbers":true}),
        false,
    );
    assert_eq!(tree.entries["leaf"].rect, whole.entries["leaf"].rect);
    assert_eq!(
        tree.text.code_gutter_layouts["leaf"].len(),
        grown.split('\n').count()
    );
}

#[test]
pub(super) fn a_chunked_plain_text_lays_out_like_one_layout() {
    let value = log_lines(0..1200);
    same_geometry(
        json!({"kind":"text","text":value,"style":{"width":360}}),
        &value,
        Some(360.0),
    );
}
