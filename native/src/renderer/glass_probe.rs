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
