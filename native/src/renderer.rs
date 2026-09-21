use std::sync::Arc;
use vello::{
    AaConfig, AaSupport, RenderParams, Renderer, RendererOptions, Scene,
    util::{RenderContext, RenderSurface},
    wgpu,
};
use winit::window::Window;

pub struct Graphics {
    // Drop the surface before the context; the surface itself owns an Arc<Window>.
    surface: RenderSurface<'static>,
    renderer: Renderer,
    context: RenderContext,
    pub frames: u64,
}
impl Graphics {
    pub fn new(window: Arc<Window>) -> Result<Self, String> {
        let mut context = RenderContext::new();
        let size = window.inner_size();
        let surface = pollster::block_on(context.create_surface(
            window,
            size.width.max(1),
            size.height.max(1),
            wgpu::PresentMode::AutoVsync,
        ))
        .map_err(|e| e.to_string())?;
        let device = &context.devices[surface.dev_id].device;
        let renderer = Renderer::new(
            device,
            RendererOptions {
                antialiasing_support: AaSupport::area_only(),
                ..Default::default()
            },
        )
        .map_err(|e| e.to_string())?;
        Ok(Self {
            surface,
            renderer,
            context,
            frames: 0,
        })
    }
    pub fn resize(&mut self, width: u32, height: u32) {
        if width > 0 && height > 0 {
            self.context
                .resize_surface(&mut self.surface, width, height);
        }
    }
    pub fn render(
        &mut self,
        scene: &Scene,
        background: vello::peniko::Color,
    ) -> Result<(), String> {
        let surface = &self.surface;
        let device = &self.context.devices[surface.dev_id];
        self.renderer
            .render_to_texture(
                &device.device,
                &device.queue,
                scene,
                &surface.target_view,
                &RenderParams {
                    base_color: background,
                    width: surface.config.width,
                    height: surface.config.height,
                    antialiasing_method: AaConfig::Area,
                },
            )
            .map_err(|e| e.to_string())?;
        let frame = match surface.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(frame)
            | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => frame,
            wgpu::CurrentSurfaceTexture::Outdated => {
                self.context.configure_surface(surface);
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
        let mut encoder = device.device.create_command_encoder(&Default::default());
        surface
            .blitter
            .copy(&device.device, &mut encoder, &surface.target_view, &view);
        device.queue.submit([encoder.finish()]);
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
        let device = &self.context.devices[self.surface.dev_id];
        let (width, height) = (self.surface.config.width, self.surface.config.height);
        let texture = device.device.create_texture(&wgpu::TextureDescriptor {
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
                &device.device,
                &device.queue,
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
        let buffer = device.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("tarve-readback"),
            size: (pitch * height) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = device.device.create_command_encoder(&Default::default());
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
        device.queue.submit([encoder.finish()]);
        let (tx, rx) = std::sync::mpsc::channel();
        buffer
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                let _ = tx.send(result);
            });
        device
            .device
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
