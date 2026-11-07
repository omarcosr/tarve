//! Manual probe of BUI's benchmark scene (github.com/ppmpreetham/BUI, bindings/rust/bench):
//! N rounded cells with a centred number in a 1000×800 window, every cell changing each frame.
//! Times each native phase of a frame headless, so a change shows its effect without a window:
//!
//!   CELLS=3000 cargo test --release --lib cells_probe -- --ignored --nocapture
use super::*;
use crate::cpu_display::CpuRecorder;
use crate::protocol::Node;
use serde_json::{Value, json};
use std::time::Instant;

const WIDTH: f32 = 1000.0;
const HEIGHT: f32 = 800.0;

fn cell_color(i: usize, t: usize) -> String {
    let h = ((i * 7 + t * 3) % 360) as f32 / 60.0;
    let (s, v) = (0.55f32, 0.75f32);
    let c = v * s;
    let x = c * (1.0 - (h % 2.0 - 1.0).abs());
    let (r, g, b) = match h as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = v - c;
    let byte = |f: f32| ((f + m) * 255.0).round() as u32;
    format!("#{:02x}{:02x}{:02x}", byte(r), byte(g), byte(b))
}

fn grid(cells: usize) -> (f32, f32, f32) {
    let gap = 2.0;
    let cols = ((cells as f32 * WIDTH / HEIGHT).sqrt().ceil() as usize).max(1);
    let rows = cells.div_ceil(cols);
    let w = (WIDTH - gap) / cols as f32 - gap;
    let h = (HEIGHT - gap) / rows as f32 - gap;
    (w.floor(), h.floor(), (h * 0.55).clamp(8.0, 14.0).floor())
}

fn cell(i: usize, t: usize, (w, h, font): (f32, f32, f32)) -> (Value, Value) {
    let view = json!({"id": format!("c{i}"), "kind": "view", "style": {"width": w, "height": h, "background": cell_color(i, t), "radius": 3, "align": "center", "justify": "center"}, "children": []});
    let label_t = if std::env::var("TEXT").is_ok_and(|v| v == "0") {
        0
    } else {
        t
    };
    let text = json!({"id": format!("t{i}"), "kind": "text", "style": {"fontSize": font, "foreground": "#ffffff"}, "text": format!("{}", (i * 13 + label_t) % 1000), "children": []});
    (view, text)
}

fn document(cells: usize, t: usize) -> Node {
    let size = grid(cells);
    let children: Vec<Value> = (0..cells)
        .map(|i| {
            let (mut view, text) = cell(i, t, size);
            view["children"] = json!([text]);
            view
        })
        .collect();
    serde_json::from_value(json!({"id": "root", "kind": "window", "style": {}, "children": [
        {"id": "grid", "kind": "view", "style": {"flex": 1, "direction": "row", "wrap": true, "alignContent": "start", "gap": 2, "padding": 2, "background": "#303030"}, "children": children}
    ]}))
    .unwrap()
}

/// What JS sends for frame `t`: every cell and its label patched, as JSON text.
fn patch_json(cells: usize, t: usize) -> String {
    let size = grid(cells);
    // MODE=one: only the first cell changes (BUI's `--mode one`).
    let changed = if std::env::var("MODE").is_ok_and(|mode| mode == "one") {
        1
    } else {
        cells
    };
    let nodes: Vec<Value> = (0..changed)
        .flat_map(|i| {
            let (view, text) = cell(i, t, size);
            [view, text]
        })
        .collect();
    // SET=1: what bound signals send (`setNodes`): the colour and the label only.
    if std::env::var("SET").is_ok_and(|value| value == "1") {
        let sets: Vec<Value> = (0..changed)
            .flat_map(|i| {
                let (view, text) = cell(i, t, size);
                [
                    json!({"id": view["id"], "style": {"background": view["style"]["background"]}}),
                    json!({"id": text["id"], "text": text["text"]}),
                ]
            })
            .collect();
        return format!(
            r#"{{"type":"setNodes","nodes":{}}}"#,
            serde_json::to_string(&sets).unwrap()
        );
    }
    // JS writes the type first (a `Value` map would sort it after "nodes").
    format!(
        r#"{{"type":"patch","nodes":{}}}"#,
        serde_json::to_string(&nodes).unwrap()
    )
}

#[cfg(windows)]
use crate::profiler as sampler;

/// A frame recorded after `previous` (reusing its unchanged subtrees) and the same frame
/// recorded from scratch paint the same ops in the same order.
fn assert_retained_matches_fresh(
    tree: &mut crate::tree::Tree,
    previous: &DisplayList,
) -> DisplayList {
    let mut images = HashMap::new();
    let retained = {
        let mut recorder = CpuRecorder::after(&mut images, Some(previous));
        tree.paint(1.0, &mut recorder);
        recorder.finish()
    };
    let fresh = {
        let mut recorder = CpuRecorder::new(&mut images);
        tree.paint(1.0, &mut recorder);
        recorder.finish()
    };
    assert_eq!(retained.len(), fresh.len());
    assert_eq!(
        damage(&retained, &fresh),
        None,
        "retained paint differs from a fresh one"
    );
    retained
}

fn record(tree: &mut crate::tree::Tree) -> DisplayList {
    let mut images = HashMap::new();
    let mut recorder = CpuRecorder::new(&mut images);
    tree.paint(1.0, &mut recorder);
    recorder.finish()
}

#[test]
fn simple_paint_records_what_the_full_paint_records() {
    let doc: Node = serde_json::from_value(json!({"id": "root", "kind": "window", "style": {}, "children": [
        {"id": "grid", "kind": "view", "style": {"flex": 1, "direction": "row", "wrap": true, "gap": 2, "padding": 4, "background": "#303030"}, "children": [
            {"id": "a", "kind": "view", "style": {"width": 60, "height": 30, "background": "#ff8800", "radius": 6, "align": "center", "justify": "center"}, "children": [
                {"id": "a-label", "kind": "text", "style": {"fontSize": 12, "foreground": "#ffffff"}, "text": "42", "children": []}
            ]},
            {"id": "b", "kind": "column", "style": {"width": 80, "height": 40, "padding": {"top": 3, "left": 5, "right": 0, "bottom": 0}}, "children": [
                {"id": "b-label", "kind": "text", "style": {"fontSize": 14, "background": "#00000040"}, "text": "plain", "children": []},
                {"id": "b-long", "kind": "text", "style": {"fontSize": 14, "width": 20}, "text": "too long to fit here", "children": []}
            ]},
            {"id": "c", "kind": "row", "style": {"width": 50, "height": 20, "background": "transparent", "radius": 3}, "children": []}
        ]}
    ]})).unwrap();
    let mut tree = crate::tree::Tree::new(doc);
    tree.compute(400.0, 300.0).unwrap();
    let paint = |tree: &mut crate::tree::Tree, simple: bool| {
        tree.simple_paint_enabled = simple;
        record(tree)
    };
    let full = paint(&mut tree, false);
    let simple = paint(&mut tree, true);
    assert_eq!(full.len(), simple.len());
    assert_eq!(
        damage(&full, &simple),
        None,
        "the simple paint differs from the full one"
    );
    let mut cells = crate::tree::Tree::new(document(300, 7));
    cells.compute(WIDTH, HEIGHT).unwrap();
    let full = paint(&mut cells, false);
    let simple = paint(&mut cells, true);
    assert_eq!(full.len(), simple.len());
    assert_eq!(damage(&full, &simple), None);
}

#[test]
fn retained_paint_reuses_unchanged_subtrees_and_matches_a_fresh_paint() {
    let cells = 60;
    let mut tree = crate::tree::Tree::new(document(cells, 0));
    tree.compute(WIDTH, HEIGHT).unwrap();
    let first = record(&mut tree);
    // One cell's label and another's background change: the rest is reused.
    let size = grid(cells);
    let (_, label) = cell(3, 9, size);
    let (background, _) = cell(7, 9, size);
    let nodes: Vec<Node> = [label, background]
        .into_iter()
        .map(|value| serde_json::from_value(value).unwrap())
        .collect();
    tree.patch(nodes).unwrap();
    tree.compute(WIDTH, HEIGHT).unwrap();
    let second = assert_retained_matches_fresh(&mut tree, &first);
    // An ancestor's change reaches every subtree under it (inherited text colour).
    let grid_node: Node = serde_json::from_value(json!({"id": "grid", "kind": "view", "style": {"flex": 1, "direction": "row", "wrap": true, "alignContent": "start", "gap": 2, "padding": 2, "background": "#101010", "foreground": "#ff0000"}, "children": []})).unwrap();
    tree.patch(vec![grid_node]).unwrap();
    tree.compute(WIDTH, HEIGHT).unwrap();
    let third = assert_retained_matches_fresh(&mut tree, &second);
    // Nothing changed but the pointer: the whole frame paints again.
    tree.dirty.paint = true;
    tree.dirty.full_paint = true;
    assert_retained_matches_fresh(&mut tree, &third);
}

/// Live heap bytes of the native tree for the cells scene, stage by stage:
///   CELLS=3000 cargo test --release --lib --no-default-features --features fxhash memory_probe -- --ignored --nocapture
#[cfg(not(feature = "mimalloc"))]
#[test]
#[ignore = "manual memory probe"]
fn memory_probe() {
    use crate::counting_alloc::LIVE;
    use std::sync::atomic::Ordering;
    let cells: usize = std::env::var("CELLS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3000);
    let mb = |bytes: isize| bytes as f64 / 1048576.0;
    println!(
        "SIZES node={} entry={} taffy_style={} taffy_layout={} taffy_cache={}",
        std::mem::size_of::<Node>(),
        std::mem::size_of::<crate::tree::Entry>(),
        std::mem::size_of::<taffy::Style<String>>(),
        std::mem::size_of::<taffy::Layout>(),
        std::mem::size_of::<taffy::Cache>()
    );
    let base = LIVE.load(Ordering::Relaxed);
    let document = document(cells, 0);
    let parsed = LIVE.load(Ordering::Relaxed);
    let mut tree = crate::tree::Tree::new(document);
    let built = LIVE.load(Ordering::Relaxed);
    tree.compute(WIDTH, HEIGHT).unwrap();
    let laid = LIVE.load(Ordering::Relaxed);
    let mut images = HashMap::new();
    let list = {
        let mut recorder = CpuRecorder::new(&mut images);
        tree.paint(1.0, &mut recorder);
        recorder.finish()
    };
    let painted = LIVE.load(Ordering::Relaxed);
    println!(
        "MEMORY cells={cells} document={:.2} tree={:.2} layout+text={:.2} displaylist={:.2} total={:.2} MB ({} ops)",
        mb(parsed - base),
        mb(built - parsed),
        mb(laid - built),
        mb(painted - laid),
        mb(painted - base),
        list.len()
    );
    drop(list);
    for (name, bytes) in tree.text_memory_report() {
        println!("MEMORY text {name}: {:.2} MB", mb(bytes));
    }
    let before_drop = LIVE.load(Ordering::Relaxed);
    drop(tree);
    println!(
        "MEMORY rest of tree (entries, taffy): {:.2} MB",
        mb(before_drop - LIVE.load(Ordering::Relaxed))
    );
}

#[test]
#[ignore = "manual performance probe"]
fn font_startup_probe() {
    let start = Instant::now();
    let mut tree = crate::tree::Tree::new(document(100, 0));
    let built = start.elapsed();
    tree.compute(WIDTH, HEIGHT).unwrap();
    let laid = start.elapsed();
    let mut again = crate::tree::Tree::new(document(100, 1));
    again.compute(WIDTH, HEIGHT).unwrap();
    println!(
        "FONTS tree={:.2} first layout={:.2} second tree+layout={:.2} ms",
        built.as_secs_f64() * 1e3,
        (laid - built).as_secs_f64() * 1e3,
        (start.elapsed() - laid).as_secs_f64() * 1e3
    );
}

#[test]
#[ignore = "manual performance probe"]
fn cells_probe() {
    #[cfg(windows)]
    let sampler = std::env::var_os("PROFILE").map(|_| sampler::Sampler::start());
    let phase = std::env::var("PROFILE").unwrap_or_default();
    let profiling = |name: &str, on: bool| {
        #[cfg(windows)]
        if phase == name {
            sampler::ACTIVE.store(on, std::sync::atomic::Ordering::Relaxed);
        }
    };
    #[cfg(windows)]
    if !phase.is_empty() && phase != "1" {
        sampler::ACTIVE.store(false, std::sync::atomic::Ordering::Relaxed);
    }
    let cells: usize = std::env::var("CELLS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3000);
    let threads: Option<u16> = std::env::var("THREADS").ok().and_then(|v| v.parse().ok());
    let mut tree = crate::tree::Tree::new(document(cells, 0));
    tree.compute(WIDTH, HEIGHT).unwrap();
    let mut settings = cpu_render_settings(WIDTH as usize * HEIGHT as usize);
    if let Some(threads) = threads {
        settings.num_threads = threads;
    }
    let (w, h) = (WIDTH as u16, HEIGHT as u16);
    let mut context = CpuRenderContext::new_with(w, h, settings);
    let mut resources = CpuResources::new();
    let mut images = HashMap::new();
    let mut frame = vec![0_u32; usize::from(w) * usize::from(h)];
    let mut scratch = Vec::new();
    // BLIT=0: every glyph through vello_cpu, without the cached masks.
    let mut masks = std::env::var("BLIT")
        .map_or(true, |value| value != "0")
        .then(crate::cpu_display::GlyphMasks::new);
    let (mut parse, mut apply, mut layout, mut paint, mut raster, mut bytes) =
        (vec![], vec![], vec![], vec![], vec![], 0);
    let mut previous: Option<DisplayList> = None;
    for t in 1..=40 {
        let text = patch_json(cells, t);
        bytes = text.len();
        let start = Instant::now();
        profiling("parse", true);
        let command = crate::protocol::Command::from_json(text.as_bytes()).unwrap();
        profiling("parse", false);
        parse.push(start.elapsed().as_secs_f64() * 1e3);
        let start = Instant::now();
        profiling("apply", true);
        match command {
            crate::protocol::Command::Patch { nodes } => tree.patch(nodes).unwrap(),
            crate::protocol::Command::SetNodes { nodes } => tree.set_nodes(nodes).unwrap(),
            _ => panic!("not a patch"),
        }
        profiling("apply", false);
        apply.push(start.elapsed().as_secs_f64() * 1e3);
        let start = Instant::now();
        profiling("layout", true);
        tree.compute(WIDTH, HEIGHT).unwrap();
        profiling("layout", false);
        layout.push(start.elapsed().as_secs_f64() * 1e3);
        let start = Instant::now();
        let list = {
            let mut recorder = CpuRecorder::after(&mut images, previous.as_ref());
            profiling("paint", true);
            tree.paint(1.0, &mut recorder);
            profiling("paint", false);
            recorder.finish()
        };
        let recorded = start.elapsed().as_secs_f64() * 1e3;
        if let Some(previous) = &previous {
            let _ = damage(previous, &list);
        }
        if std::env::var_os("PROBE_TEXT").is_some() {
            eprintln!(
                "PROBE paint record={recorded:.2} damage={:.2}",
                start.elapsed().as_secs_f64() * 1e3 - recorded
            );
        }
        paint.push(start.elapsed().as_secs_f64() * 1e3);
        let start = Instant::now();
        profiling("raster", true);
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
            None,
            vello::kurbo::Rect::new(0.0, 0.0, f64::from(w), f64::from(h)),
            vello::peniko::Color::from_rgb8(48, 48, 48),
            None,
            masks.as_mut(),
        );
        profiling("raster", false);
        raster.push(start.elapsed().as_secs_f64() * 1e3);
        previous = Some(list);
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
    // SAVE=<file.png>: the last frame, to look at.
    if let Ok(path) = std::env::var("SAVE") {
        let bytes: Vec<u8> = frame
            .iter()
            .flat_map(|pixel| {
                let [b, g, r, _] = pixel.to_le_bytes();
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
    let median = |mut v: Vec<f64>| {
        v.drain(..5);
        v.sort_by(f64::total_cmp);
        v[v.len() / 2]
    };
    let (parse, apply, layout, paint, raster) = (
        median(parse),
        median(apply),
        median(layout),
        median(paint),
        median(raster),
    );
    println!(
        "CELLS {cells} threads={} patch={}KB parse={parse:.2} apply={apply:.2} layout={layout:.2} paint={paint:.2} raster={raster:.2} total={:.2} ms",
        settings.num_threads,
        bytes / 1024,
        parse + apply + layout + paint + raster
    );
}
