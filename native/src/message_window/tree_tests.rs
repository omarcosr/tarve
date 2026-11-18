use super::super::tests::{options, take, until};
use super::super::{KIND_MESSAGE, close, info, open, payload::CopyData, set_reply, wide};
use super::*;
use crate::threadsafe;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    FindWindowExW, GetParent, PostMessageW, SendMessageW, WM_APP,
};

fn handle(value: &serde_json::Value) -> usize {
    value.as_str().unwrap().parse::<u64>().unwrap() as usize
}

fn find(parent: usize, class: &str, title: Option<&str>) -> usize {
    let class = wide(class);
    let title = title.map(wide);
    // SAFETY: NUL-terminated names.
    unsafe {
        FindWindowExW(
            parent as HWND,
            ptr::null_mut(),
            class.as_ptr(),
            title.as_ref().map_or(ptr::null(), |title| title.as_ptr()),
        ) as usize
    }
}

fn send(hwnd: usize, message: u32, wparam: usize, lparam: isize) -> isize {
    // SAFETY: a window of this test, answered on its own thread.
    unsafe { SendMessageW(hwnd as HWND, message, wparam, lparam) }
}

#[test]
fn reply_keys_pick_dwdata_then_wparam_then_the_message() {
    let mut table = Replies::default();
    let copy = |data| CopyData {
        data,
        length: 0,
        bytes: ptr::null(),
    };
    table.set(1, WM_COPYDATA, None, Some(0));
    table.set(1, WM_COPYDATA, Some(Key::CopyData(1)), Some(1));
    table.set(1, WM_APP, Some(Key::WParam(4)), Some(3));
    // SAFETY: COPYDATASTRUCTs alive during each call.
    unsafe {
        let one = copy(1);
        let three = copy(3);
        assert_eq!(
            table.get(1, WM_COPYDATA, 0, &one as *const _ as isize),
            Some(1)
        );
        assert_eq!(
            table.get(1, WM_COPYDATA, 0, &three as *const _ as isize),
            Some(0)
        );
        assert_eq!(
            table.get(2, WM_COPYDATA, 0, &one as *const _ as isize),
            None
        );
        assert_eq!(table.get(1, WM_APP, 4, 0), Some(3));
        assert_eq!(table.get(1, WM_APP, 5, 0), None);
    }
    table.set(1, WM_APP, Some(Key::WParam(4)), None);
    assert_eq!(unsafe { table.get(1, WM_APP, 4, 0) }, None);
    assert!(Key::of(3, 0).is_err());
}

#[test]
fn builds_a_tray_like_tree_answering_natively_and_delivering_per_window() {
    let _turn = threadsafe::test_turn();
    let callback = threadsafe::create(8103, 0, u32::MAX, 0).unwrap();
    let id = open(
        options(serde_json::json!({
            "className": "TarveTreeTestTray",
            "messageOnly": true,
            "messages": [WM_COPYDATA, WM_APP + 6],
            "replies": [[WM_COPYDATA, 0], [WM_COPYDATA, 1, 2, "1"], [WM_APP + 8, 3, 1, "4"]],
            "children": [
                { "className": "TarveTreeTestNotify", "children": [
                    { "className": "TarveTreeTestPager", "children": [
                        { "className": "TarveTreeTestToolbar", "windowName": "User Promoted Notification Area" },
                    ] },
                ] },
                { "className": "TarveTreeTestReBar", "replies": [[WM_APP + 7, 5]] },
                { "className": "TarveTreeTestToolbar", "windowName": "Second" },
            ],
        })),
        callback,
    )
    .unwrap();
    let described: serde_json::Value = serde_json::from_str(&info(id).unwrap()).unwrap();
    assert_eq!(described["className"], "TarveTreeTestTray");
    let main = handle(&described["hwnd"]);
    let children = described["children"].as_array().unwrap();
    assert_eq!(
        children.len(),
        5,
        "depth first: notify, pager, toolbar, rebar, toolbar"
    );
    let notify = find(main, "TarveTreeTestNotify", None);
    assert_ne!(notify, 0);
    assert_eq!(notify, handle(&children[0]["hwnd"]));
    assert_eq!(handle(&children[0]["parent"]), main);
    let pager = find(notify, "TarveTreeTestPager", None);
    let toolbar = find(
        pager,
        "TarveTreeTestToolbar",
        Some("User Promoted Notification Area"),
    );
    assert_eq!(toolbar, handle(&children[2]["hwnd"]));
    assert_eq!(unsafe { GetParent(toolbar as HWND) } as usize, pager);
    let rebar = find(main, "TarveTreeTestReBar", None);
    assert_eq!(
        find(main, "TarveTreeTestToolbar", Some("Second")),
        handle(&children[4]["hwnd"])
    );
    // Per-window tables, answered on the window's thread without JavaScript.
    assert_eq!(send(rebar, WM_APP + 7, 0, 0), 5);
    assert_eq!(
        send(main, WM_APP + 7, 0, 0),
        0,
        "not main's entry: DefWindowProc"
    );
    assert_eq!(send(main, WM_APP + 8, 4, 0), 3);
    assert_eq!(send(main, WM_APP + 8, 5, 0), 0, "another wParam");
    assert!(set_reply(id, rebar as u64, WM_APP + 9, 1, 2, 1, 8));
    assert_eq!(send(rebar, WM_APP + 9, 2, 0), 8);
    assert!(set_reply(id, rebar as u64, WM_APP + 9, 1, 2, 0, 0));
    assert_eq!(send(rebar, WM_APP + 9, 2, 0), 0);
    assert!(!set_reply(id, rebar as u64, WM_APP + 9, 7, 2, 1, 1));
    // NIM_* (dwData 1) answered 1 at once, its payload still delivered (copied).
    let payload = *b"nid";
    let nim = CopyData {
        data: 1,
        length: 3,
        bytes: payload.as_ptr(),
    };
    let other = CopyData {
        data: 3,
        length: 0,
        bytes: ptr::null(),
    };
    assert_eq!(send(main, WM_COPYDATA, 0, &nim as *const _ as isize), 1);
    assert_eq!(send(main, WM_COPYDATA, 0, &other as *const _ as isize), 0);
    assert_ne!(
        unsafe { PostMessageW(toolbar as HWND, WM_APP + 6, 1, 2) },
        0
    );
    let mut calls = Vec::new();
    until(&mut calls, 8103, |mine| mine.len() >= 3);
    let mine: Vec<_> = calls.iter().filter(|call| call.0 == 8103).collect();
    assert_eq!(mine[0].1[0], KIND_MESSAGE);
    assert_eq!(mine[0].1[5], main as u64, "the window that got it");
    assert_eq!(mine[0].2, [1, 0, 0, 0, 0, 0, 0, 0, b'n', b'i', b'd']);
    assert_eq!(mine[2].1[..4], [KIND_MESSAGE, u64::from(WM_APP + 6), 1, 2]);
    assert_eq!(mine[2].1[5], toolbar as u64);

    // A window made a WS_CHILD of another (here: of the first tree's top window).
    let child = open(
        options(serde_json::json!({ "className": "TarveTreeTestChild", "parent": main as u64 })),
        callback,
    )
    .unwrap();
    let described: serde_json::Value = serde_json::from_str(&info(child).unwrap()).unwrap();
    assert_eq!(
        find(main, "TarveTreeTestChild", None),
        handle(&described["hwnd"])
    );
    assert!(close(child));
    let error = open(
        options(serde_json::json!({ "messageOnly": true, "parent": main as u64 })),
        callback,
    )
    .err()
    .unwrap();
    assert!(error.contains("exclude"), "{error}");
    assert!(close(id));
    // Classes are released with the tree: the same tree opens again.
    let again = open(
        options(serde_json::json!({
            "messageOnly": true,
            "children": [{ "className": "TarveTreeTestNotify" }],
        })),
        callback,
    )
    .unwrap();
    assert!(close(again));
    threadsafe::close(callback);
    take(&mut calls);
}

#[test]
fn checks_tree_size() {
    let deep = (0..20).fold(
        serde_json::json!([]),
        |inner, _| serde_json::json!([{ "className": "X", "children": inner }]),
    );
    let children: Vec<Child> = serde_json::from_value(deep).unwrap();
    assert!(check(&children).unwrap_err().contains("deep"));
    let wide: Vec<Child> = serde_json::from_value(serde_json::json!(vec![
        serde_json::json!({ "className": "X" });
        300
    ]))
    .unwrap();
    assert!(check(&wide).unwrap_err().contains("children"));
}
