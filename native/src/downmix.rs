//! Sound with more channels than a stereo or mono output, folded down as players do
//! (ITU-R BS.775: centre and surrounds at -3 dB, LFE left out). rodio's own conversion
//! keeps the first channels and drops the rest, and with them the centre, where films
//! carry the dialogue.
// Only the Windows video reader feeds it a source today; Linux audio goes through rodio.
#![cfg_attr(not(target_os = "windows"), allow(dead_code))]

use rodio::{ChannelCount, Sample, SampleRate, Source};
use std::time::Duration;

const MINUS_3DB: f32 = std::f32::consts::FRAC_1_SQRT_2;
const L: [f32; 2] = [1.0, 0.0];
const R: [f32; 2] = [0.0, 1.0];
const C: [f32; 2] = [MINUS_3DB, MINUS_3DB];
const LFE: [f32; 2] = [0.0, 0.0];
const LS: [f32; 2] = [MINUS_3DB, 0.0];
const RS: [f32; 2] = [0.0, MINUS_3DB];
const BC: [f32; 2] = [0.5, 0.5];

/// Left and right gains of each channel, in the WAVE order of the usual layout for
/// that many channels (5.1: FL FR FC LFE BL BR; 7.1: FL FR FC LFE BL BR SL SR).
fn stereo_gains(channels: u16) -> Option<&'static [[f32; 2]]> {
    Some(match channels {
        3 => &[L, R, C],
        4 => &[L, R, LS, RS],
        5 => &[L, R, C, LS, RS],
        6 => &[L, R, C, LFE, LS, RS],
        7 => &[L, R, C, LFE, BC, LS, RS],
        8 => &[L, R, C, LFE, LS, RS, LS, RS],
        _ => return None,
    })
}

/// `source` as the output takes it: folded to stereo (or mono) when it has more
/// channels than that; as it is otherwise.
pub(crate) struct Downmix<S> {
    input: S,
    gains: Option<&'static [[f32; 2]]>,
    mono: bool,
    frame: [f32; 2],
    at: usize,
}

impl<S: Source> Downmix<S> {
    pub(crate) fn new(input: S, output: ChannelCount) -> Self {
        let channels = input.channels().get();
        let gains = (output.get() <= 2 && channels > output.get())
            .then(|| stereo_gains(channels))
            .flatten();
        Self {
            input,
            gains,
            mono: output.get() == 1,
            frame: [0.0; 2],
            at: 2,
        }
    }
}

impl<S: Source> Iterator for Downmix<S> {
    type Item = Sample;
    fn next(&mut self) -> Option<Sample> {
        let Some(gains) = self.gains else {
            return self.input.next();
        };
        let width = if self.mono { 1 } else { 2 };
        if self.at >= width {
            let mut frame = [0.0f32; 2];
            for gain in gains {
                let sample = self.input.next()?;
                frame[0] += sample * gain[0];
                frame[1] += sample * gain[1];
            }
            if self.mono {
                frame[0] = (frame[0] + frame[1]) * 0.5;
            }
            self.frame = frame.map(|sample| sample.clamp(-1.0, 1.0));
            self.at = 0;
        }
        let sample = self.frame[self.at];
        self.at += 1;
        Some(sample)
    }
}

impl<S: Source> Source for Downmix<S> {
    fn current_span_len(&self) -> Option<usize> {
        None
    }
    fn channels(&self) -> ChannelCount {
        match self.gains {
            Some(_) => ChannelCount::new(if self.mono { 1 } else { 2 }).unwrap(),
            None => self.input.channels(),
        }
    }
    fn sample_rate(&self) -> SampleRate {
        self.input.sample_rate()
    }
    fn total_duration(&self) -> Option<Duration> {
        self.input.total_duration()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rodio::buffer::SamplesBuffer;

    fn fold(channels: u16, samples: Vec<f32>, output: u16) -> (u16, Vec<f32>) {
        let source = SamplesBuffer::new(
            ChannelCount::new(channels).unwrap(),
            SampleRate::new(48_000).unwrap(),
            samples,
        );
        let mix = Downmix::new(source, ChannelCount::new(output).unwrap());
        (mix.channels().get(), mix.collect())
    }

    #[test]
    fn five_one_keeps_the_centre_on_a_stereo_output() {
        // Dialogue only in the centre: it reaches both ears at -3 dB; LFE stays out.
        let (channels, out) = fold(6, vec![0.0, 0.0, 0.5, 0.9, 0.0, 0.0], 2);
        assert_eq!(channels, 2);
        assert!((out[0] - 0.5 * MINUS_3DB).abs() < 1e-6 && (out[1] - 0.5 * MINUS_3DB).abs() < 1e-6);
    }

    #[test]
    fn surrounds_fold_to_their_side_and_the_sum_is_clamped() {
        let (_, out) = fold(
            6,
            vec![0.2, 0.0, 0.0, 0.0, 0.4, 0.0, 1.0, 1.0, 1.0, 0.0, 1.0, 1.0],
            2,
        );
        assert!((out[0] - (0.2 + 0.4 * MINUS_3DB)).abs() < 1e-6);
        assert_eq!(out[1], 0.0);
        assert_eq!(&out[2..], &[1.0, 1.0]);
    }

    #[test]
    fn seven_one_and_mono_outputs_fold_too() {
        let (channels, out) = fold(8, vec![0.0, 0.0, 0.4, 0.0, 0.0, 0.0, 0.0, 0.0], 1);
        assert_eq!(channels, 1);
        assert_eq!(out.len(), 1);
        assert!((out[0] - 0.4 * MINUS_3DB).abs() < 1e-6);
    }

    #[test]
    fn an_output_with_room_gets_the_channels_as_they_are() {
        let (channels, out) = fold(6, (0..6).map(|i| i as f32 / 10.0).collect(), 6);
        assert_eq!(channels, 6);
        assert_eq!(out.len(), 6);
        let (channels, out) = fold(2, vec![0.1, 0.2], 2);
        assert_eq!((channels, out), (2, vec![0.1, 0.2]));
    }
}
