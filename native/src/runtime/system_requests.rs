//! Requests answered beside the tree: file dialogs (`fileDialog`), web sign-in (`webSignIn`,
//! Android), runtime permissions (`permissions`), the device services of crate::device
//! (`share`, `location`, `authenticate`) and the frame and memory statistics (`stats`).
use super::*;

impl App {
    /// Windows and Linux block in the dialog and answer here; Android opens the system
    /// document picker, which answers through the bridge's queue once the user picks.
    pub(super) fn file_dialog(
        &mut self,
        request_id: String,
        mode: &str,
        options: FileDialogOptions,
    ) {
        #[cfg(target_os = "android")]
        let result = crate::android::file_dialog::start(&request_id, mode, &options)
            .map(|()| None::<Vec<String>>);
        #[cfg(not(target_os = "android"))]
        let result = run_file_dialog(self.window.as_ref(), mode, options).map(Some);
        match result {
            Ok(Some(paths)) => self
                .events
                .push(json!({"type":"fileDialog", "requestId":request_id, "paths":paths})),
            Ok(None) => {}
            Err(message) => self.events.push(
                json!({"type":"fileDialog", "requestId":request_id, "paths":[], "error":message}),
            ),
        }
    }

    /// Android opens the sign-in page; elsewhere the request fails at once.
    pub(super) fn web_sign_in(&mut self, request: crate::protocol::requests::WebSignIn) {
        #[cfg(target_os = "android")]
        let started = crate::android::web_sign_in::start(
            &request.request_id,
            &request.url,
            &request.cookie_url,
            &request.cookies,
        );
        #[cfg(not(target_os = "android"))]
        let started: Result<(), String> = {
            let _ = (&request.url, &request.cookie_url, &request.cookies);
            Err("webSignIn is available on Android only".into())
        };
        if let Err(message) = started {
            self.events
                .push(json!({"type":"webSignIn", "requestId":request.request_id, "error":message}));
        }
    }

    /// Runtime permissions: Android asks the user (`dev.tarve.TarvePermissions`) and answers
    /// through the bridge's queue; desktops have no per-app permission prompt, so every name
    /// is granted there.
    pub(super) fn permissions(&mut self, request: crate::protocol::requests::Permissions) {
        #[cfg(target_os = "android")]
        let result = match request.action.as_str() {
            "check" => crate::android::permissions::check(&request.permissions).map(Some),
            "request" => {
                crate::android::permissions::request(&request.request_id, &request.permissions)
            }
            other => Err(format!("unknown permissions action {other}")),
        };
        #[cfg(not(target_os = "android"))]
        let result: Result<Option<serde_json::Map<String, serde_json::Value>>, String> =
            match request.action.as_str() {
                "check" | "request" => Ok(Some(
                    request
                        .permissions
                        .iter()
                        .map(|name| (name.clone(), json!("granted")))
                        .collect(),
                )),
                other => Err(format!("unknown permissions action {other}")),
            };
        match result {
            Ok(Some(results)) => self.events.push(
                json!({"type":"permissions", "requestId":request.request_id, "results":results}),
            ),
            Ok(None) => {}
            Err(message) => self.events.push(
                json!({"type":"permissions", "requestId":request.request_id, "results":{}, "error":message}),
            ),
        }
    }

    /// The system share sheet (crate::device): answered once it is shown, or with
    /// `supported: false` where the platform has none.
    pub(super) fn share(&mut self, request: crate::protocol::requests::Share) {
        let mut event = json!({"type":"share", "requestId":request.request_id, "supported":true});
        match crate::device::share(self.window.as_deref(), &request) {
            Ok(true) => {}
            Ok(false) => event["supported"] = json!(false),
            Err(message) => event["error"] = json!(message),
        }
        self.events.push(event);
    }

    /// `getCurrentPosition` / `watchPosition` (crate::device); answers arrive later.
    pub(super) fn location(&mut self, request: crate::protocol::requests::Location) {
        crate::device::location(request, self.events.clone());
    }

    /// `recognizeSpeech` (crate::device): Android SpeechRecognizer; answers arrive later.
    pub(super) fn speech(&mut self, request: crate::protocol::requests::Speech) {
        crate::device::speech(request, self.events.clone());
    }

    /// `authenticate` (crate::device): BiometricPrompt, Windows Hello; answers arrive later.
    pub(super) fn authenticate(&mut self, request: crate::protocol::requests::Authenticate) {
        crate::device::authenticate(self.window.as_deref(), request, self.events.clone());
    }

    /// Frame phase percentiles and memory by startup stage; `reset` clears the samples.
    pub(super) fn stats(&mut self, request_id: String, reset: bool) {
        self.events
            .push(json!({"type":"stats", "requestId":request_id, "stats": {
                "phases": self.frame_stats.summary(),
                "memory": self.memory_stages.summary(),
            }}));
        if reset {
            self.frame_stats.reset();
        }
    }
}
