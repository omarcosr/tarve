//! Slider styling: gradient fill and track, a track that fills the box (iOS brightness
//! capsule), thumb size/shape/border/shadow, hidden thumb, states and vertical sliders.
use super::*;
use crate::controls::{SliderGeometry, SliderMetrics};
use crate::paint::CpuPaintTarget;
use vello::kurbo::{Point, Rect};
use vello_cpu::{Pixmap, RenderContext, Resources};

const W: u16 = 240;
const H: u16 = 200;

fn slider(id: &str, value: f64, orientation: &str, style: serde_json::Value) -> Node {
    let mut slider = node(id, "slider", style, vec![]);
    slider.control = Some(
        serde_json::from_value(json!({
            "role": "slider", "orientation": orientation, "value": value, "min": 0, "max": 100, "step": 1
        }))
        .unwrap(),
    );
    slider
}

fn black_root(children: Vec<Node>) -> Node {
    node("root", "window", json!({"background": "#000000"}), children)
}

fn cpu_frame(tree: &mut Tree) -> Pixmap {
    let mut context = RenderContext::new(W, H);
    let mut resources = Resources::new();
    let mut images = Default::default();
    {
        let mut target = CpuPaintTarget::new(&mut context, &mut resources, &mut images);
        tree.paint(1.0, &mut target);
        target.finish();
    }
    context.flush();
    let mut pixmap = Pixmap::new(W, H);
    context.render(&mut pixmap, &mut resources);
    pixmap
}

fn rgb(pixmap: &Pixmap, x: u16, y: u16) -> [u8; 3] {
    let [r, g, b, _] =
        pixmap.data()[usize::from(y) * usize::from(W) + usize::from(x)].to_u8_array();
    [r, g, b]
}

fn near(actual: [u8; 3], expected: [u8; 3], tolerance: u8) -> bool {
    actual
        .iter()
        .zip(expected)
        .all(|(a, e)| a.abs_diff(e) <= tolerance)
}

#[test]
fn default_geometry_keeps_the_classic_track_and_thumb() {
    let rect = Rect::new(0.0, 0.0, 160.0, 24.0);
    let geometry = SliderGeometry::new(rect, false, 0.5, &SliderMetrics::default());
    assert_eq!(geometry.track, Rect::new(8.0, 10.0, 152.0, 14.0));
    assert_eq!(geometry.center, Point::new(80.0, 12.0));
    assert_eq!(geometry.fill, Rect::new(8.0, 10.0, 80.0, 14.0));
    assert_eq!(geometry.ratio_at(Point::new(8.0, 0.0)), 0.0);
    assert_eq!(geometry.ratio_at(Point::new(152.0, 0.0)), 1.0);
    // A thumb longer than the inset stays inside the box: its centre stops half a thumb in.
    let big = SliderMetrics {
        thumb: (28.0, 28.0),
        ..SliderMetrics::default()
    };
    let at_max = SliderGeometry::new(rect, false, 1.0, &big);
    assert_eq!(at_max.thumb.x1, 160.0);
    assert_eq!(at_max.ratio_at(Point::new(146.0, 0.0)), 1.0);
}

#[test]
fn a_fill_track_without_a_thumb_fills_the_whole_capsule() {
    let metrics = SliderMetrics {
        thickness: None,
        inset: 0.0,
        thumb: (0.0, 0.0),
    };
    let rect = Rect::new(0.0, 0.0, 200.0, 34.0);
    let geometry = SliderGeometry::new(rect, false, 0.25, &metrics);
    assert_eq!(geometry.track, rect);
    assert_eq!(geometry.fill, Rect::new(0.0, 0.0, 50.0, 34.0));
    let vertical = SliderGeometry::new(Rect::new(0.0, 0.0, 40.0, 100.0), true, 0.25, &metrics);
    assert_eq!(vertical.fill, Rect::new(0.0, 75.0, 40.0, 100.0));
    assert_eq!(vertical.ratio_at(Point::new(0.0, 25.0)), 0.75);
}

#[test]
fn gradient_fill_paints_a_brightness_capsule_on_the_cpu() {
    let capsule = slider(
        "brightness",
        50.0,
        "horizontal",
        json!({
            "position": "absolute", "left": 20, "top": 20, "width": 200, "height": 34, "radius": 17,
            "trackThickness": "fill", "thumbSize": 0,
            "trackBackground": "#00ff00",
            "foreground": {"type": "linear", "to": "right", "stops": [{"color": "#ff0000"}, {"color": "#0000ff"}]}
        }),
    );
    let mut tree = Tree::new(black_root(vec![capsule]));
    tree.compute(f32::from(W), f32::from(H)).unwrap();
    let frame = cpu_frame(&mut tree);
    // The gradient spans the whole track: a quarter in it is 3/4 red, 1/4 blue.
    assert!(
        near(rgb(&frame, 70, 37), [191, 0, 64], 12),
        "{:?}",
        rgb(&frame, 70, 37)
    );
    // The fill takes the capsule's whole height, not a thin line.
    assert!(rgb(&frame, 100, 22)[0] > 100, "{:?}", rgb(&frame, 100, 22));
    assert!(rgb(&frame, 100, 52)[0] > 100, "{:?}", rgb(&frame, 100, 52));
    // Past the value: the track.
    assert!(
        near(rgb(&frame, 170, 37), [0, 255, 0], 2),
        "{:?}",
        rgb(&frame, 170, 37)
    );
    // The capsule's rounded ends cut both the fill and the track.
    assert!(
        near(rgb(&frame, 21, 21), [0, 0, 0], 2),
        "{:?}",
        rgb(&frame, 21, 21)
    );
    assert!(
        near(rgb(&frame, 218, 52), [0, 0, 0], 2),
        "{:?}",
        rgb(&frame, 218, 52)
    );
    // Every pointer position maps onto the capsule's full width.
    tree.pointer_move(170.0, 37.0);
    tree.pointer_down();
    tree.pointer_up();
    assert_eq!(
        tree.entries["brightness"]
            .node
            .control
            .as_ref()
            .unwrap()
            .value,
        75.0
    );
}

#[test]
fn thumb_takes_size_radius_gradient_border_and_shadow() {
    let thumbed = slider(
        "thumbed",
        50.0,
        "horizontal",
        json!({
            "position": "absolute", "left": 20, "top": 60, "width": 200, "height": 40,
            "trackThickness": 6, "borderColor": "#333333", "foreground": "#ffffff",
            "thumbWidth": 36, "thumbHeight": 24, "thumbRadius": 4,
            "thumbColor": {"type": "linear", "to": "bottom", "stops": [{"color": "#ff0000"}, {"color": "#ff0000", "offset": 0.5}, {"color": "#0000ff", "offset": 0.5}, {"color": "#0000ff"}]},
            "thumbBorderWidth": 2, "thumbBorderColor": "#ffff00",
            "thumbShadow": {"y": 10, "blur": 0, "color": "#00ff00"}
        }),
    );
    let mut tree = Tree::new(black_root(vec![thumbed]));
    tree.compute(f32::from(W), f32::from(H)).unwrap();
    let frame = cpu_frame(&mut tree);
    // Thumb centred at (120, 80): 36×24, red top half, blue bottom half.
    assert!(
        near(rgb(&frame, 120, 74), [255, 0, 0], 2),
        "{:?}",
        rgb(&frame, 120, 74)
    );
    assert!(
        near(rgb(&frame, 120, 86), [0, 0, 255], 2),
        "{:?}",
        rgb(&frame, 120, 86)
    );
    // A pill wider than tall: past a round 24px thumb, still the thumb.
    assert!(
        near(rgb(&frame, 135, 80), [255, 0, 0], 40) || near(rgb(&frame, 135, 80), [0, 0, 255], 40),
        "{:?}",
        rgb(&frame, 135, 80)
    );
    // Its ring sits on the edge, its hard shadow 10px below.
    assert!(
        near(rgb(&frame, 102, 80), [255, 255, 0], 60),
        "{:?}",
        rgb(&frame, 102, 80)
    );
    assert!(
        near(rgb(&frame, 120, 97), [0, 255, 0], 2),
        "{:?}",
        rgb(&frame, 120, 97)
    );
}

#[test]
fn slider_states_restyle_the_thumb_and_fill() {
    let styled = slider(
        "styled",
        50.0,
        "horizontal",
        json!({
            "position": "absolute", "left": 20, "top": 20, "width": 200, "height": 30,
            "trackThickness": "fill", "thumbSize": 0, "foreground": "#0000ff",
            "hover": {"foreground": "#ff0000"},
            "disabled": {"foreground": "#00ff00"}
        }),
    );
    let mut tree = Tree::new(black_root(vec![styled]));
    tree.compute(f32::from(W), f32::from(H)).unwrap();
    assert!(near(rgb(&cpu_frame(&mut tree), 60, 35), [0, 0, 255], 2));
    tree.pointer_move(200.0, 35.0);
    assert!(near(rgb(&cpu_frame(&mut tree), 60, 35), [255, 0, 0], 2));
}

#[test]
fn vertical_fill_grows_from_the_bottom() {
    let vertical = slider(
        "vertical",
        25.0,
        "vertical",
        json!({
            "position": "absolute", "left": 20, "top": 20, "width": 40, "height": 160, "radius": 12,
            "trackThickness": "fill", "thumbSize": 0, "foreground": "#ffffff", "trackBackground": "#ff0000"
        }),
    );
    let mut tree = Tree::new(black_root(vec![vertical]));
    tree.compute(f32::from(W), f32::from(H)).unwrap();
    let frame = cpu_frame(&mut tree);
    assert!(
        near(rgb(&frame, 40, 170), [255, 255, 255], 2),
        "{:?}",
        rgb(&frame, 40, 170)
    );
    assert!(
        near(rgb(&frame, 40, 60), [255, 0, 0], 2),
        "{:?}",
        rgb(&frame, 40, 60)
    );
    tree.pointer_move(40.0, 60.0);
    tree.pointer_down();
    tree.pointer_up();
    assert_eq!(
        tree.entries["vertical"]
            .node
            .control
            .as_ref()
            .unwrap()
            .value,
        75.0
    );
}

#[test]
fn a_fill_shorter_than_both_rounded_ends_is_cut_by_the_track_not_shrunk() {
    // 24 px of a 34 px capsule (radius 17): the fill is the track's shape cut at the value,
    // as CSS `overflow: hidden` does, not a rounded rect with its corners halved to 12.
    let horizontal = slider(
        "short",
        12.0,
        "horizontal",
        json!({
            "position": "absolute", "left": 20, "top": 20, "width": 200, "height": 34, "radius": 17,
            "trackThickness": "fill", "thumbSize": 0, "foreground": "#0000ff", "trackBackground": "#00ff00"
        }),
    );
    // 12.8 px of a 24 px wide vertical capsule (radius 12).
    let vertical = slider(
        "short-vertical",
        8.0,
        "vertical",
        json!({
            "position": "absolute", "left": 20, "top": 20, "width": 24, "height": 160, "radius": 12,
            "trackThickness": "fill", "thumbSize": 0, "foreground": "#ffffff", "trackBackground": "#ff0000"
        }),
    );
    for (node, inside, outside, colour) in [
        (horizontal, (20 + 19, 20 + 17), (20 + 7, 20 + 1), [0, 0, 255]),
        (vertical, (20 + 12, 20 + 155), (20 + 1, 20 + 155), [255, 255, 255]),
    ] {
        let mut tree = Tree::new(black_root(vec![node]));
        tree.compute(f32::from(W), f32::from(H)).unwrap();
        let frame = cpu_frame(&mut tree);
        let fill = rgb(&frame, inside.0, inside.1);
        assert!(near(fill, colour, 2), "{fill:?}");
        // Outside the track's round end, inside the shrunken corner the bug painted.
        let corner = rgb(&frame, outside.0, outside.1);
        assert!(near(corner, [0, 0, 0], 24), "{corner:?}");
    }
}

#[test]
fn a_thumb_bigger_than_its_box_paints_within_the_slider_bounds() {
    let tall = slider(
        "tall",
        50.0,
        "horizontal",
        json!({"position": "absolute", "left": 20, "top": 100, "width": 160, "height": 10, "thumbSize": 40,
               "thumbShadow": [{"y": 4, "blur": 8, "color": "#00000080"}]}),
    );
    let mut tree = Tree::new(black_root(vec![tall]));
    tree.compute(f32::from(W), f32::from(H)).unwrap();
    let bounds = tree.entries["tall"].bounds;
    assert!(
        bounds.y0 <= 85.0 && bounds.y1 >= 125.0 + 4.0 + 12.0,
        "{bounds:?}"
    );
}

#[test]
fn protocol_rejects_invalid_slider_styles() {
    for style in [
        json!({"thumbSize": -1}),
        json!({"trackThickness": "thick"}),
        json!({"trackRadius": {"middle": 3}}),
        json!({"thumbColor": 4}),
        json!({"hover": {"trackInset": -2}}),
        json!({"thumbShadow": {"x": 1}}),
    ] {
        let tree = black_root(vec![slider("s", 1.0, "horizontal", style.clone())]);
        assert!(protocol::validate(&tree).is_err(), "{style}");
    }
    let valid = black_root(vec![slider(
        "s",
        1.0,
        "horizontal",
        json!({"trackThickness": "fill", "trackRadius": {"topLeft": 4}, "thumbSize": 0,
               "thumbColor": {"type": "linear", "stops": [{"color": "#fff"}]},
               "thumbShadow": [{"y": 1, "blur": 2, "color": "#0004"}]}),
    )]);
    protocol::validate(&valid).unwrap();
}
