//! Desktop window for the MicroTS counter: software raster + minifb, no JS engine.
#![windows_subsystem = "windows"]

use microts::pocketjs_core::raster;
use microts::spec::btn;
use microts::{Input, NodeId, Ui};
use minifb::{Key, KeyRepeat, MouseButton, MouseMode, Window, WindowOptions};
use tarve_counter_microts::{CounterApp, HEIGHT, WIDTH};

fn contains(ui: &Ui, root: NodeId, node: NodeId) -> bool {
    root == node || ui.core().node_children(root.0).iter().any(|child| contains(ui, NodeId(*child), node))
}

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

fn main() {
    let mut app = CounterApp::default();
    app.frame(Input::default());
    if let Some(path) = std::env::args().skip_while(|a| a != "--screenshot").nth(1) {
        let core = app.ui_mut().core_mut();
        core.draw();
        let mut rgba = vec![0u8; WIDTH * HEIGHT * 4];
        raster::render_scaled_argb(core, &core.current_draw_list().words, &mut rgba, 1);
        let mut bmp = Vec::with_capacity(54 + rgba.len());
        bmp.extend_from_slice(b"BM");
        for v in [(54 + rgba.len()) as u32, 0, 54, 40, WIDTH as u32, (-(HEIGHT as i32)) as u32] {
            bmp.extend_from_slice(&v.to_le_bytes());
        }
        bmp.extend_from_slice(&[1, 0, 32, 0]);
        for v in [0u32, rgba.len() as u32, 2835, 2835, 0, 0] {
            bmp.extend_from_slice(&v.to_le_bytes());
        }
        bmp.extend_from_slice(&rgba);
        std::fs::write(path, bmp).expect("screenshot");
        return;
    }
    let buttons = ["Decrease", "Increase", "Protect"].map(|name| find(app.ui(), NodeId::ROOT, name));
    let mut window = Window::new("Counter (MicroTS)", WIDTH, HEIGHT, WindowOptions::default()).expect("window");
    window.set_target_fps(60);
    let mut rgba = vec![0u8; WIDTH * HEIGHT * 4];
    let mut frame = vec![0u32; WIDTH * HEIGHT];
    let mut was_down = false;
    while window.is_open() && !window.is_key_down(Key::Escape) {
        let mut input = Input::default();
        let down = window.get_mouse_down(MouseButton::Left);
        if down && !was_down {
            if let Some((x, y)) = window.get_mouse_pos(MouseMode::Discard) {
                let hit = NodeId(app.ui_mut().core_mut().hit_test(x, y));
                if let Some(&target) = buttons.iter().find(|&&b| hit != NodeId::NONE && contains(app.ui(), b, hit)) {
                    input = Input::press(target);
                }
            }
        }
        was_down = down;
        let mut held = 0;
        for (key, bit) in [(Key::Left, btn::LEFT), (Key::Right, btn::RIGHT), (Key::Up, btn::UP), (Key::Down, btn::DOWN), (Key::Tab, btn::RIGHT)] {
            if window.is_key_pressed(key, KeyRepeat::Yes) {
                held |= bit;
            }
        }
        if window.is_key_down(Key::Enter) || window.is_key_down(Key::Space) {
            held |= btn::CIRCLE;
        }
        input.buttons |= held;
        app.frame(input);
        let core = app.ui_mut().core_mut();
        core.draw();
        raster::render_scaled_argb(core, &core.current_draw_list().words, &mut rgba, 1);
        for (pixel, bgra) in frame.iter_mut().zip(rgba.chunks_exact(4)) {
            *pixel = u32::from_le_bytes([bgra[0], bgra[1], bgra[2], 0]);
        }
        window.update_with_buffer(&frame, WIDTH, HEIGHT).expect("present");
    }
}
