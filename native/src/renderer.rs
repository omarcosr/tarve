#[cfg(target_os = "windows")]
use crate::d3d11::{D3d11Error, D3d11Graphics, D3d11PaintTarget};
use crate::{
    paint::{CpuCachedImage, CpuPaintTarget},
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
impl GpuGraphics {
    pub fn new(window: Arc<Window>) -> Result<Self, String> {
        if std::env::var_os("WGPU_BACKEND").is_some() {
            return Self::new_with_backends(window, None);
        }
        #[cfg(target_os = "windows")]
        {
            Self::new_with_backends(window.clone(), Some(wgpu::Backends::VULKAN))
                .or_else(|vulkan_error| {
                    Self::new_with_backends(window, Some(wgpu::Backends::DX12))
                        .map_err(|dx12_error| format!("Vulkan renderer failed: {vulkan_error}; DX12 renderer failed: {dx12_error}"))
                })
        }
        #[cfg(not(target_os = "windows"))]
        Self::new_with_backends(window, None)
    }

    pub fn recover(window: Arc<Window>, previous_backend: wgpu::Backend) -> Result<Self, String> {
        if std::env::var_os("WGPU_BACKEND").is_some() {
            return Self::new_with_backends(window, None);
        }
        #[cfg(target_os = "windows")]
        {
            let (first, second) = if previous_backend == wgpu::Backend::Vulkan {
                (wgpu::Backends::VULKAN, wgpu::Backends::DX12)
            } else {
                (wgpu::Backends::DX12, wgpu::Backends::VULKAN)
            };
            Self::new_with_backends(window.clone(), Some(first)).or_else(|first_error| {
                Self::new_with_backends(window, Some(second)).map_err(|second_error| {
                    format!(
                        "GPU recovery primary backend failed: {first_error}; fallback backend failed: {second_error}"
                    )
                })
            })
        }
        #[cfg(not(target_os = "windows"))]
        Self::new_with_backends(window, None)
    }

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
        let optional_features = wgpu::Features::CLEAR_TEXTURE | wgpu::Features::PIPELINE_CACHE;
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: None,
            required_features: adapter.features() & optional_features,
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

struct CpuGraphics {
    _soft_context: SoftContext<Arc<Window>>,
    surface: SoftSurface<Arc<Window>, Arc<Window>>,
    context: CpuRenderContext,
    resources: CpuResources,
    images: HashMap<String, CpuCachedImage>,
    width: u32,
    height: u32,
    prepared: bool,
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
        })
    }

    fn prepare(
        &mut self,
        width: u32,
        height: u32,
        paint: impl FnOnce(&mut CpuPaintTarget<'_>),
    ) -> Result<(), String> {
        let (cpu_width, cpu_height) = Self::dimensions(width, height)?;
        self.width = u32::from(cpu_width);
        self.height = u32::from(cpu_height);
        self.context.reset_and_resize(cpu_width, cpu_height);
        let mut target =
            CpuPaintTarget::new(&mut self.context, &mut self.resources, &mut self.images);
        paint(&mut target);
        target.finish();
        self.context.flush();
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
        true
    }

    fn render(
        &mut self,
        background: vello::peniko::Color,
        content_changed: bool,
    ) -> Result<PresentResult, RenderError> {
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
        let mut buffer = self
            .surface
            .buffer_mut()
            .map_err(|error| RenderError::Fatal(format!("Softbuffer buffer failed: {error}")))?;
        if should_rasterize_cpu_frame(content_changed, buffer.age()) {
            {
                let bytes = bytemuck::cast_slice_mut::<u32, u8>(&mut buffer);
                let pixmap = PixmapMut::new(width, height, bytes)
                    .ok_or_else(|| RenderError::Fatal("Invalid CPU framebuffer size".into()))?;
                self.context.render(pixmap, &mut self.resources);
            }
            flatten_rgba_for_softbuffer(&mut buffer, background);
        }
        buffer
            .present()
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
        let pixmap = PixmapMut::new(width, height, &mut pixels)
            .ok_or_else(|| CaptureError::Request("Invalid CPU capture size".into()))?;
        self.context.render(pixmap, &mut self.resources);
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

fn should_rasterize_cpu_frame(content_changed: bool, buffer_age: u8) -> bool {
    content_changed || buffer_age == 0
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
        let backend =
            match resolve_renderer(preference, std::env::var_os("TARVE_RENDERER").as_deref())? {
                ResolvedRenderer::Gpu => Self::new_gpu_backend(window)?,
                ResolvedRenderer::Cpu => GraphicsImpl::Cpu(Box::new(CpuGraphics::new(window)?)),
            };
        Ok(Self {
            backend,
            frames: 0,
            generation: 1,
        })
    }

    pub fn recover(window: Arc<Window>, previous_backend: RendererBackend) -> Result<Self, String> {
        let backend = match previous_backend {
            #[cfg(target_os = "windows")]
            RendererBackend::D3d11 => D3d11Graphics::new(window.clone())
                .map(|graphics| GraphicsImpl::D3d11(Box::new(graphics)))
                .or_else(|d3d11_error| {
                    GpuGraphics::new_with_backends(window, Some(wgpu::Backends::DX12))
                        .map(|graphics| GraphicsImpl::Gpu(Box::new(graphics)))
                        .map_err(|vello_error| {
                            format!(
                                "D3D11 GPU recovery failed: {d3d11_error}; Vello/DX12 fallback failed: {vello_error}"
                            )
                        })
                })?,
            RendererBackend::Gpu(previous) => {
                GraphicsImpl::Gpu(Box::new(GpuGraphics::recover(window, previous)?))
            }
            RendererBackend::Cpu => GraphicsImpl::Cpu(Box::new(CpuGraphics::new(window)?)),
        };
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

    pub(crate) fn backend(&self) -> RendererBackend {
        match &self.backend {
            #[cfg(target_os = "windows")]
            GraphicsImpl::D3d11(_) => RendererBackend::D3d11,
            GraphicsImpl::Gpu(graphics) => RendererBackend::Gpu(graphics.backend()),
            GraphicsImpl::Cpu(_) => RendererBackend::Cpu,
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
        paint: impl FnOnce(&mut CpuPaintTarget<'_>),
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
            GraphicsImpl::Cpu(graphics) => graphics.render(background, content_changed),
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

    fn new_gpu_backend(window: Arc<Window>) -> Result<GraphicsImpl, String> {
        #[cfg(target_os = "windows")]
        {
            // Explicit WGPU_BACKEND remains an escape hatch for debugging the legacy Vello path.
            if std::env::var_os("WGPU_BACKEND").is_none() {
                match D3d11Graphics::new(window.clone()) {
                    Ok(graphics) => return Ok(GraphicsImpl::D3d11(Box::new(graphics))),
                    Err(d3d11_error) => {
                        return GpuGraphics::new_with_backends(window, Some(wgpu::Backends::DX12))
                            .map(|graphics| GraphicsImpl::Gpu(Box::new(graphics)))
                            .map_err(|vello_error| {
                                format!(
                                    "Native D3D11 renderer failed: {d3d11_error}; Vello/DX12 fallback failed: {vello_error}"
                                )
                            });
                    }
                }
            }
        }
        GpuGraphics::new(window).map(|graphics| GraphicsImpl::Gpu(Box::new(graphics)))
    }
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
        CpuGraphics, GraphicsFault, GraphicsFaultKind, GraphicsSignals, ResolvedRenderer,
        SurfaceIssue, flatten_rgba_bytes, flatten_rgba_for_softbuffer, resolve_renderer,
        should_rasterize_cpu_frame, surface_failure_threshold,
    };
    use crate::protocol::RendererPreference;
    use std::ffi::OsStr;
    use vello::peniko::Color;

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
    fn cpu_dimensions_reject_only_sizes_outside_vello_cpu_range() {
        assert_eq!(CpuGraphics::dimensions(0, 0).unwrap(), (1, 1));
        assert_eq!(CpuGraphics::dimensions(1920, 1080).unwrap(), (1920, 1080));
        assert!(CpuGraphics::dimensions(u32::from(u16::MAX) + 1, 1080).is_err());
    }

    #[test]
    fn cpu_clean_redraw_reuses_retained_softbuffer_pixels() {
        assert!(should_rasterize_cpu_frame(true, 1));
        assert!(should_rasterize_cpu_frame(false, 0));
        assert!(!should_rasterize_cpu_frame(false, 1));
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
