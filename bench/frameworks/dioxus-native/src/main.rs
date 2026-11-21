#![windows_subsystem = "windows"]
use dioxus::prelude::*;

fn main() {
    use dioxus::native::{Config, LogicalSize, WindowAttributes};
    let window = WindowAttributes::default().with_title("bench").with_inner_size(LogicalSize::new(1024.0, 760.0));
    dioxus::LaunchBuilder::new().with_cfg(Config::default().with_window_attributes(window)).launch(app);
}

fn app() -> Element {
    let mut tick = use_signal(|| 0u32);
    let list = std::env::var("SCENE").as_deref() == Ok("list");
    let t = tick();
    let marker = if t == 0 { "#ff00ff" } else if t % 2 == 1 { "#00ff00" } else { "#0000ff" };
    rsx! {
        style { "html, body {{ margin: 0; height: 100%; }}" }
        div { style: "height: 100vh; display: flex; flex-direction: column; background: #fff; font-family: system-ui, sans-serif; font-size: 14px;",
            div { style: "height: 48px; flex-shrink: 0; position: relative;",
                div { style: "position: absolute; left: 0; top: 0; width: 48px; height: 48px; background: {marker};" }
                button { style: "position: absolute; left: 64px; top: 8px; width: 120px; height: 32px;", onclick: move |_| tick += 1, "Update" }
            }
            if list {
                div { style: "flex: 1; min-height: 0; overflow: auto;",
                    for i in 0..2000 {
                        div { key: "{i}", style: "height: 36px; flex-shrink: 0; display: flex; align-items: center; gap: 12px;",
                            span { style: "flex: 1;", "Record {i}: native layout and text {t}" }
                            button { "Open" }
                        }
                    }
                }
            } else {
                span { "hi" }
            }
        }
    }
}
