//! Keyboard state winit's Android backend leaves out.

use winit::event::{ElementState, WindowEvent};
use winit::keyboard::{Key, ModifiersState, NamedKey};

/// Tracks Ctrl/Shift/Alt/Meta from their own key events (winit sends no
/// `ModifiersChanged` on Android), and gives a printable key its text when the
/// backend did not, so text fields receive what a hardware or soft keyboard types.
pub(crate) fn adapt(event: WindowEvent, modifiers: &mut ModifiersState) -> WindowEvent {
    let WindowEvent::KeyboardInput {
        device_id,
        mut event,
        is_synthetic,
    } = event
    else {
        return event;
    };
    // The key character map gives Enter, Tab and Space as characters; the shared handling
    // (submit, focus moves, button presses) expects the named keys.
    let named = match &event.logical_key {
        Key::Character(text) if text == "\n" || text == "\r" => Some(NamedKey::Enter),
        Key::Character(text) if text == "\t" => Some(NamedKey::Tab),
        Key::Character(text) if text == " " => Some(NamedKey::Space),
        _ => None,
    };
    if let Some(named) = named {
        event.logical_key = Key::Named(named);
        event.text =
            (named == NamedKey::Space && event.state == ElementState::Pressed).then(|| " ".into());
    }
    let pressed = event.state == ElementState::Pressed;
    let flag = match &event.logical_key {
        Key::Named(NamedKey::Control) => ModifiersState::CONTROL,
        Key::Named(NamedKey::Shift) => ModifiersState::SHIFT,
        Key::Named(NamedKey::Alt | NamedKey::AltGraph) => ModifiersState::ALT,
        Key::Named(NamedKey::Super | NamedKey::Meta) => ModifiersState::SUPER,
        _ => ModifiersState::empty(),
    };
    if !flag.is_empty() {
        modifiers.set(flag, pressed);
    }
    if pressed
        && event.text.is_none()
        && let Some(text) = typed_text(&event.logical_key)
    {
        event.text = Some(text.into());
    }
    WindowEvent::KeyboardInput {
        device_id,
        event,
        is_synthetic,
    }
}

pub(crate) fn typed_text(key: &Key) -> Option<&str> {
    match key {
        Key::Character(text) => Some(text.as_str()),
        Key::Named(NamedKey::Space) => Some(" "),
        _ => None,
    }
}
