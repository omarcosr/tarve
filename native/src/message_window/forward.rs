//! What a message window does natively for a window that stands in for another process's (a
//! replacement tray in Explorer's place): message ranges it delivers, messages it sends on to that
//! other window (its twin) and answers with the twin's answer, icons it reads before the sender
//! gets its answer, and keeping the top window the first of its class. All on the window's thread.
use super::payload::{CopyData, WM_COPYDATA};
use super::{MAX_MESSAGES, MessageName, Options, icon, resolve, wide};
use serde::Deserialize;
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    ptr,
};
use windows_sys::Win32::{
    Foundation::{GetLastError, HWND, LPARAM, LRESULT, WPARAM},
    UI::WindowsAndMessaging::{
        FindWindowExW, HICON, HWND_TOPMOST, SMTO_ABORTIFHUNG, SMTO_BLOCK, SWP_NOACTIVATE,
        SWP_NOMOVE, SWP_NOSIZE, SendMessageTimeoutW, SetTimer, SetWindowPos, WM_TIMER,
    },
};

const MAX_RANGES: usize = 64;
const MAX_ICON_SOURCES: usize = 64;
const DEFAULT_FORWARD_TIMEOUT_MS: u32 = 2_000;
const MAX_FORWARD_TIMEOUT_MS: u32 = 10_000;
/// The keepFirst timer's id (WM_TIMER wParam) on the top window.
const KEEP_FIRST_TIMER: usize = 0x7461_7276;

/// Messages sent on, natively, to the twin of the window that got them (see [`Relay::twin`]),
/// whose answer becomes theirs.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Forward {
    #[serde(default)]
    pub messages: Vec<MessageName>,
    #[serde(default)]
    pub ranges: Vec<[u32; 2]>,
    pub timeout: Option<u32>,
}

/// Where a message carries an icon whose pixels reach JavaScript (read before the answer).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct IconSource {
    pub message: MessageName,
    /// WM_COPYDATA: only this dwData (a decimal u64).
    pub dw_data: Option<String>,
    /// The handle: lParam (None), or a 32-bit handle at this byte offset of WM_COPYDATA's data.
    pub offset: Option<u32>,
    /// Only when the u32 at this offset of WM_COPYDATA's data has any of these bits: [offset, mask].
    pub when: Option<[u32; 2]>,
}

struct Icon {
    message: u32,
    dw_data: Option<u64>,
    offset: Option<u32>,
    when: Option<[u32; 2]>,
}

fn within(ranges: &[[u32; 2]], message: u32) -> bool {
    ranges
        .iter()
        .any(|[min, max]| (*min..=*max).contains(&message))
}

fn check_ranges(ranges: &[[u32; 2]], what: &str) -> Result<(), String> {
    if ranges.len() > MAX_RANGES {
        return Err(format!("messageWindow takes at most {MAX_RANGES} {what}"));
    }
    if ranges.iter().any(|[min, max]| min > max) {
        return Err(format!(
            "messageWindow: every range of {what} needs min <= max"
        ));
    }
    Ok(())
}

/// Checks the options this module reads before the window's thread starts.
pub(super) fn check(options: &Options) -> Result<(), String> {
    check_ranges(&options.message_ranges, "messageRanges")?;
    if let Some(forward) = &options.forward {
        check_ranges(&forward.ranges, "forward ranges")?;
        if forward.messages.len() > MAX_MESSAGES {
            return Err(format!(
                "messageWindow forwards at most {MAX_MESSAGES} messages"
            ));
        }
    }
    if options.icons.len() > MAX_ICON_SOURCES {
        return Err(format!(
            "messageWindow takes at most {MAX_ICON_SOURCES} icons"
        ));
    }
    if options.keep_first.is_some() && (options.message_only || options.parent.is_some()) {
        return Err(
            "messageWindow: keepFirst needs a top-level window (no messageOnly, no parent)".into(),
        );
    }
    Ok(())
}

/// The window's relay state, on its own thread.
pub(super) struct Relay {
    ranges: Vec<[u32; 2]>,
    forward: Vec<u32>,
    forward_ranges: Vec<[u32; 2]>,
    timeout: u32,
    icons: Vec<Icon>,
    keep_first: Option<u32>,
    /// Each window of the tree's class path from the top window (to find its twin).
    paths: RefCell<HashMap<usize, Vec<Vec<u16>>>>,
    top: Cell<usize>,
    /// Window procedures of this thread running one inside another (see [`Relay::forwarded`]).
    pub(super) depth: Cell<u32>,
}

impl Relay {
    /// Takes this module's options, their registered message names resolved into `named`.
    pub(super) fn new(
        options: &mut Options,
        named: &mut HashMap<String, u32>,
    ) -> Result<Self, String> {
        let forward = options.forward.take().unwrap_or_default();
        let mut icons = Vec::with_capacity(options.icons.len());
        for source in &options.icons {
            let dw_data = match &source.dw_data {
                Some(key) => Some(
                    key.parse::<u64>()
                        .map_err(|_| format!("Icon dwData \"{key}\" is not a u64"))?,
                ),
                None => None,
            };
            icons.push(Icon {
                message: resolve(std::slice::from_ref(&source.message), named)?[0],
                dw_data,
                offset: source.offset,
                when: source.when,
            });
        }
        Ok(Self {
            ranges: std::mem::take(&mut options.message_ranges),
            forward: resolve(&forward.messages, named)?,
            forward_ranges: forward.ranges,
            timeout: forward
                .timeout
                .unwrap_or(DEFAULT_FORWARD_TIMEOUT_MS)
                .clamp(1, MAX_FORWARD_TIMEOUT_MS),
            icons,
            keep_first: options.keep_first,
            paths: RefCell::new(HashMap::new()),
            top: Cell::new(0),
            depth: Cell::new(0),
        })
    }

    /// Notes the tree (`children` as the info describes them, depth first) and starts keepFirst.
    pub(super) fn start(
        &self,
        top: HWND,
        class: &[u16],
        children: &[serde_json::Value],
    ) -> Result<(), String> {
        {
            let mut paths = self.paths.borrow_mut();
            paths.insert(top as usize, vec![class.to_vec()]);
            // Depth first: a parent's path is there before its children's.
            for child in children {
                let number = |key: &str| {
                    child[key]
                        .as_str()
                        .and_then(|text| text.parse::<usize>().ok())
                        .unwrap_or(0)
                };
                let mut path = paths.get(&number("parent")).cloned().unwrap_or_default();
                path.push(wide(child["className"].as_str().unwrap_or("")));
                paths.insert(number("hwnd"), path);
            }
        }
        self.top.set(top as usize);
        let Some(interval) = self.keep_first else {
            return Ok(());
        };
        // Windows tells nobody when a hidden window loses its z-order place (no message, no
        // WinEvent), so a native timer on this thread checks it; JavaScript is never woken.
        self.keep_first(top);
        // SAFETY: this thread's own window; the timer goes with it.
        if unsafe { SetTimer(top, KEEP_FIRST_TIMER, interval.clamp(50, 60_000), None) } == 0 {
            return Err(format!("SetTimer failed (Windows error {})", unsafe {
                GetLastError()
            }));
        }
        Ok(())
    }

    /// Whether `message` is in the delivered ranges.
    pub(super) fn delivers(&self, message: u32) -> bool {
        within(&self.ranges, message)
    }

    /// Handles the keepFirst timer: true when this was it.
    pub(super) fn timer(&self, hwnd: HWND, message: u32, wparam: WPARAM) -> bool {
        let mine =
            message == WM_TIMER && wparam == KEEP_FIRST_TIMER && hwnd as usize == self.top.get();
        if mine {
            self.keep_first(hwnd);
        }
        mine
    }

    /// The twin's answer to `message` when it is forwarded: 0 when there is no twin or it does not
    /// answer within the timeout.
    pub(super) fn forwarded(
        &self,
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> Option<LRESULT> {
        if self.forward.binary_search(&message).is_err() && !within(&self.forward_ranges, message) {
            return None;
        }
        let target = self.twin(hwnd);
        if target.is_null() {
            return Some(0);
        }
        // While it waits, SendMessageTimeoutW runs the messages sent to this thread, so a burst
        // (every app re-adding its tray icon at once) would nest forwards ever deeper. A forward
        // made inside another one waits without running them (SMTO_BLOCK): their senders queue.
        let flags = if self.depth.get() > 1 {
            SMTO_ABORTIFHUNG | SMTO_BLOCK
        } else {
            SMTO_ABORTIFHUNG
        };
        let mut result = 0usize;
        // SAFETY: Windows marshals the message's own arguments (WM_COPYDATA across processes too).
        let sent = unsafe {
            SendMessageTimeoutW(
                target,
                message,
                wparam,
                lparam,
                flags,
                self.timeout,
                &mut result,
            )
        };
        Some(if sent == 0 { 0 } else { result as LRESULT })
    }

    /// The window another process made in the place of `hwnd`: the first top-level window of the
    /// top window's class that is not this tree's (in z-order), then down the same class path as
    /// `hwnd` under it. Looked up at each message, so a restarted shell is found again.
    fn twin(&self, hwnd: HWND) -> HWND {
        let paths = self.paths.borrow();
        let Some(path) = paths.get(&(hwnd as usize)) else {
            return ptr::null_mut();
        };
        let mut top: HWND = ptr::null_mut();
        // SAFETY: NUL-terminated class names; FindWindowExW checks the handles.
        unsafe {
            loop {
                top = FindWindowExW(ptr::null_mut(), top, path[0].as_ptr(), ptr::null());
                if top.is_null() || !paths.contains_key(&(top as usize)) {
                    break;
                }
            }
            let mut at = top;
            for class in &path[1..] {
                if at.is_null() {
                    break;
                }
                at = FindWindowExW(at, ptr::null_mut(), class.as_ptr(), ptr::null());
            }
            at
        }
    }

    /// The pixels of the icon `message` carries, per `icons`.
    pub(super) fn icon(&self, message: u32, lparam: LPARAM) -> Option<(u32, u32, Vec<u8>)> {
        for source in self.icons.iter().filter(|source| source.message == message) {
            // SAFETY: WM_COPYDATA's lParam is a COPYDATASTRUCT valid during this call.
            let copy = (message == WM_COPYDATA && lparam != 0)
                .then(|| unsafe { &*(lparam as *const CopyData) });
            if source.dw_data.is_some()
                && copy.is_none_or(|copy| Some(copy.data as u64) != source.dw_data)
            {
                continue;
            }
            let field = |at: u32| -> Option<u32> {
                let copy = copy?;
                (!copy.bytes.is_null() && at as usize + 4 <= copy.length as usize).then(|| {
                    // SAFETY: inside the cbData bytes lpData points to.
                    unsafe { ptr::read_unaligned(copy.bytes.add(at as usize).cast::<u32>()) }
                })
            };
            if let Some([at, mask]) = source.when
                && field(at).is_none_or(|value| value & mask == 0)
            {
                continue;
            }
            // Handles are 32-bit values, sign-extended (as Windows does across 32/64-bit processes).
            let handle = match source.offset {
                None => lparam,
                Some(at) => match field(at) {
                    Some(value) => value as i32 as isize,
                    None => continue,
                },
            };
            if handle != 0 {
                return icon::rgba(handle as HICON);
            }
        }
        None
    }

    /// Makes the top window the first of its class again (FindWindow returns that one), when
    /// another took its place.
    fn keep_first(&self, hwnd: HWND) {
        let paths = self.paths.borrow();
        let Some(path) = paths.get(&(hwnd as usize)) else {
            return;
        };
        // SAFETY: a NUL-terminated class name; this thread's own window.
        unsafe {
            let first = FindWindowExW(
                ptr::null_mut(),
                ptr::null_mut(),
                path[0].as_ptr(),
                ptr::null(),
            );
            if first != hwnd {
                SetWindowPos(
                    hwnd,
                    HWND_TOPMOST,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE,
                );
            }
        }
    }
}
