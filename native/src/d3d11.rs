use std::{
    collections::{HashMap, HashSet},
    ffi::c_void,
    mem::size_of,
    ptr,
    sync::Arc,
};

use lyon_tessellation::{
    BuffersBuilder, FillOptions, FillRule, FillTessellator, FillVertex, LineCap, LineJoin,
    StrokeOptions, StrokeTessellator, StrokeVertex, VertexBuffers,
    math::{Point as LyonPoint, point},
    path::Path as LyonPath,
};
use swash::{
    FontRef, GlyphId,
    scale::{Render as SwashRender, ScaleContext, Source},
    zeno::{Format as SwashFormat, Vector as SwashVector},
};
use vello::{
    kurbo::{Affine, BezPath, Cap, Join, PathEl, Point, Shape, Stroke, dash},
    peniko::{Color, Fill, FontData, ImageAlphaType, ImageData, ImageFormat},
};
use windows::{
    Win32::{
        Foundation::{HMODULE, HWND},
        Graphics::{
            Direct3D::{
                D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0,
                D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST,
            },
            Direct3D11::{
                D3D11_BIND_DEPTH_STENCIL, D3D11_BIND_INDEX_BUFFER, D3D11_BIND_SHADER_RESOURCE,
                D3D11_BIND_VERTEX_BUFFER, D3D11_BLEND_DESC, D3D11_BLEND_INV_SRC_ALPHA,
                D3D11_BLEND_ONE, D3D11_BLEND_OP_ADD, D3D11_BLEND_SRC_ALPHA, D3D11_BUFFER_DESC,
                D3D11_COLOR_WRITE_ENABLE_ALL, D3D11_COMPARISON_EQUAL, D3D11_CPU_ACCESS_WRITE,
                D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_CULL_NONE, D3D11_DEPTH_STENCIL_DESC,
                D3D11_DEPTH_WRITE_MASK_ZERO, D3D11_FILTER_MIN_MAG_MIP_LINEAR,
                D3D11_FILTER_MIN_MAG_MIP_POINT, D3D11_INPUT_ELEMENT_DESC,
                D3D11_INPUT_PER_VERTEX_DATA, D3D11_MAP_WRITE_DISCARD, D3D11_MAPPED_SUBRESOURCE,
                D3D11_RASTERIZER_DESC, D3D11_RENDER_TARGET_BLEND_DESC, D3D11_SAMPLER_DESC,
                D3D11_SDK_VERSION, D3D11_STENCIL_OP_DECR_SAT, D3D11_STENCIL_OP_INCR_SAT,
                D3D11_STENCIL_OP_KEEP, D3D11_SUBRESOURCE_DATA, D3D11_TEXTURE_ADDRESS_CLAMP,
                D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, D3D11_USAGE_DYNAMIC,
                D3D11_USAGE_IMMUTABLE, D3D11_VIEWPORT, D3D11CreateDevice, ID3D11BlendState,
                ID3D11Buffer, ID3D11DepthStencilState, ID3D11DepthStencilView, ID3D11Device,
                ID3D11DeviceContext, ID3D11InputLayout, ID3D11PixelShader, ID3D11RasterizerState,
                ID3D11RenderTargetView, ID3D11SamplerState, ID3D11ShaderResourceView,
                ID3D11Texture2D, ID3D11VertexShader,
            },
            Dxgi::{
                Common::{
                    DXGI_ALPHA_MODE_IGNORE, DXGI_FORMAT_B8G8R8A8_UNORM,
                    DXGI_FORMAT_D24_UNORM_S8_UINT, DXGI_FORMAT_R8_UNORM,
                    DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_FORMAT_R32_FLOAT, DXGI_FORMAT_R32_UINT,
                    DXGI_FORMAT_R32G32_FLOAT, DXGI_FORMAT_R32G32B32A32_FLOAT, DXGI_SAMPLE_DESC,
                },
                CreateDXGIFactory1, DXGI_PRESENT, DXGI_SCALING_STRETCH, DXGI_SWAP_CHAIN_DESC1,
                DXGI_SWAP_CHAIN_FLAG, DXGI_SWAP_EFFECT_FLIP_DISCARD,
                DXGI_USAGE_RENDER_TARGET_OUTPUT, IDXGIFactory2, IDXGISwapChain1,
            },
        },
    },
    core::PCSTR,
};
use winit::{
    raw_window_handle::{HasWindowHandle, RawWindowHandle},
    window::Window,
};

use crate::paint::{GradientGeometry, PaintGlyph, PaintGradient, PaintTarget};

const GLYPH_ATLAS_SIZE: u32 = 1024;
const MAX_GLYPH_ATLASES: usize = 4;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum D3d11Error {
    RecoverDevice(String),
    FatalGpu(String),
    Request(String),
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Vertex {
    pos: [f32; 2],
    uv: [f32; 2],
    color: [f32; 4],
    mode: f32,
    /// Blurred rounded-rect shadow: half width, half height, corner radius,
    /// gaussian sigma, all in device pixels. Zero for every other mode.
    params: [f32; 4],
}

unsafe impl bytemuck::Zeroable for Vertex {}
unsafe impl bytemuck::Pod for Vertex {}

#[derive(Clone)]
enum TextureRef {
    Solid,
    Glyph(ID3D11ShaderResourceView),
    Image(ID3D11ShaderResourceView),
}

enum DrawCommand {
    Draw {
        first: u32,
        count: u32,
        texture: TextureRef,
    },
    PushClip {
        first: u32,
        count: u32,
    },
    PopClip {
        first: u32,
        count: u32,
    },
}

struct CachedImage {
    _texture: ID3D11Texture2D,
    view: ID3D11ShaderResourceView,
    signature: (u64, u32, u32, ImageFormat, ImageAlphaType),
}

#[derive(Clone, Hash, PartialEq, Eq)]
struct GlyphKey {
    font_id: u64,
    font_index: u32,
    font_size_64: u32,
    glyph_id: u32,
    subpixel_x: u8,
    subpixel_y: u8,
    coords: Vec<i16>,
}

#[derive(Clone)]
struct GlyphEntry {
    view: Option<ID3D11ShaderResourceView>,
    uv: [f32; 4],
    left: i32,
    top: i32,
    width: u32,
    height: u32,
}

struct GlyphAtlas {
    _texture: ID3D11Texture2D,
    view: ID3D11ShaderResourceView,
    x: u32,
    y: u32,
    row_height: u32,
}

impl GlyphAtlas {
    fn allocate(&mut self, width: u32, height: u32) -> Option<(u32, u32)> {
        let width = width.max(1);
        let height = height.max(1);
        if width > GLYPH_ATLAS_SIZE || height > GLYPH_ATLAS_SIZE {
            return None;
        }
        if self.x + width > GLYPH_ATLAS_SIZE {
            self.x = 0;
            self.y = self.y.saturating_add(self.row_height);
            self.row_height = 0;
        }
        if self.y + height > GLYPH_ATLAS_SIZE {
            return None;
        }
        let pos = (self.x, self.y);
        self.x += width;
        self.row_height = self.row_height.max(height);
        Some(pos)
    }
}

pub(crate) struct D3d11Graphics {
    _window: Arc<Window>,
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    swap_chain: IDXGISwapChain1,
    render_target: Option<ID3D11RenderTargetView>,
    multisample_texture: Option<ID3D11Texture2D>,
    depth_texture: Option<ID3D11Texture2D>,
    depth_view: Option<ID3D11DepthStencilView>,
    vertex_shader: ID3D11VertexShader,
    pixel_shader: ID3D11PixelShader,
    input_layout: ID3D11InputLayout,
    image_sampler: ID3D11SamplerState,
    glyph_sampler: ID3D11SamplerState,
    rasterizer: ID3D11RasterizerState,
    blend: ID3D11BlendState,
    clip_blend: ID3D11BlendState,
    stencil_draw: ID3D11DepthStencilState,
    stencil_push: ID3D11DepthStencilState,
    stencil_pop: ID3D11DepthStencilState,
    vertex_buffer: ID3D11Buffer,
    vertex_capacity: usize,
    index_buffer: ID3D11Buffer,
    index_capacity: usize,
    sample_desc: DXGI_SAMPLE_DESC,
    width: u32,
    height: u32,
    vertices: Vec<Vertex>,
    indices: Vec<u32>,
    commands: Vec<DrawCommand>,
    images: HashMap<String, CachedImage>,
    used_images: HashSet<String>,
    glyphs: HashMap<GlyphKey, GlyphEntry>,
    glyph_outlines: HashMap<GlyphKey, vello::kurbo::BezPath>,
    glyph_atlases: Vec<GlyphAtlas>,
    glyph_atlas_exhausted: bool,
    /// Glyphs rasterized since the device was created; steady redraws of
    /// already-seen text must not move it.
    glyph_rasterizations: u64,
    scale_context: ScaleContext,
    prepared: bool,
}

pub(crate) struct D3d11PaintTarget<'a> {
    graphics: &'a mut D3d11Graphics,
    layers: Vec<D3d11PaintLayer>,
    suppressed_clips: usize,
    opacity: f32,
}

enum D3d11PaintLayer {
    Clip(Option<(u32, u32)>),
    Opacity(f32),
}

impl D3d11Graphics {
    pub(crate) fn new(window: Arc<Window>) -> Result<Self, String> {
        let size = window.inner_size();
        let width = size.width.max(1);
        let height = size.height.max(1);

        // Claim the prewarmed device first so an early error cannot strand it.
        let (device, context) = create_device()?;
        let hwnd = hwnd(&window)?;

        let factory: IDXGIFactory2 = unsafe { CreateDXGIFactory1() }.map_err(win_error)?;
        let desc = DXGI_SWAP_CHAIN_DESC1 {
            Width: width,
            Height: height,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            Stereo: false.into(),
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
            BufferCount: 2,
            Scaling: DXGI_SCALING_STRETCH,
            SwapEffect: DXGI_SWAP_EFFECT_FLIP_DISCARD,
            AlphaMode: DXGI_ALPHA_MODE_IGNORE,
            Flags: 0,
        };
        let swap_chain =
            unsafe { factory.CreateSwapChainForHwnd(&device, hwnd, &desc, None, None) }
                .map_err(win_error)?;

        let sample_desc = choose_sample_desc(&device);
        let (multisample_texture, render_target) =
            create_color_target(&device, &swap_chain, width, height, sample_desc)?;
        let (depth_texture, depth_view) = create_depth_target(&device, width, height, sample_desc)?;

        let (vertex_shader, pixel_shader, input_layout) = create_shaders(&device)?;

        let image_sampler = create_sampler(&device, D3D11_FILTER_MIN_MAG_MIP_LINEAR)?;
        let glyph_sampler = create_sampler(&device, D3D11_FILTER_MIN_MAG_MIP_POINT)?;
        let rasterizer = create_rasterizer(&device, sample_desc.Count > 1)?;
        let blend = create_blend(&device, true)?;
        let clip_blend = create_blend(&device, false)?;
        let stencil_draw = create_stencil(&device, D3D11_STENCIL_OP_KEEP)?;
        let stencil_push = create_stencil(&device, D3D11_STENCIL_OP_INCR_SAT)?;
        let stencil_pop = create_stencil(&device, D3D11_STENCIL_OP_DECR_SAT)?;
        let vertex_capacity = 4096;
        let index_capacity = 8192;
        let vertex_buffer = create_dynamic_buffer(
            &device,
            vertex_capacity * size_of::<Vertex>(),
            D3D11_BIND_VERTEX_BUFFER,
        )?;
        let index_buffer = create_dynamic_buffer(
            &device,
            index_capacity * size_of::<u32>(),
            D3D11_BIND_INDEX_BUFFER,
        )?;
        let first_atlas = create_glyph_atlas(&device)?;

        Ok(Self {
            _window: window,
            device,
            context,
            swap_chain,
            render_target: Some(render_target),
            multisample_texture,
            depth_texture: Some(depth_texture),
            depth_view: Some(depth_view),
            vertex_shader,
            pixel_shader,
            input_layout,
            image_sampler,
            glyph_sampler,
            rasterizer,
            blend,
            clip_blend,
            stencil_draw,
            stencil_push,
            stencil_pop,
            vertex_buffer,
            vertex_capacity,
            index_buffer,
            index_capacity,
            sample_desc,
            width,
            height,
            vertices: Vec::with_capacity(2048),
            indices: Vec::with_capacity(4096),
            commands: Vec::with_capacity(256),
            images: HashMap::new(),
            used_images: HashSet::new(),
            glyphs: HashMap::new(),
            glyph_outlines: HashMap::new(),
            glyph_atlases: vec![first_atlas],
            glyph_atlas_exhausted: false,
            glyph_rasterizations: 0,
            scale_context: ScaleContext::new(),
            prepared: false,
        })
    }

    pub(crate) fn prepare(
        &mut self,
        width: u32,
        height: u32,
        paint: impl FnOnce(&mut D3d11PaintTarget<'_>),
    ) -> Result<(), D3d11Error> {
        if width == 0 || height == 0 {
            return Err(D3d11Error::FatalGpu(
                "D3D11 renderer cannot prepare a zero-sized frame".into(),
            ));
        }
        if (self.width != width || self.height != height)
            && let Err(error) = self.resize_targets(width, height)
        {
            self.prepared = false;
            return Err(self.classify_gpu_error("D3D11 resize during frame preparation", error));
        }
        self.vertices.clear();
        self.indices.clear();
        self.commands.clear();
        self.used_images.clear();
        if self.glyph_atlas_exhausted {
            self.glyphs.clear();
            self.glyph_atlases.clear();
            let atlas = match create_glyph_atlas(&self.device) {
                Ok(atlas) => atlas,
                Err(error) => {
                    self.prepared = false;
                    return Err(self.classify_gpu_error("D3D11 glyph-atlas reset", error));
                }
            };
            self.glyph_atlases.push(atlas);
            self.glyph_atlas_exhausted = false;
        }
        let mut target = D3d11PaintTarget {
            graphics: self,
            layers: Vec::with_capacity(8),
            suppressed_clips: 0,
            opacity: 1.0,
        };
        paint(&mut target);
        self.images.retain(|key, _| self.used_images.contains(key));
        self.prepared = true;
        Ok(())
    }

    pub(crate) fn glyph_rasterizations(&self) -> u64 {
        self.glyph_rasterizations
    }

    pub(crate) fn resize(&mut self, width: u32, height: u32) -> Result<bool, D3d11Error> {
        if width == 0 || height == 0 || (self.width == width && self.height == height) {
            return Ok(false);
        }
        if let Err(error) = self.resize_targets(width, height) {
            self.prepared = false;
            return Err(self.classify_gpu_error("D3D11 ResizeBuffers", error));
        }
        self.prepared = false;
        Ok(true)
    }

    fn resize_targets(&mut self, width: u32, height: u32) -> Result<(), String> {
        unsafe {
            self.context.OMSetRenderTargets(None, None);
            self.context.Flush();
        }
        self.render_target.take();
        self.multisample_texture.take();
        self.depth_view.take();
        self.depth_texture.take();
        unsafe {
            self.swap_chain.ResizeBuffers(
                2,
                width,
                height,
                DXGI_FORMAT_B8G8R8A8_UNORM,
                DXGI_SWAP_CHAIN_FLAG(0),
            )
        }
        .map_err(win_error)?;
        let (multisample_texture, render_target) = create_color_target(
            &self.device,
            &self.swap_chain,
            width,
            height,
            self.sample_desc,
        )?;
        self.multisample_texture = multisample_texture;
        self.render_target = Some(render_target);
        let (depth_texture, depth_view) =
            create_depth_target(&self.device, width, height, self.sample_desc)?;
        self.depth_texture = Some(depth_texture);
        self.depth_view = Some(depth_view);
        self.width = width;
        self.height = height;
        Ok(())
    }

    pub(crate) fn render(&mut self, background: Color) -> Result<(), D3d11Error> {
        if !self.prepared {
            return Err(D3d11Error::FatalGpu(
                "D3D11 frame was not prepared before presentation".into(),
            ));
        }
        if let Err(error) = self.draw_frame(background) {
            return Err(self.classify_gpu_error("D3D11 draw", error));
        }
        if let Err(error) = unsafe { self.swap_chain.Present(1, DXGI_PRESENT(0)).ok() } {
            return Err(self.classify_windows_gpu_error("DXGI Present", error));
        }
        Ok(())
    }

    fn draw_frame(&mut self, background: Color) -> Result<(), String> {
        self.ensure_gpu_buffers()?;
        self.upload_frame_buffers()?;
        let render_target = self
            .render_target
            .as_ref()
            .ok_or("D3D11 render target is unavailable")?;
        let depth_view = self
            .depth_view
            .as_ref()
            .ok_or("D3D11 stencil target is unavailable")?;
        let bg = rgba(background);
        unsafe {
            self.context.ClearRenderTargetView(render_target, &bg);
            self.context.ClearDepthStencilView(
                depth_view,
                windows::Win32::Graphics::Direct3D11::D3D11_CLEAR_STENCIL.0,
                1.0,
                0,
            );
            self.context
                .OMSetRenderTargets(Some(&[Some(render_target.clone())]), Some(depth_view));
            self.context.RSSetState(&self.rasterizer);
            self.context.RSSetViewports(Some(&[D3D11_VIEWPORT {
                TopLeftX: 0.0,
                TopLeftY: 0.0,
                Width: self.width as f32,
                Height: self.height as f32,
                MinDepth: 0.0,
                MaxDepth: 1.0,
            }]));
            self.context.IASetInputLayout(&self.input_layout);
            self.context
                .IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
            let stride = size_of::<Vertex>() as u32;
            let offset = 0_u32;
            let buffers = [Some(self.vertex_buffer.clone())];
            let strides = [stride];
            let offsets = [offset];
            self.context.IASetVertexBuffers(
                0,
                1,
                Some(buffers.as_ptr()),
                Some(strides.as_ptr()),
                Some(offsets.as_ptr()),
            );
            self.context
                .IASetIndexBuffer(&self.index_buffer, DXGI_FORMAT_R32_UINT, 0);
            self.context.VSSetShader(&self.vertex_shader, None);
            self.context.PSSetShader(&self.pixel_shader, None);
        }
        let mut clip_depth = 0_u32;
        for command in &self.commands {
            match command {
                DrawCommand::Draw {
                    first,
                    count,
                    texture,
                } => unsafe {
                    self.context.OMSetBlendState(
                        Some(&self.blend),
                        Some(&[0.0, 0.0, 0.0, 0.0]),
                        u32::MAX,
                    );
                    self.context
                        .OMSetDepthStencilState(Some(&self.stencil_draw), clip_depth);
                    match texture {
                        TextureRef::Solid => self.context.PSSetShaderResources(0, Some(&[None])),
                        TextureRef::Glyph(view) => {
                            self.context
                                .PSSetSamplers(0, Some(&[Some(self.glyph_sampler.clone())]));
                            self.context
                                .PSSetShaderResources(0, Some(&[Some(view.clone())]));
                        }
                        TextureRef::Image(view) => {
                            self.context
                                .PSSetSamplers(0, Some(&[Some(self.image_sampler.clone())]));
                            self.context
                                .PSSetShaderResources(0, Some(&[Some(view.clone())]));
                        }
                    }
                    self.context.DrawIndexed(*count, *first, 0);
                },
                DrawCommand::PushClip { first, count } => unsafe {
                    self.context.OMSetBlendState(
                        Some(&self.clip_blend),
                        Some(&[0.0, 0.0, 0.0, 0.0]),
                        u32::MAX,
                    );
                    self.context
                        .OMSetDepthStencilState(Some(&self.stencil_push), clip_depth);
                    self.context.PSSetShaderResources(0, Some(&[None]));
                    self.context.DrawIndexed(*count, *first, 0);
                    clip_depth = clip_depth.saturating_add(1);
                },
                DrawCommand::PopClip { first, count } => unsafe {
                    self.context.OMSetBlendState(
                        Some(&self.clip_blend),
                        Some(&[0.0, 0.0, 0.0, 0.0]),
                        u32::MAX,
                    );
                    self.context
                        .OMSetDepthStencilState(Some(&self.stencil_pop), clip_depth);
                    self.context.PSSetShaderResources(0, Some(&[None]));
                    self.context.DrawIndexed(*count, *first, 0);
                    clip_depth = clip_depth.saturating_sub(1);
                },
            }
        }
        unsafe { self.context.PSSetShaderResources(0, Some(&[None])) };
        if let Some(multisample_texture) = &self.multisample_texture {
            unsafe {
                self.context.OMSetRenderTargets(None, None);
                let backbuffer: ID3D11Texture2D =
                    self.swap_chain.GetBuffer(0).map_err(win_error)?;
                self.context.ResolveSubresource(
                    &backbuffer,
                    0,
                    multisample_texture,
                    0,
                    DXGI_FORMAT_B8G8R8A8_UNORM,
                );
            }
        }
        Ok(())
    }

    pub(crate) fn capture(&mut self, background: Color, path: &str) -> Result<(), D3d11Error> {
        if !self.prepared {
            return Err(D3d11Error::Request(
                "D3D11 frame was not prepared before capture".into(),
            ));
        }
        // Capture the current prepared command list. Flip-model swapchain buffers are not
        // retained-frame storage, so never read them without drawing this frame first.
        if let Err(error) = self.draw_frame(background) {
            return Err(self.classify_gpu_error("D3D11 capture draw", error));
        }
        let backbuffer: ID3D11Texture2D = match unsafe { self.swap_chain.GetBuffer(0) } {
            Ok(backbuffer) => backbuffer,
            Err(error) => return Err(self.classify_windows_gpu_error("DXGI GetBuffer", error)),
        };
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { backbuffer.GetDesc(&mut desc) };
        desc.BindFlags = 0;
        desc.MiscFlags = 0;
        desc.Usage = windows::Win32::Graphics::Direct3D11::D3D11_USAGE_STAGING;
        desc.CPUAccessFlags = windows::Win32::Graphics::Direct3D11::D3D11_CPU_ACCESS_READ.0 as u32;
        let mut staging = None;
        if let Err(error) = unsafe { self.device.CreateTexture2D(&desc, None, Some(&mut staging)) }
        {
            return Err(
                self.classify_windows_gpu_error("D3D11 capture staging texture creation", error)
            );
        }
        let staging = staging.ok_or_else(|| {
            D3d11Error::FatalGpu("D3D11 capture staging texture was not created".into())
        })?;
        unsafe { self.context.CopyResource(&staging, &backbuffer) };
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        if let Err(error) = unsafe {
            self.context.Map(
                &staging,
                0,
                windows::Win32::Graphics::Direct3D11::D3D11_MAP_READ,
                0,
                Some(&mut mapped),
            )
        } {
            return Err(self.classify_windows_gpu_error("D3D11 capture Map", error));
        }
        let mut rgba = vec![0_u8; self.width as usize * self.height as usize * 4];
        for y in 0..self.height as usize {
            let src = unsafe {
                std::slice::from_raw_parts(
                    (mapped.pData as *const u8).add(y * mapped.RowPitch as usize),
                    self.width as usize * 4,
                )
            };
            let dst = &mut rgba[y * self.width as usize * 4..(y + 1) * self.width as usize * 4];
            for (source, target) in src
                .as_chunks::<4>()
                .0
                .iter()
                .zip(dst.as_chunks_mut::<4>().0)
            {
                target.copy_from_slice(&[source[2], source[1], source[0], source[3]]);
            }
        }
        unsafe { self.context.Unmap(&staging, 0) };
        image::save_buffer(
            path,
            &rgba,
            self.width,
            self.height,
            image::ColorType::Rgba8,
        )
        .map_err(|error| D3d11Error::Request(error.to_string()))
    }

    fn classify_windows_gpu_error(
        &self,
        operation: &str,
        error: windows::core::Error,
    ) -> D3d11Error {
        self.classify_gpu_error(operation, error.to_string())
    }

    fn classify_gpu_error(&self, operation: &str, error: String) -> D3d11Error {
        let message = format!("{operation} failed: {error}");
        match unsafe { self.device.GetDeviceRemovedReason() } {
            Ok(()) => D3d11Error::FatalGpu(message),
            Err(reason) => {
                D3d11Error::RecoverDevice(format!("{message}; device removal reason: {reason}"))
            }
        }
    }

    fn ensure_gpu_buffers(&mut self) -> Result<(), String> {
        if self.vertices.len() > self.vertex_capacity {
            self.vertex_capacity = self.vertices.len().next_power_of_two().max(4096);
            self.vertex_buffer = create_dynamic_buffer(
                &self.device,
                self.vertex_capacity * size_of::<Vertex>(),
                D3D11_BIND_VERTEX_BUFFER,
            )?;
        }
        if self.indices.len() > self.index_capacity {
            self.index_capacity = self.indices.len().next_power_of_two().max(8192);
            self.index_buffer = create_dynamic_buffer(
                &self.device,
                self.index_capacity * size_of::<u32>(),
                D3D11_BIND_INDEX_BUFFER,
            )?;
        }
        Ok(())
    }

    fn upload_frame_buffers(&self) -> Result<(), String> {
        upload_dynamic(
            &self.context,
            &self.vertex_buffer,
            bytemuck::cast_slice(&self.vertices),
        )?;
        upload_dynamic(
            &self.context,
            &self.index_buffer,
            bytemuck::cast_slice(&self.indices),
        )
    }

    fn append_geometry(
        &mut self,
        points: &[LyonPoint],
        indices: &[u32],
        transform: Affine,
        color: Color,
        mode: f32,
        uv: impl Fn(LyonPoint) -> [f32; 2],
    ) -> (u32, u32) {
        let vertex_base = self.vertices.len() as u32;
        let first = self.indices.len() as u32;
        let rgba = rgba(color);
        for source in points {
            let texcoord = uv(*source);
            let p = transform * Point::new(f64::from(source.x), f64::from(source.y));
            self.vertices.push(Vertex {
                pos: self.ndc(p.x as f32, p.y as f32),
                uv: texcoord,
                color: rgba,
                mode,
                params: [0.0; 4],
            });
        }
        self.indices
            .extend(indices.iter().map(|index| vertex_base + *index));
        (first, indices.len() as u32)
    }

    /// One quad over `area` whose pixels evaluate an analytic gaussian-blurred
    /// rounded rectangle (mode 3), or its inverse for inset shadows (mode 4).
    /// `uv` carries each corner's offset from the shadow centre in pixels.
    fn append_shadow_quad(
        &mut self,
        area: [[f32; 2]; 2],
        center: [f32; 2],
        color: Color,
        invert: bool,
        params: [f32; 4],
    ) {
        let first = self.indices.len() as u32;
        let base = self.vertices.len() as u32;
        let rgba = rgba(color);
        let [[x0, y0], [x1, y1]] = area;
        for [x, y] in [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] {
            self.vertices.push(Vertex {
                pos: self.ndc(x, y),
                uv: [x - center[0], y - center[1]],
                color: rgba,
                mode: if invert { 4.0 } else { 3.0 },
                params,
            });
        }
        self.indices
            .extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
        self.commands.push(DrawCommand::Draw {
            first,
            count: 6,
            texture: TextureRef::Solid,
        });
    }

    /// Plain triangles with per-vertex colours (three entries per triangle).
    fn append_colored_triangles(
        &mut self,
        points: &[(Point, Color)],
        transform: Affine,
        opacity: f32,
    ) {
        if points.is_empty() {
            return;
        }
        let first = self.indices.len() as u32;
        let base = self.vertices.len() as u32;
        for (index, (point, color)) in points.iter().enumerate() {
            let p = transform * *point;
            self.vertices.push(Vertex {
                pos: self.ndc(p.x as f32, p.y as f32),
                uv: [0.0, 0.0],
                color: rgba(color.multiply_alpha(opacity)),
                mode: 0.0,
                params: [0.0; 4],
            });
            self.indices.push(base + index as u32);
        }
        self.commands.push(DrawCommand::Draw {
            first,
            count: points.len() as u32,
            texture: TextureRef::Solid,
        });
    }

    fn ndc(&self, x: f32, y: f32) -> [f32; 2] {
        [
            x * 2.0 / self.width.max(1) as f32 - 1.0,
            1.0 - y * 2.0 / self.height.max(1) as f32,
        ]
    }

    fn append_quad_points(
        &mut self,
        points: [[f32; 2]; 4],
        uv: [f32; 4],
        color: Color,
        mode: f32,
        texture: TextureRef,
    ) {
        let first = self.indices.len() as u32;
        let base = self.vertices.len() as u32;
        let rgba = rgba(color);
        let [u0, v0, u1, v1] = uv;
        for ([x, y], [u, v]) in points
            .into_iter()
            .zip([[u0, v0], [u1, v0], [u1, v1], [u0, v1]])
        {
            self.vertices.push(Vertex {
                pos: self.ndc(x, y),
                uv: [u, v],
                color: rgba,
                mode,
                params: [0.0; 4],
            });
        }
        self.indices
            .extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
        self.commands.push(DrawCommand::Draw {
            first,
            count: 6,
            texture,
        });
    }

    fn image_view(&mut self, key: &str, image: &ImageData) -> Option<ID3D11ShaderResourceView> {
        self.used_images.insert(key.to_string());
        let signature = (
            image.data.id(),
            image.width,
            image.height,
            image.format,
            image.alpha_type,
        );
        if self
            .images
            .get(key)
            .is_some_and(|cached| cached.signature == signature)
        {
            return self.images.get(key).map(|cached| cached.view.clone());
        }
        let pixels = image_rgba(image)?;
        let cached =
            create_rgba_texture(&self.device, image.width, image.height, &pixels, signature)
                .ok()?;
        let view = cached.view.clone();
        self.images.insert(key.to_string(), cached);
        Some(view)
    }

    #[allow(clippy::too_many_arguments)]
    fn glyph_entry(
        &mut self,
        font: &FontData,
        font_size: f32,
        normalized_coords: &[i16],
        glyph_id: u32,
        subpixel_x: u8,
        subpixel_y: u8,
        scale: f32,
    ) -> Option<GlyphEntry> {
        let physical_size = (font_size * scale).max(1.0);
        let key = GlyphKey {
            font_id: font.data.id(),
            font_index: font.index,
            font_size_64: (physical_size * 64.0).round() as u32,
            glyph_id,
            subpixel_x,
            subpixel_y,
            coords: normalized_coords.to_vec(),
        };
        if let Some(entry) = self.glyphs.get(&key) {
            return Some(entry.clone());
        }
        self.glyph_rasterizations += 1;
        let font_ref = FontRef::from_index(font.data.data(), font.index as usize)?;
        let mut scaler = self
            .scale_context
            .builder(font_ref)
            .size(physical_size)
            .hint(true)
            .normalized_coords(normalized_coords)
            .build();
        let image = SwashRender::new(&[Source::Outline])
            .format(SwashFormat::Alpha)
            .offset(SwashVector::new(
                f32::from(subpixel_x) / 4.0,
                f32::from(subpixel_y) / 4.0,
            ))
            .render(&mut scaler, glyph_id as GlyphId)?;
        if image.placement.width == 0 || image.placement.height == 0 {
            // Blank glyphs (spaces) are cached too; otherwise every frame
            // rebuilds a scaler and rasterizes them again.
            let entry = GlyphEntry {
                view: None,
                uv: [0.0; 4],
                left: image.placement.left,
                top: image.placement.top,
                width: 0,
                height: 0,
            };
            self.glyphs.insert(key, entry.clone());
            return Some(entry);
        }
        let entry = if let Some((page, ax, ay)) =
            self.allocate_glyph(image.placement.width, image.placement.height)
        {
            let atlas = &self.glyph_atlases[page];
            update_r8_texture(
                &self.context,
                &atlas._texture,
                ax,
                ay,
                image.placement.width,
                image.placement.height,
                &image.data,
            );
            let size = GLYPH_ATLAS_SIZE as f32;
            GlyphEntry {
                view: Some(atlas.view.clone()),
                uv: [
                    ax as f32 / size,
                    ay as f32 / size,
                    (ax + image.placement.width) as f32 / size,
                    (ay + image.placement.height) as f32 / size,
                ],
                left: image.placement.left,
                top: image.placement.top,
                width: image.placement.width,
                height: image.placement.height,
            }
        } else {
            self.glyph_atlas_exhausted = true;
            GlyphEntry {
                view: Some(
                    create_r8_texture(
                        &self.device,
                        image.placement.width,
                        image.placement.height,
                        &image.data,
                    )
                    .ok()?,
                ),
                uv: [0.0, 0.0, 1.0, 1.0],
                left: image.placement.left,
                top: image.placement.top,
                width: image.placement.width,
                height: image.placement.height,
            }
        };
        self.glyphs.insert(key, entry.clone());
        Some(entry)
    }

    /// A glyph's outline in font-size units, y down, for transforms a bitmap
    /// atlas cannot follow (rotation, skew, non-uniform scale).
    fn glyph_outline(
        &mut self,
        font: &FontData,
        font_size: f32,
        normalized_coords: &[i16],
        glyph_id: u32,
    ) -> Option<vello::kurbo::BezPath> {
        use swash::zeno::{Command, PathData};
        let key = GlyphKey {
            font_id: font.data.id(),
            font_index: font.index,
            font_size_64: (font_size * 64.0).round() as u32,
            glyph_id,
            subpixel_x: 255,
            subpixel_y: 255,
            coords: normalized_coords.to_vec(),
        };
        if let Some(path) = self.glyph_outlines.get(&key) {
            return Some(path.clone());
        }
        let font_ref = FontRef::from_index(font.data.data(), font.index as usize)?;
        let mut scaler = self
            .scale_context
            .builder(font_ref)
            .size(font_size)
            .normalized_coords(normalized_coords)
            .build();
        let outline = scaler.scale_outline(glyph_id as GlyphId)?;
        let mut path = vello::kurbo::BezPath::new();
        let p = |v: swash::zeno::Vector| (f64::from(v.x), -f64::from(v.y));
        for command in outline.path().commands() {
            match command {
                Command::MoveTo(a) => path.move_to(p(a)),
                Command::LineTo(a) => path.line_to(p(a)),
                Command::QuadTo(a, b) => path.quad_to(p(a), p(b)),
                Command::CurveTo(a, b, c) => path.curve_to(p(a), p(b), p(c)),
                Command::Close => path.close_path(),
            }
        }
        self.glyph_outlines.insert(key, path.clone());
        Some(path)
    }

    fn allocate_glyph(&mut self, width: u32, height: u32) -> Option<(usize, u32, u32)> {
        for (page, atlas) in self.glyph_atlases.iter_mut().enumerate() {
            if let Some((x, y)) = atlas.allocate(width + 1, height + 1) {
                return Some((page, x, y));
            }
        }
        if self.glyph_atlases.len() >= MAX_GLYPH_ATLASES {
            return None;
        }
        let mut atlas = create_glyph_atlas(&self.device).ok()?;
        let (x, y) = atlas.allocate(width + 1, height + 1)?;
        let page = self.glyph_atlases.len();
        self.glyph_atlases.push(atlas);
        Some((page, x, y))
    }
}

fn quantize_glyph_position(value: f32) -> (f32, u8) {
    let quarter = (value * 4.0).round();
    let base = (quarter / 4.0).floor();
    let subpixel = (quarter as i64).rem_euclid(4) as u8;
    (base, subpixel)
}

impl PaintTarget for D3d11PaintTarget<'_> {
    fn fill<S: Shape>(&mut self, fill: Fill, transform: Affine, color: Color, shape: &S) {
        if self.suppressed_clips > 0 {
            return;
        }
        let path = lyon_path(shape.to_path(0.1).elements().iter().copied());
        let mut tess = FillTessellator::new();
        let mut geometry: VertexBuffers<LyonPoint, u32> = VertexBuffers::new();
        let options = FillOptions::default().with_fill_rule(match fill {
            Fill::EvenOdd => FillRule::EvenOdd,
            Fill::NonZero => FillRule::NonZero,
        });
        if tess
            .tessellate_path(
                &path,
                &options,
                &mut BuffersBuilder::new(&mut geometry, |vertex: FillVertex| vertex.position()),
            )
            .is_err()
        {
            return;
        }
        let (first, count) = self.graphics.append_geometry(
            &geometry.vertices,
            &geometry.indices,
            transform,
            color.multiply_alpha(self.opacity),
            0.0,
            |_| [0.0, 0.0],
        );
        if count > 0 {
            self.graphics.commands.push(DrawCommand::Draw {
                first,
                count,
                texture: TextureRef::Solid,
            });
        }
    }

    /// Clips to `shape` and paints vertex-coloured bands between stops: the
    /// colour is linear between two stops, so the bands are exact for linear
    /// gradients and exact along each of 96 slices for radial ones.
    fn fill_gradient<S: Shape>(&mut self, transform: Affine, gradient: &PaintGradient, shape: &S) {
        if self.suppressed_clips > 0 || gradient.stops.is_empty() {
            return;
        }
        let bounds = shape.bounding_box();
        let corners = [
            Point::new(bounds.x0, bounds.y0),
            Point::new(bounds.x1, bounds.y0),
            Point::new(bounds.x1, bounds.y1),
            Point::new(bounds.x0, bounds.y1),
        ];
        let stops: Vec<(f64, Color)> = gradient
            .stops
            .iter()
            .map(|(offset, color)| (f64::from(*offset), *color))
            .collect();
        let first = stops[0].1;
        let last = stops[stops.len() - 1].1;
        // Range of the gradient parameter t the shape covers.
        let (low, high) = match gradient.geometry {
            GradientGeometry::Linear { start, end } => {
                let axis = end - start;
                let length2 = axis.hypot2().max(1e-12);
                let project = |point: &Point| (*point - start).dot(axis) / length2;
                (
                    corners.iter().map(project).fold(f64::INFINITY, f64::min),
                    corners
                        .iter()
                        .map(project)
                        .fold(f64::NEG_INFINITY, f64::max),
                )
            }
            GradientGeometry::Radial {
                center,
                radius_x,
                radius_y,
                start,
                end,
            } => {
                let (rx, ry) = (radius_x.max(1e-6), radius_y.max(1e-6));
                let span = (end - start).max(1e-9);
                let reach = corners
                    .iter()
                    .map(|p| ((p.x - center.x) / rx).hypot((p.y - center.y) / ry))
                    .fold(0.0, f64::max)
                    + 0.01;
                (-start / span, (reach - start) / span)
            }
            // The shape covers every angle: t spans one full turn.
            GradientGeometry::Conic { start, end, .. } => {
                let span = (end - start).max(1e-9);
                (-start / span, (1.0 - start) / span)
            }
        };
        let mut bands: Vec<(f64, Color, f64, Color)> = Vec::new();
        if gradient.repeat {
            let (from, to) = (low.floor() as i64, high.ceil() as i64);
            if (to - from).unsigned_abs() as usize * stops.len() > 20_000 {
                // Finer than a pixel: CSS paints the average colour.
                let mut sum = [0.0_f32; 4];
                for pair in stops.windows(2) {
                    let weight = (pair[1].0 - pair[0].0) as f32;
                    for (channel, total) in sum.iter_mut().enumerate() {
                        *total += weight
                            * (pair[0].1.components[channel] + pair[1].1.components[channel])
                            / 2.0;
                    }
                }
                self.fill(Fill::NonZero, transform, Color::new(sum), shape);
                return;
            }
            for period in from..to {
                let base = period as f64;
                for pair in stops.windows(2) {
                    bands.push((base + pair[0].0, pair[0].1, base + pair[1].0, pair[1].1));
                }
            }
        } else {
            let mut list = vec![(low.min(0.0), first)];
            list.extend(stops.iter().copied());
            list.push((high.max(1.0), last));
            for pair in list.windows(2) {
                bands.push((pair[0].0, pair[0].1, pair[1].0, pair[1].1));
            }
        }
        let mix = |a: Color, b: Color, amount: f64| {
            let amount = amount.clamp(0.0, 1.0) as f32;
            let mut out = [0.0_f32; 4];
            for (channel, value) in out.iter_mut().enumerate() {
                *value = a.components[channel]
                    + (b.components[channel] - a.components[channel]) * amount;
            }
            Color::new(out)
        };
        let mut wedges: Vec<(Point, Color)> = Vec::new();
        let mut triangles: Vec<(Point, Color)> = Vec::new();
        let mut quad = |a: Point, b: Point, c: Point, d: Point, from: Color, to: Color| {
            triangles.extend([(a, from), (b, from), (c, to), (a, from), (c, to), (d, to)]);
        };
        for (t0, c0, t1, c1) in bands {
            if t1 <= t0 || t1 < low || t0 > high {
                continue;
            }
            match gradient.geometry {
                GradientGeometry::Linear { start, end } => {
                    let axis = end - start;
                    let along = axis / axis.hypot().max(1e-12);
                    let across = vello::kurbo::Vec2::new(-along.y, along.x)
                        * (bounds.width().hypot(bounds.height()) + axis.hypot());
                    let p0 = start + axis * t0;
                    let p1 = start + axis * t1;
                    quad(p0 - across, p0 + across, p1 + across, p1 - across, c0, c1);
                }
                GradientGeometry::Radial {
                    center,
                    radius_x,
                    radius_y,
                    start,
                    end,
                } => {
                    let radius = |t: f64| start + (end - start) * t;
                    let (mut r0, r1) = (radius(t0), radius(t1));
                    if r1 <= 0.0 {
                        continue;
                    }
                    let mut c0 = c0;
                    if r0 < 0.0 {
                        c0 = mix(c0, c1, -r0 / (r1 - r0));
                        r0 = 0.0;
                    }
                    const SLICES: usize = 96;
                    let at = |r: f64, k: usize| {
                        let angle = std::f64::consts::TAU * k as f64 / SLICES as f64;
                        Point::new(
                            center.x + radius_x * r * angle.cos(),
                            center.y + radius_y * r * angle.sin(),
                        )
                    };
                    for k in 0..SLICES {
                        quad(at(r0, k), at(r0, k + 1), at(r1, k + 1), at(r1, k), c0, c1);
                    }
                }
                // Colour varies with the angle only: wedges of at most 1° from
                // the centre, split at every stop so hard stops stay exact.
                GradientGeometry::Conic {
                    center,
                    from,
                    start,
                    end,
                } => {
                    let (a, b) = (t0.max(low), t1.min(high));
                    if b <= a {
                        continue;
                    }
                    let ca = mix(c0, c1, (a - t0) / (t1 - t0));
                    let cb = mix(c0, c1, (b - t0) / (t1 - t0));
                    let turn = |t: f64| from + (start + (end - start) * t) * std::f64::consts::TAU;
                    let (angle0, angle1) = (turn(a), turn(b));
                    let reach = corners
                        .iter()
                        .map(|p| (p.x - center.x).hypot(p.y - center.y))
                        .fold(0.0, f64::max)
                        + 1.0;
                    let point = |angle: f64| {
                        Point::new(
                            center.x + reach * angle.sin(),
                            center.y - reach * angle.cos(),
                        )
                    };
                    let count = ((angle1 - angle0) / 1f64.to_radians()).ceil().max(1.0) as usize;
                    for k in 0..count {
                        let (f0, f1) = (k as f64 / count as f64, (k + 1) as f64 / count as f64);
                        let (w0, w1) = (mix(ca, cb, f0), mix(ca, cb, f1));
                        wedges.extend([
                            (center, mix(w0, w1, 0.5)),
                            (point(angle0 + (angle1 - angle0) * f0), w0),
                            (point(angle0 + (angle1 - angle0) * f1), w1),
                        ]);
                    }
                }
            }
        }
        triangles.append(&mut wedges);
        self.push_clip(Fill::NonZero, transform, shape);
        let opacity = self.opacity;
        self.graphics
            .append_colored_triangles(&triangles, transform, opacity);
        self.pop_layer();
    }

    fn stroke<S: Shape>(&mut self, stroke: &Stroke, transform: Affine, color: Color, shape: &S) {
        if self.suppressed_clips > 0 {
            return;
        }
        let source: BezPath = if stroke.dash_pattern.is_empty() {
            shape.to_path(0.1)
        } else {
            dash(
                shape.path_elements(0.1),
                stroke.dash_offset,
                &stroke.dash_pattern,
            )
            .collect()
        };
        let path = lyon_path(source.elements().iter().copied());
        let mut tess = StrokeTessellator::new();
        let mut geometry: VertexBuffers<LyonPoint, u32> = VertexBuffers::new();
        let options = StrokeOptions::default()
            .with_line_width(stroke.width as f32)
            .with_start_cap(lyon_cap(stroke.start_cap))
            .with_end_cap(lyon_cap(stroke.end_cap))
            .with_line_join(lyon_join(stroke.join));
        if tess
            .tessellate_path(
                &path,
                &options,
                &mut BuffersBuilder::new(&mut geometry, |vertex: StrokeVertex| vertex.position()),
            )
            .is_err()
        {
            return;
        }
        let (first, count) = self.graphics.append_geometry(
            &geometry.vertices,
            &geometry.indices,
            transform,
            color.multiply_alpha(self.opacity),
            0.0,
            |_| [0.0, 0.0],
        );
        if count > 0 {
            self.graphics.commands.push(DrawCommand::Draw {
                first,
                count,
                texture: TextureRef::Solid,
            });
        }
    }

    fn box_shadow(
        &mut self,
        transform: Affine,
        area: vello::kurbo::Rect,
        rect: vello::kurbo::Rect,
        color: Color,
        radius: f64,
        std_dev: f64,
        invert: bool,
    ) {
        if self.suppressed_clips > 0 {
            return;
        }
        // Node transforms are translate/scale only, so the axes stay aligned.
        let coeffs = transform.as_coeffs();
        let (scale_x, scale_y) = (coeffs[0].abs(), coeffs[3].abs());
        let scale = (scale_x * scale_y).sqrt();
        let corner = |point: Point| {
            let point = transform * point;
            [point.x as f32, point.y as f32]
        };
        let half = [
            (rect.width() * scale_x / 2.0) as f32,
            (rect.height() * scale_y / 2.0) as f32,
        ];
        self.graphics.append_shadow_quad(
            [
                corner(Point::new(area.x0, area.y0)),
                corner(Point::new(area.x1, area.y1)),
            ],
            corner(rect.center()),
            color.multiply_alpha(self.opacity),
            invert,
            [
                half[0],
                half[1],
                ((radius * scale) as f32).min(half[0].min(half[1])).max(0.0),
                ((std_dev * scale) as f32).max(0.01),
            ],
        );
    }

    fn push_clip<S: Shape>(&mut self, fill: Fill, transform: Affine, shape: &S) {
        if self.suppressed_clips > 0 || self.layers.len() >= u8::MAX as usize {
            self.layers.push(D3d11PaintLayer::Clip(None));
            self.suppressed_clips = self.suppressed_clips.saturating_add(1);
            return;
        }
        let path = lyon_path(shape.to_path(0.1).elements().iter().copied());
        let mut tess = FillTessellator::new();
        let mut geometry: VertexBuffers<LyonPoint, u32> = VertexBuffers::new();
        let options = FillOptions::default().with_fill_rule(match fill {
            Fill::EvenOdd => FillRule::EvenOdd,
            Fill::NonZero => FillRule::NonZero,
        });
        if tess
            .tessellate_path(
                &path,
                &options,
                &mut BuffersBuilder::new(&mut geometry, |vertex: FillVertex| vertex.position()),
            )
            .is_err()
        {
            self.layers.push(D3d11PaintLayer::Clip(None));
            self.suppressed_clips = self.suppressed_clips.saturating_add(1);
            return;
        }
        let (first, count) = self.graphics.append_geometry(
            &geometry.vertices,
            &geometry.indices,
            transform,
            Color::WHITE,
            0.0,
            |_| [0.0, 0.0],
        );
        if count == 0 {
            self.layers.push(D3d11PaintLayer::Clip(None));
            self.suppressed_clips = self.suppressed_clips.saturating_add(1);
            return;
        }
        self.graphics
            .commands
            .push(DrawCommand::PushClip { first, count });
        self.layers
            .push(D3d11PaintLayer::Clip(Some((first, count))));
    }

    fn push_opacity<S: Shape>(&mut self, alpha: f32, _transform: Affine, _shape: &S) {
        let previous = self.opacity;
        self.layers.push(D3d11PaintLayer::Opacity(previous));
        self.opacity = (previous * alpha.clamp(0.0, 1.0)).clamp(0.0, 1.0);
    }

    fn pop_layer(&mut self) {
        let Some(layer) = self.layers.pop() else {
            return;
        };
        match layer {
            D3d11PaintLayer::Clip(Some((first, count))) => {
                self.graphics
                    .commands
                    .push(DrawCommand::PopClip { first, count });
            }
            D3d11PaintLayer::Clip(None) => {
                self.suppressed_clips = self.suppressed_clips.saturating_sub(1);
            }
            D3d11PaintLayer::Opacity(previous) => self.opacity = previous,
        }
    }

    fn draw_image(&mut self, key: &str, image: &ImageData, transform: Affine) {
        if self.suppressed_clips > 0 {
            return;
        }
        let Some(view) = self.graphics.image_view(key, image) else {
            return;
        };
        let width = f64::from(image.width);
        let height = f64::from(image.height);
        let corners = [
            transform * Point::new(0.0, 0.0),
            transform * Point::new(width, 0.0),
            transform * Point::new(width, height),
            transform * Point::new(0.0, height),
        ];
        self.graphics.append_quad_points(
            corners.map(|point| [point.x as f32, point.y as f32]),
            [0.0, 0.0, 1.0, 1.0],
            Color::WHITE.multiply_alpha(self.opacity),
            1.0,
            TextureRef::Image(view),
        );
    }

    fn draw_glyphs(
        &mut self,
        font: &FontData,
        font_size: f32,
        normalized_coords: &[i16],
        transform: Affine,
        color: Color,
        glyphs: &[PaintGlyph],
    ) {
        if self.suppressed_clips > 0 {
            return;
        }
        let coeffs = transform.as_coeffs();
        let x_scale = (coeffs[0] * coeffs[0] + coeffs[1] * coeffs[1]).sqrt();
        let y_scale = (coeffs[2] * coeffs[2] + coeffs[3] * coeffs[3]).sqrt();
        // Atlas bitmaps are axis-aligned and uniformly scaled; any other transform
        // (a rotated canvas, skew, a squashed axis) fills the glyph outlines instead.
        if coeffs[1].abs() > 1e-6
            || coeffs[2].abs() > 1e-6
            || (x_scale - y_scale).abs() > 1e-3 * x_scale.max(y_scale)
            || coeffs[0] < 0.0
            || coeffs[3] < 0.0
        {
            for glyph in glyphs {
                if let Some(path) =
                    self.graphics
                        .glyph_outline(font, font_size, normalized_coords, glyph.id)
                {
                    let at =
                        transform * Affine::translate((f64::from(glyph.x), f64::from(glyph.y)));
                    self.fill(Fill::NonZero, at, color, &path);
                }
            }
            return;
        }
        let scale = x_scale.max(y_scale) as f32;
        let scale = scale.max(0.01);
        for glyph in glyphs {
            let baseline = transform * Point::new(f64::from(glyph.x), f64::from(glyph.y));
            let (base_x, subpixel_x) = quantize_glyph_position(baseline.x as f32);
            let (base_y, subpixel_y) = quantize_glyph_position(baseline.y as f32);
            let Some(entry) = self.graphics.glyph_entry(
                font,
                font_size,
                normalized_coords,
                glyph.id,
                subpixel_x,
                subpixel_y,
                scale,
            ) else {
                continue;
            };
            if entry.width == 0 || entry.height == 0 {
                continue;
            }
            let Some(view) = entry.view.clone() else {
                continue;
            };
            // Swash already rasterized the requested quarter-pixel offset into the
            // coverage mask. Place that bitmap on whole physical pixels so the GPU
            // does not resample the glyph a second time and soften text.
            let x0 = base_x + entry.left as f32;
            let y0 = base_y - entry.top as f32;
            let x1 = x0 + entry.width as f32;
            let y1 = y0 + entry.height as f32;
            self.graphics.append_quad_points(
                [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
                entry.uv,
                color.multiply_alpha(self.opacity),
                2.0,
                TextureRef::Glyph(view),
            );
        }
    }
}

fn hwnd(window: &Window) -> Result<HWND, String> {
    let handle = window.window_handle().map_err(|error| error.to_string())?;
    match handle.as_raw() {
        RawWindowHandle::Win32(handle) => Ok(HWND(handle.hwnd.get() as *mut c_void)),
        _ => Err("D3D11 renderer requires a Win32 window".into()),
    }
}

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
        .spawn(|| PrewarmedDevice(create_device_now()))
        .ok();
}
fn create_device() -> Result<(ID3D11Device, ID3D11DeviceContext), String> {
    let prewarmed = PREWARM.lock().ok().and_then(|mut slot| slot.take());
    match prewarmed.and_then(|handle| handle.join().ok()) {
        Some(PrewarmedDevice(result)) => result,
        None => create_device_now(),
    }
}
fn create_device_now() -> Result<(ID3D11Device, ID3D11DeviceContext), String> {
    let mut device = None;
    let mut context = None;
    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&[D3D_FEATURE_LEVEL_11_0]),
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )
    }
    .map_err(win_error)?;
    Ok((
        device.ok_or("D3D11 device was not created")?,
        context.ok_or("D3D11 immediate context was not created")?,
    ))
}

fn create_render_target(
    device: &ID3D11Device,
    swap_chain: &IDXGISwapChain1,
) -> Result<ID3D11RenderTargetView, String> {
    let backbuffer: ID3D11Texture2D = unsafe { swap_chain.GetBuffer(0) }.map_err(win_error)?;
    let mut view = None;
    unsafe { device.CreateRenderTargetView(&backbuffer, None, Some(&mut view)) }
        .map_err(win_error)?;
    view.ok_or_else(|| "D3D11 render-target view was not created".into())
}

fn choose_sample_desc(device: &ID3D11Device) -> DXGI_SAMPLE_DESC {
    for count in [8_u32, 4, 2] {
        if unsafe { device.CheckMultisampleQualityLevels(DXGI_FORMAT_B8G8R8A8_UNORM, count) }
            .is_ok_and(|levels| levels > 0)
        {
            return DXGI_SAMPLE_DESC {
                Count: count,
                Quality: 0,
            };
        }
    }
    DXGI_SAMPLE_DESC {
        Count: 1,
        Quality: 0,
    }
}

fn create_color_target(
    device: &ID3D11Device,
    swap_chain: &IDXGISwapChain1,
    width: u32,
    height: u32,
    sample_desc: DXGI_SAMPLE_DESC,
) -> Result<(Option<ID3D11Texture2D>, ID3D11RenderTargetView), String> {
    if sample_desc.Count <= 1 {
        return create_render_target(device, swap_chain).map(|view| (None, view));
    }
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: sample_desc,
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: windows::Win32::Graphics::Direct3D11::D3D11_BIND_RENDER_TARGET.0 as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };
    let mut texture = None;
    unsafe { device.CreateTexture2D(&desc, None, Some(&mut texture)) }.map_err(win_error)?;
    let texture = texture.ok_or("D3D11 multisample color texture was not created")?;
    let mut view = None;
    unsafe { device.CreateRenderTargetView(&texture, None, Some(&mut view)) }.map_err(win_error)?;
    Ok((
        Some(texture),
        view.ok_or("D3D11 multisample render-target view was not created")?,
    ))
}

fn create_depth_target(
    device: &ID3D11Device,
    width: u32,
    height: u32,
    sample_desc: DXGI_SAMPLE_DESC,
) -> Result<(ID3D11Texture2D, ID3D11DepthStencilView), String> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_D24_UNORM_S8_UINT,
        SampleDesc: sample_desc,
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: D3D11_BIND_DEPTH_STENCIL.0 as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };
    let mut texture = None;
    unsafe { device.CreateTexture2D(&desc, None, Some(&mut texture)) }.map_err(win_error)?;
    let texture = texture.ok_or("D3D11 stencil texture was not created")?;
    let mut view = None;
    unsafe { device.CreateDepthStencilView(&texture, None, Some(&mut view)) }.map_err(win_error)?;
    Ok((texture, view.ok_or("D3D11 stencil view was not created")?))
}

fn create_dynamic_buffer(
    device: &ID3D11Device,
    bytes: usize,
    bind: windows::Win32::Graphics::Direct3D11::D3D11_BIND_FLAG,
) -> Result<ID3D11Buffer, String> {
    let desc = D3D11_BUFFER_DESC {
        ByteWidth: u32::try_from(bytes.max(16)).map_err(|_| "D3D11 buffer is too large")?,
        Usage: D3D11_USAGE_DYNAMIC,
        BindFlags: bind.0 as u32,
        CPUAccessFlags: D3D11_CPU_ACCESS_WRITE.0 as u32,
        MiscFlags: 0,
        StructureByteStride: 0,
    };
    let mut buffer = None;
    unsafe { device.CreateBuffer(&desc, None, Some(&mut buffer)) }.map_err(win_error)?;
    buffer.ok_or_else(|| "D3D11 dynamic buffer was not created".into())
}

fn upload_dynamic(
    context: &ID3D11DeviceContext,
    buffer: &ID3D11Buffer,
    bytes: &[u8],
) -> Result<(), String> {
    if bytes.is_empty() {
        return Ok(());
    }
    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    unsafe { context.Map(buffer, 0, D3D11_MAP_WRITE_DISCARD, 0, Some(&mut mapped)) }
        .map_err(win_error)?;
    unsafe { ptr::copy_nonoverlapping(bytes.as_ptr(), mapped.pData as *mut u8, bytes.len()) };
    unsafe { context.Unmap(buffer, 0) };
    Ok(())
}

/// DXBC compiled from `shaders/ui.hlsl` by the ignored test
/// `regenerate_d3d11_shaders`. DXBC is hardware-independent (the driver
/// translates it when the shader is created), so shipping it skips loading
/// `d3dcompiler_47.dll` and ~20 ms of compilation on every start.
const VERTEX_SHADER: &[u8] = include_bytes!("shaders/ui.vs.dxbc");
const PIXEL_SHADER: &[u8] = include_bytes!("shaders/ui.ps.dxbc");

#[allow(clippy::manual_c_str_literals)]
fn create_shaders(
    device: &ID3D11Device,
) -> Result<(ID3D11VertexShader, ID3D11PixelShader, ID3D11InputLayout), String> {
    let vs_bytes = VERTEX_SHADER;
    let ps_bytes = PIXEL_SHADER;
    let mut vertex_shader = None;
    unsafe { device.CreateVertexShader(vs_bytes, None, Some(&mut vertex_shader)) }
        .map_err(win_error)?;
    let mut pixel_shader = None;
    unsafe { device.CreatePixelShader(ps_bytes, None, Some(&mut pixel_shader)) }
        .map_err(win_error)?;
    let elements = [
        D3D11_INPUT_ELEMENT_DESC {
            SemanticName: PCSTR(b"POSITION\0".as_ptr()),
            SemanticIndex: 0,
            Format: DXGI_FORMAT_R32G32_FLOAT,
            InputSlot: 0,
            AlignedByteOffset: 0,
            InputSlotClass: D3D11_INPUT_PER_VERTEX_DATA,
            InstanceDataStepRate: 0,
        },
        D3D11_INPUT_ELEMENT_DESC {
            SemanticName: PCSTR(b"TEXCOORD\0".as_ptr()),
            SemanticIndex: 0,
            Format: DXGI_FORMAT_R32G32_FLOAT,
            InputSlot: 0,
            AlignedByteOffset: 8,
            InputSlotClass: D3D11_INPUT_PER_VERTEX_DATA,
            InstanceDataStepRate: 0,
        },
        D3D11_INPUT_ELEMENT_DESC {
            SemanticName: PCSTR(b"COLOR\0".as_ptr()),
            SemanticIndex: 0,
            Format: DXGI_FORMAT_R32G32B32A32_FLOAT,
            InputSlot: 0,
            AlignedByteOffset: 16,
            InputSlotClass: D3D11_INPUT_PER_VERTEX_DATA,
            InstanceDataStepRate: 0,
        },
        D3D11_INPUT_ELEMENT_DESC {
            SemanticName: PCSTR(b"TEXCOORD\0".as_ptr()),
            SemanticIndex: 1,
            Format: DXGI_FORMAT_R32_FLOAT,
            InputSlot: 0,
            AlignedByteOffset: 32,
            InputSlotClass: D3D11_INPUT_PER_VERTEX_DATA,
            InstanceDataStepRate: 0,
        },
        D3D11_INPUT_ELEMENT_DESC {
            SemanticName: PCSTR(b"TEXCOORD\0".as_ptr()),
            SemanticIndex: 2,
            Format: DXGI_FORMAT_R32G32B32A32_FLOAT,
            InputSlot: 0,
            AlignedByteOffset: 36,
            InputSlotClass: D3D11_INPUT_PER_VERTEX_DATA,
            InstanceDataStepRate: 0,
        },
    ];
    let mut layout = None;
    unsafe { device.CreateInputLayout(&elements, vs_bytes, Some(&mut layout)) }
        .map_err(win_error)?;
    Ok((
        vertex_shader.ok_or("D3D11 vertex shader was not created")?,
        pixel_shader.ok_or("D3D11 pixel shader was not created")?,
        layout.ok_or("D3D11 input layout was not created")?,
    ))
}

#[cfg(test)]
fn compile_shader(
    source: &str,
    entry: &[u8],
    target: &[u8],
) -> Result<windows::Win32::Graphics::Direct3D::ID3DBlob, String> {
    let mut code = None;
    let mut errors = None;
    let result = unsafe {
        windows::Win32::Graphics::Direct3D::Fxc::D3DCompile(
            source.as_ptr().cast(),
            source.len(),
            PCSTR::null(),
            None,
            None,
            PCSTR(entry.as_ptr()),
            PCSTR(target.as_ptr()),
            0,
            0,
            &mut code,
            Some(&mut errors),
        )
    };
    result.map_err(|error| {
        errors.map_or_else(
            || error.to_string(),
            |blob| String::from_utf8_lossy(blob_bytes(&blob)).into_owned(),
        )
    })?;
    code.ok_or_else(|| "D3D shader compiler returned no bytecode".into())
}

#[cfg(test)]
fn blob_bytes(blob: &windows::Win32::Graphics::Direct3D::ID3DBlob) -> &[u8] {
    unsafe {
        std::slice::from_raw_parts(blob.GetBufferPointer() as *const u8, blob.GetBufferSize())
    }
}

fn create_sampler(
    device: &ID3D11Device,
    filter: windows::Win32::Graphics::Direct3D11::D3D11_FILTER,
) -> Result<ID3D11SamplerState, String> {
    let desc = D3D11_SAMPLER_DESC {
        Filter: filter,
        AddressU: D3D11_TEXTURE_ADDRESS_CLAMP,
        AddressV: D3D11_TEXTURE_ADDRESS_CLAMP,
        AddressW: D3D11_TEXTURE_ADDRESS_CLAMP,
        MipLODBias: 0.0,
        MaxAnisotropy: 1,
        ComparisonFunc: windows::Win32::Graphics::Direct3D11::D3D11_COMPARISON_ALWAYS,
        BorderColor: [0.0; 4],
        MinLOD: 0.0,
        MaxLOD: f32::MAX,
    };
    let mut state = None;
    unsafe { device.CreateSamplerState(&desc, Some(&mut state)) }.map_err(win_error)?;
    state.ok_or_else(|| "D3D11 sampler was not created".into())
}

fn create_rasterizer(
    device: &ID3D11Device,
    multisampled: bool,
) -> Result<ID3D11RasterizerState, String> {
    let desc = D3D11_RASTERIZER_DESC {
        FillMode: windows::Win32::Graphics::Direct3D11::D3D11_FILL_SOLID,
        CullMode: D3D11_CULL_NONE,
        FrontCounterClockwise: false.into(),
        DepthBias: 0,
        DepthBiasClamp: 0.0,
        SlopeScaledDepthBias: 0.0,
        DepthClipEnable: true.into(),
        ScissorEnable: false.into(),
        MultisampleEnable: multisampled.into(),
        AntialiasedLineEnable: false.into(),
    };
    let mut state = None;
    unsafe { device.CreateRasterizerState(&desc, Some(&mut state)) }.map_err(win_error)?;
    state.ok_or_else(|| "D3D11 rasterizer state was not created".into())
}

fn create_blend(device: &ID3D11Device, write_color: bool) -> Result<ID3D11BlendState, String> {
    let mut targets = [D3D11_RENDER_TARGET_BLEND_DESC::default(); 8];
    targets[0] = D3D11_RENDER_TARGET_BLEND_DESC {
        BlendEnable: true.into(),
        SrcBlend: D3D11_BLEND_SRC_ALPHA,
        DestBlend: D3D11_BLEND_INV_SRC_ALPHA,
        BlendOp: D3D11_BLEND_OP_ADD,
        SrcBlendAlpha: D3D11_BLEND_ONE,
        DestBlendAlpha: D3D11_BLEND_INV_SRC_ALPHA,
        BlendOpAlpha: D3D11_BLEND_OP_ADD,
        RenderTargetWriteMask: if write_color {
            D3D11_COLOR_WRITE_ENABLE_ALL.0 as u8
        } else {
            0
        },
    };
    let desc = D3D11_BLEND_DESC {
        AlphaToCoverageEnable: false.into(),
        IndependentBlendEnable: false.into(),
        RenderTarget: targets,
    };
    let mut state = None;
    unsafe { device.CreateBlendState(&desc, Some(&mut state)) }.map_err(win_error)?;
    state.ok_or_else(|| "D3D11 blend state was not created".into())
}

fn create_stencil(
    device: &ID3D11Device,
    pass: windows::Win32::Graphics::Direct3D11::D3D11_STENCIL_OP,
) -> Result<ID3D11DepthStencilState, String> {
    let face = windows::Win32::Graphics::Direct3D11::D3D11_DEPTH_STENCILOP_DESC {
        StencilFailOp: D3D11_STENCIL_OP_KEEP,
        StencilDepthFailOp: D3D11_STENCIL_OP_KEEP,
        StencilPassOp: pass,
        StencilFunc: D3D11_COMPARISON_EQUAL,
    };
    let desc = D3D11_DEPTH_STENCIL_DESC {
        DepthEnable: false.into(),
        DepthWriteMask: D3D11_DEPTH_WRITE_MASK_ZERO,
        DepthFunc: windows::Win32::Graphics::Direct3D11::D3D11_COMPARISON_ALWAYS,
        StencilEnable: true.into(),
        StencilReadMask: 0xff,
        StencilWriteMask: 0xff,
        FrontFace: face,
        BackFace: face,
    };
    let mut state = None;
    unsafe { device.CreateDepthStencilState(&desc, Some(&mut state)) }.map_err(win_error)?;
    state.ok_or_else(|| "D3D11 stencil state was not created".into())
}

fn create_glyph_atlas(device: &ID3D11Device) -> Result<GlyphAtlas, String> {
    let zeros = vec![0_u8; (GLYPH_ATLAS_SIZE * GLYPH_ATLAS_SIZE) as usize];
    let desc = D3D11_TEXTURE2D_DESC {
        Width: GLYPH_ATLAS_SIZE,
        Height: GLYPH_ATLAS_SIZE,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_R8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };
    let data = D3D11_SUBRESOURCE_DATA {
        pSysMem: zeros.as_ptr().cast(),
        SysMemPitch: GLYPH_ATLAS_SIZE,
        SysMemSlicePitch: 0,
    };
    let mut texture = None;
    unsafe { device.CreateTexture2D(&desc, Some(&data), Some(&mut texture)) }.map_err(win_error)?;
    let texture = texture.ok_or("D3D11 glyph atlas texture was not created")?;
    let mut view = None;
    unsafe { device.CreateShaderResourceView(&texture, None, Some(&mut view)) }
        .map_err(win_error)?;
    Ok(GlyphAtlas {
        _texture: texture,
        view: view.ok_or("D3D11 glyph atlas view was not created")?,
        x: 0,
        y: 0,
        row_height: 0,
    })
}

fn create_r8_texture(
    device: &ID3D11Device,
    width: u32,
    height: u32,
    pixels: &[u8],
) -> Result<ID3D11ShaderResourceView, String> {
    if width == 0 || height == 0 || pixels.len() != width as usize * height as usize {
        return Err("Invalid D3D11 glyph texture dimensions".into());
    }
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_R8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_IMMUTABLE,
        BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };
    let data = D3D11_SUBRESOURCE_DATA {
        pSysMem: pixels.as_ptr().cast(),
        SysMemPitch: width,
        SysMemSlicePitch: 0,
    };
    let mut texture = None;
    unsafe { device.CreateTexture2D(&desc, Some(&data), Some(&mut texture)) }.map_err(win_error)?;
    let texture = texture.ok_or("D3D11 glyph fallback texture was not created")?;
    let mut view = None;
    unsafe { device.CreateShaderResourceView(&texture, None, Some(&mut view)) }
        .map_err(win_error)?;
    view.ok_or_else(|| "D3D11 glyph fallback view was not created".into())
}

fn update_r8_texture(
    context: &ID3D11DeviceContext,
    texture: &ID3D11Texture2D,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    data: &[u8],
) {
    let region = windows::Win32::Graphics::Direct3D11::D3D11_BOX {
        left: x,
        top: y,
        front: 0,
        right: x + width,
        bottom: y + height,
        back: 1,
    };
    unsafe { context.UpdateSubresource(texture, 0, Some(&region), data.as_ptr().cast(), width, 0) };
}

fn create_rgba_texture(
    device: &ID3D11Device,
    width: u32,
    height: u32,
    pixels: &[u8],
    signature: (u64, u32, u32, ImageFormat, ImageAlphaType),
) -> Result<CachedImage, String> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width.max(1),
        Height: height.max(1),
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_R8G8B8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_IMMUTABLE,
        BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };
    let data = D3D11_SUBRESOURCE_DATA {
        pSysMem: pixels.as_ptr().cast(),
        SysMemPitch: width.max(1) * 4,
        SysMemSlicePitch: 0,
    };
    let mut texture = None;
    unsafe { device.CreateTexture2D(&desc, Some(&data), Some(&mut texture)) }.map_err(win_error)?;
    let texture = texture.ok_or("D3D11 image texture was not created")?;
    let mut view = None;
    unsafe { device.CreateShaderResourceView(&texture, None, Some(&mut view)) }
        .map_err(win_error)?;
    Ok(CachedImage {
        _texture: texture,
        view: view.ok_or("D3D11 image view was not created")?,
        signature,
    })
}

fn image_rgba(image: &ImageData) -> Option<Vec<u8>> {
    let source = image.data.data();
    if source.len() != image.width as usize * image.height as usize * 4 {
        return None;
    }
    let mut pixels = Vec::with_capacity(source.len());
    for px in source.as_chunks::<4>().0 {
        let (mut r, mut g, mut b, a) = match image.format {
            ImageFormat::Rgba8 => (px[0], px[1], px[2], px[3]),
            ImageFormat::Bgra8 => (px[2], px[1], px[0], px[3]),
            _ => return None,
        };
        if image.alpha_type == ImageAlphaType::AlphaPremultiplied && a > 0 {
            let unpremul = |channel: u8| -> u8 {
                ((u32::from(channel) * 255 + u32::from(a) / 2) / u32::from(a)).min(255) as u8
            };
            r = unpremul(r);
            g = unpremul(g);
            b = unpremul(b);
        }
        pixels.extend_from_slice(&[r, g, b, a]);
    }
    Some(pixels)
}

fn lyon_path(elements: impl IntoIterator<Item = PathEl>) -> LyonPath {
    let mut builder = LyonPath::builder();
    let mut open = false;
    for element in elements {
        match element {
            PathEl::MoveTo(p) => {
                if open {
                    builder.end(false);
                }
                builder.begin(point(p.x as f32, p.y as f32));
                open = true;
            }
            PathEl::LineTo(p) => {
                builder.line_to(point(p.x as f32, p.y as f32));
            }
            PathEl::QuadTo(p1, p2) => {
                builder.quadratic_bezier_to(
                    point(p1.x as f32, p1.y as f32),
                    point(p2.x as f32, p2.y as f32),
                );
            }
            PathEl::CurveTo(p1, p2, p3) => {
                builder.cubic_bezier_to(
                    point(p1.x as f32, p1.y as f32),
                    point(p2.x as f32, p2.y as f32),
                    point(p3.x as f32, p3.y as f32),
                );
            }
            PathEl::ClosePath => {
                if open {
                    builder.end(true);
                    open = false;
                }
            }
        }
    }
    if open {
        builder.end(false);
    }
    builder.build()
}

fn lyon_cap(cap: Cap) -> LineCap {
    match cap {
        Cap::Butt => LineCap::Butt,
        Cap::Square => LineCap::Square,
        Cap::Round => LineCap::Round,
    }
}

fn lyon_join(join: Join) -> LineJoin {
    match join {
        Join::Bevel => LineJoin::Bevel,
        Join::Miter => LineJoin::Miter,
        Join::Round => LineJoin::Round,
    }
}

fn rgba(color: Color) -> [f32; 4] {
    let c = color.to_rgba8();
    [
        f32::from(c.r) / 255.0,
        f32::from(c.g) / 255.0,
        f32::from(c.b) / 255.0,
        f32::from(c.a) / 255.0,
    ]
}

fn win_error(error: windows::core::Error) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::quantize_glyph_position;

    #[test]
    fn glyph_subpixel_quantization_carries_into_the_next_pixel() {
        assert_eq!(quantize_glyph_position(10.10), (10.0, 0));
        assert_eq!(quantize_glyph_position(10.24), (10.0, 1));
        assert_eq!(quantize_glyph_position(10.51), (10.0, 2));
        assert_eq!(quantize_glyph_position(10.74), (10.0, 3));
        assert_eq!(quantize_glyph_position(10.90), (11.0, 0));
    }

    #[test]
    fn glyph_subpixel_quantization_handles_negative_positions() {
        assert_eq!(quantize_glyph_position(-0.10), (0.0, 0));
        assert_eq!(quantize_glyph_position(-0.24), (-1.0, 3));
        assert_eq!(quantize_glyph_position(-0.51), (-1.0, 2));
        assert_eq!(quantize_glyph_position(-0.90), (-1.0, 0));
    }
}

#[cfg(test)]
mod shader_tests {
    use super::*;

    const SOURCE: &str = include_str!("shaders/ui.hlsl");
    const SOURCE_HASH: &str = include_str!("shaders/ui.hlsl.fnv");

    /// FNV-1a over the HLSL with line endings normalized, so a CRLF checkout
    /// hashes the same as an LF one.
    fn source_hash() -> String {
        let hash = SOURCE
            .replace("\r\n", "\n")
            .bytes()
            .fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
                (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3)
            });
        format!("{hash:016x}")
    }

    #[test]
    fn d3d11_shader_bytecode_matches_hlsl_source() {
        assert_eq!(
            SOURCE_HASH.trim(),
            source_hash(),
            "shaders/ui.hlsl changed without regenerating its bytecode; run \
             `cargo test --lib regenerate_d3d11_shaders -- --ignored`"
        );
        for (name, bytes) in [("vertex", VERTEX_SHADER), ("pixel", PIXEL_SHADER)] {
            assert!(
                bytes.starts_with(b"DXBC"),
                "{name} shader is not DXBC bytecode"
            );
        }
    }

    #[test]
    #[ignore = "writes shaders/*.dxbc; run after editing shaders/ui.hlsl"]
    fn regenerate_d3d11_shaders() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/shaders");
        for (entry, target, file) in [
            (&b"vs_main\0"[..], &b"vs_5_0\0"[..], "ui.vs.dxbc"),
            (&b"ps_main\0"[..], &b"ps_5_0\0"[..], "ui.ps.dxbc"),
        ] {
            let blob = compile_shader(SOURCE, entry, target).unwrap();
            std::fs::write(dir.join(file), blob_bytes(&blob)).unwrap();
        }
        std::fs::write(dir.join("ui.hlsl.fnv"), format!("{}\n", source_hash())).unwrap();
    }
}
