//! The `error` events the native side sends to the app.
use serde_json::{Value, json};

/// An error the app reports; whether it is fatal is left to where it happens (before `ready` it fails it).
pub fn error(message: impl ToString) -> Value {
    json!({"type":"error", "message": message.to_string()})
}

/// An error that ended the window (or the app, for the main window); `closed` follows.
pub fn fatal_error(message: impl ToString) -> Value {
    json!({"type":"error", "message": message.to_string(), "fatal": true})
}

/// An error that leaves the app usable (window finish such as rounded corners or the
/// border colour): reported, but it does not fail `ready`.
pub fn nonfatal_error(message: impl ToString) -> Value {
    json!({"type":"error", "message": message.to_string(), "fatal": false})
}
