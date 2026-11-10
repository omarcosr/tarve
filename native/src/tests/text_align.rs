//! CSS `text-align`: physical left/right, logical start/end, and match-parent.
use super::*;

fn line_x(kind: &str, value: &str, text_align: &str) -> f64 {
    let mut field = node(
        "field",
        kind,
        json!({"width":240,"height":60,"padding":8,"fontSize":18,"textAlign":text_align}),
        vec![],
    );
    field.value = Some(value.into());
    let mut tree = Tree::new(root(vec![field]));
    tree.compute(300.0, 100.0).unwrap();
    let lines = tree.accessibility_text_lines("field", value);
    lines[0].x0 - tree.entries["field"].rect.x0
}

#[test]
fn left_and_right_are_physical_and_start_end_follow_the_text_direction() {
    for kind in ["input", "textarea"] {
        for value in ["abc", "\u{05e9}\u{05dc}\u{05d5}\u{05dd}"] {
            let rtl = value != "abc";
            let left = line_x(kind, value, "left");
            let right = line_x(kind, value, "right");
            assert!(
                left < 20.0,
                "{kind} {value}: left stays at the left edge ({left})"
            );
            assert!(
                right > 150.0,
                "{kind} {value}: right stays at the right edge ({right})"
            );
            let (start_edge, end_edge) = if rtl { (right, left) } else { (left, right) };
            let (start, end) = (line_x(kind, value, "start"), line_x(kind, value, "end"));
            assert!(
                (start - start_edge).abs() < 1.0,
                "{kind} {value}: start follows the direction ({start})"
            );
            assert!(
                (end - end_edge).abs() < 1.0,
                "{kind} {value}: end follows the direction ({end})"
            );
            let unresolved = line_x(kind, value, "match-parent");
            assert!(
                (unresolved - left).abs() < 1.0,
                "{kind} {value}: an unresolved match-parent is start against a left-to-right parent"
            );
        }
    }
}

const HEBREW: &str = "\u{05e9}\u{05dc}\u{05d5}\u{05dd}";

/// A 240px input (224px content box) holding `value`, laid out in a 300px window.
fn input_tree(value: &str, style: serde_json::Value) -> Tree {
    let mut style = style;
    for (key, default) in [
        ("width", json!(240)),
        ("height", json!(40)),
        ("padding", json!(8)),
        ("fontSize", json!(18)),
    ] {
        style.as_object_mut().unwrap().entry(key).or_insert(default);
    }
    let mut field = node("field", "input", style, vec![]);
    field.value = Some(value.into());
    let mut tree = Tree::new(root(vec![field]));
    tree.compute(300.0, 100.0).unwrap();
    tree
}

fn content_box(tree: &Tree) -> (f64, f64) {
    let rect = tree.entries["field"].rect;
    (rect.x0 + 8.0, rect.x1 - 8.0)
}

#[test]
fn single_line_input_centres_and_justify_is_start_on_its_only_line() {
    for value in ["abc", HEBREW] {
        let left = line_x("input", value, "left");
        let right = line_x("input", value, "right");
        let centre = line_x("input", value, "center");
        assert!(
            (centre - (left + right) / 2.0).abs() < 1.0,
            "{value}: center sits halfway between the edges ({left} {centre} {right})"
        );
        // CSS: `justify` aligns a paragraph's last line (here its only one) to `start`.
        let justify = line_x("input", value, "justify");
        let start = line_x("input", value, "start");
        assert!(
            (justify - start).abs() < 1.0,
            "{value}: justify is start on one line"
        );
    }
}

#[test]
fn input_caret_and_ime_area_sit_on_the_aligned_text() {
    for value in ["abc", HEBREW] {
        let rtl = value != "abc";
        for align in ["left", "center", "right", "start", "end"] {
            let mut tree = input_tree(value, json!({"textAlign":align}));
            let _ = tree.focus("field");
            let line = tree.accessibility_text_lines("field", value)[0].clone();
            // Logical start/end are the visual right/left of a right-to-left line.
            let (home_x, end_x) = if rtl {
                (line.x1, line.x0)
            } else {
                (line.x0, line.x1)
            };
            tree.key("Home");
            let home = tree.ime_cursor_area().unwrap();
            tree.key("End");
            let end = tree.ime_cursor_area().unwrap();
            assert!(
                (home.x0 - home_x).abs() < 1.5,
                "{value} {align}: Home caret {} vs text {home_x}",
                home.x0
            );
            assert!(
                (end.x0 - end_x).abs() < 1.5,
                "{value} {align}: End caret {} vs text {end_x}",
                end.x0
            );
        }
    }
}

#[test]
fn empty_input_caret_follows_the_alignment_not_the_placeholder() {
    for (align, expected) in [
        ("start", 0.0),
        ("center", 112.0),
        ("end", 223.0),
        ("right", 223.0),
    ] {
        let mut field = node(
            "field",
            "input",
            json!({"width":240,"height":40,"padding":8,"fontSize":18,"textAlign":align}),
            vec![],
        );
        field.value = Some(String::new());
        field.placeholder = HEBREW.into();
        let mut tree = Tree::new(root(vec![field]));
        tree.compute(300.0, 100.0).unwrap();
        let _ = tree.focus("field");
        let caret = tree.ime_cursor_area().unwrap();
        let (left, _) = content_box(&tree);
        assert!(
            (caret.x0 - left - expected).abs() < 1.5,
            "{align}: empty caret at {} (expected {expected})",
            caret.x0 - left
        );
    }
}

#[test]
fn clicking_an_aligned_input_hits_the_glyph_under_the_pointer() {
    for (value, align) in [
        ("abcd", "right"),
        ("abcd", "center"),
        (HEBREW, "left"),
        (HEBREW, "end"),
    ] {
        let mut tree = input_tree(value, json!({"textAlign":align}));
        let line = tree.accessibility_text_lines("field", value)[0].clone();
        let rect = tree.entries["field"].rect;
        let y = (rect.y0 + rect.y1) / 2.0;
        // The left half of the third character in logical order: its caret stop is before it
        // (left-to-right) or after it (right-to-left).
        let third = value.char_indices().nth(2).unwrap().0;
        let x = if line.right_to_left {
            line.x1
                - f64::from(line.character_positions[2])
                - f64::from(line.character_widths[2]) * 0.2
        } else {
            line.x0
                + f64::from(line.character_positions[2])
                + f64::from(line.character_widths[2]) * 0.2
        };
        tree.pointer_move(x, y);
        tree.pointer_down();
        tree.pointer_up();
        assert_eq!(tree.focused.as_deref(), Some("field"));
        assert_eq!(
            tree.caret_for_test(),
            third,
            "{value} {align}: click at {x}"
        );
    }
}

#[test]
fn an_overflowing_input_scrolls_its_line_to_keep_the_caret_visible() {
    let long = "abcdefghijklmnopqrstuvwxyz0123456789";
    let hebrew = HEBREW.repeat(8);
    for (value, align) in [
        (long, "start"),
        (long, "center"),
        (long, "right"),
        (hebrew.as_str(), "start"),
        (hebrew.as_str(), "left"),
    ] {
        let rtl = value != long;
        let mut tree = input_tree(value, json!({"width":120,"textAlign":align}));
        let (left, right) = content_box(&tree);
        // Blurred, an overflowing line shows its start: the start edge of the content box.
        let line = tree.accessibility_text_lines("field", value)[0].clone();
        if rtl {
            assert!(
                (line.x1 - right).abs() < 1.5,
                "{align}: right-to-left start at the right edge ({})",
                line.x1
            );
        } else {
            assert!(
                (line.x0 - left).abs() < 1.5,
                "{align}: start at the left edge ({})",
                line.x0
            );
        }
        let _ = tree.focus("field");
        for key in ["End", "Home", "End"] {
            tree.key(key);
            let caret = tree.ime_cursor_area().unwrap();
            assert!(
                caret.x0 >= left - 0.5 && caret.x0 <= right + 0.5,
                "{value} {align} {key}: caret {} outside the content box {left}..{right}",
                caret.x0
            );
            let line = tree.accessibility_text_lines("field", value)[0].clone();
            let end_edge = if rtl { line.x0 } else { line.x1 };
            let start_edge = if rtl { line.x1 } else { line.x0 };
            let edge = if key == "End" { end_edge } else { start_edge };
            assert!(
                (caret.x0 - edge).abs() < 1.5,
                "{value} {align} {key}: the caret stays on the text ({} vs {edge})",
                caret.x0
            );
        }
        let scroll = tree.entries["field"].input_scroll_x;
        assert!(
            if rtl { scroll < -10.0 } else { scroll > 10.0 },
            "{align}: scrolled to the end ({scroll})"
        );
        // A click near the visible end edge lands near the end of the text, not where the
        // unscrolled line would put that point.
        let rect = tree.entries["field"].rect;
        let x = if rtl { left + 2.0 } else { right - 2.0 };
        tree.pointer_move(x, (rect.y0 + rect.y1) / 2.0);
        tree.pointer_down();
        tree.pointer_up();
        let caret = tree.caret_for_test();
        assert!(
            caret + 4 >= value.len(),
            "{align}: click at the scrolled end hits byte {caret} of {}",
            value.len()
        );
        tree.key("Home");
        let _ = tree.ime_cursor_area();
        assert_eq!(
            tree.entries["field"].input_scroll_x, 0.0,
            "{align}: Home scrolls back to the start"
        );
    }
}

#[test]
fn protocol_validates_text_align_keywords() {
    for align in [
        "start",
        "center",
        "end",
        "justify",
        "left",
        "right",
        "match-parent",
    ] {
        let label = node("label", "text", json!({"textAlign":align}), vec![]);
        assert!(protocol::validate(&root(vec![label])).is_ok(), "{align}");
    }
    for bad in [json!("middle"), json!(3)] {
        let label = node("label", "text", json!({"textAlign":bad}), vec![]);
        assert!(protocol::validate(&root(vec![label])).is_err(), "{bad}");
    }
}
