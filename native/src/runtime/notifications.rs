//! System notifications (crate::notification): `notify` shows one now; `scheduleNotification`
//! arms or drops a timed or place notification (Android).
use super::*;
use crate::protocol::notifications::{Notify, ScheduleNotification};

impl App {
    pub(super) fn notify(&mut self, Notify { id, title, body }: Notify) {
        let app_name = self
            .document
            .app_identity
            .as_ref()
            .map(|identity| identity.name.trim())
            .filter(|name| !name.is_empty())
            .or_else(|| Some(self.document.window.title.trim()).filter(|t| !t.is_empty()))
            .unwrap_or("Tarve")
            .to_owned();
        let notification = crate::notification::Notification {
            id: id.as_deref(),
            title: &title,
            body: &body,
            app_name: &app_name,
        };
        #[cfg(target_os = "windows")]
        let result = crate::notification::show(
            &notification,
            self.document.app_identity.as_ref(),
            self.event_proxy.clone(),
        )
        .or_else(|error| match self.tray.as_mut() {
            // A toast that cannot show (no notification platform) falls back to the tray balloon.
            Some(tray) => tray.notify(&title, &body),
            None => Err(error),
        });
        #[cfg(not(target_os = "windows"))]
        let result = crate::notification::show(&notification, self.event_proxy.clone());
        if let Err(message) = result {
            self.events.push(error(message));
        }
    }

    /// Desktops keep timed notifications in the app (TS); places are Android only.
    pub(super) fn schedule_notification(&mut self, request: ScheduleNotification) {
        #[cfg(target_os = "android")]
        if let Err(message) = crate::android::notification::schedule(&request) {
            self.events.push(error(message));
        }
        #[cfg(not(target_os = "android"))]
        let _ = request;
    }
}
