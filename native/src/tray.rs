//! System tray icon, native menu and desktop notifications.
//!
//! Windows talks to the shell directly (`Shell_NotifyIconW`, `TrackPopupMenu`) so the
//! feature costs no extra crates. The hidden owner window lives on the event-loop
//! thread, so winit's message pump already dispatches its messages.
//!
//! Linux publishes a StatusNotifierItem with a dbusmenu over D-Bus (`ksni`, pure
//! Rust zbus, already in the tree for AT-SPI) and notifications through
//! org.freedesktop.Notifications (`notify-rust`). GNOME shows SNI icons only with
//! the AppIndicator extension; KDE, XFCE, Cinnamon, MATE, Budgie and most
//! wlroots bars show them natively.
//!
//! Tray input on every platform is forwarded to the runtime through the
//! event-loop proxy as `Command::TrayEvent`.

use crate::protocol::{Command, TrayMenuItem, TrayOptions};
use serde_json::{Value, json};
use winit::event_loop::EventLoopProxy;

fn send(proxy: &EventLoopProxy<Command>, event: Value) {
    let _ = proxy.send_event(Command::TrayEvent { event });
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

        pub fn apply(&mut self, options: Option<TrayOptions>) -> Result<(), String> {
            let Some(options) = options else {
                if self.added {
                    let data = self.data(0);
                    unsafe { Shell_NotifyIconW(NIM_DELETE, &data) };
                    self.added = false;
                }
                self.release_icon();
                SHARED.with(|s| {
                    if let Some(s) = s.borrow_mut().as_mut() {
                        s.visible = false
                    }
                });
                return Ok(());
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
            self.publish(false)
        }

        /// Adds or refreshes the shell icon. `force_add` re-adds after Explorer restarts.
        pub fn publish(&mut self, force_add: bool) -> Result<(), String> {
            if self.hwnd.is_null() || self.icon.is_null() {
                return Ok(());
            }
            let mut data = self.data(NIF_MESSAGE | NIF_ICON | NIF_TIP);
            data.uCallbackMessage = CALLBACK;
            data.hIcon = self.icon;
            copy_into(&mut data.szTip, &self.tooltip);
            let add = force_add || !self.added;
            let ok = unsafe { Shell_NotifyIconW(if add { NIM_ADD } else { NIM_MODIFY }, &data) };
            if ok == 0 {
                return Err("Shell_NotifyIconW failed".into());
            }
            self.added = true;
            Ok(())
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
pub use linux_impl::Tray;

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
pub struct Tray;

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
impl Tray {
    pub fn new(_proxy: EventLoopProxy<Command>) -> Self {
        Self
    }
    pub fn apply(&mut self, options: Option<TrayOptions>) -> Result<(), String> {
        match options {
            None => Ok(()),
            Some(_) => Err("the system tray is not supported on this platform".into()),
        }
    }
    pub fn notify(&mut self, _title: &str, _body: &str) -> Result<(), String> {
        Err("notifications are not supported on this platform".into())
    }
}

#[cfg(target_os = "linux")]
mod linux_impl {
    use super::*;
    use ksni::blocking::TrayMethods as _;
    use ksni::menu::{CheckmarkItem, StandardItem, SubMenu};

    struct Sni {
        id: String,
        proxy: EventLoopProxy<Command>,
        tooltip: String,
        icon: Vec<ksni::Icon>,
        menu: Vec<TrayMenuItem>,
    }

    fn convert(items: &[TrayMenuItem]) -> Vec<ksni::MenuItem<Sni>> {
        items
            .iter()
            .map(|item| {
                let label = item.label.clone().unwrap_or_default();
                let enabled = !item.disabled;
                if item.separator {
                    return ksni::MenuItem::Separator;
                }
                if !item.items.is_empty() {
                    return SubMenu {
                        label,
                        enabled,
                        submenu: convert(&item.items),
                        ..Default::default()
                    }
                    .into();
                }
                let id = item.id.clone().unwrap_or_default();
                let activate = Box::new(move |tray: &mut Sni| {
                    if !id.is_empty() {
                        send(&tray.proxy, json!({"type":"trayMenu", "id":id}));
                    }
                });
                match item.checked {
                    Some(checked) => CheckmarkItem {
                        label,
                        enabled,
                        checked,
                        activate,
                        ..Default::default()
                    }
                    .into(),
                    None => StandardItem {
                        label,
                        enabled,
                        activate,
                        ..Default::default()
                    }
                    .into(),
                }
            })
            .collect()
    }

    impl ksni::Tray for Sni {
        fn id(&self) -> String {
            self.id.clone()
        }
        fn title(&self) -> String {
            self.tooltip.clone()
        }
        fn icon_name(&self) -> String {
            if self.icon.is_empty() {
                "application-x-executable".into()
            } else {
                String::new()
            }
        }
        fn icon_pixmap(&self) -> Vec<ksni::Icon> {
            self.icon.clone()
        }
        fn tool_tip(&self) -> ksni::ToolTip {
            ksni::ToolTip {
                title: self.tooltip.clone(),
                ..Default::default()
            }
        }
        fn activate(&mut self, _x: i32, _y: i32) {
            send(&self.proxy, json!({"type":"tray", "action":"click"}));
        }
        fn secondary_activate(&mut self, _x: i32, _y: i32) {
            send(&self.proxy, json!({"type":"tray", "action":"doubleClick"}));
        }
        fn menu(&self) -> Vec<ksni::MenuItem<Self>> {
            convert(&self.menu)
        }
        fn watcher_offline(&self, _reason: ksni::OfflineReason) -> bool {
            // Keep the item alive: the host comes back after a shell restart.
            true
        }
    }

    /// SNI hosts scale pixmaps themselves; offer the common panel sizes.
    fn pixmaps(image: &image::RgbaImage) -> Vec<ksni::Icon> {
        [16u32, 22, 24, 32, 48, 64]
            .into_iter()
            .map(|size| {
                let mut data = image::imageops::resize(
                    image,
                    size,
                    size,
                    image::imageops::FilterType::Lanczos3,
                )
                .into_raw();
                for pixel in data.as_chunks_mut::<4>().0 {
                    pixel.rotate_right(1);
                }
                ksni::Icon {
                    width: size as i32,
                    height: size as i32,
                    data,
                }
            })
            .collect()
    }

    pub struct Tray {
        proxy: EventLoopProxy<Command>,
        handle: Option<ksni::blocking::Handle<Sni>>,
        icon: Vec<ksni::Icon>,
    }

    impl Tray {
        pub fn new(proxy: EventLoopProxy<Command>) -> Self {
            Self {
                proxy,
                handle: None,
                icon: vec![],
            }
        }

        pub fn is_active(&self) -> bool {
            self.handle
                .as_ref()
                .is_some_and(|handle| !handle.is_closed())
        }

        pub fn apply(&mut self, options: Option<TrayOptions>) -> Result<(), String> {
            let Some(options) = options else {
                if let Some(handle) = self.handle.take() {
                    handle.shutdown().wait();
                }
                return Ok(());
            };
            if let Some(data) = options.icon_data.as_deref().filter(|data| !data.is_empty()) {
                self.icon = pixmaps(&decode_icon(data)?);
            }
            let tooltip = options.tooltip.unwrap_or_default();
            let menu = options.menu;
            if let Some(handle) = self.handle.as_ref().filter(|handle| !handle.is_closed()) {
                let icon = self.icon.clone();
                handle.update(move |tray| {
                    tray.tooltip = tooltip;
                    tray.menu = menu;
                    tray.icon = icon;
                });
                return Ok(());
            }
            let tray = Sni {
                id: format!("tarve-{}", std::process::id()),
                proxy: self.proxy.clone(),
                tooltip,
                icon: self.icon.clone(),
                menu,
            };
            let assume =
                std::env::var_os("TARVE_TRAY_ASSUME_SNI").is_some_and(|value| value == "1");
            let handle = tray.disable_dbus_name(false).assume_sni_available(assume).spawn().map_err(|error| match error {
                ksni::Error::Watcher(_) | ksni::Error::WontShow => format!(
                    "no system tray host is running ({error}); on GNOME install the AppIndicator extension"
                ),
                other => format!("system tray: {other}"),
            })?;
            self.handle = Some(handle);
            Ok(())
        }

        pub fn notify(&mut self, title: &str, body: &str) -> Result<(), String> {
            if !self.is_active() {
                return Err("notifications need an active tray icon (call app.tray first)".into());
            }
            let (title, body, proxy) = (title.to_owned(), body.to_owned(), self.proxy.clone());
            // Showing blocks on D-Bus and waiting for the click blocks until the
            // notification closes, so neither may run on the event-loop thread.
            std::thread::Builder::new()
                .name("tarve-notification".into())
                .spawn(move || {
                    let shown = notify_rust::Notification::new()
                        .summary(&title)
                        .body(&body)
                        .action("default", "Open")
                        .show();
                    match shown {
                        Ok(handle) => handle.wait_for_action(|action| {
                            if action == "default" {
                                send(&proxy, json!({"type":"notificationClick"}));
                            }
                        }),
                        Err(error) => send(
                            &proxy,
                            json!({"type":"error", "message":format!("notification: {error}")}),
                        ),
                    }
                })
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
    }

    impl Drop for Tray {
        fn drop(&mut self) {
            let _ = self.apply(None);
        }
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
