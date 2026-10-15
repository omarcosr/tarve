//! Runtime diagnostics for `app.stats()`: how long each frame phase took
//! (percentiles over the recent frames) and the process memory at each
//! startup stage. Always on: a sample is two clock reads and an `f32`.

use serde_json::{Value, json};
use std::collections::VecDeque;

/// Samples kept per phase: ten seconds of frames at 60 Hz.
const CAPACITY: usize = 600;

#[derive(Default)]
pub(crate) struct Samples(VecDeque<f32>);

impl Samples {
    pub(crate) fn push(&mut self, ms: f64) {
        if self.0.len() == CAPACITY {
            self.0.pop_front();
        }
        self.0.push_back(ms as f32);
    }

    pub(crate) fn summary(&self) -> Value {
        let mut sorted: Vec<f32> = self.0.iter().copied().collect();
        sorted.sort_by(f32::total_cmp);
        let at = |q: f64| -> f64 {
            if sorted.is_empty() {
                return 0.0;
            }
            let index = ((sorted.len() as f64 * q).ceil() as usize).clamp(1, sorted.len()) - 1;
            round(f64::from(sorted[index]))
        };
        json!({
            "count": sorted.len(),
            "p50": at(0.50),
            "p95": at(0.95),
            "p99": at(0.99),
            "max": sorted.last().map_or(0.0, |max| round(f64::from(*max))),
        })
    }
}

fn round(ms: f64) -> f64 {
    (ms * 1000.0).round() / 1000.0
}

/// Native frame phases, in the order a frame runs them.
#[derive(Default)]
pub(crate) struct FrameStats {
    /// Applying a JS update (patch, mutate or replace) to the retained tree.
    pub apply: Samples,
    /// Layout and text measurement (`Tree::compute`).
    pub layout: Samples,
    /// Recording the frame for the renderer (`Tree::paint`).
    pub paint: Samples,
    /// Rasterizing and presenting (GPU submit or CPU blit, including vsync waits).
    pub present: Samples,
    /// Motion, layout and paint: the CPU cost of a frame before present.
    pub frame: Samples,
}

impl FrameStats {
    pub(crate) fn summary(&self) -> Value {
        json!({
            "apply": self.apply.summary(),
            "layout": self.layout.summary(),
            "paint": self.paint.summary(),
            "present": self.present.summary(),
            "frame": self.frame.summary(),
        })
    }

    pub(crate) fn reset(&mut self) {
        *self = Self::default();
    }
}

/// Process memory at named startup stages, plus a current reading on request.
#[derive(Default)]
pub(crate) struct MemoryStages(Vec<(&'static str, ProcessMemory)>);

impl MemoryStages {
    pub(crate) fn record(&mut self, label: &'static str) {
        if let Some(memory) = process_memory() {
            self.0.push((label, memory));
        }
    }

    pub(crate) fn summary(&self) -> Value {
        json!({
            "stages": self.0.iter().map(|(label, memory)| {
                let mut stage = memory.json();
                stage["label"] = json!(label);
                stage
            }).collect::<Vec<_>>(),
            "current": process_memory().map(|memory| memory.json()),
        })
    }
}

#[derive(Clone, Copy)]
pub(crate) struct ProcessMemory {
    /// Resident pages (Task Manager's "Memory" column on Windows, VmRSS on Linux).
    working_set: f64,
    /// Private committed bytes on Windows; anonymous resident memory on Linux.
    private: f64,
}

impl ProcessMemory {
    fn json(self) -> Value {
        json!({
            "workingSetMb": (self.working_set / 1048576.0 * 10.0).round() / 10.0,
            "privateMb": (self.private / 1048576.0 * 10.0).round() / 10.0,
        })
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn process_memory() -> Option<ProcessMemory> {
    #[repr(C)]
    #[derive(Default)]
    struct Counters {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
    }
    unsafe extern "system" {
        fn GetCurrentProcess() -> isize;
        fn K32GetProcessMemoryInfo(process: isize, counters: *mut Counters, cb: u32) -> i32;
    }
    let mut counters = Counters {
        cb: size_of::<Counters>() as u32,
        ..Default::default()
    };
    // SAFETY: the counters struct matches PROCESS_MEMORY_COUNTERS and its size is passed in.
    let ok = unsafe { K32GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb) };
    (ok != 0).then_some(ProcessMemory {
        working_set: counters.working_set_size as f64,
        private: counters.pagefile_usage as f64,
    })
}

#[cfg(target_os = "linux")]
pub(crate) fn process_memory() -> Option<ProcessMemory> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let field = |name: &str| -> Option<f64> {
        let line = status.lines().find(|line| line.starts_with(name))?;
        let kb: f64 = line[name.len()..]
            .trim()
            .trim_end_matches("kB")
            .trim()
            .parse()
            .ok()?;
        Some(kb * 1024.0)
    };
    Some(ProcessMemory {
        working_set: field("VmRSS:")?,
        private: field("RssAnon:").unwrap_or(0.0),
    })
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
pub(crate) fn process_memory() -> Option<ProcessMemory> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn samples_report_nearest_rank_percentiles_over_the_recent_window() {
        let mut samples = Samples::default();
        assert_eq!(samples.summary()["count"], 0);
        for ms in 1..=100 {
            samples.push(f64::from(ms));
        }
        let summary = samples.summary();
        assert_eq!(
            (
                summary["p50"].as_f64(),
                summary["p95"].as_f64(),
                summary["p99"].as_f64(),
                summary["max"].as_f64()
            ),
            (Some(50.0), Some(95.0), Some(99.0), Some(100.0))
        );
        for _ in 0..CAPACITY {
            samples.push(1.0);
        }
        assert_eq!(samples.summary()["max"].as_f64(), Some(1.0));
        assert_eq!(samples.summary()["count"], CAPACITY);
    }

    #[test]
    fn the_process_memory_reading_is_plausible() {
        let mut stages = MemoryStages::default();
        stages.record("start");
        let summary = stages.summary();
        if cfg!(any(target_os = "windows", target_os = "linux")) {
            assert!(summary["current"]["workingSetMb"].as_f64().unwrap() > 1.0);
            assert_eq!(summary["stages"][0]["label"], "start");
        }
    }
}
