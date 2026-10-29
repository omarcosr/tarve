//! Commands the runtime answers with an event carrying the same `requestId`.
use serde::Deserialize;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDialogFilter {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub extensions: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDialogOptions {
    pub title: Option<String>,
    pub directory: Option<String>,
    pub file_name: Option<String>,
    #[serde(default)]
    pub filters: Vec<FileDialogFilter>,
}

/// A native open or save dialog; answered by a `fileDialog` event.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDialog {
    pub mode: String,
    #[serde(default)]
    pub options: FileDialogOptions,
    pub request_id: String,
}

/// `app.checkPermissions` (`action: "check"`) and `app.requestPermissions` (`"request"`);
/// answered by a `permissions` event mapping each name to "granted", "prompt" or "denied".
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    pub action: String,
    pub permissions: Vec<String>,
    pub request_id: String,
}

/// `share(...)`: the system share sheet; answered by a `share` event once it is shown
/// (`supported: false` where the platform has none).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(target_os = "linux", allow(dead_code))]
pub struct Share {
    pub request_id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub files: Vec<String>,
}

/// `getCurrentPosition` (`action: "get"`, one `location` event), `watchPosition` (`"watch"`,
/// `position` events whose `watchId` is `request_id`) and its stop (`"clear"`, no answer).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(target_os = "linux", allow(dead_code))]
pub struct Location {
    pub action: String,
    pub request_id: String,
    #[serde(default)]
    pub high_accuracy: bool,
    #[serde(default)]
    pub timeout_ms: Option<f64>,
    #[serde(default)]
    pub maximum_age_ms: Option<f64>,
}

/// `authenticate({ reason })`: a biometric (or device credential) check; answered by an
/// `authenticate` event.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(target_os = "linux", allow(dead_code))]
pub struct Authenticate {
    pub request_id: String,
    pub reason: String,
}

/// Android: a sign-in page in the system WebView; answered by a `webSignIn` event.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSignIn {
    pub url: String,
    pub cookie_url: String,
    pub cookies: Vec<String>,
    pub request_id: String,
}
