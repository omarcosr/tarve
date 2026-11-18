//! A message window's tree: its top window (a child of `parent` when given) and the `children`
//! made on its thread under it (a replacement Shell_TrayWnd's TrayNotifyWnd, SysPager,
//! ToolbarWindow32, ...), all answering from one reply table on that thread, without JavaScript.
//! A table entry answers a message to one window of the tree: any of it, only the one with a
//! given wParam, or (WM_COPYDATA) only the one whose COPYDATASTRUCT dwData matches, e.g. the
//! tray's NIM_* (dwData 1) answered 1 while its copied payload still reaches JavaScript.
use super::payload::WM_COPYDATA;
use super::{MessageName, resolve, wide};
use serde::Deserialize;
use std::{collections::HashMap, ffi::c_void, ptr, sync::Mutex};
use windows_sys::Win32::{
    Foundation::{GetLastError, HWND, LPARAM, WPARAM},
    UI::WindowsAndMessaging::{
        CreateWindowExW, HWND_MESSAGE, RegisterClassExW, UnregisterClassW, WNDCLASSEXW, WNDPROC,
        WS_CHILD, WS_POPUP,
    },
};

const MAX_WINDOWS: usize = 256;
const MAX_DEPTH: usize = 16;
const MAX_REPLIES: usize = 4096;
const ERROR_CLASS_ALREADY_EXISTS: u32 = 1410;

/// A fixed answer: `[message, value]`, or `[message, value, kind, key]` for only wParam `key`
/// (kind 1) or only WM_COPYDATA dwData `key` (kind 2), the key a decimal string (a u64).
#[derive(Deserialize, Clone)]
#[serde(untagged)]
pub(crate) enum ReplyEntry {
    Keyed(MessageName, i64, u32, String),
    Plain(MessageName, i64),
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) enum Key {
    WParam(u64),
    CopyData(u64),
}

impl Key {
    /// `kind` 0: no key (any wParam); 1: wParam; 2: WM_COPYDATA dwData.
    pub(crate) fn of(kind: u32, key: u64) -> Result<Option<Key>, String> {
        match kind {
            0 => Ok(None),
            1 => Ok(Some(Key::WParam(key))),
            2 => Ok(Some(Key::CopyData(key))),
            _ => Err(format!("Unknown reply key kind {kind}")),
        }
    }
}

/// The reply table of every window of a tree.
#[derive(Default)]
pub(crate) struct Replies {
    plain: HashMap<(usize, u32), isize>,
    keyed: HashMap<(usize, u32, Key), isize>,
}

impl Replies {
    /// Sets (`Some`) or clears the answer to `message` sent to `hwnd`.
    pub(crate) fn set(
        &mut self,
        hwnd: usize,
        message: u32,
        key: Option<Key>,
        value: Option<isize>,
    ) {
        match (key, value) {
            (None, Some(value)) => drop(self.plain.insert((hwnd, message), value)),
            (None, None) => drop(self.plain.remove(&(hwnd, message))),
            (Some(key), Some(value)) => drop(self.keyed.insert((hwnd, message, key), value)),
            (Some(key), None) => drop(self.keyed.remove(&(hwnd, message, key))),
        }
    }

    /// The answer to this message to `hwnd`: by dwData, then by wParam, then by message alone.
    ///
    /// # Safety
    /// `lparam` is the message's own: a COPYDATASTRUCT valid during the call for WM_COPYDATA.
    pub(crate) unsafe fn get(
        &self,
        hwnd: usize,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> Option<isize> {
        if !self.keyed.is_empty() {
            if message == WM_COPYDATA && lparam != 0 {
                // SAFETY: dwData is COPYDATASTRUCT's first field.
                let data = unsafe { *(lparam as *const usize) } as u64;
                if let Some(value) = self.keyed.get(&(hwnd, message, Key::CopyData(data))) {
                    return Some(*value);
                }
            }
            if let Some(value) = self.keyed.get(&(hwnd, message, Key::WParam(wparam as u64))) {
                return Some(*value);
            }
        }
        self.plain.get(&(hwnd, message)).copied()
    }

    /// Adds `entries` as answers of `hwnd`.
    pub(crate) fn fill(
        &mut self,
        hwnd: usize,
        entries: &[ReplyEntry],
        named: &mut HashMap<String, u32>,
    ) -> Result<(), String> {
        for entry in entries {
            let (name, value, key) = match entry {
                ReplyEntry::Plain(name, value) => (name, *value, None),
                ReplyEntry::Keyed(name, value, kind, key) => {
                    let key = key
                        .parse::<u64>()
                        .map_err(|_| format!("Reply key \"{key}\" is not a u64"))?;
                    (name, *value, Key::of(*kind, key)?)
                }
            };
            let id = resolve(std::slice::from_ref(name), named)?[0];
            self.set(hwnd, id, key, Some(value as isize));
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Child {
    pub class_name: String,
    pub window_name: Option<String>,
    pub style: Option<u32>,
    pub ex_style: Option<u32>,
    #[serde(default)]
    pub replies: Vec<ReplyEntry>,
    #[serde(default)]
    pub children: Vec<Child>,
}

/// Checks a tree's size before its thread starts: windows, depth and reply entries.
pub(crate) fn check(children: &[Child]) -> Result<(), String> {
    fn walk(children: &[Child], depth: usize, totals: &mut (usize, usize)) -> Result<(), String> {
        if !children.is_empty() && depth > MAX_DEPTH {
            return Err(format!(
                "messageWindow children nest at most {MAX_DEPTH} deep"
            ));
        }
        for child in children {
            totals.0 += 1;
            totals.1 += child.replies.len();
            walk(&child.children, depth + 1, totals)?;
        }
        Ok(())
    }
    let mut totals = (0, 0);
    walk(children, 1, &mut totals)?;
    if totals.0 > MAX_WINDOWS {
        return Err(format!(
            "messageWindow takes at most {MAX_WINDOWS} children"
        ));
    }
    if totals.1 > MAX_REPLIES {
        return Err(format!(
            "messageWindow children take at most {MAX_REPLIES} replies"
        ));
    }
    Ok(())
}

/// The top window's parent and style: a WS_CHILD of `parent`, a message-only window, or a
/// hidden top-level one.
pub(crate) fn top(
    message_only: bool,
    parent: Option<u64>,
    style: Option<u32>,
) -> Result<(HWND, u32), String> {
    match parent {
        Some(_) if message_only => {
            Err("messageWindow: parent and messageOnly exclude each other".into())
        }
        Some(0) => Err("messageWindow: parent must be a window handle".into()),
        Some(parent) => Ok((parent as usize as HWND, style.unwrap_or(0) | WS_CHILD)),
        None if message_only => Ok((HWND_MESSAGE, style.unwrap_or(WS_POPUP))),
        None => Ok((ptr::null_mut(), style.unwrap_or(WS_POPUP))),
    }
}

/// The window classes a tree's children registered: unregistered on drop, after the windows are
/// gone (the top window's DestroyWindow takes its children along).
pub(crate) struct Classes {
    instance: *mut c_void,
    names: Vec<(String, Vec<u16>)>,
}

impl Classes {
    pub(crate) fn new(instance: *mut c_void) -> Self {
        Self {
            instance,
            names: Vec::new(),
        }
    }
}

impl Drop for Classes {
    fn drop(&mut self) {
        for (_, class) in self.names.drain(..) {
            // SAFETY: a class this tree registered, whose windows are destroyed.
            unsafe { UnregisterClassW(class.as_ptr(), self.instance) };
        }
    }
}

/// What making a tree's children needs from the top window's setup.
pub(crate) struct Build<'a> {
    pub proc: WNDPROC,
    /// The top window's class (children may share it).
    pub top_class: &'a [u16],
    pub classes: &'a mut Classes,
    pub replies: &'a Mutex<Replies>,
    pub named: &'a mut HashMap<String, u32>,
}

impl Build<'_> {
    /// Registers `name` for this tree unless it or the top window already did (names compare
    /// without case, as Windows does).
    fn class(&mut self, name: &str) -> Result<Vec<u16>, String> {
        if name.is_empty() || name.len() > 255 || name.contains('\0') {
            return Err("A child's className must be 1-255 characters".into());
        }
        let class = wide(name);
        let folded = name.to_lowercase();
        let top = String::from_utf16_lossy(&self.top_class[..self.top_class.len() - 1]);
        if top.to_lowercase() == folded || self.classes.names.iter().any(|(n, _)| *n == folded) {
            return Ok(class);
        }
        // SAFETY: a zeroed WNDCLASSEXW is valid; the name outlives the class (Classes owns it).
        unsafe {
            let mut info: WNDCLASSEXW = std::mem::zeroed();
            info.cbSize = std::mem::size_of::<WNDCLASSEXW>() as u32;
            info.lpfnWndProc = self.proc;
            info.hInstance = self.classes.instance;
            info.lpszClassName = class.as_ptr();
            if RegisterClassExW(&info) == 0 {
                let error = GetLastError();
                return Err(if error == ERROR_CLASS_ALREADY_EXISTS {
                    format!("The window class \"{name}\" is already registered in this process")
                } else {
                    format!("RegisterClassExW(\"{name}\") failed (Windows error {error})")
                });
            }
        }
        self.classes.names.push((folded, class.clone()));
        Ok(class)
    }

    /// Makes `children` under `parent`, depth first; each one's description lands in `info`.
    pub(crate) fn create(
        &mut self,
        children: &[Child],
        parent: HWND,
        info: &mut Vec<serde_json::Value>,
    ) -> Result<(), String> {
        for child in children {
            let class = self.class(&child.class_name)?;
            let title = wide(child.window_name.as_deref().unwrap_or(""));
            // SAFETY: NUL-terminated names; a live parent made on this thread.
            let hwnd = unsafe {
                CreateWindowExW(
                    child.ex_style.unwrap_or(0),
                    class.as_ptr(),
                    title.as_ptr(),
                    child.style.unwrap_or(0) | WS_CHILD,
                    0,
                    0,
                    0,
                    0,
                    parent,
                    (info.len() + 1) as *mut c_void,
                    self.classes.instance,
                    ptr::null(),
                )
            };
            if hwnd.is_null() {
                return Err(format!(
                    "CreateWindowExW(\"{}\") failed (Windows error {})",
                    child.class_name,
                    unsafe { GetLastError() }
                ));
            }
            self.replies
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .fill(hwnd as usize, &child.replies, self.named)?;
            info.push(serde_json::json!({
                "hwnd": (hwnd as u64).to_string(),
                "parent": (parent as u64).to_string(),
                "className": child.class_name,
                "windowName": child.window_name.as_deref().unwrap_or(""),
            }));
            self.create(&child.children, hwnd, info)?;
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "tree_tests.rs"]
mod tests;
