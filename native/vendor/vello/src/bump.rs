// Copyright 2025 the Tarve Authors
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Tarve patch: the bump-allocated buffers sized from what the GPU reports it needed.
//!
//! Upstream allocates them for its worst test scene (~165 MB of GPU memory, whatever is drawn).
//! Here they start small; every frame reads back the bump counters after the coarse stages and,
//! when a buffer was too small, grows it and runs the coarse stages again before fine
//! rasterization, so a frame never shows what did not fit. A capacity far above what recent
//! frames used shrinks back.

use vello_encoding::{BumpAllocators, BumpCapacity};

/// Words a tile's command list grows by (`PTCL_INCREMENT` in `ptcl.wgsl`).
const PTCL_INCREMENT: u32 = 256;

/// Frames over which the peak use is measured before a capacity may shrink.
const WINDOW: u32 = 240;

/// Capacities a renderer starts with: a few hundred KB each, enough for simple scenes.
pub(crate) const FLOOR: BumpCapacity = BumpCapacity {
    lines: 1 << 14,
    binning: 1 << 13,
    tiles: 1 << 14,
    seg_counts: 1 << 14,
    segments: 1 << 14,
    blend: 1 << 12,
    ptcl: 1 << 15,
};

/// Capacities never grow past four times upstream's sizes (each under 128 MB).
const CEILING: BumpCapacity = BumpCapacity {
    lines: 1 << 22,
    binning: 1 << 20,
    tiles: 1 << 23,
    seg_counts: 1 << 23,
    segments: 1 << 22,
    blend: 1 << 22,
    ptcl: 1 << 24,
};

fn fields(c: &BumpCapacity) -> [u32; 7] {
    [
        c.lines,
        c.binning,
        c.tiles,
        c.seg_counts,
        c.segments,
        c.blend,
        c.ptcl,
    ]
}

fn from_fields(f: [u32; 7]) -> BumpCapacity {
    BumpCapacity {
        lines: f[0],
        binning: f[1],
        tiles: f[2],
        seg_counts: f[3],
        segments: f[4],
        blend: f[5],
        ptcl: f[6],
    }
}

/// What a frame used, in the capacities' terms.
fn needed(bump: &BumpAllocators) -> [u32; 7] {
    [
        bump.lines,
        bump.binning,
        bump.tile,
        bump.seg_counts,
        bump.segments,
        bump.blend,
        bump.ptcl.saturating_add(PTCL_INCREMENT),
    ]
}

/// Half again what was needed, rounded up to a power of two.
fn roomy(need: u32) -> u32 {
    let roomy = (u64::from(need) * 3 / 2).max(1).next_power_of_two();
    u32::try_from(roomy).unwrap_or(1 << 31)
}

/// The bump capacities of a renderer and the use they are sized from.
#[derive(Debug)]
pub(crate) struct BumpSizing {
    pub(crate) capacity: BumpCapacity,
    peak: [u32; 7],
    frames: u32,
}

impl Default for BumpSizing {
    fn default() -> Self {
        Self {
            capacity: FLOOR,
            peak: [0; 7],
            frames: 0,
        }
    }
}

/// The verdict on a frame's coarse stages.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Verdict {
    /// Everything fit: rasterize.
    Fits,
    /// Everything fit; the capacities shrank for the next frames.
    FitsShrunk,
    /// Something did not fit: the capacities grew, run the coarse stages again.
    Grown,
    /// Something did not fit and the capacities are at their ceiling: rasterize what fit.
    AtCeiling,
}

impl BumpSizing {
    pub(crate) fn check(&mut self, bump: &BumpAllocators) -> Verdict {
        let need = needed(bump);
        let capacity = fields(&self.capacity);
        let fits = bump.failed == 0 && need.iter().zip(capacity).all(|(n, c)| *n <= c);
        if fits {
            for (peak, need) in self.peak.iter_mut().zip(need) {
                *peak = (*peak).max(need);
            }
            self.frames += 1;
            if self.frames < WINDOW {
                return Verdict::Fits;
            }
            let floor = fields(&FLOOR);
            let mut shrunk = false;
            let next = std::array::from_fn(|i| {
                let target = roomy(self.peak[i]).max(floor[i]);
                if capacity[i] >= target * 4 {
                    shrunk = true;
                    target * 2
                } else {
                    capacity[i]
                }
            });
            self.capacity = from_fields(next);
            self.peak = [0; 7];
            self.frames = 0;
            return if shrunk { Verdict::FitsShrunk } else { Verdict::Fits };
        }
        let ceiling = fields(&CEILING);
        let mut next: [u32; 7] = std::array::from_fn(|i| {
            if need[i] > capacity[i] {
                roomy(need[i]).min(ceiling[i])
            } else {
                capacity[i]
            }
        });
        if need.iter().zip(capacity).all(|(n, c)| *n <= c) {
            // A stage failed though every counter fits what it saw: an earlier failure kept the
            // later stages from counting. Grow everything.
            next = std::array::from_fn(|i| capacity[i].saturating_mul(2).min(ceiling[i]));
        }
        if next == capacity {
            return Verdict::AtCeiling;
        }
        self.capacity = from_fields(next);
        Verdict::Grown
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bump(lines: u32, tile: u32, failed: u32) -> BumpAllocators {
        BumpAllocators {
            failed,
            lines,
            tile,
            ..Default::default()
        }
    }

    #[test]
    fn a_frame_that_overflows_grows_the_buffer_it_overflowed_and_is_redone() {
        let mut sizing = BumpSizing::default();
        assert_eq!(sizing.check(&bump(100, 100, 0)), Verdict::Fits);
        assert_eq!(sizing.check(&bump(100_000, 100, 4)), Verdict::Grown);
        assert_eq!(sizing.capacity.lines, 1 << 18);
        assert_eq!(sizing.capacity.tiles, FLOOR.tiles);
        assert_eq!(sizing.check(&bump(100_000, 100, 0)), Verdict::Fits);
    }

    #[test]
    fn a_failure_no_counter_explains_grows_every_buffer() {
        let mut sizing = BumpSizing::default();
        assert_eq!(sizing.check(&bump(10, 10, 2)), Verdict::Grown);
        assert_eq!(sizing.capacity.tiles, FLOOR.tiles * 2);
        assert_eq!(sizing.capacity.lines, FLOOR.lines * 2);
    }

    #[test]
    fn capacities_stop_at_the_ceiling() {
        let mut sizing = BumpSizing::default();
        assert_eq!(sizing.check(&bump(u32::MAX / 2, 0, 4)), Verdict::Grown);
        assert_eq!(sizing.capacity.lines, CEILING.lines);
        assert_eq!(sizing.check(&bump(u32::MAX / 2, 0, 4)), Verdict::AtCeiling);
    }

    #[test]
    fn a_capacity_far_above_recent_use_shrinks_after_a_window() {
        let mut sizing = BumpSizing::default();
        sizing.check(&bump(1_000_000, 0, 4));
        let grown = sizing.capacity.lines;
        let mut last = Verdict::Fits;
        for _ in 0..WINDOW {
            last = sizing.check(&bump(1_000, 0, 0));
        }
        assert_eq!(last, Verdict::FitsShrunk);
        assert!(sizing.capacity.lines < grown / 4);
        assert!(sizing.capacity.lines >= FLOOR.lines);
    }
}
