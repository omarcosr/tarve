use super::accessibility_actions::accessibility_scroll_alignment;
use crate::tree::AccessibilityScrollAlignment;
use accesskit::{ActionData, ScrollHint};

#[test]
fn preserves_vertical_accesskit_scroll_hints_for_text_ranges() {
    assert_eq!(
        accessibility_scroll_alignment(Some(&ActionData::ScrollHint(ScrollHint::TopEdge))),
        Some(AccessibilityScrollAlignment::Top)
    );
    assert_eq!(
        accessibility_scroll_alignment(Some(&ActionData::ScrollHint(ScrollHint::BottomEdge))),
        Some(AccessibilityScrollAlignment::Bottom)
    );
    assert_eq!(
        accessibility_scroll_alignment(Some(&ActionData::ScrollHint(ScrollHint::LeftEdge))),
        None
    );
}
