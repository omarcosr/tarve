//! `activation`: windows that do not take the foreground (a dock, a menu, an overlay).
//!
//! Windows: `never` and `whileEditing` windows carry `WS_EX_NOACTIVATE` (kept through winit's
//! style rewrites by a subclass) and answer `WM_MOUSEACTIVATE` with `MA_NOACTIVATE`, so a click
//! leaves the keyboard with the app in use. A `whileEditing` window drops the style while an
//! editable Input or TextArea has focus: the click that focused it activates the window, which
//! then receives typing; on blur the style comes back and the foreground returns to the window
//! that had it. Nothing runs for `normal` windows. Elsewhere the window only opens inactive.
use crate::protocol::WindowActivation;
use winit::window::Window;

/// Whether the window is shown activated (winit `with_active`).
pub(super) fn activates_on_show(mode: WindowActivation) -> bool {
    mode == WindowActivation::Normal
}

/// The non-activating state a window moves to when an editable field gains (`editing`) or
/// loses focus, or `None` when it stays as it is.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(super) fn next_no_activate(
    mode: WindowActivation,
    no_activate: bool,
    editing: bool,
) -> Option<bool> {
    (mode == WindowActivation::WhileEditing && no_activate == editing).then_some(!editing)
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{WindowActivation, next_no_activate};
    use std::cell::Cell;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GWL_EXSTYLE, GetForegroundWindow, GetPropW, GetWindowLongPtrW, IsWindow, IsWindowVisible,
        MA_NOACTIVATE, RemovePropW, STYLESTRUCT, SetForegroundWindow, SetPropW, SetWindowLongPtrW,
        WM_LBUTTONDOWN, WM_MBUTTONDOWN, WM_MOUSEACTIVATE, WM_NCDESTROY, WM_RBUTTONDOWN,
        WM_STYLECHANGING, WM_XBUTTONDOWN, WS_EX_NOACTIVATE,
    };
    use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};

    const SUBCLASS_ID: usize = 0x7a20;
    /// Window property holding the window's `State` ("TarveActivation", UTF-16, NUL-terminated);
    /// `GetWindowSubclass` is exported from comctl32 by ordinal only.
    const STATE_PROP: &[u16] = &[
        b'T' as u16,
        b'a' as u16,
        b'r' as u16,
        b'v' as u16,
        b'e' as u16,
        b'A' as u16,
        b'c' as u16,
        b't' as u16,
        b'i' as u16,
        b'v' as u16,
        b'a' as u16,
        b't' as u16,
        b'i' as u16,
        b'o' as u16,
        b'n' as u16,
        0,
    ];
    const WM_POINTERDOWN: u32 = 0x0246;
    /// How recent a press must be for a field's focus to count as the user's click.
    const PRESS_WINDOW_MS: u32 = 1000;

    /// Per window, owned by the subclass (its reference data) and freed with the window.
    pub(super) struct State {
        no_activate: Cell<bool>,
        /// `GetTickCount` of the last button press in the window.
        last_press: Cell<Option<u32>>,
        /// The window that had the foreground before the window took it for typing.
        previous: Cell<HWND>,
    }

    pub(super) fn hwnd(window: &winit::window::Window) -> Option<HWND> {
        match window.window_handle().ok()?.as_raw() {
            RawWindowHandle::Win32(handle) => Some(handle.hwnd.get() as HWND),
            _ => None,
        }
    }

    fn with_style(style: u32, no_activate: bool) -> u32 {
        if no_activate {
            style | WS_EX_NOACTIVATE
        } else {
            style & !WS_EX_NOACTIVATE
        }
    }

    fn set_style(hwnd: HWND, no_activate: bool) {
        unsafe {
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            let next = with_style(style, no_activate);
            if next != style {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next as isize);
            }
        }
    }

    unsafe extern "system" fn proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _: usize,
        data: usize,
    ) -> LRESULT {
        let state = unsafe { &*(data as *const State) };
        match message {
            // winit rewrites the extended style whenever its window state changes.
            WM_STYLECHANGING if wparam as i32 == GWL_EXSTYLE => {
                let styles = lparam as *mut STYLESTRUCT;
                unsafe {
                    (*styles).styleNew = with_style((*styles).styleNew, state.no_activate.get())
                };
            }
            WM_MOUSEACTIVATE if state.no_activate.get() => return MA_NOACTIVATE as LRESULT,
            WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_XBUTTONDOWN | WM_POINTERDOWN => {
                state.last_press.set(Some(unsafe { GetTickCount() }));
            }
            WM_NCDESTROY => unsafe {
                RemoveWindowSubclass(hwnd, Some(proc), SUBCLASS_ID);
                RemovePropW(hwnd, STATE_PROP.as_ptr());
                drop(Box::from_raw(data as *mut State));
            },
            _ => {}
        }
        unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
    }

    pub(super) fn install_hwnd(hwnd: HWND, mode: WindowActivation) {
        if mode == WindowActivation::Normal || state(hwnd).is_some() {
            return;
        }
        let state = Box::into_raw(Box::new(State {
            no_activate: Cell::new(true),
            last_press: Cell::new(None),
            previous: Cell::new(std::ptr::null_mut()),
        }));
        if unsafe { SetWindowSubclass(hwnd, Some(proc), SUBCLASS_ID, state as usize) } == 0 {
            drop(unsafe { Box::from_raw(state) });
            return;
        }
        unsafe { SetPropW(hwnd, STATE_PROP.as_ptr(), state.cast()) };
        set_style(hwnd, true);
    }

    pub(super) fn state<'a>(hwnd: HWND) -> Option<&'a State> {
        let data = unsafe { GetPropW(hwnd, STATE_PROP.as_ptr()) } as *const State;
        (!data.is_null()).then(|| unsafe { &*data })
    }

    pub(super) fn editing_changed_hwnd(hwnd: HWND, mode: WindowActivation, editing: bool) {
        let Some(state) = state(hwnd) else {
            return;
        };
        let Some(no_activate) = next_no_activate(mode, state.no_activate.get(), editing) else {
            return;
        };
        state.no_activate.set(no_activate);
        set_style(hwnd, no_activate);
        unsafe {
            let foreground = GetForegroundWindow();
            if !no_activate {
                // Only the click that focused the field activates: focus set by the app
                // (autoFocus, `focus()`) leaves the foreground alone.
                let pressed = state
                    .last_press
                    .get()
                    .is_some_and(|tick| GetTickCount().wrapping_sub(tick) <= PRESS_WINDOW_MS);
                if pressed && foreground != hwnd {
                    state.previous.set(foreground);
                    SetForegroundWindow(hwnd);
                }
            } else {
                let previous = state.previous.replace(std::ptr::null_mut());
                if foreground == hwnd
                    && !previous.is_null()
                    && IsWindow(previous) != 0
                    && IsWindowVisible(previous) != 0
                {
                    SetForegroundWindow(previous);
                }
            }
        }
    }

    #[cfg(test)]
    pub(super) fn no_activate(hwnd: HWND) -> bool {
        unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_NOACTIVATE != 0 }
    }
}

/// Makes a `never`/`whileEditing` window non-activating; call once, after creation.
pub(super) fn install(window: &Window, mode: WindowActivation) {
    #[cfg(target_os = "windows")]
    if mode != WindowActivation::Normal
        && let Some(hwnd) = platform::hwnd(window)
    {
        platform::install_hwnd(hwnd, mode);
    }
    #[cfg(not(target_os = "windows"))]
    let _ = (window, mode);
}

/// An editable field gained (`editing`) or lost focus: a `whileEditing` window becomes
/// activatable (activated by the click that focused it) or non-activating again.
pub(super) fn editing_changed(window: &Window, mode: WindowActivation, editing: bool) {
    if mode != WindowActivation::WhileEditing {
        return;
    }
    #[cfg(target_os = "windows")]
    if let Some(hwnd) = platform::hwnd(window) {
        platform::editing_changed_hwnd(hwnd, mode, editing);
    }
    #[cfg(not(target_os = "windows"))]
    let _ = (window, editing);
}

/// Where the keyboard focus went when a window lost it: another window of this app (`"main"`
/// for the first one, else its `openWindow` id) and, when the pointer is over that window, the
/// node a press there reaches. A menu window that closes on blur learns that the click which
/// took its focus landed on its own anchor in the dock, and need not reopen.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct FocusHandoff {
    pub(super) to: String,
    pub(super) pointer_target: Option<String>,
}

/// The `windowFocus` event of a window that lost the focus.
pub(super) fn blur_event(handoff: Option<FocusHandoff>) -> serde_json::Value {
    let mut event = serde_json::json!({"type":"windowFocus", "focused":false});
    if let Some(handoff) = handoff {
        event["to"] = handoff.to.into();
        if let Some(target) = handoff.pointer_target {
            event["pointerTarget"] = target.into();
        }
    }
    event
}

/// The window that has the foreground now (Windows); `None` elsewhere.
pub(super) fn foreground_window() -> Option<usize> {
    #[cfg(target_os = "windows")]
    {
        let hwnd = unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow() };
        (!hwnd.is_null()).then_some(hwnd as usize)
    }
    #[cfg(not(target_os = "windows"))]
    None
}

/// The native handle `foreground_window` compares with (the HWND on Windows).
pub(super) fn window_key(window: &Window) -> Option<usize> {
    #[cfg(target_os = "windows")]
    {
        platform::hwnd(window).map(|hwnd| hwnd as usize)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blur_event_names_the_window_and_node_that_took_the_focus() {
        assert_eq!(
            blur_event(None),
            serde_json::json!({"type":"windowFocus", "focused":false})
        );
        assert_eq!(
            blur_event(Some(FocusHandoff {
                to: "dock".into(),
                pointer_target: Some("menu-anchor".into()),
            })),
            serde_json::json!({"type":"windowFocus", "focused":false, "to":"dock", "pointerTarget":"menu-anchor"})
        );
        assert_eq!(
            blur_event(Some(FocusHandoff {
                to: "main".into(),
                pointer_target: None,
            })),
            serde_json::json!({"type":"windowFocus", "focused":false, "to":"main"})
        );
    }

    #[test]
    fn only_while_editing_windows_toggle_with_editable_focus() {
        use WindowActivation::*;
        assert!(activates_on_show(Normal));
        assert!(!activates_on_show(Never));
        assert!(!activates_on_show(WhileEditing));
        assert_eq!(next_no_activate(WhileEditing, true, true), Some(false));
        assert_eq!(next_no_activate(WhileEditing, false, false), Some(true));
        assert_eq!(
            next_no_activate(WhileEditing, false, true),
            None,
            "input to input"
        );
        assert_eq!(next_no_activate(WhileEditing, true, false), None);
        assert_eq!(next_no_activate(Never, true, true), None);
        assert_eq!(next_no_activate(Normal, false, true), None);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn no_activate_style_survives_rewrites_and_follows_editing() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, GWL_EXSTYLE, GetWindowLongPtrW, SetWindowLongPtrW,
            WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_POPUP,
        };
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        let hwnd = unsafe {
            CreateWindowExW(
                WS_EX_TOOLWINDOW,
                class.as_ptr(),
                std::ptr::null(),
                WS_POPUP,
                0,
                0,
                1,
                1,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        };
        assert!(!hwnd.is_null());
        platform::install_hwnd(hwnd, WindowActivation::WhileEditing);
        assert!(platform::no_activate(hwnd));
        // A rewrite without the bit (winit applying its window flags) keeps it.
        unsafe {
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (style & !WS_EX_NOACTIVATE) as isize);
        }
        assert!(platform::no_activate(hwnd));
        // No press in the window: the field's focus makes it activatable without activating.
        platform::editing_changed_hwnd(hwnd, WindowActivation::WhileEditing, true);
        assert!(!platform::no_activate(hwnd));
        unsafe {
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (style | WS_EX_NOACTIVATE) as isize);
        }
        assert!(!platform::no_activate(hwnd), "editing keeps it activatable");
        platform::editing_changed_hwnd(hwnd, WindowActivation::WhileEditing, false);
        assert!(platform::no_activate(hwnd));
        unsafe { DestroyWindow(hwnd) };
    }
}
