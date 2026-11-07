//! A sampling profiler without ETW (no admin rights): a thread suspends the profiled thread
//! every half millisecond, walks its stack with DbgHelp and symbolizes once done. Needs debug
//! info (CARGO_PROFILE_RELEASE_DEBUG=line-tables-only CARGO_PROFILE_RELEASE_STRIP=false).
//!
//! The cells probe uses it (PROFILE=<phase>), and so does a running window: TARVE_PROFILE=1
//! samples its event-loop thread, TARVE_PROFILE=<phase> (apply, layout, paint, present) one
//! phase; the report goes to stderr when the window closes (TOP=<rows>, default 40).
//! TARVE_PROFILE_SYMBOLS=<dir> points DbgHelp at the PDBs when the library was extracted
//! away from them.
#![allow(unsafe_code)]

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
    fn SymFromAddrW(process: isize, address: u64, displacement: *mut u64, info: *mut u8) -> i32;
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
        let symbols = std::env::var("TARVE_PROFILE_SYMBOLS").ok();
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let handle = std::thread::spawn(move || {
            let process = unsafe { GetCurrentProcess() };
            unsafe {
                SymSetOptions(0x2 | 0x10); // SYMOPT_UNDNAME | SYMOPT_LOAD_LINES
                let directory = symbols.unwrap_or_else(|| {
                    std::env::current_exe()
                        .unwrap()
                        .parent()
                        .unwrap()
                        .to_string_lossy()
                        .to_string()
                });
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
            eprintln!("PROFILE {title} ({} samples)", stacks.len());
            for (name, count) in rows.into_iter().take(top) {
                eprintln!("{:6.1}%  {}", count as f64 * 100.0 / samples, name);
            }
        };
        print("self", own);
        print("total", total);
    }
}

fn symbol_name(info: &[u8]) -> String {
    let length =
        (u32::from_le_bytes(info[76..80].try_into().unwrap()) as usize).min((info.len() - 84) / 2);
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

static RUNNING: std::sync::Mutex<Option<(Sampler, String)>> = std::sync::Mutex::new(None);

/// TARVE_PROFILE set: samples the calling thread until `finish`.
pub(crate) fn start_from_env() {
    let Ok(phase) = std::env::var("TARVE_PROFILE") else {
        return;
    };
    let Ok(mut running) = RUNNING.lock() else {
        return;
    };
    if running.is_some() {
        return;
    }
    ACTIVE.store(phase.is_empty() || phase == "1", Ordering::Relaxed);
    *running = Some((Sampler::start(), phase));
}

/// Marks the start (`on`) or end of a phase: samples are kept inside the profiled one.
pub(crate) fn phase(name: &str, on: bool) {
    if let Ok(running) = RUNNING.try_lock()
        && let Some((_, phase)) = running.as_ref()
        && phase == name
    {
        ACTIVE.store(on, Ordering::Relaxed);
    }
}

/// Prints the report of a `start_from_env` run.
pub(crate) fn finish() {
    let taken = RUNNING.lock().ok().and_then(|mut running| running.take());
    if let Some((sampler, _)) = taken {
        let top = std::env::var("TOP")
            .ok()
            .and_then(|top| top.parse().ok())
            .unwrap_or(40);
        sampler.report(top);
    }
}
