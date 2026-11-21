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
        // As the app sends a list's new labels: text sets, applied in place (Tree::set_nodes).
        let sets: Vec<crate::protocol::NodeSet> = nodes
            .iter()
            .filter(|node| node.kind == "text")
            .map(|node| serde_json::from_value(json!({"id": node.id, "text": node.text})).unwrap())
            .collect();
        let rest: Vec<Node> = nodes.into_iter().filter(|node| node.kind != "text").collect();
        let profile_apply = std::env::var("TARVE_LAYOUT_PROFILE").is_ok_and(|v| v == "apply");
        let start = Instant::now();
        crate::profiler::ACTIVE.store(profile_apply, std::sync::atomic::Ordering::Relaxed);
        tree.set_nodes(sets).unwrap();
        if !rest.is_empty() {
            tree.patch(rest).unwrap();
        }
        crate::profiler::ACTIVE.store(false, std::sync::atomic::Ordering::Relaxed);
        let patched = start.elapsed().as_secs_f64() * 1000.0;
        let start = Instant::now();
        crate::profiler::ACTIVE.store(!profile_apply, std::sync::atomic::Ordering::Relaxed);
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
        tree.release_retired_text();
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


/// Live native heap of the benchmark's list, stage by stage (no mimalloc: the counting allocator):
///   set TARVE_LAYOUT_BENCH=<dir> && cargo test --release --lib --no-default-features --features fxhash layout_memory -- --ignored --nocapture
#[cfg(not(feature = "mimalloc"))]
#[test]
#[ignore = "memory probe: needs TARVE_LAYOUT_BENCH"]
fn layout_memory() {
    use crate::counting_alloc::LIVE;
    use std::sync::atomic::Ordering;
    let Ok(dir) = std::env::var("TARVE_LAYOUT_BENCH") else {
        return;
    };
    println!(
        "SIZES node={} entry={} taffy_style={} taffy_layout={} taffy_cache={}",
        std::mem::size_of::<Node>(),
        std::mem::size_of::<crate::tree::Entry>(),
        std::mem::size_of::<taffy::Style<String>>(),
        std::mem::size_of::<taffy::Layout>(),
        std::mem::size_of::<taffy::Cache>()
    );
    let mb = |bytes: isize| bytes as f64 / 1048576.0;
    let live = || LIVE.load(Ordering::Relaxed);
    let bytes = std::fs::read(format!("{dir}/root.json")).unwrap();
    let base = live();
    let root: Node = serde_json::from_slice(&bytes).unwrap();
    let parsed = live();
    let mut tree = Tree::new(root);
    let built = live();
    tree.compute(1024.0, 760.0).unwrap();
    let laid = live();
    let mut images = std::collections::HashMap::new();
    let list = {
        let mut recorder = crate::cpu_display::CpuRecorder::new(&mut images);
        tree.paint(1.25, &mut recorder);
        recorder.finish()
    };
    let painted = live();
    println!(
        "MEMORY document={:.2} tree={:.2} layout+text={:.2} displaylist={:.2} MB ({} ops)",
        mb(parsed - base),
        mb(built - parsed),
        mb(laid - built),
        mb(painted - laid),
        list.len()
    );
    drop(list);
    // As after the first frame: texts far offscreen give their layouts back.
    tree.evict_offscreen_texts();
    println!("MEMORY after evicting offscreen texts: {:.2} MB", mb(live() - base));
    for (name, bytes) in tree.text_memory_report() {
        println!("MEMORY text {name}: {:.2} MB", mb(bytes));
    }
    let before = live();
    drop(tree);
    println!("MEMORY rest (entries, taffy): {:.2} MB", mb(before - live()));
}
