//! The D3D11 device created ahead, on its own thread, while the window and first layout are made.
use super::*;

struct PrewarmedDevice(Result<(ID3D11Device, ID3D11DeviceContext), String>);
// SAFETY: the device is created on the prewarm thread and handed over once;
// D3D11 devices are free-threaded and the immediate context is only used by
// the window thread after the handoff.
unsafe impl Send for PrewarmedDevice {}
static PREWARM: std::sync::Mutex<Option<std::thread::JoinHandle<PrewarmedDevice>>> =
    std::sync::Mutex::new(None);
/// Starts `D3D11CreateDevice` on a background thread. Loading the driver takes
/// most of the GPU startup (~140 ms), and it does not need the window, so it
/// overlaps window creation and the first layout.
pub(crate) fn prewarm_device() {
    let Ok(mut slot) = PREWARM.lock() else { return };
    if slot.is_some() {
        return;
    }
    *slot = std::thread::Builder::new()
        .name("tarve-d3d11-prewarm".into())
        .spawn(|| PrewarmedDevice(super::create_device_now()))
        .ok();
}
/// The prewarm thread is still creating the device: a window opened now would wait for it.
pub(crate) fn prewarm_pending() -> bool {
    PREWARM
        .lock()
        .ok()
        .is_some_and(|slot| slot.as_ref().is_some_and(|handle| !handle.is_finished()))
}
pub(super) fn create_device() -> Result<(ID3D11Device, ID3D11DeviceContext), String> {
    let prewarmed = PREWARM.lock().ok().and_then(|mut slot| slot.take());
    match prewarmed.and_then(|handle| handle.join().ok()) {
        Some(PrewarmedDevice(result)) => result,
        None => super::create_device_now(),
    }
}
