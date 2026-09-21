use std::{num::NonZeroUsize, sync::Arc};
use vello::{AaConfig, AaSupport, RenderParams, Renderer, RendererOptions, Scene, wgpu};
use winit::window::Window;

pub struct Graphics {
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
    pub frames: u64,
}
impl Graphics {
    pub fn new(window: Arc<Window>) -> Result<Self, String> {
        if std::env::var_os("WGPU_BACKEND").is_some() {
            return Self::new_with_backends(window, None);
        }
        #[cfg(target_os = "windows")]
        {
            return Self::new_with_backends(window.clone(), Some(wgpu::Backends::VULKAN))
                .or_else(|vulkan_error| {
                    Self::new_with_backends(window, Some(wgpu::Backends::DX12))
                        .map_err(|dx12_error| format!("Vulkan renderer failed: {vulkan_error}; DX12 renderer failed: {dx12_error}"))
                });
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
        let surface = instance.create_surface(window).map_err(|e| e.to_string())?;
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
        let capabilities = surface.get_capabilities(&adapter);
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
            frames: 0,
        })
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
    ) -> Result<(), String> {
        self.renderer
            .render_to_texture(
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
            )
            .map_err(|e| e.to_string())?;
        let frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(frame)
            | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => frame,
            wgpu::CurrentSurfaceTexture::Outdated => {
                self.surface.configure(&self.device, &self.config);
                return Ok(());
            }
            wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => {
                return Ok(());
            }
            state => return Err(format!("Could not acquire surface: {state:?}")),
        };
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = self.device.create_command_encoder(&Default::default());
        self.blitter
            .copy(&self.device, &mut encoder, &self.target_view, &view);
        self.queue.submit([encoder.finish()]);
        frame.present();
        self.frames += 1;
        Ok(())
    }
    /// Render the same display list to a readable GPU texture for reproducible visual QA.
    pub fn capture(
        &mut self,
        scene: &Scene,
        background: vello::peniko::Color,
        path: &str,
    ) -> Result<(), String> {
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
            .map_err(|e| e.to_string())?;
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
            .map_err(|e| e.to_string())?;
        rx.recv()
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        let mapped = buffer.slice(..).get_mapped_range();
        let mut pixels = Vec::with_capacity((width * height * 4) as usize);
        for row in mapped.chunks(pitch as usize) {
            pixels.extend_from_slice(&row[..width as usize * 4]);
        }
        image::save_buffer(path, &pixels, width, height, image::ColorType::Rgba8)
            .map_err(|e| e.to_string())?;
        drop(mapped);
        buffer.unmap();
        Ok(())
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
