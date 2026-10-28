//! Linux tray: a StatusNotifierItem with a dbusmenu over D-Bus (`ksni`).
//!
//! Whether a host shows the item is reported as `trayAvailability`, not as an error: with
//! no StatusNotifierWatcher on the bus (GNOME without the AppIndicator extension, WSLg) the
//! item still goes on the bus, ksni watches for a watcher and registers the item when one
//! starts (`watcher_online`), and reports when it goes away (`watcher_offline`).

use super::*;
use ksni::blocking::TrayMethods as _;
use ksni::menu::{CheckmarkItem, StandardItem, SubMenu};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

struct Sni {
    id: String,
    proxy: EventLoopProxy<Command>,
    tooltip: String,
    icon: Vec<ksni::Icon>,
    menu: Vec<TrayMenuItem>,
    /// Set by `watcher_offline`, so `apply` knows spawning already reported no host.
    offline: Arc<AtomicBool>,
}

fn no_host(error: &dyn std::fmt::Display) -> String {
    format!("no system tray host is running ({error}); on GNOME install the AppIndicator extension")
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
    fn watcher_online(&self) {
        self.offline.store(false, Ordering::Relaxed);
        send(&self.proxy, availability(true, None));
    }
    fn watcher_offline(&self, reason: ksni::OfflineReason) -> bool {
        self.offline.store(true, Ordering::Relaxed);
        let reason = match reason {
            ksni::OfflineReason::Error(error) => no_host(&error),
            _ => no_host(&"the StatusNotifierWatcher stopped"),
        };
        send(&self.proxy, availability(true, Some(reason)));
        // Keep the item on the bus: it registers when a host (re)starts.
        true
    }
}

/// SNI hosts scale pixmaps themselves; offer the common panel sizes.
fn pixmaps(image: &image::RgbaImage) -> Vec<ksni::Icon> {
    [16u32, 22, 24, 32, 48, 64]
        .into_iter()
        .map(|size| {
            let mut data =
                image::imageops::resize(image, size, size, image::imageops::FilterType::Lanczos3)
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

    /// Shows, updates (`Some`) or removes (`None`) the item; returns the `trayAvailability`
    /// event a new item gets right away (later changes arrive through the proxy).
    pub fn apply(&mut self, options: Option<TrayOptions>) -> Result<Option<Value>, String> {
        let Some(options) = options else {
            if let Some(handle) = self.handle.take() {
                handle.shutdown().wait();
            }
            return Ok(None);
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
            return Ok(None);
        }
        let offline = Arc::new(AtomicBool::new(false));
        let tray = Sni {
            id: format!("tarve-{}", std::process::id()),
            proxy: self.proxy.clone(),
            tooltip,
            icon: self.icon.clone(),
            menu,
            offline: offline.clone(),
        };
        // Assumed available: a missing watcher goes to watcher_offline (during this spawn)
        // instead of failing it, and the item registers once a watcher appears.
        match tray
            .disable_dbus_name(false)
            .assume_sni_available(true)
            .spawn()
        {
            Ok(handle) => {
                self.handle = Some(handle);
                Ok((!offline.load(Ordering::Relaxed)).then(|| availability(true, None)))
            }
            // No session bus, or a watcher that refused the item: nothing to watch.
            Err(error @ ksni::Error::Dbus(_)) => Ok(Some(availability(
                true,
                Some(format!(
                    "no D-Bus session bus for the system tray ({error})"
                )),
            ))),
            Err(error) => Ok(Some(availability(true, Some(no_host(&error))))),
        }
    }
}

impl Drop for Tray {
    fn drop(&mut self) {
        let _ = self.apply(None);
    }
}
