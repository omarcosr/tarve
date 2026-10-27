//! Text subtitles inside a local video file (Matroska SRT/ASS/WebVTT, MP4 tx3g/wvtt):
//! read once on a thread of their own, the cue under the current time reported by the
//! event loop. Picture subtitles (PGS, VobSub) are not read.

use super::text_cues::{Cue, TextTrack, cue_text_at};
use super::windows_stream::streamable;
use crate::media::remote::{Reader, Stream, is_remote};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};

#[derive(Default)]
struct State {
    /// `None` until the file was opened and its streams looked at.
    tracks: Option<Vec<TextTrack>>,
    /// Cues read so far, per stream.
    cues: HashMap<u32, Vec<Cue>>,
    selected: Option<u32>,
    /// Bumped by `select`: the reader starts over on the new stream.
    generation: u64,
}

struct Shared {
    state: Mutex<State>,
    changed: Condvar,
    /// Playback time (f64 bits): the reader keeps `LOOKAHEAD` ahead of it.
    time: AtomicU64,
    stop: AtomicBool,
    wake: Arc<dyn Fn() + Send + Sync>,
}

impl Shared {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }
}

pub(super) struct Subtitles {
    shared: Arc<Shared>,
    reported_tracks: bool,
    shown: String,
}

impl Drop for Subtitles {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::Relaxed);
        self.shared.changed.notify_all();
    }
}

impl Subtitles {
    pub(super) fn spawn(src: &str, wake: Arc<dyn Fn() + Send + Sync>) -> Self {
        // A path as the file system knows it (`source_url` makes local paths file:// URLs).
        let url = src.to_string();
        let shared = Arc::new(Shared {
            state: Mutex::new(State::default()),
            changed: Condvar::new(),
            time: AtomicU64::new(0.0f64.to_bits()),
            stop: AtomicBool::new(false),
            wake,
        });
        let (thread, remote) = (shared.clone(), is_remote(src) && streamable(src));
        let spawned = std::thread::Builder::new()
            .name("tarve-video-subtitles".into())
            .spawn(move || run(&thread, &url, remote));
        if spawned.is_err() {
            shared.lock().tracks = Some(Vec::new());
        }
        Self {
            shared,
            reported_tracks: false,
            shown: String::new(),
        }
    }

    pub(super) fn select(&mut self, index: Option<u32>) -> Result<(), String> {
        let mut state = self.shared.lock();
        if let Some(index) = index
            && !state
                .tracks
                .as_ref()
                .is_some_and(|tracks| tracks.iter().any(|track| track.index == index))
        {
            return Err(format!("no text track {index}"));
        }
        state.selected = index;
        state.generation += 1;
        if let Some(tracks) = state.tracks.as_mut() {
            for track in tracks {
                track.enabled = Some(track.index) == index;
            }
        }
        drop(state);
        self.reported_tracks = false;
        self.shared.changed.notify_all();
        Ok(())
    }

    /// Events for this frame: `texttracks` (`textTracks`) once known or changed, and
    /// `cuechange` (`cueText`) when the cue under `time` changes.
    pub(super) fn tick(&mut self, time: f64) -> Vec<(&'static str, &'static str, Value)> {
        self.shared.time.store(time.to_bits(), Ordering::Relaxed);
        let state = self.shared.lock();
        let mut out = Vec::new();
        if !self.reported_tracks
            && let Some(tracks) = &state.tracks
        {
            self.reported_tracks = true;
            if !tracks.is_empty() || state.selected.is_some() {
                out.push(("texttracks", "textTracks", TextTrack::json(tracks)));
            }
        }
        let text = state
            .selected
            .and_then(|index| state.cues.get(&index))
            .map(|cues| cue_text_at(cues, time))
            .unwrap_or_default();
        if text != self.shown {
            self.shown = text.clone();
            out.push(("cuechange", "cueText", Value::String(text)));
        }
        out
    }
}

fn run(shared: &Arc<Shared>, url: &str, remote: bool) {
    // Media Foundation's sources do not expose subtitle streams: the container is read here.
    // Remote: MP4 reads only its index and the subtitle samples through ranges; a
    // Matroska file interleaves them over the whole file, so it is not downloaded for them.
    let found = if remote {
        Stream::open_windowed(url, 4)
            .ok()
            .and_then(|stream| super::embedded_subtitles::read(Reader::new(stream), false))
    } else {
        std::fs::File::open(url)
            .ok()
            .and_then(|file| super::embedded_subtitles::read(std::io::BufReader::new(file), true))
    };
    let mut state = shared.lock();
    match found {
        Some((tracks, cues)) => {
            state.tracks = Some(tracks);
            state.cues = cues;
        }
        None => state.tracks = Some(Vec::new()),
    }
    drop(state);
    (shared.wake)();
}
