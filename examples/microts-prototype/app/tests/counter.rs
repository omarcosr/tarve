use microts::{Input, NodeId, Ui};
use tarve_counter_microts::{AppViewModel, CounterApp};

fn find(ui: &Ui, id: NodeId, name: &str) -> NodeId {
    if ui.debug_name(id) == Some(name) {
        return id;
    }
    for child in ui.core().node_children(id.0) {
        let found = find(ui, NodeId(*child), name);
        if found != NodeId::NONE {
            return found;
        }
    }
    NodeId::NONE
}

#[test]
fn counter_presses_update_the_compiled_model() {
    let mut app = CounterApp::default();
    app.frame(Input::default());
    let increase = find(app.ui(), NodeId::ROOT, "Increase");
    let decrease = find(app.ui(), NodeId::ROOT, "Decrease");
    let protect = find(app.ui(), NodeId::ROOT, "Protect");
    assert_ne!(increase, NodeId::NONE);
    assert_ne!(decrease, NodeId::NONE);
    assert_ne!(protect, NodeId::NONE);

    for _ in 0..3 {
        app.frame(Input::press(increase));
        app.frame(Input::default());
    }
    app.frame(Input::press(decrease));
    app.frame(Input::default());
    assert_eq!(app.model.count(), 2);

    assert!(app.model.protectClose());
    app.frame(Input::press(protect));
    app.frame(Input::default());
    assert!(!app.model.protectClose());
    assert_eq!(app.model.status(), "Window may now be closed");
    app.unmount();
}
