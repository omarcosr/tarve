//! Platforms without a video backend yet: every `<video>` reports an error.

use super::{VideoFrame, VideoLoad, media_error};
use serde_json::Value;
use std::time::Instant;

pub(crate) struct Videos;

impl Videos {
    pub(crate) fn new(_wake: impl Fn() + Send + Sync + 'static) -> Self {
        Self
    }
    pub(crate) fn handles(&self, _id: &str) -> bool {
        false
    }
    pub(crate) fn load<Mixer>(
        &mut self,
        id: &str,
        _load: VideoLoad<'_>,
        _mixer: Option<Mixer>,
    ) -> Vec<Value> {
        vec![media_error(
            id,
            "Video playback is not supported on this platform yet",
        )]
    }
    pub(crate) fn command(
        &mut self,
        _id: &str,
        _action: &str,
        _time: Option<f64>,
        _volume: Option<f64>,
        _muted: Option<bool>,
        _looped: Option<bool>,
    ) -> Vec<Value> {
        Vec::new()
    }
    pub(crate) fn set_text_track(&mut self, _id: &str, _index: Option<u32>) -> Vec<Value> {
        Vec::new()
    }
    pub(crate) fn set_audio_track(&mut self, _id: &str, _index: u32) -> Vec<Value> {
        Vec::new()
    }
    pub(crate) fn set_rate(&mut self, _id: &str, _rate: f64) -> Vec<Value> {
        Vec::new()
    }
    pub(crate) fn tick(&mut self, _now: Instant) -> Vec<Value> {
        Vec::new()
    }
    pub(crate) fn take_frames(&mut self) -> Vec<(String, Option<VideoFrame>)> {
        Vec::new()
    }
    pub(crate) fn set_display_sizes(&mut self, _sizes: impl Fn(&str) -> Option<(u32, u32)>) {}
    pub(crate) fn set_visible(&mut self, _visible: impl Fn(&str) -> bool) {}
    pub(crate) fn take_repaint(&mut self) -> Vec<String> {
        Vec::new()
    }
    pub(crate) fn deadline(&self) -> Option<Instant> {
        None
    }
    #[cfg(target_os = "windows")]
    pub(crate) fn attach_renderer(
        &mut self,
        _device: Option<windows::Win32::Graphics::Direct3D11::ID3D11Device>,
    ) {
    }
    #[cfg(target_os = "windows")]
    pub(crate) fn view(&self, _id: &str) -> Option<crate::d3d11::VideoView> {
        None
    }
    #[cfg(target_os = "windows")]
    pub(crate) fn views(&self) -> Vec<(String, crate::d3d11::VideoView)> {
        Vec::new()
    }
}
