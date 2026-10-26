//! `app.notify`: a system notification on every platform, with or without a tray icon.
//!
//! - Windows: a toast (`ToastNotificationManager`) under the app's AppUserModelID; an app
//!   without `appIdentity` gets `Tarve.<name>` registered for it (HKCU, no shortcut needed).
//! - Linux: org.freedesktop.Notifications (`notify-rust`).
//! - Android: `dev.tarve.TarveNotifications` (android/notification.rs), which asks for
//!   POST_NOTIFICATIONS first on Android 13+.
//!
//! A click raises `notificationClick` with the notification's `id` and brings the window forward.

use crate::protocol::Command;
use serde_json::json;
use winit::event_loop::EventLoopProxy;

pub(crate) struct Notification<'a> {
    pub id: Option<&'a str>,
    pub title: &'a str,
    pub body: &'a str,
    /// The name the system shows the notification under.
    pub app_name: &'a str,
}

#[cfg_attr(not(any(target_os = "windows", target_os = "linux")), allow(dead_code))]
fn clicked(proxy: &EventLoopProxy<Command>, id: Option<&str>) {
    let mut event = json!({"type":"notificationClick"});
    if let Some(id) = id {
        event["id"] = json!(id);
    }
    let _ = proxy.send_event(Command::TrayEvent { event });
}

#[cfg(target_os = "windows")]
pub(crate) fn show(
    notification: &Notification,
    identity: Option<&crate::protocol::AppIdentity>,
    proxy: EventLoopProxy<Command>,
) -> Result<(), String> {
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};
    use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize};
    use windows::core::{HSTRING, IInspectable};

    thread_local! {
        /// Toasts stay referenced so their Activated handler still runs when clicked.
        static SHOWN: std::cell::RefCell<std::collections::VecDeque<ToastNotification>> =
            const { std::cell::RefCell::new(std::collections::VecDeque::new()) };
        static REGISTERED: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
    }

    let app_id = match identity {
        Some(identity) => identity.id.clone(),
        None => {
            let name = notification.app_name;
            let id = format!(
                "Tarve.{}",
                name.chars()
                    .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
                    .collect::<String>()
            );
            if REGISTERED.with(|registered| registered.borrow().as_deref() != Some(&id)) {
                crate::smtc::register_app_user_model_id(&id, name, None)?;
                REGISTERED.with(|registered| *registered.borrow_mut() = Some(id.clone()));
            }
            id
        }
    };
    // The event-loop thread may already be in an apartment (RPC_E_CHANGED_MODE): either works.
    let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
    let xml = format!(
        "<toast activationType=\"foreground\"><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>",
        escape_xml(notification.title),
        escape_xml(notification.body)
    );
    let id = notification.id.map(str::to_owned);
    let shown = (|| -> windows::core::Result<ToastNotification> {
        let document = XmlDocument::new()?;
        document.LoadXml(&HSTRING::from(xml))?;
        let toast = ToastNotification::CreateToastNotification(&document)?;
        toast.Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(
            move |_, _| {
                clicked(&proxy, id.as_deref());
                Ok(())
            },
        ))?;
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id.as_str()))?
            .Show(&toast)?;
        Ok(toast)
    })()
    .map_err(|error| format!("notification: {error}"))?;
    SHOWN.with(|toasts| {
        let mut toasts = toasts.borrow_mut();
        toasts.push_back(shown);
        while toasts.len() > 32 {
            toasts.pop_front();
        }
    });
    Ok(())
}

#[cfg(target_os = "windows")]
fn escape_xml(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c if c.is_control() && c != '\n' && c != '\t' => {}
            c => out.push(c),
        }
    }
    out
}

#[cfg(target_os = "linux")]
pub(crate) fn show(
    notification: &Notification,
    proxy: EventLoopProxy<Command>,
) -> Result<(), String> {
    let (id, title, body, app_name) = (
        notification.id.map(str::to_owned),
        notification.title.to_owned(),
        notification.body.to_owned(),
        notification.app_name.to_owned(),
    );
    // Showing blocks on D-Bus and waiting for the click blocks until the notification
    // closes, so neither may run on the event-loop thread.
    std::thread::Builder::new()
        .name("tarve-notification".into())
        .spawn(move || {
            let shown = notify_rust::Notification::new()
                .appname(&app_name)
                .summary(&title)
                .body(&body)
                .action("default", "Open")
                .show();
            match shown {
                Ok(handle) => handle.wait_for_action(|action| {
                    if action == "default" {
                        clicked(&proxy, id.as_deref());
                    }
                }),
                Err(error) => {
                    let _ = proxy.send_event(Command::TrayEvent {
                        event: json!({"type":"error", "message":format!("notification: {error}")}),
                    });
                }
            }
        })
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "android")]
pub(crate) fn show(
    notification: &Notification,
    _proxy: EventLoopProxy<Command>,
) -> Result<(), String> {
    crate::android::notification::show(
        notification.id.unwrap_or(""),
        notification.title,
        notification.body,
    )
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "android")))]
pub(crate) fn show(
    notification: &Notification,
    proxy: EventLoopProxy<Command>,
) -> Result<(), String> {
    let _ = (notification.id, notification.app_name, proxy);
    Err("notifications are not supported on this platform".into())
}
