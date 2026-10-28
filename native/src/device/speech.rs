//! Dictation (`recognizeSpeech`): Android answers through `android/device.rs`
//! (SpeechRecognizer); elsewhere `start` answers `supported: false`.
use super::fake;
use crate::protocol::requests::Speech;
use crate::runtime::EventSink;
use serde_json::{Value, json};

/// A `speech` event of a dictation session: `phase` is "ready", "partial" (`text`), "level"
/// (`level`, 0..1), "end" (the speaker stopped) or "result" (the last one: `text`, or `code`).
pub(crate) fn speech_event(
    session: &str,
    phase: &str,
    text: Option<&str>,
    level: Option<f64>,
    code: Option<&str>,
    error: Option<&str>,
) -> Value {
    let mut event = json!({"type":"speech", "sessionId":session, "phase":phase});
    if phase == "result" {
        event["supported"] = json!(code != Some("unsupported"));
    }
    if let Some(text) = text {
        event["text"] = json!(text);
    }
    if let Some(level) = level {
        event["level"] = json!(level.clamp(0.0, 1.0));
    }
    if let Some(code) = code {
        event["code"] = json!(code);
    }
    if let Some(error) = error {
        event["error"] = json!(error);
    }
    event
}

/// Starts, stops or cancels a dictation session; every answer goes to `events`.
pub(crate) fn speech(request: Speech, events: EventSink) {
    if !matches!(request.action.as_str(), "start" | "stop" | "cancel") {
        events.push(speech_event(
            &request.session_id,
            "result",
            None,
            None,
            Some("unavailable"),
            Some(&format!("unknown speech action {}", request.action)),
        ));
        return;
    }
    if fake::enabled() {
        return fake::speech(request, move |event| events.push(event));
    }
    #[cfg(target_os = "android")]
    if let Err(message) = crate::android::device::speech(&request)
        && request.action == "start"
    {
        events.push(speech_event(
            &request.session_id,
            "result",
            None,
            None,
            Some("unavailable"),
            Some(&message),
        ));
    }
    #[cfg(not(target_os = "android"))]
    if request.action == "start" {
        events.push(speech_event(
            &request.session_id,
            "result",
            None,
            None,
            Some("unsupported"),
            Some("speech recognition is not available on this platform"),
        ));
    }
}
