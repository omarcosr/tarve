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

/// PROFILE=1: a sampling profiler without ETW (no admin): a thread suspends the probe's
/// thread every millisecond, walks its stack with DbgHelp and symbolizes once the probe is
/// done. Needs debug info: CARGO_PROFILE_RELEASE_DEBUG=line-tables-only CARGO_PROFILE_RELEASE_STRIP=false.
#[cfg(windows)]
mod sampler {
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[repr(C, align(16))]
    struct Context([u8; 1232]);

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentThreadId() -> u32;
        fn GetCurrentProcess() -> isize;
        fn OpenThread(access: u32, inherit: i32, id: u32) -> isize;
        fn SuspendThread(thread: isize) -> u32;
        fn ResumeThread(thread: isize) -> u32;
        fn GetThreadContext(thread: isize, context: *mut Context) -> i32;
    }
    #[link(name = "dbghelp")]
    unsafe extern "system" {
        fn SymSetOptions(options: u32) -> u32;
        fn SymInitializeW(process: isize, path: *const u16, invade: i32) -> i32;
        fn SymFunctionTableAccess64(process: isize, base: u64) -> *mut u8;
        fn SymGetModuleBase64(process: isize, address: u64) -> u64;
        fn StackWalk64(
            machine: u32,
            process: isize,
            thread: isize,
            frame: *mut u8,
            context: *mut Context,
            read: *const u8,
            table: unsafe extern "system" fn(isize, u64) -> *mut u8,
            base: unsafe extern "system" fn(isize, u64) -> u64,
            translate: *const u8,
        ) -> i32;
        fn SymFromAddrW(process: isize, address: u64, displacement: *mut u64, info: *mut u8)
        -> i32;
        fn SymAddrIncludeInlineTrace(process: isize, address: u64) -> u32;
        fn SymQueryInlineTrace(
            process: isize,
            start: u64,
            start_context: u32,
            start_return: u64,
            current: u64,
            context: *mut u32,
            index: *mut u32,
        ) -> i32;
        fn SymFromInlineContextW(
            process: isize,
            address: u64,
            inline: u32,
            displacement: *mut u64,
            info: *mut u8,
        ) -> i32;
    }

    /// Samples are kept only while this is set (PROFILE=<phase> limits them to one phase).
    pub static ACTIVE: AtomicBool = AtomicBool::new(true);

    pub struct Sampler {
        stop: Arc<AtomicBool>,
        handle: Option<std::thread::JoinHandle<Vec<Vec<u64>>>>,
    }

    impl Sampler {
        pub fn start() -> Self {
            let target = unsafe { GetCurrentThreadId() };
            let stop = Arc::new(AtomicBool::new(false));
            let flag = stop.clone();
            let handle = std::thread::spawn(move || {
                let process = unsafe { GetCurrentProcess() };
                unsafe {
                    SymSetOptions(0x2 | 0x10); // SYMOPT_UNDNAME | SYMOPT_LOAD_LINES
                    let directory = std::env::current_exe()
                        .unwrap()
                        .parent()
                        .unwrap()
                        .to_string_lossy()
                        .to_string();
                    let path: Vec<u16> = directory.encode_utf16().chain([0]).collect();
                    SymInitializeW(process, path.as_ptr(), 1);
                }
                // THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT | THREAD_QUERY_INFORMATION
                let thread = unsafe { OpenThread(0x2 | 0x8 | 0x40, 0, target) };
                let mut stacks = Vec::new();
                while !flag.load(Ordering::Relaxed) {
                    std::thread::sleep(std::time::Duration::from_micros(500));
                    let mut context = Context([0; 1232]);
                    context.0[0x30..0x34].copy_from_slice(&0x0010_0001u32.to_le_bytes()); // CONTEXT_CONTROL
                    unsafe { SuspendThread(thread) };
                    let mut stack = Vec::new();
                    if unsafe { GetThreadContext(thread, &mut context) } != 0 {
                        let read = |offset: usize| {
                            u64::from_le_bytes(context.0[offset..offset + 8].try_into().unwrap())
                        };
                        let (rsp, rbp, rip) = (read(0x98), read(0xA0), read(0xF8));
                        let mut frame = [0u8; 1024];
                        for (offset, value) in [(0, rip), (32, rbp), (48, rsp)] {
                            frame[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
                            frame[offset + 12..offset + 16].copy_from_slice(&3u32.to_le_bytes()); // AddrModeFlat
                        }
                        for _ in 0..64 {
                            let walked = unsafe {
                                StackWalk64(
                                    0x8664,
                                    process,
                                    thread,
                                    frame.as_mut_ptr(),
                                    &mut context,
                                    std::ptr::null(),
                                    SymFunctionTableAccess64,
                                    SymGetModuleBase64,
                                    std::ptr::null(),
                                )
                            };
                            let pc = u64::from_le_bytes(frame[0..8].try_into().unwrap());
                            if walked == 0 || pc == 0 {
                                break;
                            }
                            stack.push(pc);
                        }
                    }
                    unsafe { ResumeThread(thread) };
                    if !stack.is_empty() && ACTIVE.load(Ordering::Relaxed) {
                        stacks.push(stack);
                    }
                }
                stacks
            });
            Self {
                stop,
                handle: Some(handle),
            }
        }

        /// Stops sampling and prints the hottest functions, self (innermost inlined frame of
        /// the sampled instruction) and total (any frame of the stack, inlined ones included).
        pub fn report(mut self, top: usize) {
            self.stop.store(true, Ordering::Relaxed);
            let stacks = self.handle.take().unwrap().join().unwrap();
            let process = unsafe { GetCurrentProcess() };
            let mut names: HashMap<u64, Vec<String>> = HashMap::new();
            let mut resolve = |pc: u64, leaf: bool| -> Vec<String> {
                names
                    .entry(pc ^ u64::from(leaf))
                    .or_insert_with(|| {
                        // A return address points after the call: look up the call itself.
                        let address = if leaf { pc } else { pc - 1 };
                        symbolize(process, address)
                    })
                    .clone()
            };
            let (mut own, mut total) = (
                HashMap::<String, usize>::new(),
                HashMap::<String, usize>::new(),
            );
            for stack in &stacks {
                let mut seen = std::collections::HashSet::new();
                for (index, pc) in stack.iter().enumerate() {
                    let frames = resolve(*pc, index == 0);
                    if index == 0
                        && let Some(innermost) = frames.first()
                    {
                        *own.entry(innermost.clone()).or_default() += 1;
                    }
                    for name in frames {
                        if seen.insert(name.clone()) {
                            *total.entry(name).or_default() += 1;
                        }
                    }
                }
            }
            let samples = stacks.len().max(1) as f64;
            let print = |title: &str, counts: HashMap<String, usize>| {
                let mut rows: Vec<_> = counts.into_iter().collect();
                rows.sort_by_key(|row| std::cmp::Reverse(row.1));
                println!("PROFILE {title} ({} samples)", stacks.len());
                for (name, count) in rows.into_iter().take(top) {
                    println!("{:6.1}%  {}", count as f64 * 100.0 / samples, name);
                }
            };
            print("self", own);
            print("total", total);
        }
    }

    fn symbol_name(info: &[u8]) -> String {
        let length = (u32::from_le_bytes(info[76..80].try_into().unwrap()) as usize)
            .min((info.len() - 84) / 2);
        let name: Vec<u16> = info[84..84 + length * 2]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes(*pair))
            .collect();
        let name = String::from_utf16_lossy(&name);
        // Drop the hash suffix and generic noise for grouping.
        name.split("::h").next().unwrap_or(&name).to_string()
    }

    fn new_info() -> Vec<u8> {
        let mut info = vec![0u8; 88 + 1024 * 2];
        info[0..4].copy_from_slice(&88u32.to_le_bytes()); // SizeOfStruct
        info[80..84].copy_from_slice(&1000u32.to_le_bytes()); // MaxNameLen
        info
    }

    /// The functions at `address`, innermost inlined frame first, the real function last.
    fn symbolize(process: isize, address: u64) -> Vec<String> {
        let mut frames = Vec::new();
        unsafe {
            let inline = SymAddrIncludeInlineTrace(process, address);
            if inline > 0 {
                let (mut context, mut index) = (0u32, 0u32);
                if SymQueryInlineTrace(
                    process,
                    address,
                    0,
                    address,
                    address,
                    &mut context,
                    &mut index,
                ) != 0
                {
                    for step in 0..inline {
                        let mut info = new_info();
                        let mut displacement = 0;
                        if SymFromInlineContextW(
                            process,
                            address,
                            context + step,
                            &mut displacement,
                            info.as_mut_ptr(),
                        ) != 0
                        {
                            frames.push(symbol_name(&info));
                        }
                    }
                }
            }
            let mut info = new_info();
            let mut displacement = 0;
            if SymFromAddrW(process, address, &mut displacement, info.as_mut_ptr()) != 0 {
                frames.push(symbol_name(&info));
            } else {
                frames.push(format!("{address:#x}"));
            }
        }
        frames
    }
}

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
    let mut settings = cpu_render_settings();
    if let Some(threads) = threads {
        settings.num_threads = threads;
    }
    let (w, h) = (WIDTH as u16, HEIGHT as u16);
    let mut context = CpuRenderContext::new_with(w, h, settings);
    let mut resources = CpuResources::new();
    let mut images = HashMap::new();
    let mut frame = vec![0_u32; usize::from(w) * usize::from(h)];
    let mut scratch = Vec::new();
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
