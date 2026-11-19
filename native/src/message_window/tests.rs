use super::payload::{WM_COPYDATA, WM_SETTINGCHANGE};
use super::*;
use windows_sys::Win32::UI::WindowsAndMessaging::{PostMessageW, SendMessageW, WM_APP};

type Call = (u32, [u64; threadsafe::ARGS], Vec<u8>);

pub(super) fn take(into: &mut Vec<Call>) {
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
        let data =
            out[at + threadsafe::RECORD_HEADER..at + threadsafe::RECORD_HEADER + len].to_vec();
        into.push((id, args, data));
        at += threadsafe::RECORD_HEADER + len;
    }
}

pub(super) fn until(calls: &mut Vec<Call>, id: u32, done: impl Fn(&[&Call]) -> bool) {
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

pub(super) fn options(json: serde_json::Value) -> Options {
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
    assert_eq!(
        send(WM_APP + 3, 0, 0),
        77,
        "not delivered, answered from the table"
    );
    assert_eq!(send(WM_APP + 5, 0, 0), 0, "neither: DefWindowProc");
    let settings = wide("ImmersiveColorSet");
    send(WM_SETTINGCHANGE, 0, settings.as_ptr() as isize);
    let payload = *b"tray";
    let copy = payload::CopyData {
        data: 1,
        length: 4,
        bytes: payload.as_ptr(),
    };
    send(WM_COPYDATA, 0, &copy as *const payload::CopyData as isize);
    until(&mut calls, 8101, |mine| mine.len() >= 4);
    let mine: Vec<&Call> = calls.iter().filter(|call| call.0 == 8101).collect();
    assert_eq!(mine[0].1[..4], [KIND_MESSAGE, u64::from(WM_APP + 1), 5, 6]);
    assert_eq!(mine[1].1[..4], [KIND_MESSAGE, u64::from(registered), 7, 8]);
    let text: Vec<u16> = mine[2]
        .2
        .chunks(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
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
    assert_eq!(
        std::thread::spawn(move || send(WM_APP + 4, 0, 0))
            .join()
            .unwrap(),
        9
    );
    assert!(set_reply(id, hwnd as u64, WM_APP + 4, 0, 0, 1, -1));
    assert_eq!(
        std::thread::spawn(move || send(WM_APP + 4, 0, 0))
            .join()
            .unwrap(),
        -1
    );
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
    until(&mut calls, 8102, |mine| {
        mine.iter().any(|call| call.1[0] == KIND_FOLDER)
    });
    let folder_call = calls
        .iter()
        .find(|call| call.0 == 8102 && call.1[0] == KIND_FOLDER)
        .unwrap();
    assert_eq!(
        folder_call.1[1], 1,
        "the watch's index among registry keys then folders"
    );
    assert!(close(id));
    let _ = std::fs::remove_dir_all(&folder);

    let taken = open(
        options(serde_json::json!({ "className": "TarveMessageWindowTwice", "messageOnly": true })),
        callback,
    )
    .unwrap();
    let error = open(
        options(serde_json::json!({ "className": "TarveMessageWindowTwice", "messageOnly": true })),
        callback,
    )
    .err()
    .unwrap();
    assert!(error.contains("already registered"), "{error}");
    assert!(close(taken));
    let again = open(
        options(serde_json::json!({ "className": "TarveMessageWindowTwice", "messageOnly": true })),
        callback,
    )
    .unwrap();
    assert!(
        close(again),
        "the class is unregistered when the window closes"
    );
    let error = open(
        options(serde_json::json!({ "registry": [{ "key": "HKXX\\Nope" }] })),
        callback,
    )
    .err()
    .unwrap();
    assert!(error.contains("HKCU"), "{error}");
    assert!(
        open(Options::default(), 12345)
            .err()
            .unwrap()
            .contains("threadsafe callback")
    );
    assert!(serde_json::from_value::<Options>(serde_json::json!({ "bogus": 1 })).is_err());
    threadsafe::close(callback);
    take(&mut calls);
}
