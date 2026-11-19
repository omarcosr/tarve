use super::payload::{CopyData, WM_COPYDATA};
use super::tests::{options, take, until};
use super::*;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    FindWindowExW, GetMessageW, HWND_TOPMOST, IDI_APPLICATION, LoadIconW, PostThreadMessageW,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SendMessageW, SetWindowPos, WM_APP, WM_QUIT, WS_CHILD,
    WS_POPUP,
};

fn send(hwnd: usize, message: u32, wparam: usize, lparam: isize) -> isize {
    // SAFETY: windows of this test, answered on their own threads.
    unsafe { SendMessageW(hwnd as HWND, message, wparam, lparam) }
}

fn first(class: &str) -> usize {
    let class = wide(class);
    // SAFETY: a NUL-terminated class name.
    unsafe {
        FindWindowExW(
            ptr::null_mut(),
            ptr::null_mut(),
            class.as_ptr(),
            ptr::null(),
        ) as usize
    }
}

/// The stand-in shell: its tray answers WM_APP + n with 100 + n, its band with 200 + n, and
/// WM_COPYDATA with ten times dwData.
unsafe extern "system" fn twin_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    let tray = unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetParent(hwnd) }.is_null();
    match message {
        WM_COPYDATA if lparam != 0 => unsafe {
            (*(lparam as *const CopyData)).data as LRESULT * 10
        },
        _ if (WM_APP..WM_APP + 16).contains(&message) => {
            (if tray { 100 } else { 200 }) + (message - WM_APP) as LRESULT
        }
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}

/// Another "process's" tray and band, of the same classes, on a thread of their own. Registered
/// with another module's instance: classes are per module, as they would be in Explorer.
fn stand_in(
    tray: &'static str,
    band: &'static str,
) -> (std::thread::JoinHandle<()>, u32, usize, usize) {
    let (sender, receiver) = mpsc::channel();
    let thread = std::thread::spawn(move || unsafe {
        let instance = GetModuleHandleW(wide("kernel32.dll").as_ptr());
        let mut made = [0usize; 2];
        for (index, (class, style, parent)) in [(tray, WS_POPUP, 0usize), (band, WS_CHILD, 1)]
            .into_iter()
            .enumerate()
        {
            let name = wide(class);
            let mut info: WNDCLASSEXW = std::mem::zeroed();
            info.cbSize = std::mem::size_of::<WNDCLASSEXW>() as u32;
            info.lpfnWndProc = Some(twin_proc);
            info.hInstance = instance;
            info.lpszClassName = name.as_ptr();
            assert_ne!(RegisterClassExW(&info), 0);
            let parent = if parent == 1 {
                made[0] as HWND
            } else {
                ptr::null_mut()
            };
            made[index] = CreateWindowExW(
                WS_EX_TOOLWINDOW,
                name.as_ptr(),
                ptr::null(),
                style,
                0,
                0,
                0,
                0,
                parent,
                ptr::null_mut(),
                instance,
                ptr::null(),
            ) as usize;
            assert_ne!(made[index], 0);
        }
        sender
            .send((
                windows_sys::Win32::System::Threading::GetCurrentThreadId(),
                made[0],
                made[1],
            ))
            .unwrap();
        let mut message: MSG = std::mem::zeroed();
        while GetMessageW(&mut message, ptr::null_mut(), 0, 0) > 0 {
            DispatchMessageW(&message);
        }
        DestroyWindow(made[0] as HWND);
        for class in [band, tray] {
            UnregisterClassW(wide(class).as_ptr(), instance);
        }
    });
    let (id, tray, band) = receiver.recv().unwrap();
    (thread, id, tray, band)
}

#[test]
fn forwards_to_the_twin_reads_icons_and_keeps_its_window_first() {
    let _turn = threadsafe::test_turn();
    let (twin, twin_thread, twin_tray, twin_band) =
        stand_in("TarveTwinTestTray", "TarveTwinTestBand");
    let callback = threadsafe::create(8104, 0, u32::MAX, 0).unwrap();
    let id = open(
        options(serde_json::json!({
            "className": "TarveTwinTestTray",
            "children": [{ "className": "TarveTwinTestBand" }],
            "messages": [WM_COPYDATA],
            "messageRanges": [[WM_APP + 5, WM_APP + 5]],
            "replies": [[WM_COPYDATA, 1, 2, "1"]],
            "forward": { "messages": [WM_COPYDATA], "ranges": [[WM_APP, WM_APP + 10]] },
            "icons": [
                { "message": WM_COPYDATA, "dwData": "2", "offset": 4, "when": [0, 2] },
                { "message": WM_APP + 5 },
            ],
            "keepFirst": 50,
        })),
        callback,
    )
    .unwrap();
    let info: serde_json::Value = serde_json::from_str(&info(id).unwrap()).unwrap();
    let top = info["hwnd"].as_str().unwrap().parse::<usize>().unwrap();
    let band = info["children"][0]["hwnd"]
        .as_str()
        .unwrap()
        .parse::<usize>()
        .unwrap();
    assert_eq!(first("TarveTwinTestTray"), top, "made first at once");
    // Answered by the twin of the window that got it, without JavaScript.
    assert_eq!(send(top, WM_APP + 1, 0, 0), 101);
    assert_eq!(send(band, WM_APP + 2, 0, 0), 202);
    assert_eq!(
        send(twin_tray, WM_APP + 3, 0, 0),
        103,
        "the twin itself is untouched"
    );
    let _ = twin_band;
    let copy = |data: usize, bytes: &[u8]| CopyData {
        data,
        length: bytes.len() as u32,
        bytes: bytes.as_ptr(),
    };
    let three = copy(3, b"x");
    assert_eq!(
        send(top, WM_COPYDATA, 0, &three as *const CopyData as isize),
        30
    );
    let one = copy(1, b"x");
    assert_eq!(
        send(top, WM_COPYDATA, 0, &one as *const CopyData as isize),
        1,
        "a fixed reply wins"
    );
    // The icon's pixels arrive just before the message that carried it.
    // SAFETY: a shared system icon (never destroyed).
    let icon = unsafe { LoadIconW(ptr::null_mut(), IDI_APPLICATION) } as usize as u32;
    let mut data = [0u8; 8];
    data[..4].copy_from_slice(&2u32.to_le_bytes());
    data[4..].copy_from_slice(&icon.to_le_bytes());
    let two = copy(2, &data);
    send(top, WM_COPYDATA, 0, &two as *const CopyData as isize);
    data[..4].copy_from_slice(&0u32.to_le_bytes());
    let unflagged = copy(2, &data);
    send(top, WM_COPYDATA, 0, &unflagged as *const CopyData as isize);
    send(top, WM_APP + 5, 0, icon as i32 as isize);
    let mut calls = Vec::new();
    until(&mut calls, 8104, |mine| {
        mine.iter().filter(|call| call.1[0] == KIND_MESSAGE).count() >= 5
    });
    let kinds: Vec<u64> = calls
        .iter()
        .filter(|call| call.0 == 8104)
        .map(|call| call.1[0])
        .collect();
    assert_eq!(
        kinds,
        [
            KIND_MESSAGE,
            KIND_MESSAGE,
            KIND_ICON,
            KIND_MESSAGE,
            KIND_MESSAGE,
            KIND_ICON,
            KIND_MESSAGE
        ],
        "dwData 3 and 1 carry no icon, the unflagged one neither"
    );
    let pixels = calls
        .iter()
        .find(|call| call.0 == 8104 && call.1[0] == KIND_ICON)
        .unwrap();
    let (width, height) = (pixels.1[1], pixels.1[2]);
    assert!(width >= 16 && height >= 16);
    assert_eq!(pixels.2.len() as u64, width * height * 4);
    assert!(
        pixels
            .2
            .as_chunks::<4>()
            .0
            .iter()
            .any(|pixel| pixel[3] != 0)
    );
    // Another window takes the place: the timer gives it back.
    // SAFETY: the stand-in's own window.
    unsafe {
        SetWindowPos(
            twin_tray as HWND,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE,
        )
    };
    assert_eq!(first("TarveTwinTestTray"), twin_tray);
    for _ in 0..100 {
        if first("TarveTwinTestTray") == top {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(first("TarveTwinTestTray"), top);
    assert!(close(id));
    threadsafe::close(callback);
    take(&mut calls);
    // SAFETY: the stand-in's thread.
    unsafe { PostThreadMessageW(twin_thread, WM_QUIT, 0, 0) };
    twin.join().unwrap();
}

#[test]
fn rejects_bad_ranges_and_keep_first_without_a_top_level_window() {
    let _turn = threadsafe::test_turn();
    let callback = threadsafe::create(8105, 0, u32::MAX, 0).unwrap();
    let error = |json| open(options(json), callback).err().unwrap();
    assert!(error(serde_json::json!({ "messageRanges": [[5, 4]] })).contains("min <= max"));
    assert!(error(serde_json::json!({ "forward": { "ranges": [[9, 1]] } })).contains("min <= max"));
    assert!(
        error(serde_json::json!({ "messageOnly": true, "keepFirst": 100 })).contains("keepFirst")
    );
    threadsafe::close(callback);
}
