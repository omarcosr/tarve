//! `<audio>` in a library built without the native "media" feature (rodio):
//! a load reports an error event, as a browser does for an unsupported source.
use serde_json::{Value, json};
use std::time::Instant;

const UNAVAILABLE: &str = "audio playback needs the native \"media\" feature";

/// "<reason> (<source>)", the same shape the full media module reports.
pub(crate) fn failure(src: &str, reason: impl std::fmt::Display) -> String {
    let source = src.split_once("://").map_or(src, |(_, rest)| {
        rest.split(['/', '?', '#']).next().unwrap_or(rest)
    });
    let reason = reason.to_string();
    if reason.ends_with(&format!(" ({source})")) {
        return reason;
    }
    format!("{reason} ({source})")
}

#[derive(Default)]
pub struct Media;

impl Media {
    #[cfg(target_os = "windows")]
    pub(crate) fn output_mixer(&mut self) -> Result<(), String> {
        Err(UNAVAILABLE.to_string())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn command(
        &mut self,
        id: &str,
        action: &str,
        src: Option<&str>,
        _time: Option<f64>,
        _volume: Option<f64>,
        _muted: Option<bool>,
        _looped: Option<bool>,
    ) -> Vec<Value> {
        match src.filter(|src| action == "load" && !src.is_empty()) {
            Some(src) => vec![
                json!({"type":"media", "id":id, "event":"error", "message":failure(src, UNAVAILABLE)}),
            ],
            None => Vec::new(),
        }
    }

    pub fn deadline(&self) -> Option<Instant> {
        None
    }

    pub(crate) fn playing(&self) -> Vec<String> {
        Vec::new()
    }

    pub fn tick(&mut self, _now: Instant) -> Vec<Value> {
        Vec::new()
    }
}
