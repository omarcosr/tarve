//! Native cost of the cross-framework benchmark's update (bench/frameworks): 2,000 rows whose
//! labels all change. Reads the document and the patch bench/render/render.tsx dumps:
//!
//!   set DUMP=<dir> && bun bench/render/render.tsx
//!   set TARVE_LAYOUT_BENCH=<dir> && cargo test --release --lib layout_bench -- --ignored --nocapture
use super::*;
use std::time::Instant;

fn load(dir: &str, name: &str) -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(format!("{dir}/{name}")).unwrap()).unwrap()
}

#[test]
#[ignore = "benchmark: needs TARVE_LAYOUT_BENCH"]
fn layout_bench() {
    let Ok(dir) = std::env::var("TARVE_LAYOUT_BENCH") else {
        return;
    };
    let root: Node = serde_json::from_value(load(&dir, "root.json")).unwrap();
    let command = load(&dir, "command.json");
    let patch: Vec<Node> = serde_json::from_value(command["nodes"].clone()).unwrap();
    let mut tree = Tree::new(root);
    // TARVE_LAYOUT_PROFILE=1 samples the layouts (needs debug info: see crate::profiler).
    let sampler = std::env::var_os("TARVE_LAYOUT_PROFILE").map(|_| {
        crate::profiler::ACTIVE.store(false, std::sync::atomic::Ordering::Relaxed);
        crate::profiler::Sampler::start()
    });
    tree.compute(1024.0, 760.0).unwrap();
    tree.scene(1.25);
    let rounds: usize = std::env::var("TARVE_LAYOUT_ROUNDS").ok().and_then(|v| v.parse().ok()).unwrap_or(40);
    let mut times: Vec<(f64, f64, f64, f64)> = Vec::new();
    for round in 0..rounds {
        // Every round shows texts never shaped before, as the app's ticking counter does.
        let mut nodes = patch.clone();
        for node in &mut nodes {
            if node.kind == "text" {
                node.text = format!("{} {round}", node.text);
            }
        }
        let start = Instant::now();
        tree.patch(nodes).unwrap();
        let patched = start.elapsed().as_secs_f64() * 1000.0;
        let start = Instant::now();
        crate::profiler::ACTIVE.store(true, std::sync::atomic::Ordering::Relaxed);
        // As the window's frame loop: offscreen rows wait until the frame is presented.
        tree.defer_offscreen = true;
        tree.compute(1024.0, 760.0).unwrap();
        tree.defer_offscreen = false;
        crate::profiler::ACTIVE.store(false, std::sync::atomic::Ordering::Relaxed);
        let laid = start.elapsed().as_secs_f64() * 1000.0;
        let start = Instant::now();
        tree.scene(1.25);
        let painted = start.elapsed().as_secs_f64() * 1000.0;
        let start = Instant::now();
        tree.finish_deferred_layout().unwrap();
        let shaped = start.elapsed().as_secs_f64() * 1000.0;
        times.push((patched, shaped, laid, painted));
    }
    let median = |pick: fn(&(f64, f64, f64, f64)) -> f64| {
        let mut values: Vec<f64> = times[5..].iter().map(pick).collect();
        values.sort_by(f64::total_cmp);
        values[values.len() / 2]
    };
    if let Some(sampler) = sampler {
        sampler.report(40);
    }
    println!(
        "patch {:.2} ms, after the frame {:.2} ms, layout {:.2} ms, scene {:.2} ms",
        median(|t| t.0),
        median(|t| t.1),
        median(|t| t.2),
        median(|t| t.3)
    );
}

