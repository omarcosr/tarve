//! Windows System Media Transport Controls: publish the current track and forward hardware keys.
use crate::protocol::{Command, SystemMediaSession};
use windows::core::{factory, HSTRING};
use windows::Foundation::{TimeSpan, TypedEventHandler, Uri};
use windows::Media::{
    MediaPlaybackStatus, MediaPlaybackType, PlaybackPositionChangeRequestedEventArgs,
    SystemMediaTransportControls, SystemMediaTransportControlsButton,
    SystemMediaTransportControlsButtonPressedEventArgs,
    SystemMediaTransportControlsTimelineProperties,
};
use windows::Storage::Streams::RandomAccessStreamReference;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::WinRT::{
    ISystemMediaTransportControlsInterop, RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED,
};
use winit::event_loop::EventLoopProxy;
use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
use winit::window::Window;

fn valid_app_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && !id.chars().any(|c| c.is_whitespace() || c == '\\' || c.is_control())
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

/// Names the process for the shell (media flyout, notifications): an unpackaged app is
/// otherwise reported as its host executable or "Unknown app". Registers DisplayName and
/// IconUri under HKCU\Software\Classes\AppUserModelId\<id>, then claims that id for the
/// process; must run before the first window is created.
/// The shell names a media session (and its icon) from a Start menu shortcut that carries the
/// session's AppUserModelID; the registry entry alone only covers notifications. Writes
/// %APPDATA%\Microsoft\Windows\Start Menu\Programs\<name>.lnk pointing at this process.
fn write_start_menu_shortcut(identity: &crate::protocol::AppIdentity) -> Result<(), String> {
    use windows::core::{HSTRING, Interface};
    use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
        CoUninitialize, IPersistFile,
    };
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
    let appdata = std::env::var_os("APPDATA").ok_or("APPDATA is not set")?;
    let file_name: String = identity
        .name
        .trim()
        .chars()
        .map(|c| if "<>:\"/\\|?*".contains(c) || c.is_control() { '_' } else { c })
        .collect();
    let folder = std::path::Path::new(&appdata).join("Microsoft\\Windows\\Start Menu\\Programs");
    let path = folder.join(format!("{file_name}.lnk"));
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let arguments = std::env::args()
        .skip(1)
        .map(|arg| if arg.contains(' ') { format!("\"{arg}\"") } else { arg })
        .collect::<Vec<_>>()
        .join(" ");
    let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
    let result = (|| -> windows::core::Result<()> {
        unsafe {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            link.SetPath(&HSTRING::from(exe.as_os_str()))?;
            link.SetArguments(&HSTRING::from(arguments.as_str()))?;
            if let Ok(directory) = std::env::current_dir() {
                link.SetWorkingDirectory(&HSTRING::from(directory.as_os_str()))?;
            }
            if let Some(icon) = identity.icon.as_deref().filter(|icon| icon.to_ascii_lowercase().ends_with(".ico")) {
                link.SetIconLocation(&HSTRING::from(icon), 0)?;
            }
            let store: IPropertyStore = link.cast()?;
            let value = PROPVARIANT::from(identity.id.as_str());
            store.SetValue(&PKEY_AppUserModel_ID, &value)?;
            store.Commit()?;
            let file: IPersistFile = link.cast()?;
            std::fs::create_dir_all(&folder).map_err(|error| windows::core::Error::new(windows::core::HRESULT(-1), error.to_string()))?;
            file.Save(&HSTRING::from(path.as_os_str()), true)?;
        }
        Ok(())
    })();
    if initialized {
        unsafe { CoUninitialize() };
    }
    result.map_err(|error| format!("could not write the Start menu shortcut: {error}"))
}

pub(crate) fn register_app_identity(identity: &crate::protocol::AppIdentity) -> Result<(), String> {
    use windows_sys::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE, REG_OPTION_NON_VOLATILE, REG_SZ, RegCloseKey,
        RegCreateKeyExW, RegSetValueExW,
    };
    use windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
    if !valid_app_id(&identity.id) {
        return Err("appIdentity.id must be 1-128 characters without spaces or backslashes".into());
    }
    if identity.name.trim().is_empty() {
        return Err("appIdentity.name must not be empty".into());
    }
    let path = wide(&format!("Software\\Classes\\AppUserModelId\\{}", identity.id));
    let mut key: HKEY = std::ptr::null_mut();
    let status = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            path.as_ptr(),
            0,
            std::ptr::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            std::ptr::null(),
            &mut key,
            std::ptr::null_mut(),
        )
    };
    if status != 0 {
        return Err(format!("could not register the app identity (error {status})"));
    }
    let set = |name: &str, value: &str| -> u32 {
        let name = wide(name);
        let value = wide(value);
        unsafe {
            RegSetValueExW(
                key,
                name.as_ptr(),
                0,
                REG_SZ,
                value.as_ptr().cast(),
                (value.len() * 2) as u32,
            )
        }
    };
    let mut status = set("DisplayName", identity.name.trim());
    if status == 0
        && let Some(icon) = identity.icon.as_deref().filter(|icon| std::path::Path::new(icon).is_file())
    {
        status = set("IconUri", icon);
    }
    unsafe { RegCloseKey(key) };
    if status != 0 {
        return Err(format!("could not register the app identity (error {status})"));
    }
    write_start_menu_shortcut(identity)?;
    let id = wide(&identity.id);
    let result = unsafe { SetCurrentProcessExplicitAppUserModelID(id.as_ptr()) };
    if result < 0 {
        return Err(format!("could not set the AppUserModelID (HRESULT {result:#010x})"));
    }
    Ok(())
}

fn time_span(seconds: f64) -> TimeSpan {
    TimeSpan {
        Duration: if seconds.is_finite() {
            (seconds.clamp(0.0, 86_400.0) * 10_000_000.0) as i64
        } else {
            0
        },
    }
}

pub(crate) struct SystemMedia {
    controls: Option<SystemMediaTransportControls>,
    button_token: i64,
    position_token: i64,
    apartment: bool,
    metadata: Option<(String, String, String, Option<String>)>,
}

impl SystemMedia {
    pub(crate) fn new(window: &Window, proxy: EventLoopProxy<Command>) -> Result<Self, String> {
        let apartment = match unsafe { RoInitialize(RO_INIT_MULTITHREADED) } {
            Ok(()) => true,
            Err(error) if error.code().0 == 0x80010106u32 as i32 => false,
            Err(error) => return Err(error.to_string()),
        };
        let handle = window.window_handle().map_err(|error| error.to_string())?;
        let RawWindowHandle::Win32(handle) = handle.as_raw() else {
            return Err("SMTC requires a Win32 window".into());
        };
        let interop = factory::<SystemMediaTransportControls, ISystemMediaTransportControlsInterop>()
            .map_err(|error| error.to_string())?;
        let controls: SystemMediaTransportControls = unsafe {
            interop.GetForWindow(HWND(handle.hwnd.get() as *mut _))
        }
        .map_err(|error| error.to_string())?;
        let button_proxy = proxy.clone();
        let button_handler = TypedEventHandler::<
            SystemMediaTransportControls,
            SystemMediaTransportControlsButtonPressedEventArgs,
        >::new(move |_, args| {
            let Some(button) = args.as_ref().map(|args| args.Button()).transpose()? else {
                return Ok(());
            };
            let action = match button {
                SystemMediaTransportControlsButton::Play => "play",
                SystemMediaTransportControlsButton::Pause => "pause",
                SystemMediaTransportControlsButton::Next => "next",
                SystemMediaTransportControlsButton::Previous => "previous",
                _ => return Ok(()),
            };
            let _ = button_proxy.send_event(Command::SystemMediaEvent {
                action: action.into(),
                time: None,
            });
            Ok(())
        });
        let button_token = controls.ButtonPressed(&button_handler).map_err(|error| error.to_string())?;
        let position_handler = TypedEventHandler::<
            SystemMediaTransportControls,
            PlaybackPositionChangeRequestedEventArgs,
        >::new(move |_, args| {
            if let Some(args) = args.as_ref() {
                let time = args.RequestedPlaybackPosition()?.Duration as f64 / 10_000_000.0;
                let _ = proxy.send_event(Command::SystemMediaEvent {
                    action: "seek".into(),
                    time: Some(time),
                });
            }
            Ok(())
        });
        let position_token = controls
            .PlaybackPositionChangeRequested(&position_handler)
            .map_err(|error| error.to_string())?;
        Ok(Self {
            controls: Some(controls),
            button_token,
            position_token,
            apartment,
            metadata: None,
        })
    }

    pub(crate) fn update(&mut self, session: Option<&SystemMediaSession>) -> Result<(), String> {
        let controls = self.controls.as_ref().expect("SMTC controls released only on drop");
        let Some(session) = session else {
            controls.SetIsEnabled(false).map_err(|error| error.to_string())?;
            self.metadata = None;
            return Ok(());
        };
        if session.title.trim().is_empty() {
            return Err("SMTC title must not be empty".into());
        }
        let metadata = (
            session.title.clone(),
            session.artist.clone().unwrap_or_default(),
            session.album.clone().unwrap_or_default(),
            session.artwork.clone(),
        );
        if self.metadata.as_ref() != Some(&metadata) {
            let updater = controls.DisplayUpdater().map_err(|error| error.to_string())?;
            updater.ClearAll().map_err(|error| error.to_string())?;
            updater.SetType(MediaPlaybackType::Music).map_err(|error| error.to_string())?;
            let music = updater.MusicProperties().map_err(|error| error.to_string())?;
            music.SetTitle(&HSTRING::from(&metadata.0)).map_err(|error| error.to_string())?;
            music.SetArtist(&HSTRING::from(&metadata.1)).map_err(|error| error.to_string())?;
            music.SetAlbumTitle(&HSTRING::from(&metadata.2)).map_err(|error| error.to_string())?;
            if let Some(url) = metadata.3.as_deref().filter(|url| url.starts_with("https://"))
                && let Ok(uri) = Uri::CreateUri(&HSTRING::from(url))
                && let Ok(reference) = RandomAccessStreamReference::CreateFromUri(&uri)
            {
                updater.SetThumbnail(&reference).map_err(|error| error.to_string())?;
            }
            updater.Update().map_err(|error| error.to_string())?;
            self.metadata = Some(metadata);
        }
        controls.SetIsPlayEnabled(true).map_err(|error| error.to_string())?;
        controls.SetIsPauseEnabled(true).map_err(|error| error.to_string())?;
        controls.SetIsNextEnabled(session.can_next).map_err(|error| error.to_string())?;
        controls.SetIsPreviousEnabled(session.can_previous).map_err(|error| error.to_string())?;
        if let Some(duration) = session.duration.filter(|value| value.is_finite() && *value > 0.0) {
            let timeline = SystemMediaTransportControlsTimelineProperties::new()
                .map_err(|error| error.to_string())?;
            timeline.SetStartTime(time_span(0.0)).map_err(|error| error.to_string())?;
            timeline.SetEndTime(time_span(duration)).map_err(|error| error.to_string())?;
            let position = time_span(session.position.unwrap_or(0.0).min(duration));
            let (min_seek, max_seek) = if session.can_seek {
                (time_span(0.0), time_span(duration))
            } else {
                (position, position)
            };
            timeline.SetMinSeekTime(min_seek).map_err(|error| error.to_string())?;
            timeline.SetMaxSeekTime(max_seek).map_err(|error| error.to_string())?;
            timeline.SetPosition(position).map_err(|error| error.to_string())?;
            controls.UpdateTimelineProperties(&timeline).map_err(|error| error.to_string())?;
        }
        controls.SetIsEnabled(true).map_err(|error| error.to_string())?;
        controls.SetPlaybackStatus(if session.playing {
            MediaPlaybackStatus::Playing
        } else {
            MediaPlaybackStatus::Paused
        })
        .map_err(|error| error.to_string())?;
        Ok(())
    }
}

impl Drop for SystemMedia {
    fn drop(&mut self) {
        if let Some(controls) = self.controls.take() {
            let _ = controls.SetIsEnabled(false);
            let _ = controls.RemoveButtonPressed(self.button_token);
            let _ = controls.RemovePlaybackPositionChangeRequested(self.position_token);
            drop(controls);
        }
        if self.apartment {
            unsafe { RoUninitialize() };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_ids_reject_shell_unsafe_characters() {
        assert!(valid_app_id("Tarve.YouTubeMusic"));
        assert!(!valid_app_id(""));
        assert!(!valid_app_id("Tarve Music"));
        assert!(!valid_app_id("Tarve\\Music"));
        assert!(!valid_app_id(&"a".repeat(129)));
    }

    #[test]
    fn timeline_time_is_clamped_to_nonnegative_finite_ticks() {
        assert_eq!(time_span(-5.0).Duration, 0);
        assert_eq!(time_span(1.25).Duration, 12_500_000);
        assert_eq!(time_span(f64::INFINITY).Duration, 0);
    }
}
