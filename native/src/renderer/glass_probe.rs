//! Manual probe of a real scene with glass on the CPU renderer, frame by frame, headless:
//!   TARVE_DOC=<document.json> SCALE=1.25 cargo test --release --lib glass_probe -- --ignored --nocapture
//! (the document as `start` receives it). PROFILE=raster samples the raster phase.
use super::*;
use crate::cpu_display::CpuRecorder;
use std::time::Instant;

#[cfg(windows)]
use crate::profiler as sampler;

#[test]
#[ignore = "manual performance probe"]
fn glass_probe() {
    let Some(path) = std::env::var_os("TARVE_DOC") else {
        return;
    };
    let doc: crate::protocol::Document =
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let scale: f64 = std::env::var("SCALE")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1.25);
    let (lw, lh) = (doc.window.width as f32, doc.window.height as f32);
    let mut tree = crate::tree::Tree::new(doc.root);
    tree.compute(lw, lh).unwrap();
    let (w, h) = (
        (f64::from(lw) * scale).round() as u16,
        (f64::from(lh) * scale).round() as u16,
    );
    let mut settings = cpu_render_settings(usize::from(w) * usize::from(h));
    if let Some(threads) = std::env::var("THREADS").ok().and_then(|v| v.parse().ok()) {
        settings.num_threads = threads;
    }
    let mut context = CpuRenderContext::new_with(w, h, settings);
    let mut resources = CpuResources::new();
    let mut images = HashMap::new();
    let mut frame = vec![0_u32; usize::from(w) * usize::from(h)];
    let mut scratch = Vec::new();
    let mut shadows = ShadowCache::new();
    let mut masks = crate::cpu_display::GlyphMasks::new();
    #[cfg(windows)]
    let sampler = std::env::var_os("PROFILE").map(|_| sampler::Sampler::start());
    let (mut paint, mut raster) = (vec![], vec![]);
    for _ in 0..12 {
        tree.dirty.paint = true;
        tree.dirty.full_paint = true;
        let start = Instant::now();
        let list = {
            let mut recorder = CpuRecorder::new(&mut images);
            tree.paint(scale, &mut recorder);
            recorder.finish()
        };
        paint.push(start.elapsed().as_secs_f64() * 1e3);
        // MISS=1: every frame draws and shades its backdrop (nothing changed is reused).
        if std::env::var_os("MISS").is_some() {
            crate::glass::cpu::forget_backdrop();
        }
        let start = Instant::now();
        rasterize_cpu_region(
            &mut context,
            &mut resources,
            &list,
            CpuFrame {
                pixels: &mut frame,
                width: usize::from(w),
                height: usize::from(h),
                alpha: false,
            },
            &mut scratch,
            Some(&mut shadows),
            vello::kurbo::Rect::new(0.0, 0.0, f64::from(w), f64::from(h)),
            vello::peniko::Color::from_rgb8(30, 30, 40),
            Some(scale),
            Some(&mut masks),
        );
        shadows.next_frame();
        raster.push(start.elapsed().as_secs_f64() * 1e3);
    }
    #[cfg(windows)]
    if let Some(sampler) = sampler {
        sampler.report(
            std::env::var("TOP")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(40),
        );
    }
    if let Ok(path) = std::env::var("SAVE") {
        let bytes: Vec<u8> = frame
            .iter()
            .flat_map(|p| {
                let [b, g, r, _] = p.to_le_bytes();
                [r, g, b, 255]
            })
            .collect();
        image::save_buffer(
            &path,
            &bytes,
            u32::from(w),
            u32::from(h),
            image::ColorType::Rgba8,
        )
        .unwrap();
    }
    println!("SHADOWS {:?}", shadows.cached_bytes());
    println!(
        "RASTER {:?}",
        raster.iter().map(|v| v.round()).collect::<Vec<_>>()
    );
    let median = |mut v: Vec<f64>| {
        v.drain(..2);
        v.sort_by(f64::total_cmp);
        v[v.len() / 2]
    };
    println!(
        "GLASS {w}x{h} threads={} paint={:.2} raster={:.2} ms",
        settings.num_threads,
        median(paint),
        median(raster)
    );
}

/// One frame of `root` at 1.5×, on the CPU with glass, after the frames before it (the
/// backdrop cache keeps what they drew), or from nothing when `fresh`.
fn glass_frame(tree: &mut crate::tree::Tree, root: crate::protocol::Node, fresh: bool) -> Vec<u32> {
    let (lw, lh, scale) = (300.0_f32, 200.0_f32, 1.5);
    tree.update(root);
    tree.compute(lw, lh).unwrap();
    let (w, h) = (
        (f64::from(lw) * scale) as u16,
        (f64::from(lh) * scale) as u16,
    );
    let mut images = HashMap::new();
    let list = {
        let mut recorder = CpuRecorder::new(&mut images);
        tree.paint(scale, &mut recorder);
        recorder.finish()
    };
    if fresh {
        crate::glass::cpu::forget_backdrop();
    }
    let mut context =
        CpuRenderContext::new_with(w, h, cpu_render_settings(usize::from(w) * usize::from(h)));
    let mut frame = vec![0_u32; usize::from(w) * usize::from(h)];
    rasterize_cpu_region(
        &mut context,
        &mut CpuResources::new(),
        &list,
        CpuFrame {
            pixels: &mut frame,
            width: usize::from(w),
            height: usize::from(h),
            alpha: false,
        },
        &mut Vec::new(),
        None,
        vello::kurbo::Rect::new(0.0, 0.0, f64::from(w), f64::from(h)),
        vello::peniko::Color::from_rgb8(30, 30, 40),
        Some(scale),
        None,
    );
    frame
}

#[test]
fn a_reused_glass_backdrop_paints_what_a_fresh_frame_paints() {
    let doc = |under: &str, tint: &str, label: &str, blur: f64| -> crate::protocol::Node {
        serde_json::from_value(serde_json::json!({"id":"root","kind":"window","style":{"background":"#ffffff"},"children":[
            {"id":"under","kind":"view","style":{"position":"absolute","left":0,"top":0,"width":180,"height":120,"background":under,"radius":30},"children":[]},
            {"id":"stripe","kind":"view","style":{"position":"absolute","left":40,"top":90,"width":240,"height":30,"background":"linear-gradient(90deg, #ff0000, #0000ff)"},"children":[]},
            {"id":"card","kind":"view","style":{"position":"absolute","left":60,"top":40,"width":200,"height":120,"radius":24,"background":tint,
                "glass":{"blur":blur,"saturate":1.5,"refraction":14,"highlight":0.8,"magnify":0.05}},"children":[
                {"id":"label","kind":"text","text":label,"style":{"fontSize":16,"foreground":"#000000","margin":{"top":40,"left":20}},"children":[]}
            ]}
        ]}))
        .unwrap()
    };
    let frames = [
        ("first", doc("#2050ff", "#ffffff40", "One", 10.0)),
        (
            "same frame again: reused",
            doc("#2050ff", "#ffffff40", "One", 10.0),
        ),
        (
            "only what is over the glass changed: reused",
            doc("#2050ff", "#ffffff40", "Two, longer", 10.0),
        ),
        (
            "the backdrop changed",
            doc("#20c050", "#ffffff40", "Two, longer", 10.0),
        ),
        (
            "the glass tint changed",
            doc("#20c050", "#ff000040", "Two, longer", 10.0),
        ),
        (
            "the glass blur changed",
            doc("#20c050", "#ff000040", "Two, longer", 4.0),
        ),
        (
            "back to the first",
            doc("#2050ff", "#ffffff40", "One", 10.0),
        ),
    ];
    let mut cached = crate::tree::Tree::new(frames[0].1.clone());
    let mut previous: Option<Vec<u32>> = None;
    for (label, root) in frames {
        let hits = crate::glass::cpu::reused_backdrops();
        let reused = glass_frame(&mut cached, root.clone(), false);
        let hit = crate::glass::cpu::reused_backdrops() > hits;
        assert_eq!(
            hit,
            label.ends_with("reused"),
            "{label}: backdrop reused = {hit}"
        );
        let mut fresh_tree = crate::tree::Tree::new(root.clone());
        let fresh = glass_frame(&mut fresh_tree, root, true);
        let differing = reused.iter().zip(&fresh).filter(|(a, b)| a != b).count();
        assert_eq!(
            differing, 0,
            "{label}: {differing} pixels differ from a fresh frame"
        );
        if let Some(previous) = &previous
            && !label.starts_with("same")
        {
            assert_ne!(previous, &reused, "{label}: the frame changed");
        }
        previous = Some(reused);
    }
}

#[test]
fn a_region_over_cached_glass_paints_what_a_full_frame_paints() {
    let doc = |label: &str, fill: f64, under: &str| -> crate::protocol::Node {
        serde_json::from_value(serde_json::json!({"id":"root","kind":"window","style":{"background":"#ffffff"},"children":[
            {"id":"under","kind":"view","style":{"position":"absolute","left":0,"top":0,"width":180,"height":120,"background":under,"radius":30},"children":[]},
            {"id":"card","kind":"view","style":{"position":"absolute","left":40,"top":30,"width":220,"height":140,"radius":24,"background":"#ffffff40",
                "boxShadow":[{"y":6,"blur":14,"color":"#00000033"}],
                "glass":{"blur":10,"saturate":1.5,"refraction":14,"highlight":0.8,"magnify":0.05}},"children":[
                {"id":"label","kind":"text","text":label,"style":{"fontSize":16,"foreground":"#000000","margin":{"top":20,"left":20}},"children":[]},
                {"id":"bar","kind":"view","style":{"margin":{"top":20,"left":20},"width":fill,"height":20,"radius":10,"background":"linear-gradient(90deg, #ffd27a, #ffb02e)"},"children":[]}
            ]}
        ]}))
        .unwrap()
    };
    let (lw, lh, scale) = (640.0_f32, 420.0_f32, 1.5);
    let (w, h) = (
        (f64::from(lw) * scale) as u16,
        (f64::from(lh) * scale) as u16,
    );
    let full = vello::kurbo::Rect::new(0.0, 0.0, f64::from(w), f64::from(h));
    let background = vello::peniko::Color::from_rgb8(30, 30, 40);
    let mut context =
        CpuRenderContext::new_with(w, h, cpu_render_settings(usize::from(w) * usize::from(h)));
    let mut resources = CpuResources::new();
    let mut images = HashMap::new();
    let record = |tree: &mut crate::tree::Tree, images: &mut HashMap<_, _>| {
        let mut recorder = CpuRecorder::new(images);
        tree.paint(scale, &mut recorder);
        recorder.finish()
    };
    let draw = |list: &DisplayList,
                pixels: &mut Vec<u32>,
                region: vello::kurbo::Rect,
                resources: &mut CpuResources,
                context: &mut CpuRenderContext| {
        rasterize_cpu_region(
            context,
            resources,
            list,
            CpuFrame {
                pixels,
                width: usize::from(w),
                height: usize::from(h),
                alpha: false,
            },
            &mut Vec::new(),
            None,
            region,
            background,
            Some(scale),
            None,
        );
    };
    crate::glass::cpu::forget_backdrop();
    let mut tree = crate::tree::Tree::new(doc("70%", 100.0, "#2050ff"));
    tree.compute(lw, lh).unwrap();
    let mut previous = record(&mut tree, &mut images);
    let mut frame = vec![0_u32; usize::from(w) * usize::from(h)];
    draw(&previous, &mut frame, full, &mut resources, &mut context);
    let steps = [
        ("80%", 140.0, "#2050ff", true),
        ("90%", 170.0, "#2050ff", true),
        ("90%", 170.0, "#20c050", false),
    ];
    for (label, fill, under, over_only) in steps {
        tree.update(doc(label, fill, under));
        tree.compute(lw, lh).unwrap();
        let list = record(&mut tree, &mut images);
        let reusable = crate::glass::cpu::backdrop_reusable(
            &list,
            (u32::from(w), u32::from(h)),
            background,
            false,
            scale,
        );
        assert_eq!(reusable, over_only, "{label} {under}: backdrop reusable");
        let damage = crate::cpu_display::damage(&previous, &list).expect("something changed");
        let region = cpu_redraw_region(damage, u32::from(w), u32::from(h));
        if reusable {
            assert_ne!(region, full, "{label}: a region, not the frame");
            draw(&list, &mut frame, region, &mut resources, &mut context);
        } else {
            draw(&list, &mut frame, full, &mut resources, &mut context);
        }
        let mut expected = vec![0_u32; frame.len()];
        crate::glass::cpu::forget_backdrop();
        draw(&list, &mut expected, full, &mut resources, &mut context);
        let worst = frame
            .iter()
            .zip(&expected)
            .map(|(a, b)| {
                [0, 8, 16]
                    .iter()
                    .map(|s| (((a >> s) & 255) as i32 - ((b >> s) & 255) as i32).abs())
                    .max()
                    .unwrap()
            })
            .max()
            .unwrap();
        assert!(
            worst <= 3,
            "{label} {under}: the region differs from a full frame by {worst}"
        );
        previous = list;
    }
}
