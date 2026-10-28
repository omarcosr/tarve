//! Popups: portals that dismiss on outside presses (menus, popovers, selects).
use super::*;

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

/// The popup's (x0, y0, x1, y1) after layout in a 300 × 200 window.
fn popup_rect(trigger_style: serde_json::Value, popup_style: serde_json::Value) -> PopupBox {
    let mut popup = node("popup", "column", popup_style, vec![]);
    popup.portal = true;
    popup.dismiss_on_outside = true;
    let trigger = node("trigger", "view", trigger_style, vec![popup]);
    let mut tree = Tree::new(root(vec![trigger]));
    tree.compute(300.0, 200.0).unwrap();
    let rect = tree.entries["popup"].rect;
    PopupBox {
        x0: rect.x0,
        y0: rect.y0,
        x1: rect.x1,
        y1: rect.y1,
    }
}

struct PopupBox {
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
}

#[test]
fn popup_past_the_right_edge_aligns_to_the_end_of_its_trigger() {
    let rect = popup_rect(
        json!({"position":"absolute","left":260,"top":10,"width":32,"height":32}),
        json!({"position":"absolute","top":38,"left":0,"width":180,"height":100}),
    );
    assert_eq!((rect.x0, rect.x1), (112.0, 292.0));
    assert_eq!(rect.y0, 48.0, "a popup that fits vertically stays below");
}

#[test]
fn popup_past_the_bottom_flips_above_its_trigger() {
    let rect = popup_rect(
        json!({"position":"absolute","left":10,"top":150,"width":40,"height":30}),
        json!({"position":"absolute","top":36,"left":0,"width":120,"height":100}),
    );
    // 6 px below the trigger becomes 6 px above it.
    assert_eq!((rect.y0, rect.y1), (44.0, 144.0));
    assert_eq!(rect.x0, 10.0);
}

#[test]
fn popup_without_room_on_either_side_slides_inside() {
    let rect = popup_rect(
        json!({"position":"absolute","left":10,"top":90,"width":40,"height":20}),
        json!({"position":"absolute","top":26,"left":0,"width":120,"height":150}),
    );
    assert_eq!((rect.y0, rect.y1), (42.0, 192.0));
}

#[test]
fn popup_that_fits_and_full_window_overlays_stay_put() {
    let rect = popup_rect(
        json!({"position":"absolute","left":10,"top":10,"width":40,"height":30}),
        json!({"position":"absolute","top":36,"left":0,"width":120,"height":60}),
    );
    assert_eq!((rect.x0, rect.y0), (10.0, 46.0));
    let overlay = popup_rect(
        json!({"position":"absolute","left":0,"top":0,"width":300,"height":200}),
        json!({"position":"absolute","top":0,"left":0,"width":300,"height":200}),
    );
    assert_eq!((overlay.x0, overlay.y0), (0.0, 0.0));
}
