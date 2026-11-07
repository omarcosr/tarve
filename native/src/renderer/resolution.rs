//! The resolution frames are drawn at and the CPU rasterizer's threads.

/// The resolution frames are drawn at, relative to the window's. A phone's display may be far
/// denser than the eye resolves at arm's length (a 1440 px wide phone has 3.75 px per dp):
/// drawing every pixel there costs the CPU renderer its vsync and the GPU renderer ~70 MB of
/// buffers and its fill rate. On Android frames are drawn at most at 2.8125 px per dp, the
/// density of a 1080 px wide phone and the resolution such phones ship with, and the compositor
/// scales them up. `adb shell setprop debug.tarve.density <px per dp>` (TARVE_RENDER_DENSITY)
/// moves the cap; 0 draws every pixel.
pub(crate) fn render_scale(scale_factor: f64) -> f64 {
    static CAP: std::sync::OnceLock<f64> = std::sync::OnceLock::new();
    let cap = *CAP.get_or_init(|| {
        std::env::var("TARVE_RENDER_DENSITY")
            .ok()
            .and_then(|value| value.trim().parse::<f64>().ok())
            .unwrap_or(2.8125)
    });
    if cfg!(target_os = "android") && cap > 0.0 {
        (cap / scale_factor).min(1.0)
    } else {
        1.0
    }
}

/// The CPU rasterizer's threads for a frame of `pixels`. On Android, up to four helpers (a
/// phone's single core cannot fill a 1080 px wide frame per vsync). On desktops the raster
/// thread already works beside the window's: a frame up to `HELPERS_FROM_PIXELS` (a laptop
/// window) rasterizes on it alone, as fast per frame and without each helper's tile buffers
/// (about 10 MB); a larger one gets two helpers. TARVE_CPU_THREADS overrides the count.
pub(super) fn cpu_render_settings(pixels: usize) -> vello_cpu::RenderSettings {
    const HELPERS_FROM_PIXELS: usize = 1_500_000;
    let mut settings = vello_cpu::RenderSettings::default();
    let available = settings.num_threads;
    settings.num_threads = std::env::var("TARVE_CPU_THREADS")
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(if cfg!(target_os = "android") {
            available.min(4)
        } else if pixels > HELPERS_FROM_PIXELS {
            available.min(2)
        } else {
            0
        });
    settings
}

/// A window's size in the pixels frames are drawn at (`render_scale`).
pub(crate) fn scaled_size(width: u32, height: u32, scale_factor: f64) -> (u32, u32) {
    let k = render_scale(scale_factor);
    (
        (f64::from(width) * k).ceil() as u32,
        (f64::from(height) * k).ceil() as u32,
    )
}
