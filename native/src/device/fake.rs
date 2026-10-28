//! The fake device provider, selected with `TARVE_DEVICE=fake` in the app's environment (read
//! once per process, before the first device request). It replaces the platform services
//! only: the request still goes TS → protocol → here → event back, so tests and CI exercise
//! the whole path on every runtime without a share UI, a location source or a biometric
//! prompt. Every answer is deterministic:
//!
//! - `share`: shown (`supported: true`); a file that does not exist is an error, as on the
//!   real platforms.
//! - `getCurrentPosition`: `FIXES[0]`; `timeoutMs: 0` answers `code: "timeout"`.
//! - `watchPosition`: `FIXES` in order, `WATCH_INTERVAL` apart, then silence until cleared;
//!   `clear` stops it at once.
//! - In both, `accuracy` is 5 m with `highAccuracy`, else 50 m.
//! - `authenticate`: success, unless the reason contains `[fake:<code>]` with an
//!   `AuthErrorCode` (`not-enrolled`, `canceled`, `failed`, `lockout`, `busy`, `unsupported`).
use super::{authenticate_event, location_event, position_json};
use crate::protocol::requests::{Authenticate, Location, Share};
use serde_json::Value;
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// The environment variable that selects the provider: `fake`, or unset/`system` for the
/// platform's.
pub(crate) const VARIABLE: &str = "TARVE_DEVICE";

/// The fixes as `[latitude, longitude, accuracy (replaced), altitude, altitudeAccuracy,
/// heading, speed, timestamp ms]` (NaN: unknown, `null` in the event).
#[rustfmt::skip]
pub(crate) const FIXES: [[f64; 8]; 3] = [
    [-23.5505, -46.6333, 0.0, 760.0, 4.0, f64::NAN, f64::NAN, 1_700_000_000_000.0],
    [-23.5506, -46.6332, 0.0, 760.0, 4.0, 45.0, 1.5, 1_700_000_001_000.0],
    [-23.5507, -46.6331, 0.0, 761.0, 4.0, 45.0, 1.5, 1_700_000_002_000.0],
];

/// Time between a watch's fixes.
pub(crate) const WATCH_INTERVAL: Duration = Duration::from_millis(50);

const AUTH_CODES: [&str; 6] = [
    "not-enrolled",
    "canceled",
    "failed",
    "lockout",
    "busy",
    "unsupported",
];

/// The running watches; a fix is sent under this lock, so none follows `clear`.
static WATCHES: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// Whether `TARVE_DEVICE=fake` selected this provider.
pub(crate) fn enabled() -> bool {
    static FAKE: OnceLock<bool> = OnceLock::new();
    *FAKE.get_or_init(|| selected(std::env::var(VARIABLE).ok().as_deref()))
}

fn selected(value: Option<&str>) -> bool {
    match value.map(str::trim) {
        Some("fake") => true,
        None | Some("" | "system") => false,
        Some(other) => {
            eprintln!(
                "tarve: {VARIABLE}={other} is not a device provider (\"fake\" or \"system\"); using the system's"
            );
            false
        }
    }
}

fn fix(index: usize, high_accuracy: bool) -> Value {
    let mut fix = FIXES[index];
    fix[2] = if high_accuracy { 5.0 } else { 50.0 };
    position_json(&fix)
}

pub(super) fn share(request: &Share) -> Result<bool, String> {
    match request
        .files
        .iter()
        .find(|path| !std::path::Path::new(path).is_file())
    {
        Some(missing) => Err(format!("cannot share {missing}: no such file")),
        None => Ok(true),
    }
}

/// `get`, `watch` or `clear` (the action is already known to be one of them).
pub(super) fn location(request: Location, push: impl Fn(Value) + Send + 'static) {
    let id = request.request_id;
    match request.action.as_str() {
        "get" if request.timeout_ms == Some(0.0) => push(location_event(
            &id,
            false,
            None,
            Some("timeout"),
            Some("no fix within 0 ms"),
        )),
        "get" => push(location_event(
            &id,
            false,
            Some(fix(0, request.high_accuracy)),
            None,
            None,
        )),
        "watch" => {
            watches(|watches| watches.insert(id.clone()));
            let high_accuracy = request.high_accuracy;
            std::thread::spawn(move || {
                for index in 0..FIXES.len() {
                    if index > 0 {
                        std::thread::sleep(WATCH_INTERVAL);
                    }
                    let sent = watches(|watches| {
                        let running = watches.contains(&id);
                        if running {
                            push(location_event(
                                &id,
                                true,
                                Some(fix(index, high_accuracy)),
                                None,
                                None,
                            ));
                        }
                        running
                    });
                    if !sent {
                        return;
                    }
                }
                watches(|watches| watches.remove(&id));
            });
        }
        _ => {
            watches(|watches| watches.remove(&id));
        }
    }
}

fn watches<T>(f: impl FnOnce(&mut HashSet<String>) -> T) -> T {
    let mut guard = WATCHES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    f(guard.get_or_insert_with(HashSet::new))
}

pub(super) fn authenticate(request: &Authenticate) -> Value {
    let code = AUTH_CODES
        .into_iter()
        .find(|code| request.reason.contains(&format!("[fake:{code}]")));
    let error = code.map(|code| format!("fake authentication: {code}"));
    authenticate_event(&request.request_id, code.is_none(), code, error.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::mpsc;

    fn location_request(action: &str, id: &str, timeout_ms: Option<f64>) -> Location {
        Location {
            action: action.into(),
            request_id: id.into(),
            high_accuracy: true,
            timeout_ms,
            maximum_age_ms: None,
        }
    }

    fn expected_fix(index: usize) -> Value {
        let fix = FIXES[index];
        let known = |value: f64| (!value.is_nan()).then_some(value);
        json!({"latitude":fix[0], "longitude":fix[1], "accuracy":5.0, "altitude":fix[3],
            "altitudeAccuracy":fix[4], "heading":known(fix[5]), "speed":known(fix[6]),
            "timestamp":fix[7]})
    }

    fn channel() -> (
        impl Fn(Value) + Clone + Send + 'static,
        mpsc::Receiver<Value>,
    ) {
        let (sender, events) = mpsc::channel();
        let push = move |event| {
            let _ = sender.send(event);
        };
        (push, events)
    }

    #[test]
    fn selected_only_by_fake() {
        assert!(selected(Some("fake")));
        assert!(selected(Some(" fake ")));
        assert!(!selected(None));
        assert!(!selected(Some("")));
        assert!(!selected(Some("system")));
        assert!(!selected(Some("FAKE")));
    }

    #[test]
    fn get_answers_the_first_fix_or_a_timeout() {
        let (push, events) = channel();
        location(location_request("get", "g", Some(3000.0)), push.clone());
        assert_eq!(
            events.recv().unwrap(),
            json!({"type":"location", "requestId":"g", "supported":true, "position":{
                "latitude":-23.5505, "longitude":-46.6333, "accuracy":5.0, "altitude":760.0,
                "altitudeAccuracy":4.0, "heading":null, "speed":null, "timestamp":1_700_000_000_000.0}})
        );
        let mut low = location_request("get", "l", None);
        low.high_accuracy = false;
        location(low, push.clone());
        assert_eq!(events.recv().unwrap()["position"]["accuracy"], json!(50.0));
        location(location_request("get", "t", Some(0.0)), push);
        assert_eq!(
            events.recv().unwrap(),
            json!({"type":"location", "requestId":"t", "supported":true, "code":"timeout", "error":"no fix within 0 ms"})
        );
    }

    #[test]
    fn watch_sends_every_fix_in_order_then_ends() {
        let (push, events) = channel();
        location(location_request("watch", "w", None), push);
        for index in 0..FIXES.len() {
            let event = events.recv_timeout(Duration::from_secs(5)).unwrap();
            assert_eq!(
                event,
                json!({"type":"position", "watchId":"w", "supported":true, "position":expected_fix(index)})
            );
        }
        // The thread drops its sender when the fixes run out.
        assert!(events.recv_timeout(Duration::from_secs(5)).is_err());
        assert!(!watches(|watches| watches.contains("w")));
    }

    #[test]
    fn clear_stops_a_watch() {
        let (push, events) = channel();
        location(location_request("watch", "c", None), push);
        assert_eq!(
            events.recv_timeout(Duration::from_secs(5)).unwrap()["position"],
            expected_fix(0)
        );
        location(location_request("clear", "c", None), |_| {
            panic!("clear answers nothing")
        });
        // Whatever was sent before `clear` returned is queued already; nothing comes later.
        let before: Vec<Value> = events.try_iter().collect();
        assert!(before.len() < FIXES.len());
        std::thread::sleep(WATCH_INTERVAL * 4);
        assert!(events.try_recv().is_err());
    }

    #[test]
    fn authenticate_succeeds_unless_the_reason_names_a_code() {
        let request = |reason: &str| Authenticate {
            request_id: "a".into(),
            reason: reason.into(),
        };
        assert_eq!(
            authenticate(&request("Unlock")),
            json!({"type":"authenticate", "requestId":"a", "supported":true, "success":true})
        );
        assert_eq!(
            authenticate(&request("Unlock [fake:canceled]")),
            json!({"type":"authenticate", "requestId":"a", "supported":true, "success":false,
                "code":"canceled", "error":"fake authentication: canceled"})
        );
        assert_eq!(
            authenticate(&request("[fake:unsupported]"))["supported"],
            json!(false)
        );
        assert_eq!(
            authenticate(&request("[fake:nope]"))["success"],
            json!(true)
        );
    }

    #[test]
    fn share_is_shown_unless_a_file_is_missing() {
        let request = |files: Vec<String>| Share {
            request_id: "s".into(),
            title: None,
            text: Some("t".into()),
            url: None,
            files,
        };
        assert_eq!(share(&request(vec![])), Ok(true));
        let existing = concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml").to_string();
        assert_eq!(share(&request(vec![existing])), Ok(true));
        let missing = "/no/such/tarve-file".to_string();
        assert_eq!(
            share(&request(vec![missing.clone()])),
            Err(format!("cannot share {missing}: no such file"))
        );
    }
}
