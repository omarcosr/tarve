use super::*;

fn call(x: f32, merge: u64) -> GlassCall {
    GlassCall {
        center: [x, 100.0],
        half: [40.0, 20.0],
        radius: 20.0,
        tint: [1.0, 1.0, 1.0, 0.2],
        opacity: 1.0,
        params: [4.0, 1.5, 10.0, 0.5, 0.05],
        merge,
        blend: 32.0,
    }
}

#[test]
fn boxes_with_one_merge_key_become_one_surface_drawn_by_the_first() {
    let plan = plan(
        &[call(100.0, 7), call(300.0, 0), call(180.0, 7)],
        (800, 400),
        0.5,
    )
    .unwrap();
    assert_eq!(plan.surfaces.len(), 2);
    assert_eq!(plan.first_of, vec![Some(0), Some(1), None]);
    assert!(plan.surfaces[0].merged && !plan.surfaces[1].merged);
    assert_eq!(plan.surfaces[0].shapes.len(), 2);
    assert!(
        plan.surfaces[0]
            .bounds
            .contains(vello::kurbo::Point::new(220.0, 100.0))
    );
}

#[test]
fn slots_do_not_overlap_and_fit_the_atlas() {
    let calls: Vec<_> = (0..6).map(|i| call(60.0 + 120.0 * i as f32, 0)).collect();
    let plan = plan(&calls, (800, 400), 0.5).unwrap();
    for (i, a) in plan.surfaces.iter().enumerate() {
        assert!(a.slot[2] < plan.atlas.0 && a.slot[3] < plan.atlas.1);
        for b in &plan.surfaces[i + 1..] {
            let apart = a.slot[2] < b.slot[0]
                || b.slot[2] < a.slot[0]
                || a.slot[3] < b.slot[1]
                || b.slot[3] < a.slot[1];
            assert!(apart, "{:?} {:?}", a.slot, b.slot);
        }
        // Slots cover their reach at the plan's scale, on the backdrop's grid.
        assert_eq!(
            f64::from(a.slot[2] - a.slot[0]),
            (a.reach.width() * plan.k).round()
        );
        assert_eq!(((a.reach.x0 - plan.region.x0) * plan.k).fract(), 0.0);
    }
}

#[test]
fn glass_off_screen_is_dropped() {
    assert!(plan(&[call(-500.0, 0)], (800, 400), 0.5).is_none());
}

#[test]
fn the_shade_shows_the_tinted_backdrop_inside_and_nothing_far_outside() {
    let plan = plan(&[call(100.0, 0)], (800, 400), 1.0).unwrap();
    let surface = &plan.surfaces[0];
    let inside = shade(surface, [100.0, 100.0], 1.0, |_| [0.0, 0.0, 1.0]);
    assert_eq!(inside[3], 1.0);
    // Blue backdrop under a 20 % white tint, lightened a little by the sheen.
    assert!(
        inside[2] > 0.95 && inside[0] > 0.15 && inside[0] < 0.4,
        "{inside:?}"
    );
    assert_eq!(shade(surface, [100.0, 140.0], 1.0, |_| [0.0; 3])[3], 0.0);
}

/// The frame as one Vello scene, for tests across the crate.
impl crate::tree::Tree {
    pub fn scene(&mut self, scale: f64) -> vello::Scene {
        let mut scene = vello::Scene::new();
        self.paint(scale, &mut scene);
        scene
    }
}
