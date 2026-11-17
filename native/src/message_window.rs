//! Message windows (`messageWindow` in @tarve/core, Windows): a hidden window on its own native
//! thread, pumping its own message loop, that hands the messages, WinEvents, shell hook
//! notifications and registry/folder changes JavaScript asked for to a threadsafe callback
//! (native/src/threadsafe.rs), in the order they happened. JavaScript never polls and never runs on
//! this thread.
//!
//! A window message is answered at once (its LRESULT): with JavaScript's answer when the message is
//! listed in `waitReplies` and its sender waits (`SendMessage`), bounded by `replyTimeout`; else
//! with the value the reply table holds for it (`replies`, changed from JavaScript at any time;
//! it also answers messages JavaScript does not get); else as `DefWindowProcW` does. While it
//! waits for JavaScript this thread pumps nothing: a sender on the JavaScript thread itself gets
//! the table value after the timeout, never a deadlock.
use crate::threadsafe;
use serde::Deserialize;
use std::{
    cell::{Cell, OnceCell},
    collections::HashMap,
    ffi::c_void,
    ptr,
    sync::{
        Arc, Condvar, Mutex, OnceLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, GetLastError, HANDLE, HWND, INVALID_HANDLE_VALUE, LPARAM, LRESULT, WAIT_OBJECT_0,
        WPARAM,
    },
    Storage::FileSystem::{
        FindCloseChangeNotification, FindFirstChangeNotificationW, FindNextChangeNotification,
    },
    System::{
        LibraryLoader::GetModuleHandleW,
        Registry::{
            HKEY, HKEY_CLASSES_ROOT, HKEY_CURRENT_CONFIG, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE,
            HKEY_USERS, KEY_NOTIFY, RegCloseKey, RegNotifyChangeKeyValue, RegOpenKeyExW,
        },
        Threading::{CreateEventW, INFINITE, SetEvent},
    },
    UI::{
        WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DeregisterShellHookWindow, DestroyWindow, RegisterShellHookWindow, DispatchMessageW, HWND_MESSAGE,
            ISMEX_NOTIFY, ISMEX_REPLIED, InSendMessageEx, MSG, MWMO_INPUTAVAILABLE,
            MsgWaitForMultipleObjectsEx, PM_REMOVE, PeekMessageW, QS_ALLINPUT, RegisterClassExW,
            RegisterWindowMessageW, UnregisterClassW, WM_CLOSE, WNDCLASSEXW, WS_EX_NOACTIVATE,
            WS_EX_TOOLWINDOW, WS_POPUP,
        },
    },
};

/// Record kinds: the first argument of every call the callback gets.
pub(crate) const KIND_MESSAGE: u64 = 1;
pub(crate) const KIND_WIN_EVENT: u64 = 2;
pub(crate) const KIND_SHELL: u64 = 3;
pub(crate) const KIND_REGISTRY: u64 = 4;
pub(crate) const KIND_FOLDER: u64 = 5;

/// Registry keys and folders one window watches (MsgWaitForMultipleObjects takes 63 handles,
/// one is the stop event).
const MAX_WATCHES: usize = 62;
const MAX_WIN_EVENTS: usize = 64;
const MAX_MESSAGES: usize = 4096;
const MAX_REPLY_TIMEOUT_MS: u32 = 5_000;
const DEFAULT_REPLY_TIMEOUT_MS: u32 = 50;
/// Messages dispatched before the stop event and the watches are looked at again.
const PUMP_BATCH: usize = 256;

const WM_SETTINGCHANGE: u32 = 0x001A;
const WM_COPYDATA: u32 = 0x004A;
const WM_POWERBROADCAST: u32 = 0x0218;
const WM_DEVICECHANGE: u32 = 0x0219;
const PBT_POWERSETTINGCHANGE: usize = 0x8013;
const WINEVENT_OUTOFCONTEXT: u32 = 0;
const ERROR_CLASS_ALREADY_EXISTS: u32 = 1410;

type WinEventProc = unsafe extern "system" fn(*mut c_void, u32, HWND, i32, i32, u32, u32);
// Win32_UI_Accessibility is not among windows-sys's enabled features; these two are all it needs.
#[link(name = "user32")]
unsafe extern "system" {
    fn SetWinEventHook(
        min: u32,
        max: u32,
        module: *mut c_void,
        callback: Option<WinEventProc>,
        process: u32,
        thread: u32,
        flags: u32,
    ) -> *mut c_void;
    fn UnhookWinEvent(hook: *mut c_void) -> i32;
}

#[derive(Deserialize, Clone)]
#[serde(untagged)]
pub(crate) enum MessageName {
    Id(u32),
    Name(String),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WinEventHook {
    pub min: u32,
    pub max: Option<u32>,
    #[serde(default)]
    pub process: u32,
    #[serde(default)]
    pub thread: u32,
    #[serde(default)]
    pub flags: u32,
}

#[derive(Deserialize)]
pub(crate) struct RegistryWatch {
    pub key: String,
    #[serde(default)]
    pub subtree: bool,
    pub filter: Option<u32>,
}

#[derive(Deserialize)]
pub(crate) struct FolderWatch {
    pub path: String,
    #[serde(default)]
    pub subtree: bool,
    pub filter: Option<u32>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Options {
    pub class_name: Option<String>,
    pub window_name: Option<String>,
    #[serde(default)]
    pub message_only: bool,
    pub style: Option<u32>,
    pub ex_style: Option<u32>,
    #[serde(default)]
    pub messages: Vec<MessageName>,
    #[serde(default)]
    pub wait_replies: Vec<MessageName>,
    pub reply_timeout: Option<u32>,
    #[serde(default)]
    pub replies: Vec<(MessageName, i64)>,
    #[serde(default)]
    pub win_events: Vec<WinEventHook>,
    #[serde(default)]
    pub shell_hook: bool,
    #[serde(default)]
    pub registry: Vec<RegistryWatch>,
    #[serde(default)]
    pub folders: Vec<FolderWatch>,
}

/// What the window's thread and JavaScript's calls share.
struct Shared {
    replies: Mutex<HashMap<u32, isize>>,
    answer: Mutex<Answer>,
    answered: Condvar,
    closing: AtomicBool,
}

#[derive(Default)]
struct Answer {
    /// The message waiting for JavaScript (0: none).
    waiting: u64,
    value: Option<isize>,
}

/// The window's state on its own thread (one window per thread).
struct Local {
    slot: usize,
    messages: Vec<u32>,
    wait: Vec<u32>,
    timeout: Duration,
    shell: u32,
    next: Cell<u64>,
    live: Cell<bool>,
    shared: Arc<Shared>,
}

thread_local! {
    static LOCAL: OnceCell<Local> = const { OnceCell::new() };
}

struct Window {
    shared: Arc<Shared>,
    stop: usize,
    thread: Option<JoinHandle<()>>,
    info: String,
}

fn windows() -> &'static Mutex<HashMap<u64, Window>> {
    static WINDOWS: OnceLock<Mutex<HashMap<u64, Window>>> = OnceLock::new();
    WINDOWS.get_or_init(|| Mutex::new(HashMap::new()))
}
static NEXT_WINDOW: AtomicU64 = AtomicU64::new(1);

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain([0]).collect()
}

fn register_name(name: &str) -> Result<u32, String> {
    if name.is_empty() || name.contains('\0') {
        return Err("A registered message name must be non-empty text".into());
    }
    // SAFETY: a NUL-terminated name.
    let id = unsafe { RegisterWindowMessageW(wide(name).as_ptr()) };
    if id == 0 {
        return Err(format!("RegisterWindowMessageW(\"{name}\") failed (Windows error {})", unsafe { GetLastError() }));
    }
    Ok(id)
}

/// Message ids for names (registered ones through RegisterWindowMessageW), noted in `named`.
fn resolve(names: &[MessageName], named: &mut HashMap<String, u32>) -> Result<Vec<u32>, String> {
    let mut ids = Vec::with_capacity(names.len());
    for name in names {
        ids.push(match name {
            MessageName::Id(id) => *id,
            MessageName::Name(name) => match named.get(name) {
                Some(id) => *id,
                None => {
                    let id = register_name(name)?;
                    named.insert(name.clone(), id);
                    id
                }
            },
        });
    }
    ids.sort_unstable();
    ids.dedup();
    Ok(ids)
}

fn hive(key: &str) -> Result<(HKEY, &str), String> {
    let (root, rest) = key.split_once('\\').unwrap_or((key, ""));
    let hive = match root.to_ascii_uppercase().as_str() {
        "HKCU" | "HKEY_CURRENT_USER" => HKEY_CURRENT_USER,
        "HKLM" | "HKEY_LOCAL_MACHINE" => HKEY_LOCAL_MACHINE,
        "HKCR" | "HKEY_CLASSES_ROOT" => HKEY_CLASSES_ROOT,
        "HKU" | "HKEY_USERS" => HKEY_USERS,
        "HKCC" | "HKEY_CURRENT_CONFIG" => HKEY_CURRENT_CONFIG,
        _ => return Err(format!("Registry key \"{key}\" must start with HKCU, HKLM, HKCR, HKU or HKCC")),
    };
    Ok((hive, rest))
}

enum Watch {
    Registry { key: HKEY, event: HANDLE, subtree: bool, filter: u32 },
    Folder { handle: HANDLE },
}

impl Watch {
    fn handle(&self) -> HANDLE {
        match self {
            Watch::Registry { event, .. } => *event,
            Watch::Folder { handle } => *handle,
        }
    }

    /// Asks for the next change: false once it cannot (the key was deleted, the folder is gone).
    fn arm(&self) -> bool {
        // SAFETY: handles this watch owns.
        unsafe {
            match self {
                Watch::Registry { key, event, subtree, filter } => {
                    RegNotifyChangeKeyValue(*key, i32::from(*subtree), *filter, *event, 1) == 0
                }
                Watch::Folder { handle } => FindNextChangeNotification(*handle) != 0,
            }
        }
    }

    fn kind(&self) -> u64 {
        match self {
            Watch::Registry { .. } => KIND_REGISTRY,
            Watch::Folder { .. } => KIND_FOLDER,
        }
    }
}

/// What the thread made, undone in reverse order when it ends.
struct Resources {
    instance: *mut c_void,
    class: Vec<u16>,
    registered_class: bool,
    hwnd: HWND,
    shell_hook: bool,
    hooks: Vec<*mut c_void>,
    watches: Vec<Watch>,
}

impl Drop for Resources {
    fn drop(&mut self) {
        LOCAL.with(|local| {
            if let Some(local) = local.get() {
                local.live.set(false);
            }
        });
        // SAFETY: everything below was made by this thread and is released once.
        unsafe {
            for hook in self.hooks.drain(..) {
                UnhookWinEvent(hook);
            }
            if self.shell_hook {
                DeregisterShellHookWindow(self.hwnd);
            }
            if !self.hwnd.is_null() {
                DestroyWindow(self.hwnd);
            }
            if self.registered_class {
                UnregisterClassW(self.class.as_ptr(), self.instance);
            }
            for watch in self.watches.drain(..) {
                match watch {
                    Watch::Registry { key, event, .. } => {
                        RegCloseKey(key);
                        CloseHandle(event);
                    }
                    Watch::Folder { handle } => {
                        FindCloseChangeNotification(handle);
                    }
                }
            }
        }
    }
}

impl Local {
    fn post(&self, args: [u64; threadsafe::ARGS], bytes: &[u8]) {
        if self.live.get() {
            threadsafe::post(self.slot, args, bytes);
        }
    }

    fn message(&self, hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if self.shell != 0 && message == self.shell {
            self.post([KIND_SHELL, wparam as u64, lparam as u64, 0, 0, 0], &[]);
            return 0;
        }
        // WM_CLOSE (taskkill, an Alt+F4 sent from outside) never destroys the window: dispose() does.
        let fallback = |hwnd, message, wparam, lparam| {
            if message == WM_CLOSE { 0 } else { unsafe { DefWindowProcW(hwnd, message, wparam, lparam) } }
        };
        let fixed = |message| self.shared.replies.lock().unwrap_or_else(|p| p.into_inner()).get(&message).copied();
        if self.messages.binary_search(&message).is_err() || !self.live.get() {
            return fixed(message).unwrap_or_else(|| fallback(hwnd, message, wparam, lparam));
        }
        // SAFETY: lParam is what Windows documents for these messages, valid during this call.
        let bytes = unsafe { copied(message, wparam, lparam) };
        // SAFETY: no arguments to check.
        let sent = unsafe { InSendMessageEx(ptr::null_mut()) };
        let waits = self.wait.binary_search(&message).is_ok()
            && sent != 0
            && sent & (ISMEX_NOTIFY | ISMEX_REPLIED) == 0;
        let sequence = if waits {
            let sequence = self.next.get() + 1;
            self.next.set(sequence);
            *self.shared.answer.lock().unwrap_or_else(|p| p.into_inner()) =
                Answer { waiting: sequence, value: None };
            sequence
        } else {
            0
        };
        self.post([KIND_MESSAGE, u64::from(message), wparam as u64, lparam as u64, sequence, 0], &bytes);
        let mut answer = None;
        if waits {
            let deadline = Instant::now() + self.timeout;
            let mut state = self.shared.answer.lock().unwrap_or_else(|p| p.into_inner());
            loop {
                if state.value.is_some() || self.shared.closing.load(Ordering::Acquire) {
                    break;
                }
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    break;
                }
                state = self
                    .shared
                    .answered
                    .wait_timeout(state, left)
                    .unwrap_or_else(|p| p.into_inner())
                    .0;
            }
            answer = state.value.take();
            state.waiting = 0;
        }
        answer.or_else(|| fixed(message)).unwrap_or_else(|| fallback(hwnd, message, wparam, lparam))
    }
}

/// The bytes a message's lParam points to, for the messages whose lParam is data JavaScript
/// cannot read once the call returned.
unsafe fn copied(message: u32, wparam: WPARAM, lparam: LPARAM) -> Vec<u8> {
    let max = threadsafe::MAX_COPY as usize;
    let address = lparam as usize;
    if address == 0 {
        return Vec::new();
    }
    // SAFETY (all arms): the layouts Windows documents for each message's lParam.
    unsafe {
        match message {
            WM_COPYDATA => {
                #[repr(C)]
                struct CopyData {
                    data: usize,
                    length: u32,
                    bytes: *const u8,
                }
                let copy = &*(address as *const CopyData);
                let length = (copy.length as usize).min(max - 8);
                let mut out = Vec::with_capacity(8 + length);
                out.extend_from_slice(&(copy.data as u64).to_le_bytes());
                if !copy.bytes.is_null() && length > 0 {
                    out.extend_from_slice(std::slice::from_raw_parts(copy.bytes, length));
                }
                out
            }
            WM_SETTINGCHANGE => {
                let text = address as *const u16;
                let mut length = 0;
                while length < max / 2 && *text.add(length) != 0 {
                    length += 1;
                }
                std::slice::from_raw_parts(text as *const u8, length * 2).to_vec()
            }
            WM_POWERBROADCAST if wparam == PBT_POWERSETTINGCHANGE => {
                // POWERBROADCAST_SETTING: GUID, DataLength, Data.
                let length = *((address + 16) as *const u32) as usize;
                std::slice::from_raw_parts(address as *const u8, (20 + length).min(max)).to_vec()
            }
            WM_DEVICECHANGE if wparam & 0x8000 != 0 => {
                // DEV_BROADCAST_HDR: its first u32 is the whole structure's size.
                let length = *(address as *const u32) as usize;
                std::slice::from_raw_parts(address as *const u8, length.clamp(4, max)).to_vec()
            }
            _ => Vec::new(),
        }
    }
}

unsafe extern "system" fn window_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let handled = LOCAL.with(|local| local.get().map(|local| local.message(hwnd, message, wparam, lparam)));
    // SAFETY: Windows' own arguments.
    handled.unwrap_or_else(|| unsafe { DefWindowProcW(hwnd, message, wparam, lparam) })
}

unsafe extern "system" fn win_event(
    _hook: *mut c_void,
    event: u32,
    hwnd: HWND,
    object: i32,
    child: i32,
    thread: u32,
    time: u32,
) {
    LOCAL.with(|local| {
        if let Some(local) = local.get() {
            let ids = u64::from(object as u32) | (u64::from(child as u32) << 32);
            local.post([KIND_WIN_EVENT, u64::from(event), hwnd as u64, ids, u64::from(thread), u64::from(time)], &[]);
        }
    });
}

fn class_name(options: &Options, id: u64) -> Result<String, String> {
    match &options.class_name {
        Some(name) if name.is_empty() || name.len() > 255 || name.contains('\0') => {
            Err("className must be 1-255 characters".into())
        }
        Some(name) => Ok(name.clone()),
        None => Ok(format!("TarveMessageWindow-{}-{id}", std::process::id())),
    }
}

/// Builds the window and everything it listens to on this (its own) thread: the info JavaScript
/// gets back, and what to release when the thread ends.
fn setup(options: Options, slot: usize, shared: Arc<Shared>, id: u64) -> Result<(String, Resources), String> {
    let mut named = HashMap::new();
    let wait = resolve(&options.wait_replies, &mut named)?;
    // A message JavaScript answers is one it gets.
    let mut messages = resolve(&options.messages, &mut named)?;
    messages.extend_from_slice(&wait);
    messages.sort_unstable();
    messages.dedup();
    let replies: Vec<(MessageName, i64)> = options.replies.clone();
    {
        let mut table = shared.replies.lock().unwrap_or_else(|p| p.into_inner());
        for (name, value) in replies {
            let id = resolve(std::slice::from_ref(&name), &mut named)?[0];
            table.insert(id, value as isize);
        }
    }
    let shell = if options.shell_hook { register_name("SHELLHOOK")? } else { 0 };
    let class = wide(&class_name(&options, id)?);
    // SAFETY: the module this code is in loaded the process image; null names the exe.
    let instance = unsafe { GetModuleHandleW(ptr::null()) };
    let mut resources = Resources {
        instance,
        class,
        registered_class: false,
        hwnd: ptr::null_mut(),
        shell_hook: false,
        hooks: Vec::new(),
        watches: Vec::new(),
    };
    LOCAL.with(|local| {
        let _ = local.set(Local {
            slot,
            messages,
            wait,
            timeout: Duration::from_millis(u64::from(
                options.reply_timeout.unwrap_or(DEFAULT_REPLY_TIMEOUT_MS).min(MAX_REPLY_TIMEOUT_MS),
            )),
            shell,
            next: Cell::new(0),
            live: Cell::new(true),
            shared,
        });
    });
    // SAFETY: a zeroed WNDCLASSEXW is valid; the fields set are owned for the window's life.
    unsafe {
        let mut class: WNDCLASSEXW = std::mem::zeroed();
        class.cbSize = std::mem::size_of::<WNDCLASSEXW>() as u32;
        class.lpfnWndProc = Some(window_proc);
        class.hInstance = instance;
        class.lpszClassName = resources.class.as_ptr();
        if RegisterClassExW(&class) == 0 {
            let error = GetLastError();
            let name = String::from_utf16_lossy(&resources.class[..resources.class.len() - 1]);
            return Err(if error == ERROR_CLASS_ALREADY_EXISTS {
                format!("The window class \"{name}\" is already registered in this process")
            } else {
                format!("RegisterClassExW(\"{name}\") failed (Windows error {error})")
            });
        }
        resources.registered_class = true;
        let title = wide(options.window_name.as_deref().unwrap_or(""));
        resources.hwnd = CreateWindowExW(
            options.ex_style.unwrap_or(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE),
            resources.class.as_ptr(),
            title.as_ptr(),
            options.style.unwrap_or(WS_POPUP),
            0,
            0,
            0,
            0,
            if options.message_only { HWND_MESSAGE } else { ptr::null_mut() },
            ptr::null_mut(),
            instance,
            ptr::null(),
        );
        if resources.hwnd.is_null() {
            return Err(format!("CreateWindowExW failed (Windows error {})", GetLastError()));
        }
        if options.shell_hook {
            if RegisterShellHookWindow(resources.hwnd) == 0 {
                return Err(format!("RegisterShellHookWindow failed (Windows error {})", GetLastError()));
            }
            resources.shell_hook = true;
        }
        for hook in &options.win_events {
            let handle = SetWinEventHook(
                hook.min,
                hook.max.unwrap_or(hook.min),
                ptr::null_mut(),
                Some(win_event),
                hook.process,
                hook.thread,
                WINEVENT_OUTOFCONTEXT | (hook.flags & 0x3),
            );
            if handle.is_null() {
                return Err(format!("SetWinEventHook({:#x}..{:#x}) failed", hook.min, hook.max.unwrap_or(hook.min)));
            }
            resources.hooks.push(handle);
        }
        for watch in &options.registry {
            let (root, path) = hive(&watch.key)?;
            let mut key: HKEY = ptr::null_mut();
            let opened = RegOpenKeyExW(root, wide(path).as_ptr(), 0, KEY_NOTIFY, &mut key);
            if opened != 0 {
                return Err(format!("Could not open registry key \"{}\" (Windows error {opened})", watch.key));
            }
            let event = CreateEventW(ptr::null(), 0, 0, ptr::null());
            if event.is_null() {
                RegCloseKey(key);
                return Err(format!("CreateEventW failed (Windows error {})", GetLastError()));
            }
            resources.watches.push(Watch::Registry { key, event, subtree: watch.subtree, filter: watch.filter.unwrap_or(0x1 | 0x4) });
        }
        for watch in &options.folders {
            let handle = FindFirstChangeNotificationW(
                wide(&watch.path).as_ptr(),
                i32::from(watch.subtree),
                watch.filter.unwrap_or(0x1 | 0x2 | 0x10),
            );
            if handle == INVALID_HANDLE_VALUE || handle.is_null() {
                return Err(format!("Could not watch folder \"{}\" (Windows error {})", watch.path, GetLastError()));
            }
            resources.watches.push(Watch::Folder { handle });
        }
        for (index, watch) in resources.watches.iter().enumerate() {
            if matches!(watch, Watch::Registry { .. }) && !watch.arm() {
                return Err(format!("RegNotifyChangeKeyValue failed for watch {index}"));
            }
        }
    }
    let info = serde_json::json!({
        "hwnd": (resources.hwnd as u64).to_string(),
        "threadId": unsafe { windows_sys::Win32::System::Threading::GetCurrentThreadId() },
        "messages": named,
        "shellHook": shell,
    })
    .to_string();
    Ok((info, resources))
}

/// The thread's loop: watches and the message queue until the stop event.
fn pump(stop: HANDLE, resources: &Resources) {
    // (watch index, handle) of the watches still armed.
    let mut armed: Vec<usize> = (0..resources.watches.len()).collect();
    let mut handles: Vec<HANDLE> = Vec::with_capacity(1 + armed.len());
    let mut changed = true;
    loop {
        if changed {
            handles.clear();
            handles.push(stop);
            handles.extend(armed.iter().map(|&index| resources.watches[index].handle()));
            changed = false;
        }
        let count = handles.len() as u32;
        // SAFETY: open handles this thread owns.
        let woke = unsafe {
            MsgWaitForMultipleObjectsEx(count, handles.as_ptr(), INFINITE, QS_ALLINPUT, MWMO_INPUTAVAILABLE)
        };
        if woke == WAIT_OBJECT_0 {
            return;
        }
        if woke > WAIT_OBJECT_0 && woke < WAIT_OBJECT_0 + count {
            let position = (woke - WAIT_OBJECT_0) as usize - 1;
            let index = armed[position];
            let watch = &resources.watches[index];
            let still = watch.arm();
            if !still {
                armed.remove(position);
                changed = true;
            }
            LOCAL.with(|local| {
                if let Some(local) = local.get() {
                    local.post([watch.kind(), index as u64, u64::from(!still), 0, 0, 0], &[]);
                }
            });
        } else if woke == WAIT_OBJECT_0 + count {
            // SAFETY: a zeroed MSG is valid output space.
            let mut message: MSG = unsafe { std::mem::zeroed() };
            for _ in 0..PUMP_BATCH {
                // SAFETY: this thread's queue; WinEvent callbacks and sent messages run in here.
                if unsafe { PeekMessageW(&mut message, ptr::null_mut(), 0, 0, PM_REMOVE) } == 0 {
                    break;
                }
                unsafe { DispatchMessageW(&message) };
            }
        } else {
            // WAIT_FAILED: nothing sensible is left to wait on.
            return;
        }
    }
}

/// Opens a message window whose calls go to the threadsafe callback at `callback`: its id.
pub(crate) fn open(options: Options, callback: u64) -> Result<u64, String> {
    let slot = threadsafe::slot_of(callback).ok_or("messageWindow: the callback is not an open threadsafe callback")?;
    if options.messages.len() + options.wait_replies.len() + options.replies.len() > MAX_MESSAGES {
        return Err(format!("messageWindow takes at most {MAX_MESSAGES} messages"));
    }
    if options.win_events.len() > MAX_WIN_EVENTS {
        return Err(format!("messageWindow takes at most {MAX_WIN_EVENTS} winEvents"));
    }
    if options.registry.len() + options.folders.len() > MAX_WATCHES {
        return Err(format!("messageWindow watches at most {MAX_WATCHES} registry keys and folders together"));
    }
    let id = NEXT_WINDOW.fetch_add(1, Ordering::Relaxed);
    let shared = Arc::new(Shared {
        replies: Mutex::new(HashMap::new()),
        answer: Mutex::new(Answer::default()),
        answered: Condvar::new(),
        closing: AtomicBool::new(false),
    });
    // SAFETY: a manual-reset event, closed by close() (or below on failure).
    let stop = unsafe { CreateEventW(ptr::null(), 1, 0, ptr::null()) };
    if stop.is_null() {
        return Err(format!("CreateEventW failed (Windows error {})", unsafe { GetLastError() }));
    }
    let stop_address = stop as usize;
    let (sender, receiver) = mpsc::sync_channel::<Result<String, String>>(1);
    let thread_shared = Arc::clone(&shared);
    let spawned = std::thread::Builder::new()
        .name("tarve-message-window".into())
        .stack_size(256 * 1024)
        .spawn(move || match setup(options, slot, thread_shared, id) {
            Ok((info, resources)) => {
                let _ = sender.send(Ok(info));
                pump(stop_address as HANDLE, &resources);
                drop(resources);
            }
            Err(message) => {
                let _ = sender.send(Err(message));
            }
        });
    let thread = match spawned {
        Ok(thread) => thread,
        Err(error) => {
            unsafe { CloseHandle(stop) };
            return Err(format!("Could not start the message window thread: {error}"));
        }
    };
    let info = match receiver.recv() {
        Ok(Ok(info)) => info,
        failed => {
            let _ = thread.join();
            unsafe { CloseHandle(stop) };
            return Err(match failed {
                Ok(Err(message)) => message,
                _ => "The message window thread ended before its window was made".into(),
            });
        }
    };
    windows().lock().unwrap_or_else(|p| p.into_inner()).insert(
        id,
        Window { shared, stop: stop_address, thread: Some(thread), info },
    );
    Ok(id)
}

/// The window's description (JSON: hwnd, threadId, registered message ids, shell hook message).
pub(crate) fn info(id: u64) -> Result<String, String> {
    windows()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(&id)
        .map(|window| window.info.clone())
        .ok_or_else(|| "No such message window".into())
}

/// JavaScript's answer to the waiting message `sequence`; false when it is no longer waited for.
pub(crate) fn reply(id: u64, sequence: u64, value: i64) -> bool {
    let Some(shared) = windows().lock().unwrap_or_else(|p| p.into_inner()).get(&id).map(|w| Arc::clone(&w.shared)) else {
        return false;
    };
    let mut answer = shared.answer.lock().unwrap_or_else(|p| p.into_inner());
    if sequence == 0 || answer.waiting != sequence || answer.value.is_some() {
        return false;
    }
    answer.value = Some(value as isize);
    shared.answered.notify_all();
    true
}

/// Sets (`Some`) or clears the fixed answer to `message`.
pub(crate) fn set_reply(id: u64, message: u32, value: Option<i64>) -> bool {
    let Some(shared) = windows().lock().unwrap_or_else(|p| p.into_inner()).get(&id).map(|w| Arc::clone(&w.shared)) else {
        return false;
    };
    let mut table = shared.replies.lock().unwrap_or_else(|p| p.into_inner());
    match value {
        Some(value) => table.insert(message, value as isize),
        None => table.remove(&message),
    };
    true
}

/// Stops the window's thread and waits for it: hooks, window and class are gone when it returns.
pub(crate) fn close(id: u64) -> bool {
    let Some(mut window) = windows().lock().unwrap_or_else(|p| p.into_inner()).remove(&id) else {
        return false;
    };
    window.shared.closing.store(true, Ordering::Release);
    {
        let _answer = window.shared.answer.lock().unwrap_or_else(|p| p.into_inner());
        window.shared.answered.notify_all();
    }
    // SAFETY: the stop event this window owns.
    unsafe { SetEvent(window.stop as HANDLE) };
    if let Some(thread) = window.thread.take() {
        let _ = thread.join();
    }
    unsafe { CloseHandle(window.stop as HANDLE) };
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::{PostMessageW, SendMessageW, WM_APP};

    type Call = (u32, [u64; threadsafe::ARGS], Vec<u8>);

    fn take(into: &mut Vec<Call>) {
        let mut out = vec![0u8; 256 * 1024];
        let written = threadsafe::poll(&mut out).unwrap();
        let mut at = 0;
        while at < written {
            let id = u32::from_le_bytes(out[at..at + 4].try_into().unwrap());
            let len = u32::from_le_bytes(out[at + 4..at + 8].try_into().unwrap()) as usize;
            let mut args = [0u64; threadsafe::ARGS];
            for (index, arg) in args.iter_mut().enumerate() {
                let start = at + 8 + index * 8;
                *arg = u64::from_le_bytes(out[start..start + 8].try_into().unwrap());
            }
            let data = out[at + threadsafe::RECORD_HEADER..at + threadsafe::RECORD_HEADER + len].to_vec();
            into.push((id, args, data));
            at += threadsafe::RECORD_HEADER + len;
        }
    }

    fn until(calls: &mut Vec<Call>, id: u32, done: impl Fn(&[&Call]) -> bool) {
        for _ in 0..500 {
            take(calls);
            let mine: Vec<&Call> = calls.iter().filter(|call| call.0 == id).collect();
            if done(&mine) {
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let mine: Vec<&Call> = calls.iter().filter(|call| call.0 == id).collect();
        panic!("timed out waiting for message window calls: {mine:?}");
    }

    fn options(json: serde_json::Value) -> Options {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn delivers_in_order_answers_from_the_table_and_waits_for_javascript() {
        let _turn = threadsafe::test_turn();
        let callback = threadsafe::create(8101, 0, u32::MAX, 0).unwrap();
        let id = open(
            options(serde_json::json!({
                "messageOnly": true,
                "messages": [WM_APP + 1, "TarveMessageWindowTest", WM_COPYDATA, WM_SETTINGCHANGE],
                "waitReplies": [WM_APP + 2, WM_APP + 4],
                "replyTimeout": 30,
                "replies": [[WM_APP + 3, 77], [WM_APP + 4, 9]],
            })),
            callback,
        )
        .unwrap();
        let info: serde_json::Value = serde_json::from_str(&info(id).unwrap()).unwrap();
        let hwnd = info["hwnd"].as_str().unwrap().parse::<u64>().unwrap() as usize as HWND;
        let registered = info["messages"]["TarveMessageWindowTest"].as_u64().unwrap() as u32;
        assert!(registered >= 0xC000);
        let hwnd_address = hwnd as usize;
        let send = move |message: u32, wparam: usize, lparam: isize| unsafe {
            SendMessageW(hwnd_address as HWND, message, wparam, lparam)
        };
        // SAFETY: a live window of this test.
        unsafe {
            assert_ne!(PostMessageW(hwnd, WM_APP + 1, 5, 6), 0);
            assert_ne!(PostMessageW(hwnd, registered, 7, 8), 0);
        }
        let mut calls = Vec::new();
        // Windows handles sent messages before posted ones: let the posted ones through first.
        until(&mut calls, 8101, |mine| mine.len() >= 2);
        assert_eq!(send(WM_APP + 3, 0, 0), 77, "not delivered, answered from the table");
        assert_eq!(send(WM_APP + 5, 0, 0), 0, "neither: DefWindowProc");
        let settings = wide("ImmersiveColorSet");
        send(WM_SETTINGCHANGE, 0, settings.as_ptr() as isize);
        let payload = *b"tray";
        #[repr(C)]
        struct CopyData {
            data: usize,
            length: u32,
            bytes: *const u8,
        }
        let copy = CopyData { data: 1, length: 4, bytes: payload.as_ptr() };
        send(WM_COPYDATA, 0, &copy as *const CopyData as isize);
        until(&mut calls, 8101, |mine| mine.len() >= 4);
        let mine: Vec<&Call> = calls.iter().filter(|call| call.0 == 8101).collect();
        assert_eq!(mine[0].1[..4], [KIND_MESSAGE, u64::from(WM_APP + 1), 5, 6]);
        assert_eq!(mine[1].1[..4], [KIND_MESSAGE, u64::from(registered), 7, 8]);
        let text: Vec<u16> = mine[2].2.chunks(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
        assert_eq!(String::from_utf16(&text).unwrap(), "ImmersiveColorSet");
        assert_eq!(mine[3].2, [1, 0, 0, 0, 0, 0, 0, 0, b't', b'r', b'a', b'y']);
        // A sent message JavaScript answers (here: this thread, standing in for it).
        calls.clear();
        let sender = std::thread::spawn(move || send(WM_APP + 2, 1, 2));
        until(&mut calls, 8101, |mine| !mine.is_empty());
        let sequence = calls.iter().find(|call| call.0 == 8101).unwrap().1[4];
        assert_ne!(sequence, 0);
        assert!(reply(id, sequence, 42));
        assert_eq!(sender.join().unwrap(), 42);
        assert!(!reply(id, sequence, 43), "answered once");
        // Unanswered: the table after the timeout; a later set_reply changes it.
        assert_eq!(std::thread::spawn(move || send(WM_APP + 4, 0, 0)).join().unwrap(), 9);
        assert!(set_reply(id, WM_APP + 4, Some(-1)));
        assert_eq!(std::thread::spawn(move || send(WM_APP + 4, 0, 0)).join().unwrap(), -1);
        assert!(close(id));
        assert!(!close(id));
        assert!(!reply(id, 1, 0));
        threadsafe::close(callback);
        take(&mut calls);
    }

    #[test]
    fn watches_folders_and_reports_setup_errors() {
        let _turn = threadsafe::test_turn();
        let callback = threadsafe::create(8102, 0, u32::MAX, 0).unwrap();
        let folder = std::env::temp_dir().join(format!("tarve-message-window-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let id = open(
            options(serde_json::json!({
                "messageOnly": true,
                "folders": [{ "path": folder.to_string_lossy() }],
                "registry": [{ "key": "HKCU\\Software" }],
            })),
            callback,
        )
        .unwrap();
        std::fs::write(folder.join("changed.txt"), b"x").unwrap();
        let mut calls = Vec::new();
        until(&mut calls, 8102, |mine| mine.iter().any(|call| call.1[0] == KIND_FOLDER));
        let folder_call = calls.iter().find(|call| call.0 == 8102 && call.1[0] == KIND_FOLDER).unwrap();
        assert_eq!(folder_call.1[1], 1, "the watch's index among registry keys then folders");
        assert!(close(id));
        let _ = std::fs::remove_dir_all(&folder);

        let taken = open(options(serde_json::json!({ "className": "TarveMessageWindowTwice", "messageOnly": true })), callback).unwrap();
        let error = open(options(serde_json::json!({ "className": "TarveMessageWindowTwice", "messageOnly": true })), callback).err().unwrap();
        assert!(error.contains("already registered"), "{error}");
        assert!(close(taken));
        let again = open(options(serde_json::json!({ "className": "TarveMessageWindowTwice", "messageOnly": true })), callback).unwrap();
        assert!(close(again), "the class is unregistered when the window closes");
        let error = open(options(serde_json::json!({ "registry": [{ "key": "HKXX\\Nope" }] })), callback).err().unwrap();
        assert!(error.contains("HKCU"), "{error}");
        assert!(open(Options::default(), 12345).err().unwrap().contains("threadsafe callback"));
        assert!(serde_json::from_value::<Options>(serde_json::json!({ "bogus": 1 })).is_err());
        threadsafe::close(callback);
        take(&mut calls);
    }
}
