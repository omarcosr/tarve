#![windows_subsystem = "windows"]
use tauri::{WebviewUrl, WebviewWindowBuilder};

fn main() {
    let scene = std::env::var("SCENE").unwrap_or_else(|_| "empty".into());
    tauri::Builder::default()
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App(format!("index.html?scene={scene}").into()))
                .title("bench")
                .inner_size(1024.0, 760.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri");
}
