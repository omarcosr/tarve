//! Other apps' media sessions (Windows `GlobalSystemMediaTransportControlsSessionManager`):
//! what each one plays and its play/pause/next/previous controls. Elsewhere there are none.
//! Reached from JavaScript through `tarve_media_sessions` / `tarve_media_session_control`
//! (bridge/entry_points.rs) as `systemMediaSessions()` / `controlSystemMediaSession()`.
use serde::Serialize;

/// One app's media session, as `ExternalMediaSession` in packages/core/src/media-sessions.ts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExternalMediaSession {
    pub app_id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artist: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album: Option<String>,
    /// The thumbnail's bytes (PNG or JPEG as the app published it), base64.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artwork: Option<String>,
    pub playing: bool,
    /// Seconds from the start of the track.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<f64>,
    /// Seconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    /// The session Windows routes media keys to.
    pub current: bool,
}

/// What `controlSystemMediaSession` asks of a session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MediaAction {
    Play,
    Pause,
    Toggle,
    Next,
    Previous,
}

impl MediaAction {
    /// The FFI's action code: 0 play, 1 pause, 2 toggle, 3 next, 4 previous.
    pub(crate) fn from_code(code: u32) -> Option<Self> {
        Some(match code {
            0 => Self::Play,
            1 => Self::Pause,
            2 => Self::Toggle,
            3 => Self::Next,
            4 => Self::Previous,
            _ => return None,
        })
    }
}

/// The largest thumbnail read; a bigger one is left out.
#[cfg(target_os = "windows")]
const MAX_ARTWORK_BYTES: u64 = 8 * 1024 * 1024;

/// Every app's media session, the current one marked. Empty off Windows.
pub(crate) fn sessions() -> Result<Vec<ExternalMediaSession>, String> {
    #[cfg(target_os = "windows")]
    return in_apartment(windows_impl::sessions);
    #[cfg(not(target_os = "windows"))]
    Ok(Vec::new())
}

/// The session list as JSON: while watched ([`watch`]), the list the last change left, read
/// without asking Windows again; otherwise a fresh read.
pub(crate) fn sessions_json() -> Result<Vec<u8>, String> {
    #[cfg(target_os = "windows")]
    if let Some(snapshot) = watcher::snapshot() {
        return Ok(snapshot);
    }
    serde_json::to_vec(&sessions()?).map_err(|error| error.to_string())
}

/// Starts following every session's changes (sessions coming and going, the current one, what
/// plays, play state, timeline) on a thread of its own, keeping the list up to date; each change
/// calls `callback` (a C function taking the list's version, u64: a threadsafe callback). Already
/// watching: only the callback changes. Windows only.
pub(crate) fn watch(callback: u64) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    return watcher::start(callback);
    #[cfg(not(target_os = "windows"))]
    {
        let _ = callback;
        Err("media sessions can only be watched on Windows".into())
    }
}

/// Stops [`watch`]: unsubscribes, ends its thread and drops the kept list.
pub(crate) fn unwatch() {
    #[cfg(target_os = "windows")]
    watcher::stop();
}

/// Runs `action` on the first session of `app_id`: whether the app accepted it (false when no
/// session has that id, and always off Windows).
#[cfg(target_os = "windows")]
pub(crate) fn control(app_id: &str, action: MediaAction) -> Result<bool, String> {
    let app_id = app_id.to_owned();
    in_apartment(move || windows_impl::control(&app_id, action))
}

/// No media sessions to control off Windows.
#[cfg(not(target_os = "windows"))]
pub(crate) fn control(_: &str, _: MediaAction) -> Result<bool, String> {
    Ok(false)
}

/// Runs `work` on a thread of its own in the multithreaded apartment: the caller's thread (the
/// JS runtime's) keeps whatever COM state it has, and the WinRT operations awaited here never
/// need a message pump.
#[cfg(target_os = "windows")]
fn in_apartment<T: Send + 'static>(
    work: impl FnOnce() -> windows::core::Result<T> + Send + 'static,
) -> Result<T, String> {
    use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize};
    std::thread::Builder::new()
        .name("tarve-media-sessions".into())
        .spawn(move || {
            let initialized = unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.is_ok();
            let result = work().map_err(|error| error.message());
            if initialized {
                unsafe { RoUninitialize() };
            }
            result
        })
        .map_err(|error| error.to_string())?
        .join()
        .map_err(|_| "media sessions: the WinRT thread panicked".to_string())?
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::{ExternalMediaSession, MAX_ARTWORK_BYTES, MediaAction};
    use base64::Engine;
    use windows::Foundation::TimeSpan;
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session,
        GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    use windows::Storage::Streams::{DataReader, IRandomAccessStreamReference};
    use windows::core::Result;

    pub(super) fn manager() -> Result<Manager> {
        Manager::RequestAsync()?.join()
    }

    pub(super) fn current_app(manager: &Manager) -> Option<String> {
        manager
            .GetCurrentSession()
            .ok()
            .and_then(|session| session.SourceAppUserModelId().ok())
            .map(|id| id.to_string())
    }

    pub(super) fn sessions() -> Result<Vec<ExternalMediaSession>> {
        let manager = manager()?;
        let current = current_app(&manager);
        let mut list = Vec::new();
        for session in manager.GetSessions()? {
            // One app closing between the listing and the read only drops that app.
            if let Ok(session) = describe(&session, current.as_deref(), &properties(&session)) {
                list.push(session);
            }
        }
        Ok(list)
    }

    /// What a session plays: the costly part of a read (an async call and the thumbnail), which
    /// the watcher keeps until the session reports new media properties.
    #[derive(Clone, Default)]
    pub(super) struct Properties {
        title: String,
        artist: Option<String>,
        album: Option<String>,
        artwork: Option<String>,
    }

    pub(super) fn properties(session: &Session) -> Properties {
        let Some(properties) = session
            .TryGetMediaPropertiesAsync()
            .and_then(|operation| operation.join())
            .ok()
        else {
            return Properties::default();
        };
        let text = |value: Option<String>| value.filter(|value| !value.is_empty());
        Properties {
            title: properties
                .Title()
                .map(|t| t.to_string())
                .unwrap_or_default(),
            artist: text(properties.Artist().ok().map(|t| t.to_string())),
            album: text(properties.AlbumTitle().ok().map(|t| t.to_string())),
            artwork: properties
                .Thumbnail()
                .ok()
                .and_then(|thumbnail| read_artwork(&thumbnail).ok())
                .filter(|bytes| !bytes.is_empty())
                .map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes)),
        }
    }

    pub(super) fn describe(
        session: &Session,
        current: Option<&str>,
        properties: &Properties,
    ) -> Result<ExternalMediaSession> {
        let app_id = session.SourceAppUserModelId()?.to_string();
        let Properties {
            title,
            artist,
            album,
            artwork,
        } = properties.clone();
        let playing = session
            .GetPlaybackInfo()
            .and_then(|info| info.PlaybackStatus())
            .is_ok_and(|status| status == Status::Playing);
        let (position, duration) = match session.GetTimelineProperties() {
            Ok(timeline) => {
                let start = timeline.StartTime().map(seconds).unwrap_or(0.0);
                let end = timeline.EndTime().map(seconds).ok();
                let duration = end.map(|end| end - start).filter(|d| *d > 0.0);
                let position = timeline
                    .Position()
                    .map(|p| (seconds(p) - start).max(0.0))
                    .ok()
                    .filter(|_| duration.is_some());
                (position, duration)
            }
            Err(_) => (None, None),
        };
        Ok(ExternalMediaSession {
            current: current == Some(app_id.as_str()),
            app_id,
            title,
            artist,
            album,
            artwork,
            playing,
            position,
            duration,
        })
    }

    fn seconds(span: TimeSpan) -> f64 {
        span.Duration as f64 / 10_000_000.0
    }

    fn read_artwork(reference: &IRandomAccessStreamReference) -> Result<Vec<u8>> {
        let stream = reference.OpenReadAsync()?.join()?;
        let size = stream.Size()?;
        if size == 0 || size > MAX_ARTWORK_BYTES {
            return Ok(Vec::new());
        }
        let reader = DataReader::CreateDataReader(&stream)?;
        let loaded = reader.LoadAsync(size as u32)?.join()?;
        let mut bytes = vec![0u8; loaded as usize];
        reader.ReadBytes(&mut bytes)?;
        Ok(bytes)
    }

    pub(super) fn control(app_id: &str, action: MediaAction) -> Result<bool> {
        let manager = manager()?;
        for session in manager.GetSessions()? {
            if session.SourceAppUserModelId()? != app_id {
                continue;
            }
            let operation = match action {
                MediaAction::Play => session.TryPlayAsync()?,
                MediaAction::Pause => session.TryPauseAsync()?,
                MediaAction::Toggle => session.TryTogglePlayPauseAsync()?,
                MediaAction::Next => session.TrySkipNextAsync()?,
                MediaAction::Previous => session.TrySkipPreviousAsync()?,
            };
            return operation.join();
        }
        Ok(false)
    }
}

/// [`watch`]: one thread in the multithreaded apartment keeps the session manager, subscribes to
/// its events and each session's, and rebuilds the list when they fire (a burst of events gives
/// one rebuild). Media properties and artwork are read again only for the session that reported
/// new ones, so a timeline or play-state change costs a few synchronous getters.
#[cfg(target_os = "windows")]
mod watcher {
    use super::windows_impl::{self, Properties};
    use std::{
        collections::HashMap,
        sync::{
            Mutex,
            atomic::{AtomicU64, Ordering},
            mpsc::{self, Receiver, RecvTimeoutError, Sender},
        },
        thread::JoinHandle,
        time::{Duration, Instant},
    };
    use windows::Foundation::TypedEventHandler;
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session,
        GlobalSystemMediaTransportControlsSessionManager as Manager,
    };

    enum Event {
        Sessions,
        Properties(String),
        Changed,
        Stop,
    }

    struct Watch {
        events: Sender<Event>,
        thread: JoinHandle<()>,
    }

    static WATCH: Mutex<Option<Watch>> = Mutex::new(None);
    static SNAPSHOT: Mutex<Option<Vec<u8>>> = Mutex::new(None);
    static CALLBACK: AtomicU64 = AtomicU64::new(0);
    static VERSION: AtomicU64 = AtomicU64::new(0);
    /// Events closer than this are one change.
    const QUIET: Duration = Duration::from_millis(40);
    /// A steady stream of events still publishes this often.
    const MAX_DELAY: Duration = Duration::from_millis(250);

    pub(super) fn snapshot() -> Option<Vec<u8>> {
        SNAPSHOT.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    pub(super) fn start(callback: u64) -> Result<(), String> {
        let mut watch = WATCH.lock().unwrap_or_else(|p| p.into_inner());
        CALLBACK.store(callback, Ordering::Release);
        if watch.is_some() {
            return Ok(());
        }
        let (events, receiver) = mpsc::channel();
        let (ready, started) = mpsc::sync_channel(1);
        let sender = events.clone();
        let thread = std::thread::Builder::new()
            .name("tarve-media-sessions-watch".into())
            .spawn(move || run(sender, receiver, ready))
            .map_err(|error| error.to_string())?;
        match started.recv() {
            Ok(Ok(())) => {
                *watch = Some(Watch { events, thread });
                Ok(())
            }
            Ok(Err(message)) => {
                let _ = thread.join();
                CALLBACK.store(0, Ordering::Release);
                Err(format!("media sessions: {message}"))
            }
            Err(_) => {
                let _ = thread.join();
                CALLBACK.store(0, Ordering::Release);
                Err("media sessions: the watch thread ended".into())
            }
        }
    }

    pub(super) fn stop() {
        let watch = WATCH.lock().unwrap_or_else(|p| p.into_inner()).take();
        CALLBACK.store(0, Ordering::Release);
        if let Some(watch) = watch {
            let _ = watch.events.send(Event::Stop);
            let _ = watch.thread.join();
        }
        *SNAPSHOT.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }

    struct Watched {
        session: Session,
        app_id: String,
        tokens: [i64; 3],
    }

    struct State {
        manager: Manager,
        manager_tokens: [i64; 2],
        sessions: Vec<Watched>,
        properties: HashMap<String, Properties>,
        events: Sender<Event>,
    }

    fn run(
        events: Sender<Event>,
        receiver: Receiver<Event>,
        ready: mpsc::SyncSender<Result<(), String>>,
    ) {
        use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize};
        let initialized = unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.is_ok();
        match State::new(events) {
            Err(error) => {
                let _ = ready.send(Err(error.message()));
            }
            Ok(mut state) => {
                state.publish();
                let _ = ready.send(Ok(()));
                state.serve(&receiver);
                state.unsubscribe();
            }
        }
        if initialized {
            unsafe { RoUninitialize() };
        }
    }

    impl State {
        fn new(events: Sender<Event>) -> windows::core::Result<Self> {
            let manager = windows_impl::manager()?;
            let sender = events.clone();
            let sessions_token =
                manager.SessionsChanged(&TypedEventHandler::new(move |_, _| {
                    let _ = sender.send(Event::Sessions);
                    Ok(())
                }))?;
            let sender = events.clone();
            let current_token =
                manager.CurrentSessionChanged(&TypedEventHandler::new(move |_, _| {
                    let _ = sender.send(Event::Changed);
                    Ok(())
                }))?;
            let mut state = Self {
                manager,
                manager_tokens: [sessions_token, current_token],
                sessions: Vec::new(),
                properties: HashMap::new(),
                events,
            };
            state.resubscribe();
            Ok(state)
        }

        /// Waits for events, then rebuilds the list once a burst of them went quiet.
        fn serve(&mut self, receiver: &Receiver<Event>) {
            while let Ok(first) = receiver.recv() {
                let (mut stop, mut sessions) = (false, false);
                let mut take = |event: Event, state: &mut Self| match event {
                    Event::Stop => stop = true,
                    Event::Sessions => sessions = true,
                    Event::Properties(app_id) => {
                        state.properties.remove(&app_id);
                    }
                    Event::Changed => {}
                };
                take(first, self);
                let started = Instant::now();
                while started.elapsed() < MAX_DELAY {
                    match receiver.recv_timeout(QUIET) {
                        Ok(event) => take(event, self),
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => {
                            stop = true;
                            break;
                        }
                    }
                }
                if stop {
                    return;
                }
                if sessions {
                    self.resubscribe();
                }
                self.publish();
            }
        }

        /// Follows the sessions there are now, each one's media properties, play state and timeline.
        fn resubscribe(&mut self) {
            self.unsubscribe_sessions();
            let Ok(list) = self.manager.GetSessions() else {
                return;
            };
            for session in list {
                let Ok(app_id) = session.SourceAppUserModelId().map(|id| id.to_string()) else {
                    continue;
                };
                let sender = self.events.clone();
                let id = app_id.clone();
                let properties =
                    session.MediaPropertiesChanged(&TypedEventHandler::new(move |_, _| {
                        let _ = sender.send(Event::Properties(id.clone()));
                        Ok(())
                    }));
                let sender = self.events.clone();
                let playback = session.PlaybackInfoChanged(&TypedEventHandler::new(move |_, _| {
                    let _ = sender.send(Event::Changed);
                    Ok(())
                }));
                let sender = self.events.clone();
                let timeline =
                    session.TimelinePropertiesChanged(&TypedEventHandler::new(move |_, _| {
                        let _ = sender.send(Event::Changed);
                        Ok(())
                    }));
                let tokens = [
                    properties.unwrap_or(0),
                    playback.unwrap_or(0),
                    timeline.unwrap_or(0),
                ];
                self.sessions.push(Watched {
                    session,
                    app_id,
                    tokens,
                });
            }
            let present: Vec<&str> = self
                .sessions
                .iter()
                .map(|watched| watched.app_id.as_str())
                .collect();
            self.properties
                .retain(|app_id, _| present.contains(&app_id.as_str()));
        }

        fn unsubscribe_sessions(&mut self) {
            for watched in self.sessions.drain(..) {
                let [properties, playback, timeline] = watched.tokens;
                if properties != 0 {
                    let _ = watched.session.RemoveMediaPropertiesChanged(properties);
                }
                if playback != 0 {
                    let _ = watched.session.RemovePlaybackInfoChanged(playback);
                }
                if timeline != 0 {
                    let _ = watched.session.RemoveTimelinePropertiesChanged(timeline);
                }
            }
        }

        fn unsubscribe(&mut self) {
            self.unsubscribe_sessions();
            let _ = self.manager.RemoveSessionsChanged(self.manager_tokens[0]);
            let _ = self
                .manager
                .RemoveCurrentSessionChanged(self.manager_tokens[1]);
        }

        /// Rebuilds the list; when it differs from the kept one, keeps it and calls the callback.
        fn publish(&mut self) {
            let current = windows_impl::current_app(&self.manager);
            let mut list = Vec::with_capacity(self.sessions.len());
            for watched in &self.sessions {
                let properties = self
                    .properties
                    .entry(watched.app_id.clone())
                    .or_insert_with(|| windows_impl::properties(&watched.session));
                if let Ok(session) =
                    windows_impl::describe(&watched.session, current.as_deref(), properties)
                {
                    list.push(session);
                }
            }
            let Ok(json) = serde_json::to_vec(&list) else {
                return;
            };
            {
                let mut snapshot = SNAPSHOT.lock().unwrap_or_else(|p| p.into_inner());
                if snapshot.as_ref() == Some(&json) {
                    return;
                }
                *snapshot = Some(json);
            }
            let version = VERSION.fetch_add(1, Ordering::AcqRel) + 1;
            let callback = CALLBACK.load(Ordering::Acquire);
            if callback != 0 {
                // SAFETY: the caller of `watch` handed a C function taking a u64 (a threadsafe
                // callback, which stays safe to call after it was closed).
                let call: extern "C" fn(u64) -> u64 =
                    unsafe { std::mem::transmute(callback as usize) };
                call(version);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "windows")]
    #[test]
    fn watching_keeps_a_list_and_stops_cleanly() {
        static CALLS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        extern "C" fn changed(_: u64) -> u64 {
            CALLS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            0
        }
        watch(changed as extern "C" fn(u64) -> u64 as usize as u64)
            .expect("watching media sessions");
        // The first list is published before `watch` returns.
        assert!(CALLS.load(std::sync::atomic::Ordering::Relaxed) >= 1);
        let kept = sessions_json().unwrap();
        assert!(
            serde_json::from_slice::<serde_json::Value>(&kept)
                .unwrap()
                .is_array()
        );
        // Watching again only swaps the callback.
        watch(changed as extern "C" fn(u64) -> u64 as usize as u64).unwrap();
        unwatch();
        assert!(watcher::snapshot().is_none());
        unwatch();
    }

    #[test]
    fn listing_sessions_succeeds_and_serializes() {
        let sessions = sessions().expect("listing media sessions");
        let json = serde_json::to_value(&sessions).unwrap();
        assert!(json.is_array());
        assert!(sessions.iter().filter(|session| session.current).count() <= 1);
        for session in &sessions {
            assert!(!session.app_id.is_empty());
        }
    }

    #[test]
    fn an_unknown_app_is_not_controlled() {
        assert_eq!(
            control("Tarve.NoSuchApp.MediaSessionTest", MediaAction::Toggle),
            Ok(false)
        );
    }

    #[test]
    fn action_codes_are_fixed() {
        assert_eq!(MediaAction::from_code(0), Some(MediaAction::Play));
        assert_eq!(MediaAction::from_code(4), Some(MediaAction::Previous));
        assert_eq!(MediaAction::from_code(5), None);
    }

    #[test]
    fn fields_serialize_in_camel_case_without_absent_ones() {
        let session = ExternalMediaSession {
            app_id: "Spotify.exe".into(),
            title: "Song".into(),
            artist: None,
            album: None,
            artwork: None,
            playing: true,
            position: Some(1.5),
            duration: Some(3.0),
            current: true,
        };
        assert_eq!(
            serde_json::to_value(&session).unwrap(),
            serde_json::json!({ "appId": "Spotify.exe", "title": "Song", "playing": true, "position": 1.5, "duration": 3.0, "current": true })
        );
    }
}
