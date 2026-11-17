//! Pointer probing for focus changes and shell icon frames sized for the screen.
use super::*;

#[test]
fn pointer_target_at_finds_the_pressable_under_a_point() {
    let anchor = node(
        "anchor",
        "pressable",
        json!({"width":40,"height":20}),
        vec![],
    );
    let mut tree = Tree::new(root(vec![anchor]));
    tree.compute(200.0, 100.0).unwrap();
    let rect = tree.entries["anchor"].rect;
    assert_eq!(
        tree.pointer_target_at((rect.x0 + 5.0, rect.y0 + 5.0))
            .as_deref(),
        Some("anchor")
    );
    assert_eq!(
        tree.pointer_target_at((rect.x1 + 50.0, rect.y1 + 50.0)),
        None
    );
    assert_eq!(
        tree.hovered, None,
        "probing a point leaves the pointer state alone"
    );
}

#[cfg(target_os = "windows")]
#[test]
fn exe_icons_draw_a_frame_sized_for_the_screen() {
    let src = r"C:\Windows\System32\notepad.exe";
    let mut icon = node("icon", "image", json!({"width":24,"height":24}), vec![]);
    icon.src = src.into();
    let mut tree = Tree::new(root(vec![icon]));
    tree.compute(200.0, 100.0).unwrap();
    let mut recorder = PaintRecorder::default();
    tree.paint(1.0, &mut recorder);
    let natural = recorder.images.last().unwrap().clone();
    assert_eq!(
        natural.0, src,
        "the natural frame is drawn until the sized one loads"
    );
    assert!(natural.2 > 24);
    let request = crate::exe_icon::frame_request(src, 24);
    assert_eq!(tree.take_remote_image_requests(), vec![request.clone()]);
    tree.paint(1.0, &mut PaintRecorder::default());
    assert!(
        tree.take_remote_image_requests().is_empty(),
        "a pending frame is requested once"
    );
    let decoded = crate::tree::decode_icon_frame(src, 24).unwrap();
    tree.dirty.paint = false;
    tree.finish_remote_image(request.clone(), Ok(decoded));
    assert!(tree.dirty.paint);
    assert_eq!(
        tree.image_cache_len(),
        1,
        "frames do not enter the layout cache"
    );
    let mut recorder = PaintRecorder::default();
    tree.paint(1.0, &mut recorder);
    let (key, _, width, height, transform) = recorder.images.last().unwrap().clone();
    assert_eq!(key, request);
    assert_eq!((width, height), (24, 24));
    assert!((transform.as_coeffs()[0] * f64::from(width) - 24.0).abs() < 1e-6);
    assert_eq!(
        tree.entries["icon"].rect.width(),
        24.0,
        "layout keeps its size"
    );
    // Half the scale asks for the next smaller step; the 24 px frame stays cached.
    tree.paint(0.5, &mut PaintRecorder::default());
    assert_eq!(
        tree.take_remote_image_requests(),
        vec![crate::exe_icon::frame_request(src, 16)]
    );
    tree.paint(1.0, &mut PaintRecorder::default());
    assert!(tree.take_remote_image_requests().is_empty());
}
