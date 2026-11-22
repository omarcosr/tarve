//! Window options in the document: desktop widgets, level and taskbar.
use super::*;

#[test]
fn start_rejects_a_desktop_widget_without_cells() {
    let document = json!({
        "version": protocol::VERSION,
        "renderer": "auto",
        "window": { "title": "W", "width": 300.0, "height": 200.0, "minWidth": 300.0, "minHeight": 200.0,
            "background": "#000", "desktopWidget": { "columns": 0, "rows": 2 } },
        "root": { "id": "root", "kind": "window", "style": {}, "children": [] }
    })
    .to_string();
    assert_eq!(
        unsafe { bridge::tarve_start(document.as_ptr(), document.len() as u32) },
        -1
    );
    let mut message = [0u8; 256];
    let length = unsafe { bridge::tarve_last_error(message.as_mut_ptr(), message.len() as u32) };
    assert_eq!(&message[..length as usize], b"Invalid desktop widget size");
}

#[test]
fn desktop_widgets_without_an_icon_grid_get_typical_icon_cells() {
    let size = crate::runtime::nominal_widget_size(protocol::DesktopWidget {
        columns: 3,
        rows: 2,
    });
    assert_eq!(size, (232.0, 192.0));
}

#[test]
fn window_options_read_widget_placement_and_default_to_a_normal_window() {
    let base = json!({ "title": "W", "width": 300.0, "height": 600.0, "minWidth": 300.0, "minHeight": 600.0, "background": "#000" });
    let plain: protocol::WindowOptions = serde_json::from_value(base.clone()).unwrap();
    assert_eq!(
        (plain.level, plain.skip_taskbar, plain.desktop_widget),
        (protocol::WindowLevel::Normal, false, None)
    );
    let mut widget = base;
    widget["level"] = json!("alwaysOnBottom");
    widget["skipTaskbar"] = json!(true);
    widget["desktopWidget"] = json!({ "columns": 3, "rows": 2 });
    let widget: protocol::WindowOptions = serde_json::from_value(widget).unwrap();
    assert_eq!(
        (widget.level, widget.skip_taskbar, widget.desktop_widget),
        (
            protocol::WindowLevel::AlwaysOnBottom,
            true,
            Some(protocol::DesktopWidget {
                columns: 3,
                rows: 2
            })
        )
    );
}
