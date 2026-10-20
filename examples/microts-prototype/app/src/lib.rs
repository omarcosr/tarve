//! Host glue for the Tarve counter compiled by MicroTS.
#![no_std]

extern crate alloc;

use core::ops::{Deref, DerefMut};
use microts::{Host, Input, Ui};

#[path = "../gen/mod.rs"]
pub mod generated;
include!("../gen/fonts.rs");
pub use generated::{AppApp, AppEvent, AppModel, AppProps, AppViewModel};

pub const WIDTH: usize = 620;
pub const HEIGHT: usize = 520;

pub struct CounterHost(pub Ui);
impl Host for CounterHost {
    fn ui(&self) -> &Ui {
        &self.0
    }
    fn ui_mut(&mut self) -> &mut Ui {
        &mut self.0
    }
    fn into_ui(self) -> Ui {
        self.0
    }
}

pub struct CounterApp {
    native: AppApp<AppModel, CounterHost>,
}

impl Default for CounterApp {
    fn default() -> Self {
        Self::new(Ui::new())
    }
}

impl CounterApp {
    pub fn new(mut ui: Ui) -> Self {
        assert!(ui.load_styles(include_bytes!("../gen/styles.bin")));
        ui.core_mut().set_viewport(WIDTH as f32, HEIGHT as f32);
        load_fonts(&mut ui);
        let mut native = AppApp::new(CounterHost(ui), AppProps {}, AppModel::default());
        let first = native.ui().initial_focus();
        native.ui_mut().set_focus(first);
        Self { native }
    }

    pub fn frame(&mut self, input: Input) -> &[AppEvent] {
        self.native.frame(&input)
    }

    pub fn unmount(self) -> Ui {
        self.native.unmount()
    }
}

impl Deref for CounterApp {
    type Target = AppApp<AppModel, CounterHost>;
    fn deref(&self) -> &Self::Target {
        &self.native
    }
}

impl DerefMut for CounterApp {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.native
    }
}
