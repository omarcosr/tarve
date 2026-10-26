//! The pointer's shape over a node: by its kind, or a CSS `cursor` keyword.
use crate::protocol::Node;
use winit::window::CursorIcon;

pub(crate) fn cursor_for_node(node: Option<&Node>) -> CursorIcon {
    match node {
        Some(node) if node.kind == "splitter" => {
            if node
                .control
                .as_ref()
                .is_some_and(|control| control.orientation == "vertical")
            {
                CursorIcon::RowResize
            } else {
                CursorIcon::ColResize
            }
        }
        Some(node) if matches!(node.kind.as_str(), "button" | "pressable" | "slider") => {
            CursorIcon::Pointer
        }
        Some(node) if matches!(node.kind.as_str(), "input" | "textarea") => CursorIcon::Text,
        _ => CursorIcon::Default,
    }
}

/// CSS `cursor` keywords winit can show.
pub(crate) fn css_cursor(name: &str) -> Option<CursorIcon> {
    Some(match name {
        "default" => CursorIcon::Default,
        "pointer" => CursorIcon::Pointer,
        "text" => CursorIcon::Text,
        "vertical-text" => CursorIcon::VerticalText,
        "move" => CursorIcon::Move,
        "grab" => CursorIcon::Grab,
        "grabbing" => CursorIcon::Grabbing,
        "not-allowed" => CursorIcon::NotAllowed,
        "no-drop" => CursorIcon::NoDrop,
        "wait" => CursorIcon::Wait,
        "progress" => CursorIcon::Progress,
        "help" => CursorIcon::Help,
        "crosshair" => CursorIcon::Crosshair,
        "copy" => CursorIcon::Copy,
        "alias" => CursorIcon::Alias,
        "context-menu" => CursorIcon::ContextMenu,
        "cell" => CursorIcon::Cell,
        "zoom-in" => CursorIcon::ZoomIn,
        "zoom-out" => CursorIcon::ZoomOut,
        "col-resize" => CursorIcon::ColResize,
        "row-resize" => CursorIcon::RowResize,
        "ew-resize" => CursorIcon::EwResize,
        "ns-resize" => CursorIcon::NsResize,
        "nesw-resize" => CursorIcon::NeswResize,
        "nwse-resize" => CursorIcon::NwseResize,
        "all-scroll" => CursorIcon::AllScroll,
        _ => return None,
    })
}
