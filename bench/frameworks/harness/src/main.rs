//! Framework-agnostic GUI benchmark harness (Windows). Launches one app, finds its window from
//! the process tree, and measures from the outside, the same way for every framework:
//! - first frame: launch -> the 48x48 marker at the client's top-left shows magenta on screen;
//! - idle: private bytes, private working set, working set, threads, handles, processes, CPU,
//!   GPU memory (Windows GPU counters), summed over the whole process tree;
//! - busy (SCENE=list): 240 wheel events at ~60 Hz posted to the window under the list, CPU and
//!   3D-engine GPU use over that window, peak commit/working set;
//! - update latency: a click posted to the Update button -> the marker colour flips on screen
//!   (the app re-renders every row label in the same update).
//! Usage: bench-harness <scene> <exe> [args...]  -> one JSON line on stdout.
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Graphics::Gdi::*;
use windows_sys::Win32::System::Diagnostics::ToolHelp::*;
use windows_sys::Win32::System::ProcessStatus::K32GetProcessMemoryInfo;
use windows_sys::Win32::System::Threading::*;
use windows_sys::Win32::UI::HiDpi::*;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
use windows_sys::Win32::UI::WindowsAndMessaging::*;

#[repr(C)]
#[derive(Default)]
struct Pmc {
    cb: u32,
    page_faults: u32,
    peak_ws: usize,
    ws: usize,
    quota_peak_paged: usize,
    quota_paged: usize,
    quota_peak_nonpaged: usize,
    quota_nonpaged: usize,
    pagefile: usize,
    peak_pagefile: usize,
    private_usage: usize,
    private_ws: usize,
    shared_commit: u64,
}

/// (pid, threads) of root and every descendant.
fn tree(root: u32) -> Vec<(u32, u32)> {
    let mut all = Vec::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                all.push((entry.th32ProcessID, entry.th32ParentProcessID, entry.cntThreads));
                if Process32NextW(snap, &mut entry) == 0 { break; }
            }
        }
        CloseHandle(snap);
    }
    let mut out = vec![];
    let mut seen = HashSet::new();
    let mut queue = vec![root];
    while let Some(pid) = queue.pop() {
        if !seen.insert(pid) { continue; }
        if let Some(p) = all.iter().find(|p| p.0 == pid) { out.push((pid, p.2)); }
        for p in all.iter().filter(|p| p.1 == pid && p.0 != pid) { queue.push(p.0); }
    }
    out
}

#[derive(Default, Clone, Copy)]
struct Snap { private: f64, private_ws: f64, ws: f64, peak_ws: f64, peak_private: f64, threads: u32, handles: u32, procs: u32, cpu_ms: f64, at: Option<Instant> }

fn snapshot(root: u32) -> Snap {
    let mut s = Snap { at: Some(Instant::now()), ..Default::default() };
    for (pid, threads) in tree(root) {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() { continue; }
            let mut pmc = Pmc { cb: std::mem::size_of::<Pmc>() as u32, ..Default::default() };
            if K32GetProcessMemoryInfo(h, &mut pmc as *mut Pmc as *mut _, pmc.cb) != 0 {
                let mb = |v: usize| v as f64 / 1048576.0;
                s.private += mb(pmc.private_usage);
                s.private_ws += mb(pmc.private_ws);
                s.ws += mb(pmc.ws);
                s.peak_ws += mb(pmc.peak_ws);
                s.peak_private += mb(pmc.peak_pagefile);
            }
            let mut handles = 0u32;
            GetProcessHandleCount(h, &mut handles);
            s.handles += handles;
            let (mut c, mut x, mut k, mut u): (FILETIME, FILETIME, FILETIME, FILETIME) = std::mem::zeroed();
            if GetProcessTimes(h, &mut c, &mut x, &mut k, &mut u) != 0 {
                let t = |f: FILETIME| ((f.dwHighDateTime as u64) << 32 | f.dwLowDateTime as u64) as f64 / 10_000.0;
                s.cpu_ms += t(k) + t(u);
            }
            CloseHandle(h);
        }
        s.threads += threads;
        s.procs += 1;
    }
    s
}

/// CPU over the interval as a percentage of one core.
fn cpu_pct(a: &Snap, b: &Snap) -> f64 {
    let wall = b.at.unwrap().duration_since(a.at.unwrap()).as_secs_f64() * 1000.0;
    (b.cpu_ms - a.cpu_ms) / wall * 100.0
}

struct Find { pids: HashSet<u32>, best: HWND, area: i64 }

unsafe extern "system" fn enum_cb(hwnd: HWND, lp: LPARAM) -> BOOL {
    let find = &mut *(lp as *mut Find);
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, &mut pid);
    if !find.pids.contains(&pid) || IsWindowVisible(hwnd) == 0 || !GetWindow(hwnd, GW_OWNER).is_null() { return 1; }
    if GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW != 0 { return 1; }
    let mut r: RECT = std::mem::zeroed();
    GetClientRect(hwnd, &mut r);
    let area = (r.right - r.left) as i64 * (r.bottom - r.top) as i64;
    if r.right - r.left >= 200 && r.bottom - r.top >= 200 && area > find.area { find.best = hwnd; find.area = area; }
    1
}

fn find_window(root: u32) -> Option<HWND> {
    let mut find = Find { pids: tree(root).into_iter().map(|p| p.0).collect(), best: std::ptr::null_mut(), area: 0 };
    unsafe { EnumWindows(Some(enum_cb), &mut find as *mut Find as LPARAM); }
    (!find.best.is_null()).then_some(find.best)
}

fn origin(hwnd: HWND) -> (i32, i32) {
    let mut p = POINT { x: 0, y: 0 };
    unsafe { ClientToScreen(hwnd, &mut p); }
    (p.x, p.y)
}

fn scale(hwnd: HWND) -> f64 { unsafe { GetDpiForWindow(hwnd) as f64 / 96.0 } }

/// One screen pixel through BitBlt (GetPixel on the screen DC misses DWM-composed content here).
fn pixel(x: i32, y: i32) -> (u8, u8, u8) {
    let px = grab(x, y, 1, 1);
    (px[2], px[1], px[0])
}

/// BGRA pixels of a physical screen rectangle.
fn grab(x: i32, y: i32, w: i32, h: i32) -> Vec<u8> {
    unsafe {
        let screen = GetDC(std::ptr::null_mut());
        let mem = CreateCompatibleDC(screen);
        let bmp = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(mem, bmp);
        BitBlt(mem, 0, 0, w, h, screen, x, y, SRCCOPY);
        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = w;
        info.bmiHeader.biHeight = -h;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        let mut buf = vec![0u8; (w * h * 4) as usize];
        GetDIBits(mem, bmp, 0, h as u32, buf.as_mut_ptr() as *mut _, &mut info, DIB_RGB_COLORS);
        SelectObject(mem, old);
        DeleteObject(bmp);
        DeleteDC(mem);
        ReleaseDC(std::ptr::null_mut(), screen);
        buf
    }
}

/// 'm' magenta, 'g' green, 'b' blue, '?' anything else.
fn marker(hwnd: HWND) -> char {
    let s = scale(hwnd);
    let (x, y) = origin(hwnd);
    let (r, g, b) = pixel(x + (24.0 * s) as i32, y + (24.0 * s) as i32);
    match (r > 200, g > 200, b > 200, r < 60, g < 60, b < 60) {
        (true, _, true, _, true, _) => 'm',
        (_, true, _, true, _, true) => 'g',
        (_, _, true, true, true, _) => 'b',
        _ => '?',
    }
}

/// Real OS input (SendInput) at a client point: the cursor moves there, so every framework sees
/// the same thing a user's mouse would produce (several read the cursor position, not the message).
fn input_at(hwnd: HWND, cx: f64, cy: f64, events: &[(u32, i32)]) {
    let s = scale(hwnd);
    let (ox, oy) = origin(hwnd);
    unsafe {
        SetCursorPos(ox + (cx * s) as i32, oy + (cy * s) as i32);
        let inputs: Vec<INPUT> = events.iter().map(|&(flags, data)| {
            let mut i: INPUT = std::mem::zeroed();
            i.r#type = INPUT_MOUSE;
            i.Anonymous.mi.dwFlags = flags;
            i.Anonymous.mi.mouseData = data as u32;
            i
        }).collect();
        SendInput(inputs.len() as u32, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32);
    }
}

fn click(hwnd: HWND, cx: f64, cy: f64) { input_at(hwnd, cx, cy, &[(MOUSEEVENTF_LEFTDOWN, 0), (MOUSEEVENTF_LEFTUP, 0)]); }

fn wheel(hwnd: HWND, cx: f64, cy: f64, delta: i32) { input_at(hwnd, cx, cy, &[(MOUSEEVENTF_WHEEL, delta)]); }

/// The window must be the one on screen at the marker before any real input is sent.
fn on_top(hwnd: HWND) -> bool { marker(hwnd) != '?' }

/// Hash of a screen rectangle (client coordinates, logical px).
fn region_hash(hwnd: HWND, x: f64, y: f64, w: f64, h: f64) -> u64 {
    let s = scale(hwnd);
    let (ox, oy) = origin(hwnd);
    let (px, py, pw, ph) = (ox + (x * s) as i32, oy + (y * s) as i32, (w * s) as i32, (h * s) as i32);
    grab(px, py, pw, ph).iter().fold(0xcbf29ce484222325u64, |h, b| (h ^ *b as u64).wrapping_mul(0x100000001b3))
}

/// Windows GPU counters for the tree: one PowerShell Get-Counter call, summed per sample.
fn gpu_counters(pids: &HashSet<u32>, counter: &str, samples: u32) -> Option<f64> {
    let script = format!("$ErrorActionPreference='SilentlyContinue'; (Get-Counter '{counter}' -SampleInterval 1 -MaxSamples {samples}).CounterSamples | % {{ \"$($_.Timestamp.Ticks) $($_.InstanceName) $($_.CookedValue)\" }}");
    let out = Command::new("powershell").args(["-NoProfile", "-Command", &script]).creation_flags(0x0800_0000).output().ok()?;
    let mut per: HashMap<String, f64> = HashMap::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let mut it = line.split_whitespace();
        let (Some(ts), Some(inst), Some(v)) = (it.next(), it.next(), it.next()) else { continue };
        let pid: u32 = inst.strip_prefix("pid_").and_then(|r| r.split('_').next()).and_then(|p| p.parse().ok()).unwrap_or(0);
        if pids.contains(&pid) { *per.entry(ts.to_string()).or_default() += v.parse::<f64>().unwrap_or(0.0); }
    }
    if per.is_empty() { return Some(0.0); }
    Some(per.values().sum::<f64>() / per.len() as f64)
}

fn kill(root: u32) {
    for (pid, _) in tree(root).into_iter().rev() {
        unsafe {
            let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if !h.is_null() { TerminateProcess(h, 1); CloseHandle(h); }
        }
    }
}

/// Whole-machine CPU busy percentage between two GetSystemTimes readings (background noise check).
fn system_times() -> (u64, u64) {
    let (mut i, mut k, mut u): (FILETIME, FILETIME, FILETIME) = unsafe { std::mem::zeroed() };
    unsafe { GetSystemTimes(&mut i, &mut k, &mut u); }
    let t = |f: FILETIME| (f.dwHighDateTime as u64) << 32 | f.dwLowDateTime as u64;
    (t(i), t(k) + t(u))
}

/// Saves the client area as a BMP (SHOT=path) so every run can be checked by eye.
fn save_shot(hwnd: HWND, path: &str) {
    let mut rc: RECT = unsafe { std::mem::zeroed() };
    unsafe { GetClientRect(hwnd, &mut rc); }
    let (x, y) = origin(hwnd);
    let (w, h) = (rc.right, rc.bottom);
    let px = grab(x, y, w, h);
    let mut f = Vec::with_capacity(54 + px.len());
    f.extend_from_slice(b"BM");
    f.extend_from_slice(&((54 + px.len()) as u32).to_le_bytes());
    f.extend_from_slice(&[0; 4]);
    f.extend_from_slice(&54u32.to_le_bytes());
    f.extend_from_slice(&40u32.to_le_bytes());
    f.extend_from_slice(&w.to_le_bytes());
    f.extend_from_slice(&(-h).to_le_bytes());
    f.extend_from_slice(&1u16.to_le_bytes());
    f.extend_from_slice(&32u16.to_le_bytes());
    f.extend_from_slice(&[0; 24]);
    f.extend_from_slice(&px);
    let _ = std::fs::write(path, f);
}

fn r1(v: f64) -> Value { json!((v * 10.0).round() / 10.0) }

fn idle_json(s: &Snap) -> Value {
    json!({ "privateMb": r1(s.private), "privateWsMb": r1(s.private_ws), "wsMb": r1(s.ws), "threads": s.threads, "handles": s.handles, "procs": s.procs })
}

fn main() {
    if unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) } == 0 {
        eprintln!("SetProcessDpiAwarenessContext failed: {}", unsafe { GetLastError() });
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    let scene = args[0].clone();
    let list = scene == "list";
    let t0 = Instant::now();
    let child = Command::new(&args[1]).args(&args[2..]).env("SCENE", &scene)
        .stdin(Stdio::null()).stdout(Stdio::null())
        // STDERR=path keeps the app's stderr (TARVE_TRACE=1 timelines, say).
        .stderr(std::env::var("STDERR").ok().and_then(|path| std::fs::File::create(path).ok()).map_or(Stdio::null(), Stdio::from))
        .creation_flags(0x0800_0000).spawn().expect("spawn");
    let root = child.id();
    let fail = |why: &str| -> ! { kill(root); println!("{}", json!({ "error": why })); std::process::exit(1) };
    let mut first_window = None;
    let debug = std::env::var("DEBUG").is_ok();
    let mut last = Instant::now();
    let hwnd = loop {
        if t0.elapsed() > Duration::from_secs(60) { fail("no first frame within 60 s"); }
        if let Some(h) = find_window(root) {
            if first_window.is_none() {
                first_window = Some(t0.elapsed());
                // On top, in the work area's top-left corner: out of the way of whoever uses the screen.
                unsafe {
                    let mut area: RECT = std::mem::zeroed();
                    SystemParametersInfoW(SPI_GETWORKAREA, 0, &mut area as *mut RECT as *mut _, 0);
                    let keep = std::env::var_os("HARNESS_CENTER").is_some();
                    SetWindowPos(h, HWND_TOPMOST, area.left, area.top, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE | if keep { SWP_NOMOVE } else { 0 });
                }
            }
            if marker(h) == 'm' { break h; }
            if debug && last.elapsed() > Duration::from_secs(1) && { last = Instant::now(); true } {
                let s = scale(h);
                let (x, y) = origin(h);
                eprintln!("{:?} hwnd {:?} origin {x},{y} scale {s} pixel {:?}", t0.elapsed(), h, pixel(x + (24.0 * s) as i32, y + (24.0 * s) as i32));
            }
        } else if debug && last.elapsed() > Duration::from_secs(1) && { last = Instant::now(); true } {
            eprintln!("{:?} no window; tree {:?}", t0.elapsed(), tree(root));
        }
        sleep(Duration::from_millis(1));
    };
    let first_frame = t0.elapsed();
    let mut rc: RECT = unsafe { std::mem::zeroed() };
    unsafe { GetClientRect(hwnd, &mut rc); }
    let s = scale(hwnd);
    sleep(Duration::from_secs(3));
    if let Ok(path) = std::env::var("SHOT") { save_shot(hwnd, &path); }
    let sys0 = system_times();
    let idle0 = snapshot(root);
    sleep(Duration::from_secs(5));
    let idle1 = snapshot(root);
    let sys1 = system_times();
    let sys_busy = 100.0 * (1.0 - (sys1.0 - sys0.0) as f64 / (sys1.1 - sys0.1).max(1) as f64);
    let pids: HashSet<u32> = tree(root).into_iter().map(|p| p.0).collect();
    let gpu_dedicated = gpu_counters(&pids, "\\GPU Process Memory(*)\\Dedicated Usage", 1).map(|v| v / 1048576.0);
    let gpu_shared = gpu_counters(&pids, "\\GPU Process Memory(*)\\Shared Usage", 1).map(|v| v / 1048576.0);
    let mut out = json!({
        "scene": scene,
        "firstWindowMs": first_window.map(|d| d.as_millis()),
        "firstFrameMs": first_frame.as_millis(),
        "client": [((rc.right as f64) / s).round(), ((rc.bottom as f64) / s).round()],
        "scale": s,
        "idle": idle_json(&idle1),
        "idleCpuPct": r1(cpu_pct(&idle0, &idle1)),
        "machineBusyPct": r1(sys_busy),
        "gpuDedicatedMb": gpu_dedicated.map(r1),
        "gpuSharedMb": gpu_shared.map(r1),
    });
    let cw = rc.right as f64 / s;
    let ch = rc.bottom as f64 / s;
    if list {
        let (lx, ly) = (cw / 2.0, 48.0 + (ch - 48.0) / 2.0);
        let before = region_hash(hwnd, 0.0, 60.0, cw * 0.6, 200.0);
        let gpu_pids = pids.clone();
        let gpu = std::thread::spawn(move || gpu_counters(&gpu_pids, "\\GPU Engine(*engtype_3D)\\Utilization Percentage", 3));
        let mut cursor = POINT { x: 0, y: 0 };
        unsafe { GetCursorPos(&mut cursor); }
        if !on_top(hwnd) { fail("window not on top before scrolling"); }
        let b0 = snapshot(root);
        let mut scrolled = false;
        for i in 0..240 {
            wheel(hwnd, lx, ly, if i % 80 < 40 { -120 } else { 120 });
            sleep(Duration::from_millis(16));
            if i == 20 { scrolled = region_hash(hwnd, 0.0, 60.0, cw * 0.6, 200.0) != before; }
        }
        let b1 = snapshot(root);
        unsafe { SetCursorPos(cursor.x, cursor.y); }
        out["busyCpuPct"] = r1(cpu_pct(&b0, &b1));
        out["busyGpu3dPct"] = gpu.join().ok().flatten().map(r1).into();
        out["scrolled"] = json!(scrolled);
        sleep(Duration::from_millis(500));
    }
    let mut cursor = POINT { x: 0, y: 0 };
    unsafe { GetCursorPos(&mut cursor); }
    let mut lat = vec![];
    if debug {
        eprintln!("clicks start at {:?}", t0.elapsed());
    }
    let mut misses = 0;
    for _ in 0..30 {
        let was = marker(hwnd);
        if was == '?' { fail("window not on top before clicking"); }
        let want = if was == 'g' { 'b' } else { 'g' };
        let t = Instant::now();
        click(hwnd, 124.0, 24.0);
        loop {
            if marker(hwnd) == want {
                lat.push(t.elapsed().as_secs_f64() * 1000.0);
                if debug {
                    eprintln!("click at {:.2} ms → pixel {:.2} ms later", t.duration_since(t0).as_secs_f64() * 1000.0, lat.last().unwrap());
                }
                break;
            }
            if t.elapsed() > Duration::from_secs(3) { misses += 1; break; }
        }
        sleep(Duration::from_millis(150));
    }
    unsafe { SetCursorPos(cursor.x, cursor.y); }
    lat.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let pick = |q: f64| lat.get(((lat.len() as f64 - 1.0) * q).round() as usize).copied().map(r1);
    out["updateMs"] = json!({ "p50": pick(0.5), "p95": pick(0.95), "max": pick(1.0), "n": lat.len(), "misses": misses });
    let end = snapshot(root);
    out["peakPrivateMb"] = r1(end.peak_private);
    out["peakWsMb"] = r1(end.peak_ws);
    out["after"] = idle_json(&end);
    kill(root);
    println!("{out}");
}
