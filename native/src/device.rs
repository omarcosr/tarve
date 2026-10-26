//! Device services with one shape on every platform: the share sheet (`share`), location
//! (`location`/`position`) and the biometric check (`authenticate`). Android answers through
//! `android/device.rs` (Java in packages/core/android/java), Windows through WinRT (DataTransfer
//! share UI, `Geolocator`, Windows Hello). Elsewhere each request answers `supported: false`.
use crate::protocol::requests::{Authenticate, Location, Share};
use crate::runtime::EventSink;
use serde_json::{Value, json};
use winit::window::Window;

/// A `location` (get) or `position` (watch) answer. `supported` is false only for "unsupported".
pub(crate) fn location_event(
    id: &str,
    watch: bool,
    position: Option<Value>,
    code: Option<&str>,
    error: Option<&str>,
) -> Value {
    let mut event = if watch {
        json!({"type":"position", "watchId":id})
    } else {
        json!({"type":"location", "requestId":id})
    };
    event["supported"] = json!(code != Some("unsupported"));
    if let Some(position) = position {
        event["position"] = position;
    }
    if let Some(code) = code {
        event["code"] = json!(code);
    }
    if let Some(error) = error {
        event["error"] = json!(error);
    }
    event
}

/// A fix as `GeoPosition`: `[latitude, longitude, accuracy, altitude, altitudeAccuracy,
/// heading, speed, timestamp ms]`, NaN where the source does not know.
#[cfg_attr(
    not(any(target_os = "android", target_os = "windows")),
    allow(dead_code)
)]
pub(crate) fn position_json(fix: &[f64; 8]) -> Value {
    let known = |value: f64| {
        if value.is_finite() {
            json!(value)
        } else {
            Value::Null
        }
    };
    json!({
        "latitude": fix[0], "longitude": fix[1], "accuracy": known(fix[2]).as_f64().unwrap_or(0.0),
        "altitude": known(fix[3]), "altitudeAccuracy": known(fix[4]), "heading": known(fix[5]),
        "speed": known(fix[6]), "timestamp": known(fix[7]).as_f64().unwrap_or(0.0),
    })
}

/// An `authenticate` answer. `supported` is false only for "unsupported".
pub(crate) fn authenticate_event(
    id: &str,
    success: bool,
    code: Option<&str>,
    error: Option<&str>,
) -> Value {
    let mut event = json!({"type":"authenticate", "requestId":id, "success":success,
        "supported": code != Some("unsupported")});
    if let Some(code) = code {
        event["code"] = json!(code);
    }
    if let Some(error) = error {
        event["error"] = json!(error);
    }
    event
}

/// Shows the share sheet. Ok(false) where the platform has none.
pub(crate) fn share(window: Option<&Window>, request: &Share) -> Result<bool, String> {
    if request.text.is_none() && request.url.is_none() && request.files.is_empty() {
        return Err("share needs text, a url or files".into());
    }
    #[cfg(target_os = "android")]
    {
        let _ = window;
        crate::android::device::share(request).map(|()| true)
    }
    #[cfg(target_os = "windows")]
    {
        windows_impl::share(window, request).map(|()| true)
    }
    #[cfg(not(any(target_os = "android", target_os = "windows")))]
    {
        let _ = (window, request);
        Ok(false)
    }
}

/// Starts a location request; every answer goes to `events` (now or from another thread).
pub(crate) fn location(request: Location, events: EventSink) {
    let watch = request.action == "watch";
    if !matches!(request.action.as_str(), "get" | "watch" | "clear") {
        events.push(location_event(
            &request.request_id,
            false,
            None,
            Some("unavailable"),
            Some(&format!("unknown location action {}", request.action)),
        ));
        return;
    }
    #[cfg(target_os = "android")]
    if let Err(message) = crate::android::device::location(&request)
        && request.action != "clear"
    {
        events.push(location_event(
            &request.request_id,
            watch,
            None,
            Some("unavailable"),
            Some(&message),
        ));
    }
    #[cfg(target_os = "windows")]
    windows_impl::location(request, events);
    #[cfg(not(any(target_os = "android", target_os = "windows")))]
    if request.action != "clear" {
        events.push(location_event(
            &request.request_id,
            watch,
            None,
            Some("unsupported"),
            Some("location is not available on this platform"),
        ));
    }
    #[cfg(target_os = "windows")]
    let _ = watch;
}

/// Starts a biometric check; the answer goes to `events`.
pub(crate) fn authenticate(window: Option<&Window>, request: Authenticate, events: EventSink) {
    #[cfg(target_os = "android")]
    {
        let _ = window;
        if let Err(message) = crate::android::device::authenticate(&request) {
            events.push(authenticate_event(
                &request.request_id,
                false,
                Some("failed"),
                Some(&message),
            ));
        }
    }
    #[cfg(target_os = "windows")]
    windows_impl::authenticate(window, request, events);
    #[cfg(not(any(target_os = "android", target_os = "windows")))]
    {
        let _ = window;
        events.push(authenticate_event(
            &request.request_id,
            false,
            Some("unsupported"),
            Some("biometric authentication is not available on this platform"),
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::Command;

    #[test]
    fn device_commands_parse() {
        let share: Command = serde_json::from_value(
            json!({"type":"share", "requestId":"r", "text":"t", "files":["/a"]}),
        )
        .unwrap();
        assert!(
            matches!(share, Command::Share(Share { ref text, ref files, .. }) if text.as_deref() == Some("t") && files == &["/a"])
        );
        let location: Command = serde_json::from_value(json!({"type":"location", "action":"get", "requestId":"r", "highAccuracy":true, "timeoutMs":500})).unwrap();
        assert!(matches!(
            location,
            Command::Location(Location {
                high_accuracy: true,
                timeout_ms: Some(500.0),
                maximum_age_ms: None,
                ..
            })
        ));
        let authenticate: Command =
            serde_json::from_value(json!({"type":"authenticate", "requestId":"r", "reason":"why"}))
                .unwrap();
        assert!(
            matches!(authenticate, Command::Authenticate(Authenticate { ref reason, .. }) if reason == "why")
        );
    }

    #[test]
    fn answers_have_one_shape() {
        assert_eq!(
            location_event("w", true, None, Some("unsupported"), None),
            json!({"type":"position", "watchId":"w", "supported":false, "code":"unsupported"})
        );
        let fix = position_json(&[1.0, 2.0, 3.0, f64::NAN, f64::NAN, 90.0, f64::NAN, 5.0]);
        assert_eq!(
            location_event("r", false, Some(fix), None, None),
            json!({"type":"location", "requestId":"r", "supported":true, "position":{
                "latitude":1.0, "longitude":2.0, "accuracy":3.0, "altitude":null, "altitudeAccuracy":null,
                "heading":90.0, "speed":null, "timestamp":5.0}})
        );
        assert_eq!(
            authenticate_event("r", false, Some("canceled"), Some("no")),
            json!({"type":"authenticate", "requestId":"r", "supported":true, "success":false, "code":"canceled", "error":"no"})
        );
        assert_eq!(
            share(
                None,
                &Share {
                    request_id: "r".into(),
                    title: None,
                    text: None,
                    url: None,
                    files: vec![]
                }
            ),
            Err("share needs text, a url or files".into())
        );
    }
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::{EventSink, authenticate_event, location_event, position_json};
    use crate::protocol::requests::{Authenticate, Location, Share};
    use std::collections::HashMap;
    use std::sync::Mutex;
    use windows::ApplicationModel::DataTransfer::{DataRequestedEventArgs, DataTransferManager};
    use windows::Devices::Geolocation::{
        GeolocationAccessStatus, Geolocator, Geoposition, PositionAccuracy,
        PositionChangedEventArgs,
    };
    use windows::Foundation::{TimeSpan, TypedEventHandler, Uri};
    use windows::Security::Credentials::UI::{UserConsentVerificationResult, UserConsentVerifier};
    use windows::Storage::{IStorageItem, StorageFile};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::WinRT::IUserConsentVerifierInterop;
    use windows::Win32::UI::Shell::IDataTransferManagerInterop;
    use windows::core::{AgileReference, HSTRING, Interface, factory};
    use windows_collections::IIterable;
    use windows_future::IAsyncOperation;
    use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use winit::window::Window;

    fn hwnd(window: Option<&Window>) -> Result<HWND, String> {
        let window = window.ok_or("the window is not open")?;
        let handle = window.window_handle().map_err(|error| error.to_string())?;
        match handle.as_raw() {
            RawWindowHandle::Win32(handle) => Ok(HWND(handle.hwnd.get() as *mut _)),
            _ => Err("not a Win32 window".into()),
        }
    }

    thread_local! {
        /// The share UI asks for its data after ShowShareUIForWindow returns: the handler of the
        /// last share stays registered until the next one replaces it.
        static SHARING: std::cell::RefCell<Option<(DataTransferManager, i64)>> =
            const { std::cell::RefCell::new(None) };
    }

    /// The Windows share UI (DataTransferManager through IDataTransferManagerInterop).
    pub(super) fn share(window: Option<&Window>, request: &Share) -> Result<(), String> {
        let hwnd = hwnd(window)?;
        let title = request
            .title
            .clone()
            .or_else(|| request.text.clone())
            .or_else(|| request.url.clone())
            .unwrap_or_else(|| "Share".into());
        let text = request.text.clone();
        let url = request.url.clone();
        let shown = (|| -> windows::core::Result<()> {
            let mut items: Vec<Option<IStorageItem>> = Vec::new();
            for path in &request.files {
                let file =
                    StorageFile::GetFileFromPathAsync(&HSTRING::from(path.as_str()))?.get()?;
                items.push(Some(file.cast::<IStorageItem>()?));
            }
            // The handler may run on another thread: the items cross it as an agile reference.
            let items = if items.is_empty() {
                None
            } else {
                Some(AgileReference::new(&IIterable::<IStorageItem>::from(
                    items,
                ))?)
            };
            let interop = factory::<DataTransferManager, IDataTransferManagerInterop>()?;
            let manager: DataTransferManager = unsafe { interop.GetForWindow(hwnd) }?;
            SHARING.with(|sharing| {
                if let Some((previous, token)) = sharing.borrow_mut().take() {
                    let _ = previous.RemoveDataRequested(token);
                }
            });

            let handler = TypedEventHandler::<DataTransferManager, DataRequestedEventArgs>::new(
                move |_, args| {
                    let Some(args) = args.as_ref() else {
                        return Ok(());
                    };
                    let data = args.Request()?.Data()?;
                    data.Properties()?
                        .SetTitle(&HSTRING::from(title.as_str()))?;
                    let mut body = text.clone().unwrap_or_default();
                    if let Some(url) = &url {
                        match Uri::CreateUri(&HSTRING::from(url.as_str())) {
                            Ok(uri) if url.contains("://") && !url.starts_with("file:") => {
                                data.SetWebLink(&uri)?;
                            }
                            _ => {}
                        }
                        if !body.contains(url.as_str()) {
                            if !body.is_empty() {
                                body.push('\n');
                            }
                            body.push_str(url);
                        }
                    }
                    if !body.is_empty() {
                        data.SetText(&HSTRING::from(body))?;
                    }
                    if let Some(items) = &items {
                        data.SetStorageItemsReadOnly(&items.resolve()?)?;
                    }
                    Ok(())
                },
            );
            let token = manager.DataRequested(&handler)?;
            SHARING.with(|sharing| *sharing.borrow_mut() = Some((manager, token)));
            unsafe { interop.ShowShareUIForWindow(hwnd) }?;
            Ok(())
        })();
        shown.map_err(|error| format!("Could not open the share UI: {}", error.message()))
    }

    /// Watches by request id, stopped by `clear`.
    static WATCHES: Mutex<Option<HashMap<String, (Geolocator, i64)>>> = Mutex::new(None);

    const E_ACCESSDENIED: i32 = 0x8007_0005_u32 as i32;
    const ERROR_TIMEOUT: i32 = 0x8007_05B4_u32 as i32;

    fn failure(error: &windows::core::Error) -> &'static str {
        match error.code().0 {
            E_ACCESSDENIED => "denied",
            ERROR_TIMEOUT => "timeout",
            _ => "unavailable",
        }
    }

    fn fix(position: &Geoposition) -> windows::core::Result<serde_json::Value> {
        let coordinate = position.Coordinate()?;
        let point = coordinate.Point()?.Position()?;
        let optional = |value: windows::core::Result<windows::Foundation::IReference<f64>>| {
            value.and_then(|value| value.Value()).unwrap_or(f64::NAN)
        };
        // DateTime counts 100 ns ticks from 1601; the timestamp is ms from 1970.
        let time = coordinate
            .Timestamp()
            .map(|time| (time.UniversalTime - 116_444_736_000_000_000) as f64 / 10_000.0)
            .unwrap_or(f64::NAN);
        Ok(position_json(&[
            point.Latitude,
            point.Longitude,
            coordinate.Accuracy()?,
            point.Altitude,
            optional(coordinate.AltitudeAccuracy()),
            optional(coordinate.Heading()),
            optional(coordinate.Speed()),
            time,
        ]))
    }

    /// Location access for the app: Settings > Privacy > Location must allow desktop apps.
    fn allowed() -> bool {
        // RequestAccessAsync fails in some unpackaged processes: then try the fix itself.
        Geolocator::RequestAccessAsync()
            .and_then(|operation| operation.get())
            .map(|status| status == GeolocationAccessStatus::Allowed)
            .unwrap_or(true)
    }

    fn locator(high_accuracy: bool) -> windows::core::Result<Geolocator> {
        let locator = Geolocator::new()?;
        locator.SetDesiredAccuracy(if high_accuracy {
            PositionAccuracy::High
        } else {
            PositionAccuracy::Default
        })?;
        Ok(locator)
    }

    pub(super) fn location(request: Location, events: EventSink) {
        let id = request.request_id.clone();
        if request.action == "clear" {
            let removed = WATCHES
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .as_mut()
                .and_then(|watches| watches.remove(&id));
            if let Some((locator, token)) = removed {
                let _ = locator.RemovePositionChanged(token);
            }
            return;
        }
        let watch = request.action == "watch";
        let spawned = std::thread::Builder::new()
            .name("tarve-location".into())
            .spawn(move || {
                if !allowed() {
                    events.push(location_event(
                        &id,
                        watch,
                        None,
                        Some("denied"),
                        Some("location access is off for this app (Settings > Privacy > Location)"),
                    ));
                    return;
                }
                if watch {
                    let sink = events.clone();
                    let watch_id = id.clone();
                    let started = (|| -> windows::core::Result<()> {
                        let locator = locator(request.high_accuracy)?;
                        locator.SetReportInterval(1000)?;
                        let handler =
                            TypedEventHandler::<Geolocator, PositionChangedEventArgs>::new(
                                move |_, args| {
                                    if let Some(args) = args.as_ref() {
                                        let event = match fix(&args.Position()?) {
                                            Ok(position) => location_event(
                                                &watch_id,
                                                true,
                                                Some(position),
                                                None,
                                                None,
                                            ),
                                            Err(error) => location_event(
                                                &watch_id,
                                                true,
                                                None,
                                                Some(failure(&error)),
                                                Some(&error.message()),
                                            ),
                                        };
                                        sink.push(event);
                                    }
                                    Ok(())
                                },
                            );
                        let token = locator.PositionChanged(&handler)?;
                        WATCHES
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .get_or_insert_with(HashMap::new)
                            .insert(id.clone(), (locator, token));
                        Ok(())
                    })();
                    if let Err(error) = started {
                        events.push(location_event(
                            &id,
                            true,
                            None,
                            Some(failure(&error)),
                            Some(&error.message()),
                        ));
                    }
                    return;
                }
                let span = |ms: Option<f64>, default: f64| TimeSpan {
                    Duration: (ms.unwrap_or(default).clamp(0.0, 600_000.0) * 10_000.0) as i64,
                };
                let result = locator(request.high_accuracy).and_then(|locator| {
                    locator
                        .GetGeopositionAsyncWithAgeAndTimeout(
                            span(request.maximum_age_ms, 0.0),
                            span(request.timeout_ms, 30_000.0),
                        )?
                        .get()
                });
                events.push(match result.and_then(|position| fix(&position)) {
                    Ok(position) => location_event(&id, false, Some(position), None, None),
                    Err(error) => location_event(
                        &id,
                        false,
                        None,
                        Some(failure(&error)),
                        Some(&error.message()),
                    ),
                });
            });
        if let Err(error) = spawned {
            log_spawn_failure(&error);
        }
    }

    fn log_spawn_failure(error: &std::io::Error) {
        eprintln!("tarve: could not start a device request thread: {error}");
    }

    /// Windows Hello (UserConsentVerifier) over the app's window.
    pub(super) fn authenticate(window: Option<&Window>, request: Authenticate, events: EventSink) {
        let id = request.request_id;
        let started = hwnd(window).and_then(|hwnd| {
            let interop = factory::<UserConsentVerifier, IUserConsentVerifierInterop>()
                .map_err(|error| error.message())?;
            let operation: IAsyncOperation<UserConsentVerificationResult> = unsafe {
                interop.RequestVerificationForWindowAsync(
                    hwnd,
                    &HSTRING::from(request.reason.as_str()),
                )
            }
            .map_err(|error| error.message())?;
            Ok(operation)
        });
        let operation = match started {
            Ok(operation) => operation,
            Err(message) => {
                events.push(authenticate_event(
                    &id,
                    false,
                    Some("unsupported"),
                    Some(&message),
                ));
                return;
            }
        };
        let spawned = std::thread::Builder::new()
            .name("tarve-hello".into())
            .spawn(move || {
                let event = match operation.get() {
                    Ok(UserConsentVerificationResult::Verified) => {
                        authenticate_event(&id, true, None, None)
                    }
                    Ok(result) => {
                        let (code, message) = match result {
                            UserConsentVerificationResult::DeviceNotPresent => {
                                ("unsupported", "no Windows Hello device")
                            }
                            UserConsentVerificationResult::DisabledByPolicy => {
                                ("unsupported", "Windows Hello is disabled by policy")
                            }
                            UserConsentVerificationResult::NotConfiguredForUser => {
                                ("not-enrolled", "Windows Hello is not set up")
                            }
                            UserConsentVerificationResult::DeviceBusy => {
                                ("busy", "the device is busy")
                            }
                            UserConsentVerificationResult::RetriesExhausted => {
                                ("lockout", "too many attempts")
                            }
                            UserConsentVerificationResult::Canceled => ("canceled", "canceled"),
                            _ => ("failed", "verification failed"),
                        };
                        authenticate_event(&id, false, Some(code), Some(message))
                    }
                    Err(error) => {
                        authenticate_event(&id, false, Some("failed"), Some(&error.message()))
                    }
                };
                events.push(event);
            });
        if let Err(error) = spawned {
            log_spawn_failure(&error);
        }
    }
}
