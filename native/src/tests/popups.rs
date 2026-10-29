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

fn corner_menu(left: f64, top: f64, fallbacks: &str) -> Tree {
    let item = node(
        "menu-item",
        "button",
        json!({"width":120,"height":80}),
        vec![],
    );
    let mut menu = node(
        "menu",
        "column",
        json!({"position":"absolute","top":"100%","left":0,"margin":{"top":6},
            "width":120,"height":80,"zIndex":1000,"positionTryFallbacks":fallbacks}),
        vec![item],
    );
    menu.portal = true;
    let anchor = node(
        "anchor",
        "view",
        json!({"position":"absolute","left":left,"top":top,"width":30,"height":20}),
        vec![menu],
    );
    let mut tree = Tree::new(root(vec![anchor]));
    tree.compute(300.0, 200.0).unwrap();
    tree.scene(1.0);
    tree
}

#[test]
fn portal_position_try_flips_into_the_window_and_hit_tests_there() {
    use vello_cpu::kurbo::Rect as BoxRect;
    let tree = corner_menu(
        260.0,
        170.0,
        "flip-block, flip-inline, flip-block flip-inline",
    );
    assert_eq!(
        tree.visible_rect("menu"),
        Some(BoxRect::new(170.0, 84.0, 290.0, 164.0)),
        "right edge meets the anchor's right edge, and the menu sits 6px above it"
    );
    let mut tree = tree;
    tree.pointer_move(180.0, 100.0);
    assert_eq!(tree.hovered.as_deref(), Some("menu-item"));

    let tree = corner_menu(
        260.0,
        20.0,
        "flip-block, flip-inline, flip-block flip-inline",
    );
    assert_eq!(
        tree.visible_rect("menu"),
        Some(BoxRect::new(170.0, 46.0, 290.0, 126.0)),
        "room below: only the inline axis flips"
    );

    let tree = corner_menu(
        20.0,
        20.0,
        "flip-block, flip-inline, flip-block flip-inline",
    );
    assert_eq!(
        tree.visible_rect("menu"),
        Some(BoxRect::new(20.0, 46.0, 140.0, 126.0))
    );

    let tree = corner_menu(260.0, 170.0, "flip-block");
    assert_eq!(
        tree.visible_rect("menu"),
        Some(BoxRect::new(260.0, 196.0, 380.0, 276.0)),
        "no option fits: the base position stays, as in CSS"
    );
}

#[test]
fn tooltip_lane_flips_by_its_visible_box() {
    use vello_cpu::kurbo::Rect as BoxRect;
    let content = node(
        "tip",
        "view",
        json!({"position":"relative","width":120,"height":30,
            "positionTryFallbacks":"flip-block, flip-inline, flip-block flip-inline"}),
        vec![],
    );
    let mut lane = node(
        "lane",
        "column",
        json!({"position":"absolute","bottom":"100%","left":0,"right":-320,
            "align":"start","margin":{"bottom":6},"zIndex":1000}),
        vec![content],
    );
    lane.portal = true;
    let anchor = node(
        "anchor",
        "view",
        json!({"position":"absolute","left":260,"top":10,"width":30,"height":20}),
        vec![lane],
    );
    let mut tree = Tree::new(root(vec![anchor]));
    tree.compute(300.0, 200.0).unwrap();
    tree.scene(1.0);
    assert_eq!(
        tree.visible_rect("tip"),
        Some(BoxRect::new(170.0, 36.0, 290.0, 66.0)),
        "no room above or to the right: the tooltip shows below, right-aligned to its trigger"
    );
}

#[test]
fn position_try_fallbacks_parse_like_css() {
    use crate::protocol::{PositionTry, position_try_fallbacks};
    assert_eq!(position_try_fallbacks(&json!("none")), Ok(vec![]));
    assert_eq!(
        position_try_fallbacks(&json!("flip-block, flip-inline flip-block")),
        Ok(vec![
            PositionTry {
                block: true,
                inline: false
            },
            PositionTry {
                block: true,
                inline: true
            },
        ])
    );
    for invalid in [
        json!("flip-start"),
        json!("flip-block,"),
        json!("flip-block flip-block"),
        json!(3),
    ] {
        assert!(position_try_fallbacks(&invalid).is_err(), "{invalid}");
    }
}

#[test]
fn an_in_flow_box_dismisses_on_outside_too() {
    let item = node("item", "button", json!({"width":80,"height":30}), vec![]);
    let mut menu = node(
        "menu",
        "column",
        json!({"position":"absolute","top":40,"left":20,"width":80,"height":30}),
        vec![item],
    );
    menu.dismiss_on_outside = true;
    let mut hidden = node("hidden", "column", json!({"display":"none"}), vec![]);
    let mut closed = node("closed", "column", json!({"width":10,"height":10}), vec![]);
    closed.dismiss_on_outside = true;
    hidden.children = vec![closed];
    let background = node(
        "background",
        "button",
        json!({"width":200,"height":120}),
        vec![],
    );
    let mut tree = Tree::new(root(vec![background, menu, hidden]));
    tree.compute(220.0, 140.0).unwrap();
    tree.pointer_move(40.0, 50.0);
    let inside = tree.pointer_down();
    assert!(
        inside.iter().all(|event| event["type"] != "outside"),
        "{inside:?}"
    );
    tree.pointer_up();
    tree.pointer_move(180.0, 100.0);
    let down = tree.pointer_down();
    assert_eq!(down[0]["type"], "outside");
    assert_eq!(
        down[0]["id"], "menu",
        "a box under display:none is not open"
    );
    assert!(tree.pointer_up().is_empty());
}
