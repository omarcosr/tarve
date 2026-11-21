#![windows_subsystem = "windows"]
use eframe::egui;

struct Bench { tick: u32, list: bool }

impl eframe::App for Bench {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        egui::CentralPanel::default().frame(egui::Frame::NONE.fill(egui::Color32::WHITE)).show(ctx, |ui| {
            let marker = match self.tick { 0 => egui::Color32::from_rgb(255, 0, 255), t if t % 2 == 1 => egui::Color32::from_rgb(0, 255, 0), _ => egui::Color32::from_rgb(0, 0, 255) };
            ui.painter().rect_filled(egui::Rect::from_min_size(egui::pos2(0.0, 0.0), egui::vec2(48.0, 48.0)), 0.0, marker);
            if ui.put(egui::Rect::from_min_size(egui::pos2(64.0, 8.0), egui::vec2(120.0, 32.0)), egui::Button::new("Update")).clicked() { self.tick += 1; }
            let rest = egui::Rect::from_min_max(egui::pos2(0.0, 48.0), ui.max_rect().max);
            let mut child = ui.new_child(egui::UiBuilder::new().max_rect(rest));
            if self.list {
                egui::ScrollArea::vertical().auto_shrink(false).show(&mut child, |ui| {
                    for i in 0..2000 {
                        ui.allocate_ui_with_layout(egui::vec2(ui.available_width(), 36.0), egui::Layout::left_to_right(egui::Align::Center), |ui| {
                            ui.label(format!("Record {i}: native layout and text {}", self.tick));
                            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| { let _ = ui.button("Open"); });
                        });
                    }
                });
            } else {
                child.label("hi");
            }
        });
    }
}

fn main() -> eframe::Result {
    let options = eframe::NativeOptions { viewport: egui::ViewportBuilder::default().with_title("bench").with_inner_size([1024.0, 760.0]), ..Default::default() };
    let list = std::env::var("SCENE").as_deref() == Ok("list");
    eframe::run_native("bench", options, Box::new(move |_| Ok(Box::new(Bench { tick: 0, list }))))
}
