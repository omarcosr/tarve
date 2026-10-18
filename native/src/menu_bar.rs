//! The native menu bar of a window: a Win32 menu (`SetMenu`) built from the same
//! items as the tray menu. A selection arrives as WM_COMMAND in the window's
//! subclass procedure (`runtime.rs`), which queues it here for the event loop.

#[cfg(any(target_os = "windows", test))]
use crate::protocol::TrayMenuItem;

/// Menu command ids start here, clear of the small ids controls use.
#[cfg(any(target_os = "windows", test))]
const FIRST_COMMAND: usize = 0x6001;

/// The app ids of a menu's selectable items, in command id order.
#[cfg(any(target_os = "windows", test))]
pub(crate) fn item_ids(items: &[TrayMenuItem]) -> Vec<String> {
    crate::tray::menu_ids(items)
}

/// The app id a WM_COMMAND id stands for.
#[cfg(any(target_os = "windows", test))]
pub(crate) fn item_for(ids: &[String], command: usize) -> Option<&str> {
    ids.get(command.checked_sub(FIRST_COMMAND)?)
        .map(String::as_str)
        .filter(|id| !id.is_empty())
}

/// `Label\tCtrl+S`: Win32 right-aligns what follows the tab.
#[cfg(any(target_os = "windows", test))]
pub(crate) fn item_text(item: &TrayMenuItem) -> String {
    let label = item.label.as_deref().unwrap_or("");
    match item.accelerator.as_deref() {
        Some(accelerator) if !accelerator.is_empty() => format!("{label}\t{accelerator}"),
        _ => label.to_string(),
    }
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::*;
    use std::cell::RefCell;
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    thread_local! {
        /// WM_COMMAND menu selections not yet handed to their window: (hwnd, command id).
        static SELECTED: RefCell<Vec<(usize, usize)>> = const { RefCell::new(Vec::new()) };
    }

    /// Called from the window procedure for a WM_COMMAND from a menu.
    pub(crate) fn selected(hwnd: HWND, command: usize) {
        SELECTED.with(|selected| selected.borrow_mut().push((hwnd as usize, command)));
    }

    /// The selections made in `hwnd`'s menu since the last call.
    pub(crate) fn take_selected(hwnd: HWND) -> Vec<usize> {
        SELECTED.with(|selected| {
            let mut selected = selected.borrow_mut();
            let (mine, others): (Vec<_>, Vec<_>) = selected.drain(..).partition(|(owner, _)| *owner == hwnd as usize);
            *selected = others;
            mine.into_iter().map(|(_, command)| command).collect()
        })
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }

    unsafe fn append(menu: HMENU, items: &[TrayMenuItem], next: &mut usize) {
        for item in items {
            let text = wide(&item_text(item));
            let disabled = if item.disabled { MF_GRAYED } else { 0 };
            unsafe {
                if item.separator {
                    AppendMenuW(menu, MF_SEPARATOR, 0, std::ptr::null());
                } else if !item.items.is_empty() {
                    let sub = CreatePopupMenu();
                    append(sub, &item.items, next);
                    AppendMenuW(menu, MF_POPUP | MF_STRING | disabled, sub as usize, text.as_ptr());
                } else {
                    let checked = if item.checked == Some(true) { MF_CHECKED } else { 0 };
                    AppendMenuW(menu, MF_STRING | checked | disabled, *next, text.as_ptr());
                    *next += 1;
                }
            }
        }
    }

    /// The window's menu bar, replaced as a whole on every change.
    pub(crate) struct MenuBar {
        hwnd: HWND,
        menu: HMENU,
        pub(crate) ids: Vec<String>,
    }

    impl MenuBar {
        pub(crate) fn new(hwnd: HWND) -> Self {
            Self { hwnd, menu: std::ptr::null_mut(), ids: Vec::new() }
        }
        /// Top-level items are the bar's menus (`File`, `Edit`…); an item without
        /// `items` is a command directly on the bar.
        pub(crate) fn apply(&mut self, items: Option<&[TrayMenuItem]>) -> Result<(), String> {
            let menu = match items {
                Some(items) if !items.is_empty() => unsafe {
                    let menu = CreateMenu();
                    if menu.is_null() {
                        return Err("CreateMenu failed".into());
                    }
                    let mut next = FIRST_COMMAND;
                    append(menu, items, &mut next);
                    menu
                },
                _ => std::ptr::null_mut(),
            };
            unsafe {
                if SetMenu(self.hwnd, menu) == 0 {
                    if !menu.is_null() {
                        DestroyMenu(menu);
                    }
                    return Err("SetMenu failed".into());
                }
                DrawMenuBar(self.hwnd);
                if !self.menu.is_null() {
                    DestroyMenu(self.menu);
                }
            }
            self.menu = menu;
            self.ids = items.map(item_ids).unwrap_or_default();
            Ok(())
        }
        pub(crate) fn hwnd(&self) -> HWND {
            self.hwnd
        }
    }

    impl Drop for MenuBar {
        fn drop(&mut self) {
            if !self.menu.is_null() {
                unsafe {
                    SetMenu(self.hwnd, std::ptr::null_mut());
                    DestroyMenu(self.menu);
                }
            }
        }
    }
}

#[cfg(target_os = "windows")]
pub(crate) use windows_impl::{MenuBar, selected, take_selected};

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, label: &str) -> TrayMenuItem {
        TrayMenuItem { id: Some(id.into()), label: Some(label.into()), ..Default::default() }
    }

    #[test]
    fn menu_commands_map_back_to_item_ids_and_show_accelerators() {
        let mut save = item("save", "&Save");
        save.accelerator = Some("Ctrl+S".into());
        let file = TrayMenuItem {
            label: Some("&File".into()),
            items: vec![item("new", "&New"), TrayMenuItem { separator: true, ..Default::default() }, save.clone()],
            ..Default::default()
        };
        let ids = item_ids(&[file, item("about", "About")]);
        assert_eq!(item_for(&ids, FIRST_COMMAND), Some("new"));
        assert_eq!(item_for(&ids, FIRST_COMMAND + 1), Some("save"));
        assert_eq!(item_for(&ids, FIRST_COMMAND + 2), Some("about"));
        assert_eq!(item_for(&ids, FIRST_COMMAND + 3), None);
        assert_eq!(item_for(&ids, 7), None);
        assert_eq!(item_text(&save), "&Save\tCtrl+S");
        assert_eq!(item_text(&item("x", "Plain")), "Plain");
    }
}
