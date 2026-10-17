#[cfg(target_os = "windows")]
use crate::d3d11::{D3d11Error, D3d11Graphics, D3d11PaintTarget};
use crate::{
    cpu_display::{CpuRecorder, DisplayList, ShadowCache, damage},
    paint::CpuCachedImage,
    protocol::RendererPreference,
};
use softbuffer::{Context as SoftContext, Surface as SoftSurface};
use std::{
    collections::HashMap,
    num::NonZeroU32,
    num::NonZeroUsize,
    sync::{Arc, Mutex},
};
use vello::{AaConfig, AaSupport, RenderParams, Renderer, RendererOptions, Scene, wgpu};
use vello_cpu::{PixmapMut, RenderContext as CpuRenderContext, Resources as CpuResources};
use winit::window::Window;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PresentResult {
    Presented,
    RetryNow,
    RetryLater,
    Occluded,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SurfaceIssue {
    Timeout,
    Occluded,
    Outdated,
    Lost,
    Validation,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SurfaceRecoveryAction {
    RetryLater,
    SuspendPresentation,
    Reconfigure,
    RecreateSurface,
    Fatal,
}

pub(crate) fn surface_recovery_action(issue: SurfaceIssue) -> SurfaceRecoveryAction {
    match issue {
        SurfaceIssue::Timeout => SurfaceRecoveryAction::RetryLater,
        SurfaceIssue::Occluded => SurfaceRecoveryAction::SuspendPresentation,
        SurfaceIssue::Outdated => SurfaceRecoveryAction::Reconfigure,
        SurfaceIssue::Lost => SurfaceRecoveryAction::RecreateSurface,
        SurfaceIssue::Validation => SurfaceRecoveryAction::Fatal,
    }
}

pub(crate) fn surface_failure_threshold(issue: SurfaceIssue) -> Option<u16> {
    match issue {
        SurfaceIssue::Lost => Some(2),
        SurfaceIssue::Outdated => Some(8),
        SurfaceIssue::Timeout => Some(120),
        SurfaceIssue::Occluded | SurfaceIssue::Validation => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GraphicsFaultKind {
    DeviceLost,
    OutOfMemory,
    Internal,
    Validation,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct GraphicsFault {
    pub kind: GraphicsFaultKind,
    pub message: String,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RenderError {
    RecoverDevice(String),
    Fatal(String),
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CaptureError {
    RecoverDevice(String),
    FatalGpu(String),
    Request(String),
}

impl CaptureError {
    pub(crate) fn message(&self) -> &str {
        match self {
            Self::RecoverDevice(message) | Self::FatalGpu(message) | Self::Request(message) => {
                message
            }
        }
    }
}

fn classify_vello_error(error: vello::Error) -> RenderError {
    match error {
        vello::Error::WgpuErrorFromScope(wgpu::Error::Internal { .. }) => {
            RenderError::RecoverDevice(error.to_string())
        }
        vello::Error::WgpuErrorFromScope(wgpu::Error::OutOfMemory { .. })
        | vello::Error::WgpuErrorFromScope(wgpu::Error::Validation { .. }) => {
            RenderError::Fatal(error.to_string())
        }
        _ => RenderError::Fatal(error.to_string()),
    }
}

#[cfg(target_os = "windows")]
fn classify_d3d11_render_error(error: D3d11Error) -> RenderError {
    match error {
        D3d11Error::RecoverDevice(message) => RenderError::RecoverDevice(message),
        D3d11Error::FatalGpu(message) | D3d11Error::Request(message) => RenderError::Fatal(message),
    }
}

#[cfg(target_os = "windows")]
fn classify_d3d11_capture_error(error: D3d11Error) -> CaptureError {
    match error {
        D3d11Error::RecoverDevice(message) => CaptureError::RecoverDevice(message),
        D3d11Error::FatalGpu(message) => CaptureError::FatalGpu(message),
        D3d11Error::Request(message) => CaptureError::Request(message),
    }
}

#[derive(Default)]
struct GraphicsSignals {
    fault: Mutex<Option<GraphicsFault>>,
}

impl GraphicsSignals {
    fn priority(kind: GraphicsFaultKind) -> u8 {
        match kind {
            GraphicsFaultKind::OutOfMemory => 5,
            GraphicsFaultKind::Validation => 4,
            GraphicsFaultKind::DeviceLost => 3,
            GraphicsFaultKind::Internal => 2,
        }
    }

    fn record(&self, fault: GraphicsFault) {
        let mut slot = self
            .fault
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let replace = slot
            .as_ref()
            .is_none_or(|current| Self::priority(fault.kind) > Self::priority(current.kind));
        if replace {
            *slot = Some(fault);
        }
    }

    fn take(&self) -> Option<GraphicsFault> {
        self.fault
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
    }
}

struct GpuGraphics {
    // Keep surface before instance so it is dropped first.
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    target_texture: wgpu::Texture,
    target_view: wgpu::TextureView,
    blitter: wgpu::util::TextureBlitter,
    renderer: Renderer,
    device: wgpu::Device,
    queue: wgpu::Queue,
    _instance: wgpu::Instance,
    window: Arc<Window>,
    signals: Arc<GraphicsSignals>,
    backend: wgpu::Backend,
    surface_failure_streak: u16,
}

fn supports_vello_float16_packing(
    features: wgpu::Features,
    downlevel: wgpu::DownlevelFlags,
) -> bool {
    features.contains(wgpu::Features::SHADER_F16)
        || downlevel.contains(wgpu::DownlevelFlags::SHADER_F16_IN_F32)
}

impl GpuGraphics {
    fn new_with_backends(
        window: Arc<Window>,
        backends: Option<wgpu::Backends>,
    ) -> Result<Self, String> {
        let backends = backends.unwrap_or_else(|| wgpu::Backends::from_env().unwrap_or_default());
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            display: None,
            backends,
            flags: wgpu::InstanceFlags::from_build_config().with_env(),
            memory_budget_thresholds: wgpu::MemoryBudgetThresholds::default(),
            backend_options: wgpu::BackendOptions::from_env_or_default(),
        });
        let size = window.inner_size();
        let surface = instance
            .create_surface(window.clone())
            .map_err(|e| e.to_string())?;
        let adapter = pollster::block_on(wgpu::util::initialize_adapter_from_env_or_default(
            &instance,
            Some(&surface),
        ))
        .map_err(|e| e.to_string())?;
        let adapter_features = adapter.features();
        let downlevel = adapter.get_downlevel_capabilities();
        if !supports_vello_float16_packing(adapter_features, downlevel.flags) {
            let info = adapter.get_info();
            return Err(format!(
                "Vello GPU renderer is unsupported by {} ({:?}): the adapter exposes neither SHADER_F16 nor SHADER_F16_IN_F32",
                info.name, info.backend
            ));
        }
        let optional_features = wgpu::Features::CLEAR_TEXTURE
            | wgpu::Features::PIPELINE_CACHE
            | wgpu::Features::SHADER_F16;
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: None,
            required_features: adapter_features & optional_features,
            required_limits: wgpu::Limits::default(),
            memory_hints: wgpu::MemoryHints::MemoryUsage,
            ..Default::default()
        }))
        .map_err(|e| e.to_string())?;
        let signals = Arc::new(GraphicsSignals::default());
        let lost_signals = signals.clone();
        let lost_window = window.clone();
        device.set_device_lost_callback(move |reason, message| {
            if reason == wgpu::DeviceLostReason::Destroyed {
                return;
            }
            lost_signals.record(GraphicsFault {
                kind: GraphicsFaultKind::DeviceLost,
                message: if message.is_empty() {
                    format!("GPU device lost: {reason:?}")
                } else {
                    format!("GPU device lost ({reason:?}): {message}")
                },
            });
            lost_window.request_redraw();
        });
        let error_signals = signals.clone();
        let error_window = window.clone();
        device.on_uncaptured_error(Arc::new(move |error| {
            let kind = match &error {
                wgpu::Error::OutOfMemory { .. } => GraphicsFaultKind::OutOfMemory,
                wgpu::Error::Internal { .. } => GraphicsFaultKind::Internal,
                wgpu::Error::Validation { .. } => GraphicsFaultKind::Validation,
            };
            error_signals.record(GraphicsFault {
                kind,
                message: format!("Uncaptured GPU error: {error}"),
            });
            error_window.request_redraw();
        }));
        let capabilities = surface.get_capabilities(&adapter);
        let backend = adapter.get_info().backend;
        let format = capabilities
            .formats
            .into_iter()
            .find(|format| {
                matches!(
                    format,
                    wgpu::TextureFormat::Rgba8Unorm | wgpu::TextureFormat::Bgra8Unorm
                )
            })
            .ok_or("No supported surface format")?;
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: size.width.max(1),
            height: size.height.max(1),
            present_mode: wgpu::PresentMode::AutoVsync,
            desired_maximum_frame_latency: 2,
            alpha_mode: wgpu::CompositeAlphaMode::Auto,
            view_formats: vec![],
        };
        let (target_texture, target_view) = create_targets(config.width, config.height, &device);
        let blitter = wgpu::util::TextureBlitter::new(&device, format);
        surface.configure(&device, &config);
        let renderer = Renderer::new(
            &device,
            RendererOptions {
                antialiasing_support: AaSupport::area_only(),
                num_init_threads: NonZeroUsize::new(1),
                ..Default::default()
            },
        )
        .map_err(|e| e.to_string())?;
        Ok(Self {
            surface,
            config,
            target_texture,
            target_view,
            blitter,
            renderer,
            device,
            queue,
            _instance: instance,
            window,
            signals,
            backend,
            surface_failure_streak: 0,
        })
    }
    pub(crate) fn take_fault(&self) -> Option<GraphicsFault> {
        self.signals.take()
    }
    pub(crate) fn backend(&self) -> wgpu::Backend {
        self.backend
    }
    fn reconfigure_surface(&mut self) {
        self.surface.configure(&self.device, &self.config);
    }
    fn recreate_surface(&mut self) -> Result<(), String> {
        let surface = self
            ._instance
            .create_surface(self.window.clone())
            .map_err(|error| error.to_string())?;
        // On DX12 flip-model swapchains, only one configured swapchain may target an HWND.
        // Replace first so the old surface/swapchain is dropped before configuring the new one.
        self.surface = surface;
        self.surface.configure(&self.device, &self.config);
        Ok(())
    }
    fn recover_surface_issue(&mut self, issue: SurfaceIssue) -> Result<PresentResult, RenderError> {
        if let Some(threshold) = surface_failure_threshold(issue) {
            self.surface_failure_streak = self.surface_failure_streak.saturating_add(1);
            if self.surface_failure_streak >= threshold {
                return Err(RenderError::RecoverDevice(format!(
                    "Surface remained unhealthy after {} consecutive presentation failures ({issue:?})",
                    self.surface_failure_streak
                )));
            }
        }
        match surface_recovery_action(issue) {
            SurfaceRecoveryAction::RetryLater => Ok(PresentResult::RetryLater),
            SurfaceRecoveryAction::SuspendPresentation => Ok(PresentResult::Occluded),
            SurfaceRecoveryAction::Reconfigure => {
                self.reconfigure_surface();
                Ok(PresentResult::RetryNow)
            }
            SurfaceRecoveryAction::RecreateSurface => {
                self.recreate_surface().map_err(|error| {
                    RenderError::RecoverDevice(format!("Could not recreate surface: {error}"))
                })?;
                Ok(PresentResult::RetryNow)
            }
            SurfaceRecoveryAction::Fatal => Err(RenderError::Fatal(
                "Surface acquisition failed validation".into(),
            )),
        }
    }
    pub fn resize(&mut self, width: u32, height: u32) -> bool {
        if width > 0 && height > 0 && (self.config.width != width || self.config.height != height) {
            (self.target_texture, self.target_view) = create_targets(width, height, &self.device);
            self.config.width = width;
            self.config.height = height;
            self.surface.configure(&self.device, &self.config);
            return true;
        }
        false
    }
    pub fn render(
        &mut self,
        scene: &Scene,
        background: vello::peniko::Color,
    ) -> Result<PresentResult, RenderError> {
        let (frame, suboptimal) = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(frame) => (frame, false),
            wgpu::CurrentSurfaceTexture::Suboptimal(frame) => (frame, true),
            wgpu::CurrentSurfaceTexture::Outdated => {
                return self.recover_surface_issue(SurfaceIssue::Outdated);
            }
            wgpu::CurrentSurfaceTexture::Timeout => {
                return self.recover_surface_issue(SurfaceIssue::Timeout);
            }
            wgpu::CurrentSurfaceTexture::Occluded => {
                return self.recover_surface_issue(SurfaceIssue::Occluded);
            }
            wgpu::CurrentSurfaceTexture::Lost => {
                return self.recover_surface_issue(SurfaceIssue::Lost);
            }
            wgpu::CurrentSurfaceTexture::Validation => {
                return self.recover_surface_issue(SurfaceIssue::Validation);
            }
        };
        if let Err(error) = self.renderer.render_to_texture(
            &self.device,
            &self.queue,
            scene,
            &self.target_view,
            &RenderParams {
                base_color: background,
                width: self.config.width,
                height: self.config.height,
                antialiasing_method: AaConfig::Area,
            },
        ) {
            return Err(classify_vello_error(error));
        }
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = self.device.create_command_encoder(&Default::default());
        self.blitter
            .copy(&self.device, &mut encoder, &self.target_view, &view);
        self.queue.submit([encoder.finish()]);
        frame.present();
        self.surface_failure_streak = 0;
        if suboptimal {
            self.reconfigure_surface();
        }
        Ok(PresentResult::Presented)
    }
    /// Render the same display list to a readable GPU texture for reproducible visual QA.
    pub fn capture(
        &mut self,
        scene: &Scene,
        background: vello::peniko::Color,
        path: &str,
    ) -> Result<(), CaptureError> {
        let (width, height) = (self.config.width, self.config.height);
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("tarve-capture"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        self.renderer
            .render_to_texture(
                &self.device,
                &self.queue,
                scene,
                &texture.create_view(&Default::default()),
                &RenderParams {
                    base_color: background,
                    width,
                    height,
                    antialiasing_method: AaConfig::Area,
                },
            )
            .map_err(|error| match classify_vello_error(error) {
                RenderError::RecoverDevice(message) => CaptureError::RecoverDevice(message),
                RenderError::Fatal(message) => CaptureError::FatalGpu(message),
            })?;
        let pitch = (width * 4).div_ceil(256) * 256;
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("tarve-readback"),
            size: (pitch * height) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = self.device.create_command_encoder(&Default::default());
        encoder.copy_texture_to_buffer(
            texture.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(pitch),
                    rows_per_image: Some(height),
                },
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        self.queue.submit([encoder.finish()]);
        let (tx, rx) = std::sync::mpsc::channel();
        buffer
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                let _ = tx.send(result);
            });
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|error| CaptureError::Request(error.to_string()))?;
        rx.recv()
            .map_err(|error| CaptureError::Request(error.to_string()))?
            .map_err(|error| CaptureError::RecoverDevice(error.to_string()))?;
        let mapped = buffer.slice(..).get_mapped_range();
        let mut pixels = Vec::with_capacity((width * height * 4) as usize);
        for row in mapped.chunks(pitch as usize) {
            pixels.extend_from_slice(&row[..width as usize * 4]);
        }
        image::save_buffer(path, &pixels, width, height, image::ColorType::Rgba8)
            .map_err(|error| CaptureError::Request(error.to_string()))?;
        drop(mapped);
        buffer.unmap();
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RendererBackend {
    #[cfg(target_os = "windows")]
    D3d11,
    Gpu(wgpu::Backend),
    Cpu,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ResolvedRenderer {
    Gpu,
    Cpu,
}

fn renderer_from_env(value: Option<&std::ffi::OsStr>) -> Result<ResolvedRenderer, String> {
    let Some(value) = value else {
        return Ok(ResolvedRenderer::Gpu);
    };
    match value.to_string_lossy().trim().to_ascii_lowercase().as_str() {
        "" | "gpu" | "vello" => Ok(ResolvedRenderer::Gpu),
        "cpu" | "software" | "softbuffer" => Ok(ResolvedRenderer::Cpu),
        other => Err(format!(
            "Unsupported TARVE_RENDERER '{other}'; expected 'gpu' or 'cpu'"
        )),
    }
}

/// Starts GPU device creation early when the app will use the default
/// Windows GPU path.
pub(crate) fn prewarm(preference: RendererPreference) {
    #[cfg(target_os = "windows")]
    if std::env::var_os("WGPU_BACKEND").is_none()
        && matches!(
            resolve_renderer(preference, std::env::var_os("TARVE_RENDERER").as_deref()),
            Ok(ResolvedRenderer::Gpu)
        )
    {
        crate::d3d11::prewarm_device();
    }
    #[cfg(not(target_os = "windows"))]
    let _ = preference;
}
fn resolve_renderer(
    preference: RendererPreference,
    env: Option<&std::ffi::OsStr>,
) -> Result<ResolvedRenderer, String> {
    match preference {
        RendererPreference::Gpu => Ok(ResolvedRenderer::Gpu),
        RendererPreference::Cpu => Ok(ResolvedRenderer::Cpu),
        RendererPreference::Auto => renderer_from_env(env),
    }
}

const VELLO_UNSUPPORTED_ADAPTER_ERROR: &str = "Vello GPU renderer is unsupported by";

fn should_fallback_to_cpu(
    preference: RendererPreference,
    renderer_env: Option<&std::ffi::OsStr>,
    wgpu_backend_explicit: bool,
    gpu_error: &str,
) -> bool {
    if preference == RendererPreference::Auto && renderer_env.is_none() {
        return true;
    }

    // `renderer: "gpu"` is a GPU preference for applications, but an adapter that
    // cannot compile Vello's required shaders must not make the whole application
    // unusable when the CPU renderer is available. Keep an explicit WGPU backend
    // strict so diagnostics and backend-specific smoke tests still fail loudly.
    preference == RendererPreference::Gpu
        && !wgpu_backend_explicit
        && gpu_error.contains(VELLO_UNSUPPORTED_ADAPTER_ERROR)
}

struct CpuGraphics {
    _soft_context: SoftContext<Arc<Window>>,
    surface: SoftSurface<Arc<Window>, Arc<Window>>,
    context: CpuRenderContext,
    resources: CpuResources,
    images: HashMap<String, CpuCachedImage>,
    width: u32,
    height: u32,
    prepared: bool,
    /// The recorded frame, and the region that differs from what `frame` shows.
    list: Option<DisplayList>,
    damage: CpuDamage,
    /// What the retained back buffer was drawn for.
    frame_background: Option<[u8; 4]>,
    frame_size: (u16, u16),
    scratch: Vec<u8>,
    shadows: ShadowCache,
}

/// What of the retained frame must be rasterized again.
#[derive(Clone, Copy, Debug, PartialEq)]
enum CpuDamage {
    None,
    Region(vello::kurbo::Rect),
    Full,
}

impl CpuDamage {
    fn add(self, other: CpuDamage) -> CpuDamage {
        match (self, other) {
            (CpuDamage::Full, _) | (_, CpuDamage::Full) => CpuDamage::Full,
            (CpuDamage::None, other) | (other, CpuDamage::None) => other,
            (CpuDamage::Region(a), CpuDamage::Region(b)) => CpuDamage::Region(a.union(b)),
        }
    }
}

/// A damaged rectangle grown to whole 16-pixel tiles inside the frame, or the whole
/// frame when the damage covers most of it (one pass is then cheaper than two copies).
/// Tile-aligned origins keep the rasterizer's tiling, so pixels match a full redraw.
fn cpu_redraw_region(damage: vello::kurbo::Rect, width: u32, height: u32) -> vello::kurbo::Rect {
    let full = vello::kurbo::Rect::new(0.0, 0.0, f64::from(width), f64::from(height));
    let x0 = ((damage.x0 / 16.0).floor() * 16.0).clamp(0.0, full.x1);
    let y0 = ((damage.y0 / 16.0).floor() * 16.0).clamp(0.0, full.y1);
    let x1 = ((damage.x1 / 16.0).ceil() * 16.0).clamp(0.0, full.x1);
    let y1 = ((damage.y1 / 16.0).ceil() * 16.0).clamp(0.0, full.y1);
    let region = vello::kurbo::Rect::new(x0, y0, x1, y1);
    if region.area() >= full.area() * 0.6 {
        full
    } else {
        region
    }
}

/// TARVE_CPU_DAMAGE_CHECK=1: after each partial redraw, redraw the whole frame and
/// fail if a pixel differs by more than rounding. For tests; it doubles every frame's work.
#[allow(clippy::too_many_arguments)]
fn check_partial_redraw(
    context: &mut CpuRenderContext,
    resources: &mut CpuResources,
    list: &DisplayList,
    frame: &[u32],
    width: usize,
    height: usize,
    region: vello::kurbo::Rect,
    background: vello::peniko::Color,
) -> Result<(), RenderError> {
    let mut expected = vec![0_u32; width * height];
    rasterize_cpu_region(
        context,
        resources,
        list,
        CpuFrame {
            pixels: &mut expected,
            width,
            height,
        },
        &mut Vec::new(),
        None,
        vello::kurbo::Rect::new(0.0, 0.0, width as f64, height as f64),
        background,
    );
    let mut wrong = 0;
    let (mut x0, mut y0, mut x1, mut y1, mut worst) = (usize::MAX, usize::MAX, 0, 0, 0_i32);
    for (index, (a, b)) in expected.iter().zip(frame).enumerate() {
        // The region is rasterized in its own coordinates: f32 rounding can shift a
        // near-tangent edge pixel by a few steps of 255. A missed damage differs by
        // whole shapes, far more than that.
        let delta = [0, 8, 16]
            .iter()
            .map(|shift| (((a >> shift) & 255) as i32 - ((b >> shift) & 255) as i32).abs())
            .max()
            .unwrap_or(0);
        if delta > 3 {
            wrong += 1;
            let (x, y) = (index % width, index / width);
            (x0, y0, x1, y1) = (x0.min(x), y0.min(y), x1.max(x), y1.max(y));
            worst = worst.max(delta);
        }
    }
    if wrong > 0 {
        return Err(RenderError::Fatal(format!(
            "CPU partial redraw of {region:?} differs from a full redraw in {wrong} pixels within {x0},{y0}..{x1},{y1} (by up to {worst})"
        )));
    }
    Ok(())
}

fn cpu_damage_check() -> bool {
    static CHECK: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *CHECK.get_or_init(|| {
        std::env::var_os("TARVE_CPU_DAMAGE_CHECK").is_some_and(|value| value == "1")
    })
}

/// The retained frame: composited pixels packed for softbuffer.
struct CpuFrame<'a> {
    pixels: &'a mut [u32],
    width: usize,
    height: usize,
}

/// Rasterizes `region` (tile-aligned, inside the frame) of `list` into `frame`.
#[allow(clippy::too_many_arguments)]
fn rasterize_cpu_region(
    context: &mut CpuRenderContext,
    resources: &mut CpuResources,
    list: &DisplayList,
    frame: CpuFrame<'_>,
    scratch: &mut Vec<u8>,
    shadows: Option<&mut ShadowCache>,
    region: vello::kurbo::Rect,
    color: vello::peniko::Color,
) {
    let (width, height) = (frame.width, frame.height);

    let (x0, y0) = (region.x0 as usize, region.y0 as usize);
    let (region_width, region_height) = (
        (region.x1 - region.x0) as usize,
        (region.y1 - region.y0) as usize,
    );
    if region_width == 0 || region_height == 0 {
        return;
    }
    let full = region_width == width && region_height == height;
    // Geometry entering from the left of the viewport accumulates its coverage
    // differently in the first tile column (one step of rounding): rasterize a
    // margin there and keep only the region, so pixels match a full redraw.
    let margin = if full { 0 } else { x0.min(16) };
    let raster =
        vello::kurbo::Rect::new(region.x0 - margin as f64, region.y0, region.x1, region.y1);
    let raster_width = region_width + margin;
    context.reset_and_resize(raster_width as u16, region_height as u16);
    list.replay(context, resources, raster, shadows);
    context.flush();
    if full {
        let bytes = bytemuck::cast_slice_mut::<u32, u8>(frame.pixels);
        if let Some(pixmap) = PixmapMut::new(region_width as u16, region_height as u16, bytes) {
            context.render(pixmap, resources);
        }
        flatten_rgba_for_softbuffer(frame.pixels, color);
    } else {
        scratch.clear();
        scratch.resize(raster_width * region_height * 4, 0);
        if let Some(pixmap) = PixmapMut::new(raster_width as u16, region_height as u16, scratch) {
            context.render(pixmap, resources);
        }
        for row in 0..region_height {
            let source = &scratch[(row * raster_width + margin) * 4..(row + 1) * raster_width * 4];
            let start = (y0 + row) * width + x0;
            let target = &mut frame.pixels[start..start + region_width];
            for (pixel, rgba) in target.iter_mut().zip(source.as_chunks::<4>().0) {
                *pixel = u32::from_ne_bytes(*rgba);
            }
            flatten_rgba_for_softbuffer(target, color);
        }
    }
}

impl CpuGraphics {
    fn dimensions(width: u32, height: u32) -> Result<(u16, u16), String> {
        let width = u16::try_from(width.max(1))
            .map_err(|_| format!("CPU renderer width {width} exceeds vello_cpu limit"))?;
        let height = u16::try_from(height.max(1))
            .map_err(|_| format!("CPU renderer height {height} exceeds vello_cpu limit"))?;
        Ok((width, height))
    }

    fn new(window: Arc<Window>) -> Result<Self, String> {
        let size = window.inner_size();
        let (width, height) = Self::dimensions(size.width, size.height)?;
        let soft_context = SoftContext::new(window.clone()).map_err(|error| error.to_string())?;
        let surface = SoftSurface::new(&soft_context, window).map_err(|error| error.to_string())?;
        Ok(Self {
            _soft_context: soft_context,
            surface,
            context: CpuRenderContext::new(width, height),
            resources: CpuResources::new(),
            images: HashMap::new(),
            width: u32::from(width),
            height: u32::from(height),
            prepared: false,
            list: None,
            damage: CpuDamage::Full,
            frame_background: None,
            frame_size: (0, 0),
            scratch: Vec::new(),
            shadows: ShadowCache::new(),
        })
    }

    fn prepare(
        &mut self,
        width: u32,
        height: u32,
        paint: impl FnOnce(&mut CpuRecorder<'_>),
    ) -> Result<(), String> {
        let (cpu_width, cpu_height) = Self::dimensions(width, height)?;
        let resized = self.width != u32::from(cpu_width) || self.height != u32::from(cpu_height);
        self.width = u32::from(cpu_width);
        self.height = u32::from(cpu_height);
        let list = {
            let mut recorder = CpuRecorder::new(&mut self.images);
            paint(&mut recorder);
            recorder.finish()
        };
        let changed = match &self.list {
            Some(previous) if !resized => {
                damage(previous, &list).map_or(CpuDamage::None, CpuDamage::Region)
            }
            _ => CpuDamage::Full,
        };
        self.damage = self.damage.add(changed);
        self.list = Some(list);
        self.prepared = true;
        Ok(())
    }

    fn resize(&mut self, width: u32, height: u32) -> bool {
        if width == 0 || height == 0 || (self.width == width && self.height == height) {
            return false;
        }
        self.width = width;
        self.height = height;
        self.prepared = false;
        self.damage = CpuDamage::Full;
        true
    }

    /// Redraws what the last prepare changed (nothing for a plain redraw request:
    /// the retained frame is presented again) and presents it.
    fn render(&mut self, background: vello::peniko::Color) -> Result<PresentResult, RenderError> {
        if !self.prepared {
            return Err(RenderError::Fatal(
                "CPU renderer frame was not prepared before presentation".into(),
            ));
        }
        let (width, height) =
            Self::dimensions(self.width, self.height).map_err(RenderError::Fatal)?;
        self.surface
            .resize(
                NonZeroU32::new(u32::from(width)).unwrap(),
                NonZeroU32::new(u32::from(height)).unwrap(),
            )
            .map_err(|error| RenderError::Fatal(format!("Softbuffer resize failed: {error}")))?;
        let background_bytes = background.to_rgba8().to_u8_array();
        let full = vello::kurbo::Rect::new(0.0, 0.0, f64::from(width), f64::from(height));
        let mut buffer = self
            .surface
            .buffer_mut()
            .map_err(|error| RenderError::Fatal(format!("Softbuffer buffer failed: {error}")))?;
        // The back buffer is the retained frame: at age 1 it holds the last presented
        // one, so only the damage is drawn into it. Otherwise it is drawn whole.
        let mut damage = self.damage;
        if buffer.age() != 1
            || self.frame_background != Some(background_bytes)
            || self.frame_size != (width, height)
        {
            damage = CpuDamage::Full;
        }
        let region = match damage {
            CpuDamage::None => None,
            CpuDamage::Full => Some(full),
            CpuDamage::Region(rect) => Some(cpu_redraw_region(rect, self.width, self.height)),
        };
        if let (Some(region), Some(list)) = (region, &self.list) {
            let (frame_width, frame_height) = (usize::from(width), usize::from(height));
            rasterize_cpu_region(
                &mut self.context,
                &mut self.resources,
                list,
                CpuFrame {
                    pixels: &mut buffer,
                    width: frame_width,
                    height: frame_height,
                },
                &mut self.scratch,
                Some(&mut self.shadows),
                region,
                background,
            );
            if region != full && cpu_damage_check() {
                check_partial_redraw(
                    &mut self.context,
                    &mut self.resources,
                    list,
                    &buffer,
                    frame_width,
                    frame_height,
                    region,
                    background,
                )?;
            }
        }
        self.frame_background = Some(background_bytes);
        self.frame_size = (width, height);
        self.damage = CpuDamage::None;
        self.shadows.next_frame();
        let presented = match region {
            Some(region) if region != full => {
                let rect = softbuffer::Rect {
                    x: region.x0 as u32,
                    y: region.y0 as u32,
                    width: NonZeroU32::new((region.x1 - region.x0) as u32)
                        .unwrap_or(NonZeroU32::MIN),
                    height: NonZeroU32::new((region.y1 - region.y0) as u32)
                        .unwrap_or(NonZeroU32::MIN),
                };
                buffer.present_with_damage(&[rect])
            }
            _ => buffer.present(),
        };
        presented
            .map_err(|error| RenderError::Fatal(format!("Softbuffer present failed: {error}")))?;
        Ok(PresentResult::Presented)
    }

    fn capture(
        &mut self,
        background: vello::peniko::Color,
        path: &str,
    ) -> Result<(), CaptureError> {
        if !self.prepared {
            return Err(CaptureError::Request(
                "CPU renderer frame was not prepared before capture".into(),
            ));
        }
        let (width, height) =
            Self::dimensions(self.width, self.height).map_err(CaptureError::Request)?;
        let mut pixels = vec![0_u8; usize::from(width) * usize::from(height) * 4];
        if let Some(list) = &self.list {
            self.context.reset_and_resize(width, height);
            list.replay(
                &mut self.context,
                &mut self.resources,
                vello::kurbo::Rect::new(0.0, 0.0, f64::from(width), f64::from(height)),
                Some(&mut self.shadows),
            );
            self.context.flush();
            let pixmap = PixmapMut::new(width, height, &mut pixels)
                .ok_or_else(|| CaptureError::Request("Invalid CPU capture size".into()))?;
            self.context.render(pixmap, &mut self.resources);
        }
        // The next presented frame cannot reuse the rasterizer's state.
        self.damage = CpuDamage::Full;
        flatten_rgba_bytes(&mut pixels, background);
        image::save_buffer(
            path,
            &pixels,
            u32::from(width),
            u32::from(height),
            image::ColorType::Rgba8,
        )
        .map_err(|error| CaptureError::Request(error.to_string()))
    }
}

fn flatten_rgba_bytes(pixels: &mut [u8], background: vello::peniko::Color) {
    let background = background.to_rgba8();
    for pixel in pixels.as_chunks_mut::<4>().0 {
        let alpha = u16::from(pixel[3]);
        let inverse = 255_u16.saturating_sub(alpha);
        pixel[0] =
            (u16::from(pixel[0]) + (u16::from(background.r) * inverse + 127) / 255).min(255) as u8;
        pixel[1] =
            (u16::from(pixel[1]) + (u16::from(background.g) * inverse + 127) / 255).min(255) as u8;
        pixel[2] =
            (u16::from(pixel[2]) + (u16::from(background.b) * inverse + 127) / 255).min(255) as u8;
        pixel[3] = 255;
    }
}

fn flatten_rgba_for_softbuffer(pixels: &mut [u32], background: vello::peniko::Color) {
    let background = background.to_rgba8();
    for pixel in pixels {
        let [r, g, b, a] = pixel.to_ne_bytes();
        let alpha = u16::from(a);
        let inverse = 255_u16.saturating_sub(alpha);
        let r = (u16::from(r) + (u16::from(background.r) * inverse + 127) / 255).min(255) as u32;
        let g = (u16::from(g) + (u16::from(background.g) * inverse + 127) / 255).min(255) as u32;
        let b = (u16::from(b) + (u16::from(background.b) * inverse + 127) / 255).min(255) as u32;
        *pixel = b | (g << 8) | (r << 16);
    }
}

enum GraphicsImpl {
    #[cfg(target_os = "windows")]
    D3d11(Box<D3d11Graphics>),
    Gpu(Box<GpuGraphics>),
    Cpu(Box<CpuGraphics>),
}

pub struct Graphics {
    backend: GraphicsImpl,
    frames: u64,
    generation: u64,
}

impl Graphics {
    pub fn new(window: Arc<Window>, preference: RendererPreference) -> Result<Self, String> {
        let renderer_env = std::env::var_os("TARVE_RENDERER");
        let wgpu_backend_explicit = std::env::var_os("WGPU_BACKEND").is_some();
        let resolved = resolve_renderer(preference, renderer_env.as_deref())?;
        let backend = open_first(&window, &startup_attempts(resolved, wgpu_backend_explicit))
            .or_else(|error| {
                cpu_fallback(
                    &window,
                    resolved == ResolvedRenderer::Gpu
                        && should_fallback_to_cpu(
                            preference,
                            renderer_env.as_deref(),
                            wgpu_backend_explicit,
                            &error,
                        ),
                    error,
                )
            })?;
        Ok(Self {
            backend,
            frames: 0,
            generation: 1,
        })
    }

    pub fn recover(
        window: Arc<Window>,
        previous_backend: RendererBackend,
        preference: RendererPreference,
    ) -> Result<Self, String> {
        let renderer_env = std::env::var_os("TARVE_RENDERER");
        let wgpu_backend_explicit = std::env::var_os("WGPU_BACKEND").is_some();
        let backend = open_first(
            &window,
            &recovery_attempts(previous_backend, wgpu_backend_explicit),
        )
        .or_else(|error| {
            cpu_fallback(
                &window,
                previous_backend != RendererBackend::Cpu
                    && should_fallback_to_cpu(
                        preference,
                        renderer_env.as_deref(),
                        wgpu_backend_explicit,
                        &error,
                    ),
                error,
            )
        })?;
        Ok(Self {
            backend,
            frames: 0,
            generation: 1,
        })
    }

    pub fn restore_counters(&mut self, frames: u64, generation: u64) {
        self.frames = frames;
        self.generation = generation.max(1);
    }

    pub(crate) fn frames(&self) -> u64 {
        self.frames
    }

    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }

    /// Glyph rasterizations on renderers that keep their own glyph atlas
    /// (D3D11); `None` where the backend caches glyphs internally.
    pub(crate) fn glyph_rasterizations(&self) -> Option<u64> {
        match &self.backend {
            #[cfg(target_os = "windows")]
            GraphicsImpl::D3d11(graphics) => Some(graphics.glyph_rasterizations()),
            _ => None,
        }
    }

    /// GPU milliseconds per frame, where the backend can time them (D3D11).
    pub(crate) fn take_gpu_times(&mut self) -> Vec<f64> {
        match &mut self.backend {
            #[cfg(target_os = "windows")]
            GraphicsImpl::D3d11(graphics) => graphics.take_gpu_times(),
            _ => Vec::new(),
        }
    }

    pub(crate) fn backend(&self) -> RendererBackend {
        match &self.backend {
            #[cfg(target_os = "windows")]
            GraphicsImpl::D3d11(_) => RendererBackend::D3d11,
            GraphicsImpl::Gpu(graphics) => RendererBackend::Gpu(graphics.backend()),
            GraphicsImpl::Cpu(_) => RendererBackend::Cpu,
        }
    }

    /// D3D11 keeps uploaded images only as textures: releases their CPU pixels in
    /// the document, brings back the ones a lost texture needs, and pins the rest.
    /// Returns (pixels were released, pixels came back and another frame must be painted).
    #[cfg(target_os = "windows")]
    pub(crate) fn sync_d3d11_images(&mut self, tree: &mut crate::tree::Tree) -> (bool, bool) {
        let GraphicsImpl::D3d11(graphics) = &mut self.backend else {
            return (false, false);
        };
        let (uploaded, missing) = graphics.take_image_residency();
        tree.release_image_pixels(&uploaded);
        let restored = tree.restore_image_pixels(&missing);
        graphics.pin_images(tree.released_image_keys());
        (!uploaded.is_empty(), restored)
    }

    /// The D3D11 renderer's device: `<video>` pictures are decoded onto it.
    #[cfg(target_os = "windows")]
    pub(crate) fn d3d11_device(
        &self,
    ) -> Option<windows::Win32::Graphics::Direct3D11::ID3D11Device> {
        match &self.backend {
            GraphicsImpl::D3d11(graphics) => Some(graphics.device().clone()),
            _ => None,
        }
    }

    /// Whether video `id` shows in its own composition layer (D3D11 only).
    #[cfg(target_os = "windows")]
    pub(crate) fn video_layered(&self, id: &str) -> bool {
        matches!(&self.backend, GraphicsImpl::D3d11(graphics) if graphics.video_layered(id))
    }

    /// A new picture of a layered video, shown without a UI frame.
    #[cfg(target_os = "windows")]
    pub(crate) fn present_video(&mut self, id: &str, view: &crate::d3d11::VideoView, bt709: bool) -> Result<bool, RenderError> {
        match &mut self.backend {
            GraphicsImpl::D3d11(graphics) => graphics
                .present_video(id, view, bt709)
                .map_err(classify_d3d11_render_error),
            _ => Ok(false),
        }
    }

    /// Videos in their own layers, and why one could not be.
    pub(crate) fn video_layers(&self) -> (usize, Option<String>) {
        match &self.backend {
            #[cfg(target_os = "windows")]
            GraphicsImpl::D3d11(graphics) => {
                let (count, error) = graphics.video_layers();
                (count, error.map(str::to_string))
            }
            _ => (0, None),
        }
    }

    #[cfg(target_os = "windows")]
    pub(crate) fn set_video_views(
        &mut self,
        views: Vec<(String, crate::d3d11::VideoView)>,
    ) {
        if let GraphicsImpl::D3d11(graphics) = &mut self.backend {
            graphics.set_video_views(views);
        }
    }

    #[cfg(target_os = "windows")]
    pub(crate) fn prepare_d3d11_frame(
        &mut self,
        width: u32,
        height: u32,
        paint: impl FnOnce(&mut D3d11PaintTarget<'_>),
    ) -> Result<bool, RenderError> {
        let GraphicsImpl::D3d11(graphics) = &mut self.backend else {
            return Ok(false);
        };
        graphics
            .prepare(width, height, paint)
            .map_err(classify_d3d11_render_error)?;
        Ok(true)
    }

    pub(crate) fn prepare_cpu_frame(
        &mut self,
        width: u32,
        height: u32,
        paint: impl FnOnce(&mut CpuRecorder<'_>),
    ) -> Result<bool, String> {
        let GraphicsImpl::Cpu(graphics) = &mut self.backend else {
            return Ok(false);
        };
        graphics.prepare(width, height, paint)?;
        Ok(true)
    }

    pub(crate) fn take_fault(&self) -> Option<GraphicsFault> {
        match &self.backend {
            #[cfg(target_os = "windows")]
            GraphicsImpl::D3d11(_) => None,
            GraphicsImpl::Gpu(graphics) => graphics.take_fault(),
            GraphicsImpl::Cpu(_) => None,
        }
    }

    pub fn resize(&mut self, width: u32, height: u32) -> Result<bool, RenderError> {
        match &mut self.backend {
            #[cfg(target_os = "windows")]
            GraphicsImpl::D3d11(graphics) => graphics
                .resize(width, height)
                .map_err(classify_d3d11_render_error),
            GraphicsImpl::Gpu(graphics) => Ok(graphics.resize(width, height)),
            GraphicsImpl::Cpu(graphics) => Ok(graphics.resize(width, height)),
        }
    }

    pub fn render(
        &mut self,
        scene: &Scene,
        background: vello::peniko::Color,
        content_changed: bool,
    ) -> Result<PresentResult, RenderError> {
        let result = match &mut self.backend {
            #[cfg(target_os = "windows")]
            GraphicsImpl::D3d11(graphics) => graphics
                .render(background)
                .map(|()| PresentResult::Presented)
                .map_err(classify_d3d11_render_error),
            GraphicsImpl::Gpu(graphics) => graphics.render(scene, background),
            GraphicsImpl::Cpu(graphics) => {
                let _ = content_changed;
                graphics.render(background)
            }
        }?;
        if result == PresentResult::Presented {
            self.frames = self.frames.saturating_add(1);
        }
        Ok(result)
    }

    pub fn capture(
        &mut self,
        scene: &Scene,
        background: vello::peniko::Color,
        path: &str,
    ) -> Result<(), CaptureError> {
        match &mut self.backend {
            #[cfg(target_os = "windows")]
            GraphicsImpl::D3d11(graphics) => graphics
                .capture(background, path)
                .map_err(classify_d3d11_capture_error),
            GraphicsImpl::Gpu(graphics) => graphics.capture(scene, background, path),
            GraphicsImpl::Cpu(graphics) => graphics.capture(background, path),
        }
    }
}

/// One way to open the window's graphics. Startup and device-loss recovery
/// both walk an ordered list of these (see `startup_attempts` and
/// `recovery_attempts`), so the fallback order lives in one place:
///
/// - Windows, `auto`/`gpu`: D3D11 → Vello/DX12 → CPU (CPU only for `auto`
///   without `TARVE_RENDERER`, or `gpu` on an adapter Vello cannot run).
/// - Windows with `WGPU_BACKEND`: that Vello backend only (diagnostics).
/// - Linux: Vello over wgpu's default backends → CPU (same CPU rule).
/// - `cpu`: CPU only.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BackendAttempt {
    #[cfg(target_os = "windows")]
    D3d11,
    /// Vello over the given wgpu backends; `None` defers to `WGPU_BACKEND`
    /// or wgpu's defaults.
    Vello(Option<wgpu::Backends>),
    Cpu,
}

impl BackendAttempt {
    fn name(self) -> &'static str {
        match self {
            #[cfg(target_os = "windows")]
            Self::D3d11 => "D3D11",
            Self::Vello(Some(backends)) if backends == wgpu::Backends::DX12 => "Vello/DX12",
            Self::Vello(Some(backends)) if backends == wgpu::Backends::VULKAN => "Vello/Vulkan",
            Self::Vello(_) => "Vello/WGPU",
            Self::Cpu => "CPU",
        }
    }

    fn open(self, window: &Arc<Window>) -> Result<GraphicsImpl, String> {
        match self {
            #[cfg(target_os = "windows")]
            Self::D3d11 => D3d11Graphics::new(window.clone())
                .map(|graphics| GraphicsImpl::D3d11(Box::new(graphics))),
            Self::Vello(backends) => GpuGraphics::new_with_backends(window.clone(), backends)
                .map(|graphics| GraphicsImpl::Gpu(Box::new(graphics))),
            Self::Cpu => CpuGraphics::new(window.clone())
                .map(|graphics| GraphicsImpl::Cpu(Box::new(graphics))),
        }
    }
}

fn startup_attempts(
    resolved: ResolvedRenderer,
    wgpu_backend_explicit: bool,
) -> Vec<BackendAttempt> {
    match resolved {
        ResolvedRenderer::Cpu => vec![BackendAttempt::Cpu],
        ResolvedRenderer::Gpu if wgpu_backend_explicit => vec![BackendAttempt::Vello(None)],
        #[cfg(target_os = "windows")]
        ResolvedRenderer::Gpu => vec![
            BackendAttempt::D3d11,
            BackendAttempt::Vello(Some(wgpu::Backends::DX12)),
        ],
        #[cfg(not(target_os = "windows"))]
        ResolvedRenderer::Gpu => vec![BackendAttempt::Vello(None)],
    }
}

/// Recovery retries the backend that was lost first, then its alternatives.
fn recovery_attempts(
    previous: RendererBackend,
    wgpu_backend_explicit: bool,
) -> Vec<BackendAttempt> {
    match previous {
        RendererBackend::Cpu => vec![BackendAttempt::Cpu],
        #[cfg(target_os = "windows")]
        RendererBackend::D3d11 => startup_attempts(ResolvedRenderer::Gpu, false),
        RendererBackend::Gpu(_) if wgpu_backend_explicit => vec![BackendAttempt::Vello(None)],
        #[cfg(target_os = "windows")]
        RendererBackend::Gpu(lost) => {
            let (first, second) = if lost == wgpu::Backend::Vulkan {
                (wgpu::Backends::VULKAN, wgpu::Backends::DX12)
            } else {
                (wgpu::Backends::DX12, wgpu::Backends::VULKAN)
            };
            vec![
                BackendAttempt::Vello(Some(first)),
                BackendAttempt::Vello(Some(second)),
            ]
        }
        #[cfg(not(target_os = "windows"))]
        RendererBackend::Gpu(_) => vec![BackendAttempt::Vello(None)],
    }
}

/// Opens the first attempt that succeeds; the error names every failure in order.
fn open_first(window: &Arc<Window>, attempts: &[BackendAttempt]) -> Result<GraphicsImpl, String> {
    let mut failures = Vec::new();
    for attempt in attempts {
        match attempt.open(window) {
            Ok(graphics) => return Ok(graphics),
            Err(error) => failures.push(format!("{} renderer failed: {error}", attempt.name())),
        }
    }
    Err(failures.join("; "))
}

fn cpu_fallback(
    window: &Arc<Window>,
    allowed: bool,
    gpu_error: String,
) -> Result<GraphicsImpl, String> {
    if !allowed {
        return Err(gpu_error);
    }
    BackendAttempt::Cpu
        .open(window)
        .map_err(|cpu_error| format!("{gpu_error}; CPU fallback failed: {cpu_error}"))
}

fn create_targets(
    width: u32,
    height: u32,
    device: &wgpu::Device,
) -> (wgpu::Texture, wgpu::TextureView) {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING,
        format: wgpu::TextureFormat::Rgba8Unorm,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    (texture, view)
}

#[cfg(test)]
mod tests {
    use super::{
        CpuFrame, CpuGraphics, CpuRenderContext, CpuResources, DisplayList, GraphicsFault,
        GraphicsFaultKind, GraphicsSignals, HashMap, ResolvedRenderer, SurfaceIssue,
        cpu_redraw_region, damage, flatten_rgba_bytes, flatten_rgba_for_softbuffer,
        rasterize_cpu_region, resolve_renderer, should_fallback_to_cpu,
        supports_vello_float16_packing, surface_failure_threshold,
    };
    use crate::protocol::RendererPreference;
    use std::ffi::OsStr;
    use vello::kurbo::Affine;
    use vello::peniko::Color;

    #[test]
    fn vello_requires_float16_packing_capability() {
        assert!(supports_vello_float16_packing(
            vello::wgpu::Features::SHADER_F16,
            vello::wgpu::DownlevelFlags::empty()
        ));
        assert!(supports_vello_float16_packing(
            vello::wgpu::Features::empty(),
            vello::wgpu::DownlevelFlags::SHADER_F16_IN_F32
        ));
        assert!(!supports_vello_float16_packing(
            vello::wgpu::Features::empty(),
            vello::wgpu::DownlevelFlags::empty()
        ));
    }

    #[test]
    fn fallback_order_is_one_list_for_startup_and_recovery() {
        use super::{
            BackendAttempt::*, RendererBackend, ResolvedRenderer, recovery_attempts,
            startup_attempts, wgpu,
        };
        assert_eq!(startup_attempts(ResolvedRenderer::Cpu, false), [Cpu]);
        assert_eq!(startup_attempts(ResolvedRenderer::Cpu, true), [Cpu]);
        assert_eq!(startup_attempts(ResolvedRenderer::Gpu, true), [Vello(None)]);
        assert_eq!(recovery_attempts(RendererBackend::Cpu, false), [Cpu]);
        assert_eq!(
            recovery_attempts(RendererBackend::Gpu(wgpu::Backend::Dx12), true),
            [Vello(None)]
        );
        #[cfg(target_os = "windows")]
        {
            let default_gpu = [D3d11, Vello(Some(wgpu::Backends::DX12))];
            assert_eq!(startup_attempts(ResolvedRenderer::Gpu, false), default_gpu);
            assert_eq!(
                recovery_attempts(RendererBackend::D3d11, false),
                default_gpu
            );
            assert_eq!(
                recovery_attempts(RendererBackend::Gpu(wgpu::Backend::Vulkan), false),
                [
                    Vello(Some(wgpu::Backends::VULKAN)),
                    Vello(Some(wgpu::Backends::DX12))
                ]
            );
            assert_eq!(
                recovery_attempts(RendererBackend::Gpu(wgpu::Backend::Dx12), false),
                [
                    Vello(Some(wgpu::Backends::DX12)),
                    Vello(Some(wgpu::Backends::VULKAN))
                ]
            );
        }
        #[cfg(not(target_os = "windows"))]
        {
            assert_eq!(
                startup_attempts(ResolvedRenderer::Gpu, false),
                [Vello(None)]
            );
            assert_eq!(
                recovery_attempts(RendererBackend::Gpu(wgpu::Backend::Vulkan), false),
                [Vello(None)]
            );
        }
    }

    #[test]
    fn renderer_preference_honors_app_config_before_environment() {
        assert_eq!(
            resolve_renderer(RendererPreference::Auto, None).unwrap(),
            ResolvedRenderer::Gpu
        );
        assert_eq!(
            resolve_renderer(RendererPreference::Auto, Some(OsStr::new("gpu"))).unwrap(),
            ResolvedRenderer::Gpu
        );
        assert_eq!(
            resolve_renderer(RendererPreference::Auto, Some(OsStr::new("cpu"))).unwrap(),
            ResolvedRenderer::Cpu
        );
        assert_eq!(
            resolve_renderer(RendererPreference::Auto, Some(OsStr::new("softbuffer"))).unwrap(),
            ResolvedRenderer::Cpu
        );
        assert!(resolve_renderer(RendererPreference::Auto, Some(OsStr::new("unknown"))).is_err());
        assert_eq!(
            resolve_renderer(RendererPreference::Cpu, Some(OsStr::new("gpu"))).unwrap(),
            ResolvedRenderer::Cpu
        );
        assert_eq!(
            resolve_renderer(RendererPreference::Gpu, Some(OsStr::new("cpu"))).unwrap(),
            ResolvedRenderer::Gpu
        );
        assert_eq!(
            resolve_renderer(RendererPreference::Cpu, Some(OsStr::new("unknown"))).unwrap(),
            ResolvedRenderer::Cpu
        );
    }

    #[test]
    fn unsupported_vello_adapter_falls_back_without_masking_explicit_backend_failures() {
        let unsupported = "Vello GPU renderer is unsupported by llvmpipe (Vulkan): the adapter exposes neither SHADER_F16 nor SHADER_F16_IN_F32";
        let other_failure = "GPU device request failed";

        assert!(should_fallback_to_cpu(
            RendererPreference::Auto,
            None,
            false,
            other_failure,
        ));
        assert!(!should_fallback_to_cpu(
            RendererPreference::Auto,
            Some(OsStr::new("gpu")),
            false,
            other_failure,
        ));
        assert!(should_fallback_to_cpu(
            RendererPreference::Gpu,
            None,
            false,
            unsupported,
        ));
        assert!(!should_fallback_to_cpu(
            RendererPreference::Gpu,
            None,
            true,
            unsupported,
        ));
        assert!(!should_fallback_to_cpu(
            RendererPreference::Gpu,
            None,
            false,
            other_failure,
        ));
    }

    #[test]
    fn cpu_dimensions_reject_only_sizes_outside_vello_cpu_range() {
        assert_eq!(CpuGraphics::dimensions(0, 0).unwrap(), (1, 1));
        assert_eq!(CpuGraphics::dimensions(1920, 1080).unwrap(), (1920, 1080));
        assert!(CpuGraphics::dimensions(u32::from(u16::MAX) + 1, 1080).is_err());
    }

    use crate::cpu_display::CpuRecorder;
    use crate::paint::{GradientGeometry, PaintGradient, PaintTarget};
    use vello::kurbo::{Circle, Rect, RoundedRect, Stroke};
    use vello::peniko::Fill;

    fn record(paint: impl FnOnce(&mut CpuRecorder<'_>)) -> DisplayList {
        let mut images = HashMap::new();
        let mut recorder = CpuRecorder::new(&mut images);
        paint(&mut recorder);
        recorder.finish()
    }

    const W: usize = 256;
    const H: usize = 192;

    fn full_frame(list: &DisplayList) -> Vec<u32> {
        let mut context = CpuRenderContext::new(W as u16, H as u16);
        let mut resources = CpuResources::new();
        let mut frame = vec![0_u32; W * H];
        rasterize_cpu_region(
            &mut context,
            &mut resources,
            list,
            CpuFrame {
                pixels: &mut frame,
                width: W,
                height: H,
            },
            &mut Vec::new(),
            None,
            Rect::new(0.0, 0.0, W as f64, H as f64),
            Color::from_rgb8(250, 250, 250),
        );
        frame
    }

    /// Redraws only what changed from `before` to `after` and checks the result is the full redraw.
    fn assert_partial_matches(before: &DisplayList, after: &DisplayList) -> Option<Rect> {
        let mut frame = full_frame(before);
        let damage = damage(before, after);
        if let Some(damage) = damage {
            let region = cpu_redraw_region(damage, W as u32, H as u32);
            let mut context = CpuRenderContext::new(W as u16, H as u16);
            let mut resources = CpuResources::new();
            rasterize_cpu_region(
                &mut context,
                &mut resources,
                after,
                CpuFrame {
                    pixels: &mut frame,
                    width: W,
                    height: H,
                },
                &mut Vec::new(),
                None,
                region,
                Color::from_rgb8(250, 250, 250),
            );
        }
        let expected = full_frame(after);
        let wrong = frame.iter().zip(&expected).filter(|(a, b)| a != b).count();
        if wrong > 0 {
            let (mut x0, mut y0, mut x1, mut y1, mut worst) = (usize::MAX, usize::MAX, 0, 0, 0i32);
            for (index, (a, b)) in frame.iter().zip(&expected).enumerate() {
                if a != b {
                    let (x, y) = (index % W, index / W);
                    x0 = x0.min(x);
                    y0 = y0.min(y);
                    x1 = x1.max(x);
                    y1 = y1.max(y);
                    for shift in [0, 8, 16] {
                        worst = worst
                            .max((((a >> shift) & 255) as i32 - ((b >> shift) & 255) as i32).abs());
                    }
                }
            }
            eprintln!("DIFF box {x0},{y0}..{x1},{y1} worst {worst}");
        }
        assert_eq!(
            wrong, 0,
            "partial redraw differs from a full redraw in {wrong} pixels (damage {damage:?})"
        );
        damage
    }

    fn scene(dot: (f64, f64), clip: bool, alpha: f32, order_swapped: bool) -> DisplayList {
        record(|target| {
            let gradient = PaintGradient {
                geometry: GradientGeometry::Linear {
                    start: (0.0, 0.0).into(),
                    end: (256.0, 192.0).into(),
                },
                stops: vec![
                    (0.0, Color::from_rgb8(40, 10, 90)),
                    (1.0, Color::from_rgb8(230, 70, 120)),
                ],
                repeat: false,
            };
            target.fill_gradient(
                Affine::IDENTITY,
                &gradient,
                &Rect::new(0.0, 0.0, 256.0, 192.0),
            );
            target.box_shadow(
                Affine::IDENTITY,
                Rect::new(10.0, 10.0, 130.0, 110.0),
                Rect::new(30.0, 30.0, 110.0, 90.0),
                Color::from_rgba8(0, 0, 0, 120),
                12.0,
                8.0,
                false,
            );
            target.fill(
                Fill::NonZero,
                Affine::IDENTITY,
                Color::from_rgb8(255, 255, 255),
                &RoundedRect::new(30.0, 30.0, 110.0, 90.0, 12.0),
            );
            if clip {
                target.push_clip(
                    Fill::NonZero,
                    Affine::IDENTITY,
                    &Rect::new(140.0, 20.0, 230.0, 100.0),
                );
            }
            target.fill(
                Fill::NonZero,
                Affine::IDENTITY,
                Color::from_rgb8(30, 200, 120),
                &Circle::new((185.0, 60.0), 55.0),
            );
            if clip {
                target.pop_layer();
            }
            target.push_opacity(
                alpha,
                Affine::IDENTITY,
                &Rect::new(20.0, 120.0, 240.0, 180.0),
            );
            let (first, second) = (Color::from_rgb8(255, 180, 0), Color::from_rgb8(0, 120, 255));
            let (a, b) = if order_swapped {
                (second, first)
            } else {
                (first, second)
            };
            target.fill(
                Fill::NonZero,
                Affine::IDENTITY,
                a,
                &Rect::new(30.0, 125.0, 120.0, 175.0),
            );
            target.fill(
                Fill::NonZero,
                Affine::IDENTITY,
                b,
                &Rect::new(90.0, 130.0, 200.0, 170.0),
            );
            target.pop_layer();
            target.stroke(
                &Stroke::new(3.0),
                Affine::IDENTITY,
                Color::from_rgb8(20, 20, 20),
                &Circle::new(dot, 9.0),
            );
            target.fill(
                Fill::NonZero,
                Affine::translate(dot),
                Color::from_rgba8(255, 255, 255, 200),
                &Circle::new((0.0, 0.0), 6.5),
            );
        })
    }

    #[test]
    fn cpu_unchanged_frames_have_no_damage() {
        assert_eq!(
            damage(
                &scene((60.0, 150.0), true, 0.8, false),
                &scene((60.0, 150.0), true, 0.8, false)
            ),
            None
        );
    }

    #[test]
    fn cpu_partial_redraw_matches_a_full_redraw() {
        let base = scene((60.0, 150.0), true, 0.8, false);
        // A small move redraws a small region.
        let moved = assert_partial_matches(&base, &scene((64.5, 151.25), true, 0.8, false))
            .expect("a move damages");
        assert!(
            moved.area() < 40.0 * 40.0,
            "a moved dot damages only around it: {moved:?}"
        );
        // Removing a clip uncovers what it hid, outside its own rectangle.
        let unclipped = assert_partial_matches(&base, &scene((60.0, 150.0), false, 0.8, false))
            .expect("a clip damages");
        assert!(
            unclipped.x0 <= 131.0 && unclipped.y0 <= 6.0,
            "the whole circle is damaged: {unclipped:?}"
        );
        // A layer's opacity and a change of stacking order.
        assert_partial_matches(&base, &scene((60.0, 150.0), true, 0.5, false))
            .expect("opacity damages");
        assert_partial_matches(&base, &scene((60.0, 150.0), true, 0.8, true))
            .expect("order damages");
    }

    #[test]
    fn cpu_cached_shadows_match_direct_ones_and_wait_for_a_second_frame() {
        use crate::cpu_display::ShadowCache;
        let list = scene((60.0, 150.0), true, 0.8, false);
        let direct = full_frame(&list);
        let mut cache = ShadowCache::new();
        let mut context = CpuRenderContext::new(W as u16, H as u16);
        let mut resources = CpuResources::new();
        for frame_index in 0..3 {
            let mut frame = vec![0_u32; W * H];
            rasterize_cpu_region(
                &mut context,
                &mut resources,
                &list,
                CpuFrame {
                    pixels: &mut frame,
                    width: W,
                    height: H,
                },
                &mut Vec::new(),
                Some(&mut cache),
                Rect::new(0.0, 0.0, W as f64, H as f64),
                Color::from_rgb8(250, 250, 250),
            );
            cache.next_frame();
            let worst = frame
                .iter()
                .zip(&direct)
                .map(|(a, b)| {
                    [0, 8, 16]
                        .iter()
                        .map(|shift| {
                            (((a >> shift) & 255) as i32 - ((b >> shift) & 255) as i32).abs()
                        })
                        .max()
                        .unwrap_or(0)
                })
                .max()
                .unwrap_or(0);
            assert!(
                worst <= 1,
                "frame {frame_index}: a cached shadow differs by {worst}"
            );
        }
    }

    #[test]
    fn cpu_redraw_regions_are_tile_aligned_and_fall_back_to_full_frames() {
        let region = cpu_redraw_region(Rect::new(17.5, 3.0, 40.2, 20.0), 256, 192);
        assert_eq!(region, Rect::new(16.0, 0.0, 48.0, 32.0));
        assert_eq!(
            cpu_redraw_region(Rect::new(-50.0, -50.0, 300.0, 300.0), 256, 192),
            Rect::new(0.0, 0.0, 256.0, 192.0)
        );
        assert_eq!(
            cpu_redraw_region(Rect::new(0.0, 0.0, 200.0, 150.0), 256, 192),
            Rect::new(0.0, 0.0, 256.0, 192.0),
            "most of the frame redraws whole"
        );
    }

    #[test]
    fn cpu_pixels_are_composited_and_packed_for_softbuffer() {
        let background = Color::from_rgb8(10, 20, 30);
        let mut rgba = [100, 50, 25, 128];
        flatten_rgba_bytes(&mut rgba, background);
        assert_eq!(rgba, [105, 60, 40, 255]);

        let mut pixel = [u32::from_ne_bytes([100, 50, 25, 128])];
        flatten_rgba_for_softbuffer(&mut pixel, background);
        assert_eq!(pixel[0], 40 | (60 << 8) | (105 << 16));
    }

    #[test]
    fn graphics_fault_signal_coalesces_to_the_most_severe_pending_fault() {
        let signals = GraphicsSignals::default();
        signals.record(GraphicsFault {
            kind: GraphicsFaultKind::Validation,
            message: "validation".into(),
        });
        signals.record(GraphicsFault {
            kind: GraphicsFaultKind::Internal,
            message: "internal".into(),
        });
        signals.record(GraphicsFault {
            kind: GraphicsFaultKind::DeviceLost,
            message: "lost".into(),
        });
        signals.record(GraphicsFault {
            kind: GraphicsFaultKind::OutOfMemory,
            message: "oom".into(),
        });

        let fault = signals.take().unwrap();
        assert_eq!(fault.kind, GraphicsFaultKind::OutOfMemory);
        assert_eq!(fault.message, "oom");
        assert!(signals.take().is_none());
    }

    #[test]
    fn persistent_surface_failures_have_bounded_escalation_thresholds() {
        assert_eq!(surface_failure_threshold(SurfaceIssue::Lost), Some(2));
        assert_eq!(surface_failure_threshold(SurfaceIssue::Outdated), Some(8));
        assert_eq!(surface_failure_threshold(SurfaceIssue::Timeout), Some(120));
        assert_eq!(surface_failure_threshold(SurfaceIssue::Occluded), None);
        assert_eq!(surface_failure_threshold(SurfaceIssue::Validation), None);
    }
}
