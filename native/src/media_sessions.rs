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

    fn manager() -> Result<Manager> {
        Manager::RequestAsync()?.join()
    }

    pub(super) fn sessions() -> Result<Vec<ExternalMediaSession>> {
        let manager = manager()?;
        let current = manager
            .GetCurrentSession()
            .ok()
            .and_then(|session| session.SourceAppUserModelId().ok())
            .map(|id| id.to_string());
        let mut list = Vec::new();
        for session in manager.GetSessions()? {
            // One app closing between the listing and the read only drops that app.
            if let Ok(session) = describe(&session, current.as_deref()) {
                list.push(session);
            }
        }
        Ok(list)
    }

    fn describe(session: &Session, current: Option<&str>) -> Result<ExternalMediaSession> {
        let app_id = session.SourceAppUserModelId()?.to_string();
        let properties = session.TryGetMediaPropertiesAsync()?.join().ok();
        let text = |value: Option<String>| value.filter(|value| !value.is_empty());
        let title = properties
            .as_ref()
            .and_then(|p| p.Title().ok())
            .map(|t| t.to_string())
            .unwrap_or_default();
        let artist = text(
            properties
                .as_ref()
                .and_then(|p| p.Artist().ok())
                .map(|t| t.to_string()),
        );
        let album = text(
            properties
                .as_ref()
                .and_then(|p| p.AlbumTitle().ok())
                .map(|t| t.to_string()),
        );
        let artwork = properties
            .as_ref()
            .and_then(|p| p.Thumbnail().ok())
            .and_then(|thumbnail| read_artwork(&thumbnail).ok())
            .filter(|bytes| !bytes.is_empty())
            .map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes));
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

#[cfg(test)]
mod tests {
    use super::*;

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
