//! System tray icon and native menu. Notifications live in notification.rs; the Windows
//! tray balloon is only their fallback.
//!
//! Windows talks to the shell directly (`Shell_NotifyIconW`, `TrackPopupMenu`) so the
//! feature costs no extra crates. The hidden owner window lives on the event-loop
//! thread, so winit's message pump already dispatches its messages.
//!
//! Linux publishes a StatusNotifierItem with a dbusmenu over D-Bus (`ksni`, pure
//! Rust zbus, already in the tree for AT-SPI; tray/linux.rs). GNOME shows SNI icons
//! only with the AppIndicator extension; KDE, XFCE, Cinnamon, MATE, Budgie and most
//! wlroots bars show them natively.
//!
//! Tray input on every platform is forwarded to the runtime through the
//! event-loop proxy as `Command::TrayEvent`. Whether the icon can be seen is the
//! `trayAvailability` event (no tray host, no tray on the platform), never an error.

#[cfg(any(target_os = "windows", target_os = "linux", test))]
use crate::protocol::TrayMenuItem;
use crate::protocol::{Command, TrayOptions};
use serde_json::{Value, json};
use winit::event_loop::EventLoopProxy;

fn send(proxy: &EventLoopProxy<Command>, event: Value) {
    let _ = proxy.send_event(Command::TrayEvent { event });
}

/// The `trayAvailability` event: the icon can be seen, or why not.
pub fn availability(supported: bool, reason: Option<String>) -> Value {
    let available = supported && reason.is_none();
    let mut event =
        json!({"type":"trayAvailability", "supported":supported, "available":available});
    if let Some(reason) = reason {
        event["reason"] = json!(reason);
    }
    event
}

#[cfg(any(target_os = "windows", test))]
/// Flattens a menu into native command ids (1-based) mapped back to app ids.
pub fn menu_ids(items: &[TrayMenuItem]) -> Vec<String> {
    fn walk(items: &[TrayMenuItem], out: &mut Vec<String>) {
        for item in items {
            if item.items.is_empty() {
                if !item.separator {
                    out.push(item.id.clone().unwrap_or_default());
                }
            } else {
                walk(&item.items, out);
            }
        }
    }
    let mut out = Vec::new();
    walk(items, &mut out);
    out
}

#[cfg(any(target_os = "windows", test))]
/// Translates a native command id from the popup menu into a protocol event.
pub fn menu_event(ids: &[String], command: usize) -> Option<Value> {
    let id = ids.get(command.checked_sub(1)?)?;
    (!id.is_empty()).then(|| json!({"type":"trayMenu", "id":id}))
}

/// Decodes a PNG/JPEG/WebP icon sent from JS as base64 bytes.
pub fn decode_icon(data: &str) -> Result<image::RgbaImage, String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|error| format!("tray icon: invalid base64: {error}"))?;
    image::load_from_memory(&bytes)
        .map(|image| image.to_rgba8())
        .map_err(|error| format!("tray icon: {error}"))
}

#[cfg(target_os = "windows")]
pub use windows_impl::Tray;

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::*;
    use std::cell::RefCell;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{CreateBitmap, DeleteObject};
    use windows_sys::Win32::UI::Shell::{
        NIF_ICON, NIF_INFO, NIF_MESSAGE, NIF_TIP, NIIF_INFO, NIM_ADD, NIM_DELETE, NIM_MODIFY,
        NOTIFYICONDATAW, Shell_NotifyIconW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    const CALLBACK: u32 = WM_APP + 0x7a1;
    const NIN_BALLOONUSERCLICK: u32 = WM_USER + 5;

    struct Shared {
        proxy: EventLoopProxy<Command>,
        menu: Vec<TrayMenuItem>,
        ids: Vec<String>,
        taskbar_created: u32,
        visible: bool,
    }

    thread_local! {
        static SHARED: RefCell<Option<Shared>> = const { RefCell::new(None) };
    }

    pub struct Tray {
        hwnd: HWND,
        icon: HICON,
        owns_icon: bool,
        tooltip: String,
        added: bool,
        /// Whether the last publish showed the icon (the last `trayAvailability` sent).
        shown: Option<bool>,
        proxy: EventLoopProxy<Command>,
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }

    fn copy_into(target: &mut [u16], text: &str) {
        let units: Vec<u16> = text.encode_utf16().take(target.len() - 1).collect();
        target[..units.len()].copy_from_slice(&units);
        target[units.len()] = 0;
    }

    fn emit(event: Value) {
        SHARED.with(|shared| {
            if let Some(shared) = shared.borrow().as_ref() {
                send(&shared.proxy, event);
            }
        });
    }

    unsafe fn build_menu(items: &[TrayMenuItem], next: &mut usize) -> HMENU {
        let menu = unsafe { CreatePopupMenu() };
        for item in items {
            let label = wide(item.label.as_deref().unwrap_or(""));
            let disabled = if item.disabled { MF_GRAYED } else { 0 };
            unsafe {
                if item.separator {
                    AppendMenuW(menu, MF_SEPARATOR, 0, null());
                } else if !item.items.is_empty() {
                    let sub = build_menu(&item.items, next);
                    AppendMenuW(
                        menu,
                        MF_POPUP | MF_STRING | disabled,
                        sub as usize,
                        label.as_ptr(),
                    );
                } else {
                    *next += 1;
                    let checked = if item.checked == Some(true) {
                        MF_CHECKED
                    } else {
                        0
                    };
                    AppendMenuW(menu, MF_STRING | checked | disabled, *next, label.as_ptr());
                }
            }
        }
        menu
    }

    fn show_menu(hwnd: HWND) {
        let menu = SHARED.with(|shared| shared.borrow().as_ref().map(|s| s.menu.clone()));
        let Some(items) = menu.filter(|items| !items.is_empty()) else {
            return;
        };
        unsafe {
            let mut next = 0;
            let menu = build_menu(&items, &mut next);
            let mut point = POINT { x: 0, y: 0 };
            GetCursorPos(&mut point);
            // Without the foreground switch the menu never dismisses on outside clicks.
            SetForegroundWindow(hwnd);
            let command = TrackPopupMenu(
                menu,
                TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_NONOTIFY,
                point.x,
                point.y,
                0,
                hwnd,
                null(),
            );
            PostMessageW(hwnd, WM_NULL, 0, 0);
            DestroyMenu(menu);
            let event = SHARED.with(|shared| {
                shared
                    .borrow()
                    .as_ref()
                    .and_then(|s| menu_event(&s.ids, command as usize))
            });
            if let Some(event) = event {
                emit(event);
            }
        }
    }

    unsafe extern "system" fn wndproc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if msg == CALLBACK {
            match lparam as u32 {
                WM_LBUTTONUP => emit(json!({"type":"tray", "action":"click"})),
                WM_LBUTTONDBLCLK => emit(json!({"type":"tray", "action":"doubleClick"})),
                WM_RBUTTONUP | WM_CONTEXTMENU => show_menu(hwnd),
                NIN_BALLOONUSERCLICK => emit(json!({"type":"notificationClick"})),
                _ => {}
            }
            return 0;
        }
        let recreate = SHARED.with(|shared| {
            shared
                .borrow()
                .as_ref()
                .is_some_and(|s| s.visible && s.taskbar_created != 0 && s.taskbar_created == msg)
        });
        if recreate {
            // Explorer restarted: the shell forgot every icon.
            emit(json!({"type":"trayRecreate"}));
            return 0;
        }
        unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
    }

    fn load_icon(data: &str) -> Result<HICON, String> {
        let size = unsafe { GetSystemMetrics(SM_CXSMICON) }.max(16) as u32;
        let rgba = image::imageops::resize(
            &decode_icon(data)?,
            size,
            size,
            image::imageops::FilterType::Lanczos3,
        );
        let mut bgra = rgba.into_raw();
        for pixel in bgra.as_chunks_mut::<4>().0 {
            pixel.swap(0, 2);
        }
        unsafe {
            let color = CreateBitmap(size as i32, size as i32, 1, 32, bgra.as_ptr().cast());
            let mask_bits = vec![0u8; (size as usize).div_ceil(16) * 2 * size as usize];
            let mask = CreateBitmap(size as i32, size as i32, 1, 1, mask_bits.as_ptr().cast());
            let info = ICONINFO {
                fIcon: 1,
                xHotspot: 0,
                yHotspot: 0,
                hbmMask: mask,
                hbmColor: color,
            };
            let icon = CreateIconIndirect(&info);
            DeleteObject(color as _);
            DeleteObject(mask as _);
            if icon.is_null() {
                Err("tray icon: CreateIconIndirect failed".into())
            } else {
                Ok(icon)
            }
        }
    }

    impl Tray {
        pub fn new(proxy: EventLoopProxy<Command>) -> Self {
            Self {
                hwnd: null_mut(),
                icon: null_mut(),
                owns_icon: false,
                tooltip: String::new(),
                added: false,
                shown: None,
                proxy,
            }
        }

        fn ensure_window(&mut self) -> Result<(), String> {
            if !self.hwnd.is_null() {
                return Ok(());
            }
            unsafe {
                let class = wide("TarveTrayWindow");
                let instance = null_mut();
                let wc = WNDCLASSW {
                    lpfnWndProc: Some(wndproc),
                    hInstance: instance,
                    lpszClassName: class.as_ptr(),
                    ..std::mem::zeroed()
                };
                RegisterClassW(&wc);
                // A hidden top-level window (not message-only) so it receives the
                // TaskbarCreated broadcast after an Explorer restart.
                self.hwnd = CreateWindowExW(
                    0,
                    class.as_ptr(),
                    class.as_ptr(),
                    WS_POPUP,
                    0,
                    0,
                    0,
                    0,
                    null_mut(),
                    null_mut(),
                    instance,
                    null(),
                );
                if self.hwnd.is_null() {
                    return Err("could not create the tray owner window".into());
                }
                let taskbar_created = RegisterWindowMessageW(wide("TaskbarCreated").as_ptr());
                let proxy = self.proxy.clone();
                SHARED.with(|shared| {
                    *shared.borrow_mut() = Some(Shared {
                        proxy,
                        menu: vec![],
                        ids: vec![],
                        taskbar_created,
                        visible: false,
                    })
                });
            }
            Ok(())
        }

        fn data(&self, flags: u32) -> NOTIFYICONDATAW {
            let mut data: NOTIFYICONDATAW = unsafe { std::mem::zeroed() };
            data.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
            data.hWnd = self.hwnd;
            data.uID = 1;
            data.uFlags = flags;
            data
        }

        fn release_icon(&mut self) {
            if self.owns_icon && !self.icon.is_null() {
                unsafe { DestroyIcon(self.icon) };
            }
            self.icon = null_mut();
            self.owns_icon = false;
        }

        /// Shows, updates (`Some`) or removes (`None`) the icon; returns the
        /// `trayAvailability` event when whether it shows changed.
        pub fn apply(&mut self, options: Option<TrayOptions>) -> Result<Option<Value>, String> {
            let Some(options) = options else {
                if self.added {
                    let data = self.data(0);
                    unsafe { Shell_NotifyIconW(NIM_DELETE, &data) };
                    self.added = false;
                }
                self.shown = None;
                self.release_icon();
                SHARED.with(|s| {
                    if let Some(s) = s.borrow_mut().as_mut() {
                        s.visible = false
                    }
                });
                return Ok(None);
            };
            self.ensure_window()?;
            if options.icon_data.is_some() || self.icon.is_null() {
                let (icon, owned) =
                    match options.icon_data.as_deref().filter(|data| !data.is_empty()) {
                        Some(data) => (load_icon(data)?, true),
                        None => (unsafe { LoadIconW(null_mut(), IDI_APPLICATION) }, false),
                    };
                self.release_icon();
                self.icon = icon;
                self.owns_icon = owned;
            }
            self.tooltip = options.tooltip.unwrap_or_default();
            let ids = menu_ids(&options.menu);
            SHARED.with(|s| {
                if let Some(s) = s.borrow_mut().as_mut() {
                    s.menu = options.menu;
                    s.ids = ids;
                    s.visible = true;
                }
            });
            Ok(self.publish(false))
        }

        /// Adds or refreshes the shell icon (`force_add` re-adds after Explorer restarts);
        /// returns the `trayAvailability` event when whether it shows changed.
        pub fn publish(&mut self, force_add: bool) -> Option<Value> {
            if self.hwnd.is_null() || self.icon.is_null() {
                return None;
            }
            let mut data = self.data(NIF_MESSAGE | NIF_ICON | NIF_TIP);
            data.uCallbackMessage = CALLBACK;
            data.hIcon = self.icon;
            copy_into(&mut data.szTip, &self.tooltip);
            let add = force_add || !self.added;
            let ok = unsafe { Shell_NotifyIconW(if add { NIM_ADD } else { NIM_MODIFY }, &data) };
            // It fails while no taskbar runs (Explorer not started or restarting); the
            // TaskbarCreated broadcast publishes again (trayRecreate).
            self.added = ok != 0;
            if self.shown == Some(self.added) {
                return None;
            }
            self.shown = Some(self.added);
            let reason = "the taskbar notification area is not running (Explorer)";
            Some(availability(true, (!self.added).then(|| reason.into())))
        }

        pub fn notify(&mut self, title: &str, body: &str) -> Result<(), String> {
            if !self.added {
                return Err("notifications need an active tray icon (call app.tray first)".into());
            }
            let mut data = self.data(NIF_INFO);
            copy_into(&mut data.szInfoTitle, title);
            copy_into(&mut data.szInfo, body);
            data.dwInfoFlags = NIIF_INFO;
            if unsafe { Shell_NotifyIconW(NIM_MODIFY, &data) } == 0 {
                return Err("Shell_NotifyIconW failed".into());
            }
            Ok(())
        }
    }

    impl Drop for Tray {
        fn drop(&mut self) {
            let _ = self.apply(None);
            if !self.hwnd.is_null() {
                unsafe { DestroyWindow(self.hwnd) };
            }
            SHARED.with(|s| *s.borrow_mut() = None);
        }
    }
}

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::Tray;

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
pub struct Tray;

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
impl Tray {
    pub fn new(_proxy: EventLoopProxy<Command>) -> Self {
        Self
    }
    /// No tray here: every shown tray answers `supported: false`, as the device APIs do.
    pub fn apply(&mut self, options: Option<TrayOptions>) -> Result<Option<Value>, String> {
        let reason = if cfg!(target_os = "android") {
            "Android has no system tray"
        } else {
            "no system tray icon on this platform yet"
        };
        Ok(options.map(|_| availability(false, Some(reason.into()))))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str) -> TrayMenuItem {
        TrayMenuItem {
            id: Some(id.into()),
            label: Some(id.into()),
            ..Default::default()
        }
    }

    #[test]
    fn menu_ids_skip_separators_and_flatten_submenus() {
        let menu = vec![
            item("open"),
            TrayMenuItem {
                separator: true,
                ..Default::default()
            },
            TrayMenuItem {
                label: Some("More".into()),
                items: vec![item("a"), item("b")],
                ..Default::default()
            },
            item("quit"),
        ];
        let ids = menu_ids(&menu);
        assert_eq!(ids, ["open", "a", "b", "quit"]);
        assert_eq!(
            menu_event(&ids, 3),
            Some(json!({"type":"trayMenu", "id":"b"}))
        );
        assert_eq!(menu_event(&ids, 0), None, "0 means the menu was dismissed");
        assert_eq!(menu_event(&ids, 9), None);
    }
}
