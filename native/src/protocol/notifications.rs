//! System notifications: `notify` shows one now; `scheduleNotification` arms (Android) one
//! for a time or a place. Neither is answered.
use serde::Deserialize;

/// `notify({ title, body })`: a notification shown now.
#[derive(Debug, Deserialize)]
pub struct Notify {
    /// Echoed by the `notificationClick` it raises.
    #[serde(default)]
    pub id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub body: String,
}

/// `notify({ at | place })` on Android: `set` arms a notification that fires at an epoch time
/// (`at`, ms) or on entering or leaving a circle (`place`), with the app closed too; `cancel`
/// drops it. Nothing answers.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub struct ScheduleNotification {
    pub action: String,
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub at: Option<f64>,
    #[serde(default)]
    pub place: Option<NotificationPlace>,
}

/// A circle a notification waits for.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub struct NotificationPlace {
    pub latitude: f64,
    pub longitude: f64,
    pub radius: f64,
    /// Fire on leaving instead of entering.
    #[serde(default)]
    pub leave: bool,
}

#[cfg(test)]
mod tests {
    use crate::protocol::Command;
    use serde_json::json;

    #[test]
    fn schedule_notification_commands_deserialize() {
        let command: Command = serde_json::from_value(json!({
            "type":"scheduleNotification", "action":"set", "id":"home", "title":"Chegou",
            "place":{"latitude":-23.5, "longitude":-46.6, "radius":200}
        }))
        .unwrap();
        let Command::ScheduleNotification(request) = command else {
            panic!("not a scheduleNotification");
        };
        assert_eq!(
            (request.action.as_str(), request.id.as_str()),
            ("set", "home")
        );
        let place = request.place.unwrap();
        assert_eq!((place.radius, place.leave), (200.0, false));
        assert!(request.at.is_none() && request.body.is_empty());
        let cancel: Command = serde_json::from_value(
            json!({"type":"scheduleNotification", "action":"cancel", "id":"home"}),
        )
        .unwrap();
        assert!(
            matches!(cancel, Command::ScheduleNotification(request) if request.action == "cancel")
        );
    }

    #[test]
    fn notify_commands_deserialize() {
        let command: Command =
            serde_json::from_value(json!({"type":"notify", "title":"Oi"})).unwrap();
        let Command::Notify(request) = command else {
            panic!("not a notify");
        };
        assert_eq!((request.id, request.title.as_str()), (None, "Oi"));
        assert!(request.body.is_empty());
    }
}
