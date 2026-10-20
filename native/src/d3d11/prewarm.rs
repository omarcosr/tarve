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

/// The hardware driver; `TARVE_D3D11_WARP=1` picks WARP, the software rasterizer GPU-less CI
/// runners get, to reproduce them on a machine with a GPU.
pub(super) fn driver_type() -> windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE {
    use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP};
    if std::env::var_os("TARVE_D3D11_WARP").is_some_and(|value| value == "1") {
        D3D_DRIVER_TYPE_WARP
    } else {
        D3D_DRIVER_TYPE_HARDWARE
    }
}

/// Device lifetime, the other end: D3D11 destroys a released object only once the GPU is
/// done with it, so a window's flip-model swap chain can outlive its renderer and make the
/// next one for the same window (shown again after `app.hide()`) fail with E_ACCESSDENIED.
/// Unbind everything, drop the back buffer's views and wait for the GPU before the fields go.
impl Drop for super::D3d11Graphics {
    fn drop(&mut self) {
        use windows::Win32::Graphics::Direct3D11::{
            D3D11_QUERY_DESC, D3D11_QUERY_EVENT, ID3D11Query,
        };
        self.current_target = None;
        self.render_target = None;
        self.canvas = None;
        self.frame_cache = None;
        self.backdrop = None;
        self.depth_view = None;
        unsafe {
            self.context.ClearState();
            let desc = D3D11_QUERY_DESC {
                Query: D3D11_QUERY_EVENT,
                MiscFlags: 0,
            };
            let mut query: Option<ID3D11Query> = None;
            if self.device.CreateQuery(&desc, Some(&mut query)).is_ok()
                && let Some(query) = query
            {
                self.context.End(&query);
                self.context.Flush();
                // A lost device never signals: give up after about a second.
                let mut done = windows::core::BOOL(0);
                for _ in 0..1000 {
                    // S_FALSE (not yet) is a success code too: `done` says when it finished.
                    let ready = self.context.GetData(
                        &query,
                        Some(&mut done as *mut _ as *mut _),
                        std::mem::size_of_val(&done) as u32,
                        0,
                    );
                    if ready.is_err() || done.as_bool() {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
            } else {
                self.context.Flush();
            }
        }
    }
}
