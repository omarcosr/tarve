//! Actions a screen reader asks of a node (UI Automation, AT-SPI, TalkBack), carried out on the tree.
use super::*;
use crate::tree::AccessibilityScrollAlignment;
use accesskit::{Action, ActionData, ScrollHint, ScrollUnit};

pub(super) fn accessibility_scroll_alignment(
    data: Option<&ActionData>,
) -> Option<AccessibilityScrollAlignment> {
    match data {
        Some(ActionData::ScrollHint(ScrollHint::TopLeft | ScrollHint::TopEdge)) => {
            Some(AccessibilityScrollAlignment::Top)
        }
        Some(ActionData::ScrollHint(ScrollHint::BottomRight | ScrollHint::BottomEdge)) => {
            Some(AccessibilityScrollAlignment::Bottom)
        }
        _ => None,
    }
}

impl App {
    pub(super) fn handle_accessibility_action(
        &mut self,
        request: ActionRequest,
    ) -> Vec<serde_json::Value> {
        let text_run_start = self
            .accessibility
            .as_ref()
            .and_then(|accessibility| accessibility.text_run_start(request.target_node));
        let Some(native_id) = self
            .accessibility
            .as_ref()
            .and_then(|accessibility| accessibility.resolve(request.target_node))
            .map(str::to_string)
        else {
            return vec![];
        };
        if !self.tree.entries.contains_key(&native_id) {
            return vec![];
        }
        match request.action {
            Action::Focus => self.tree.accessibility_focus(&native_id),
            Action::Blur => self.tree.accessibility_blur(&native_id),
            Action::Click | Action::Expand | Action::Collapse => {
                self.tree.accessibility_click(&native_id)
            }
            Action::ShowContextMenu => self.tree.accessibility_context(&native_id),
            Action::Increment => self.tree.accessibility_adjust_numeric(&native_id, 1.0),
            Action::Decrement => self.tree.accessibility_adjust_numeric(&native_id, -1.0),
            Action::SetValue => match request.data {
                Some(ActionData::Value(value)) => {
                    self.tree.accessibility_set_text_value(&native_id, &value)
                }
                Some(ActionData::NumericValue(value)) => {
                    self.tree.accessibility_set_numeric_value(&native_id, value)
                }
                _ => vec![],
            },
            Action::ReplaceSelectedText => match request.data {
                Some(ActionData::Value(value)) => self
                    .tree
                    .accessibility_replace_selected_text(&native_id, &value),
                _ => vec![],
            },
            Action::SetTextSelection => match request.data {
                Some(ActionData::SetTextSelection(selection)) => {
                    let positions = self.accessibility.as_ref().and_then(|accessibility| {
                        let anchor = accessibility.resolve_text_position(selection.anchor)?;
                        let focus = accessibility.resolve_text_position(selection.focus)?;
                        (anchor.0 == native_id && focus.0 == native_id)
                            .then_some((anchor.1, focus.1))
                    });
                    positions.map_or_else(Vec::new, |(anchor, focus)| {
                        self.tree
                            .accessibility_set_text_selection(&native_id, anchor, focus)
                    })
                }
                _ => vec![],
            },
            Action::ScrollUp | Action::ScrollDown | Action::ScrollLeft | Action::ScrollRight => {
                let page = matches!(request.data, Some(ActionData::ScrollUnit(ScrollUnit::Page)));
                let (direction_x, direction_y) = match request.action {
                    Action::ScrollUp => (0.0, -1.0),
                    Action::ScrollDown => (0.0, 1.0),
                    Action::ScrollLeft => (-1.0, 0.0),
                    Action::ScrollRight => (1.0, 0.0),
                    _ => (0.0, 0.0),
                };
                self.tree
                    .accessibility_scroll_by(&native_id, direction_x, direction_y, page)
            }
            Action::SetScrollOffset => match request.data {
                Some(ActionData::SetScrollOffset(point)) => self
                    .tree
                    .accessibility_set_scroll(&native_id, point.x, point.y),
                _ => vec![],
            },
            Action::ScrollIntoView => {
                if let Some(character) = text_run_start {
                    let alignment = accessibility_scroll_alignment(request.data.as_ref());
                    self.tree.accessibility_scroll_text_position_into_view(
                        &native_id, character, alignment,
                    )
                } else {
                    self.tree.accessibility_scroll_into_view(&native_id)
                }
            }
            _ => vec![],
        }
    }
}
