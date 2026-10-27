//! Playback rate that keeps the pitch, as a browser's `playbackRate` with
//! `preservesPitch` (and mpv's scaletempo): WSOLA. The input is cut into
//! overlapping segments taken `rate` times faster than they are played; each
//! one starts where it best continues the last (a short search for the
//! highest correlation) and is crossfaded into it, so the waveform stays
//! smooth and the frequencies stay where they were.

/// Output frames per segment step: 30 ms, as scaletempo's stride.
const HOP_SECONDS: f64 = 0.030;
/// How far around the ideal position a segment may start: 12 ms.
const SEARCH_SECONDS: f64 = 0.012;

pub(crate) struct Stretcher {
    channels: usize,
    hop: usize,
    search: usize,
    /// Interleaved input frames not yet behind every segment that may still read them.
    input: Vec<f32>,
    /// Where the next segment ideally starts, in frames into `input`.
    position: f64,
    /// Start of the last segment played, in frames into `input`.
    previous: Option<usize>,
    /// The block being played and how much of it was.
    block: Vec<f32>,
    at: usize,
    /// No more input comes: what is left is played out (padded with silence).
    ended: bool,
    /// Frames of `input` that are real sound, not padding.
    real: usize,
}

impl Stretcher {
    pub(crate) fn new(channels: u16, sample_rate: u32) -> Self {
        let rate = f64::from(sample_rate.max(1));
        Self {
            channels: usize::from(channels.max(1)),
            hop: ((rate * HOP_SECONDS) as usize).max(16),
            search: ((rate * SEARCH_SECONDS) as usize).max(4),
            input: Vec::new(),
            position: 0.0,
            previous: None,
            block: Vec::new(),
            at: 0,
            ended: false,
            real: 0,
        }
    }

    pub(crate) fn push(&mut self, samples: &[f32]) {
        self.input.extend_from_slice(samples);
        self.real = self.input.len() / self.channels;
    }

    /// The input ended: play out what is held.
    pub(crate) fn finish(&mut self) {
        self.ended = true;
    }

    /// The next output sample at `rate`, or `None` until more input is pushed
    /// (or, once finished, when everything was played).
    pub(crate) fn pull(&mut self, rate: f64) -> Option<f32> {
        if self.at == self.block.len() && !self.step(rate) {
            return None;
        }
        let sample = self.block[self.at];
        self.at += 1;
        Some(sample)
    }

    fn frames(&self) -> usize {
        self.input.len() / self.channels
    }

    /// Mono value of frame `frame` (the channels summed), for the search.
    fn mono(&self, frame: usize) -> f32 {
        let start = frame * self.channels;
        self.input[start..start + self.channels].iter().sum()
    }

    /// Plays the next segment into `block`; false when input is missing.
    fn step(&mut self, rate: f64) -> bool {
        let (hop, search) = (self.hop, self.search);
        let target = self.position.round() as usize;
        let needed = target + search + 2 * hop;
        if self.frames() < needed {
            if !self.ended || self.real <= target {
                return false;
            }
            // Pad the tail so the last segments play out.
            self.input.resize(needed * self.channels, 0.0);
        }
        let start = match self.previous {
            None => target,
            Some(previous) => {
                // The segment that best continues the last one's natural next part.
                let natural = previous + hop;
                let low = target.saturating_sub(search);
                let mut best = (f32::MIN, target);
                for candidate in low..=target + search {
                    let mut dot = 0.0f32;
                    let mut energy = 1e-9f32;
                    for i in (0..hop).step_by(2) {
                        let a = self.mono(natural + i);
                        let b = self.mono(candidate + i);
                        dot += a * b;
                        energy += b * b;
                    }
                    let score = dot / energy.sqrt();
                    if score > best.0 {
                        best = (score, candidate);
                    }
                }
                best.1
            }
        };
        let channels = self.channels;
        self.block.clear();
        self.at = 0;
        for i in 0..hop {
            let fade = (i as f32 + 0.5) / hop as f32;
            for channel in 0..channels {
                let next = self.input[(start + i) * channels + channel];
                let sample = match self.previous {
                    Some(previous) => {
                        self.input[(previous + hop + i) * channels + channel] * (1.0 - fade)
                            + next * fade
                    }
                    None => next,
                };
                self.block.push(sample);
            }
        }
        self.previous = Some(start);
        self.position += hop as f64 * rate.clamp(0.0625, 16.0);
        // Forget input every later segment is past.
        let keep = start.min((self.position as usize).saturating_sub(search));
        if keep > 0 {
            self.input.drain(..keep * channels);
            self.real = self.real.saturating_sub(keep);
            self.position -= keep as f64;
            self.previous = Some(start - keep);
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::Stretcher;

    fn sine(frequency: f64, rate: u32, seconds: f64) -> Vec<f32> {
        (0..(f64::from(rate) * seconds) as usize)
            .map(|i| (std::f64::consts::TAU * frequency * i as f64 / f64::from(rate)).sin() as f32)
            .collect()
    }

    /// Zero crossings per second: the frequency of a sine, roughly.
    fn frequency(samples: &[f32], rate: u32) -> f64 {
        let crossings = samples
            .windows(2)
            .filter(|pair| pair[0] < 0.0 && pair[1] >= 0.0)
            .count();
        crossings as f64 * f64::from(rate) / samples.len() as f64
    }

    fn run(rate: f64) -> Vec<f32> {
        let mut stretch = Stretcher::new(1, 48_000);
        stretch.push(&sine(440.0, 48_000, 2.0));
        stretch.finish();
        let mut out = Vec::new();
        while let Some(sample) = stretch.pull(rate) {
            out.push(sample);
        }
        out
    }

    #[test]
    fn faster_and_slower_keep_the_pitch_and_scale_the_length() {
        for rate in [0.5, 1.0, 1.5, 2.0] {
            let out = run(rate);
            let seconds = out.len() as f64 / 48_000.0;
            assert!(
                (seconds - 2.0 / rate).abs() < 0.1,
                "rate {rate}: {seconds:.3} s instead of {:.3}",
                2.0 / rate
            );
            let body = &out[4_800..out.len() - 9_600];
            let hz = frequency(body, 48_000);
            assert!((hz - 440.0).abs() < 8.0, "rate {rate}: {hz:.1} Hz");
        }
    }

    #[test]
    fn interleaved_channels_stay_apart_and_it_waits_for_input() {
        let mut stretch = Stretcher::new(2, 48_000);
        let frames: Vec<f32> = (0..48_000).flat_map(|_| [0.25, -0.5]).collect();
        stretch.push(&frames);
        let mut pairs = Vec::new();
        while let (Some(left), Some(right)) = (stretch.pull(1.25), stretch.pull(1.25)) {
            pairs.push((left, right));
        }
        assert!(!pairs.is_empty());
        assert!(
            pairs[2_000..]
                .iter()
                .all(|&(l, r)| (l - 0.25).abs() < 1e-3 && (r + 0.5).abs() < 1e-3)
        );
        assert_eq!(stretch.pull(1.25), None, "no input left: it waits");
    }
}
