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
    /// Window position in device pixels (set by `push_vertex`).
    dev: [f32; 2],
    /// Antialiased rounded clip in device pixels (x0, y0, x1, y1); x0 > x1: none.
    clip: [f32; 4],
    /// Its corner radii: top-left, top-right, bottom-right, bottom-left.
    clip_radii: [f32; 4],
    /// Device pixels to the clip's own space: x' = a x + c y + e, y' = b x + d y + f,
    /// as (a, b, c, d) and (e, f, pixels per clip unit, 0). Rotated clips stay exact.
    clip_m0: [f32; 4],
    clip_m1: [f32; 4],
}

/// A clip the pixel shader applies: rectangle and radii in its own space, and
/// the map from device pixels into that space.
#[derive(Clone, Copy, PartialEq, Debug)]
struct ShaderClip {
    rect: [f32; 4],
    radii: [f32; 4],
    m0: [f32; 4],
    m1: [f32; 4],
}

impl ShaderClip {
    const IDENTITY_M0: [f32; 4] = [1.0, 0.0, 0.0, 1.0];
    const IDENTITY_M1: [f32; 4] = [0.0, 0.0, 1.0, 0.0];

    fn device(rect: [f32; 4], radii: [f32; 4]) -> Self {
        Self {
            rect,
            radii,
            m0: Self::IDENTITY_M0,
            m1: Self::IDENTITY_M1,
        }
    }

    fn axis_aligned(&self) -> bool {
        self.m0 == Self::IDENTITY_M0 && self.m1 == Self::IDENTITY_M1
    }
}

/// No analytic clip.
const NO_CLIP: ShaderClip = ShaderClip {
    rect: [1.0, 1.0, -1.0, -1.0],
    radii: [0.0; 4],
    m0: ShaderClip::IDENTITY_M0,
    m1: ShaderClip::IDENTITY_M1,
};

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

/// Edge of the square MSAA tile. 8x MSAA stores 8 colour and 8 depth-stencil
/// samples per pixel (64 bytes); a window-sized target took ~240 MB at 2560×1400.
/// Rendering through one 256px tile (~4 MB) and resolving each into a cached
/// frame keeps 8x quality at a fixed cost, and lets an unchanged tile be skipped.
/// 256 measured ~40% less GPU time than 512 on hover redraws; 128 saved no more
/// GPU time and doubled the CPU cost of hashing and replaying.
const MSAA_TILE: u32 = 256;

struct MsaaTile {
    color: ID3D11Texture2D,
    color_view: ID3D11RenderTargetView,
    resolved: ID3D11Texture2D,
    depth_view: ID3D11DepthStencilView,
}

pub(crate) struct D3d11Graphics {
    /// The innermost antialiased (shader-computed) rounded clip, stamped on vertices.
    clip: ShaderClip,
    /// No MSAA (the default, `msaa: 0`): shapes get a one-pixel coverage fringe
    /// instead, without multisampled targets (~30 MB less on Intel).
    analytic_aa: bool,
    _window: Arc<Window>,
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    swap_chain: IDXGISwapChain1,
    /// The swapchain's back buffer.
    render_target: Option<ID3D11RenderTargetView>,
    /// With MSAA, frames render tile by tile through this fixed-size target.
    tile: Option<MsaaTile>,
    /// Last resolved frame. Tiles whose commands hash the same as last frame
    /// are not redrawn; a hover or a caret blink repaints only its own tiles.
    frame_cache: Option<ID3D11Texture2D>,
    tile_hashes: Vec<u64>,
    /// Window-sized stencil, single-sample path only.
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
    /// Vertex-shader `scale.xy, offset.zw` that maps window NDC into the
    /// current render target (identity, or one MSAA tile).
    target_transform: ID3D11Buffer,
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
    /// Textures whose CPU pixels were released: kept even when off screen.
    pinned_images: HashSet<String>,
    uploaded_images: Vec<String>,
    missing_images: Vec<String>,
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
    /// A rounded clip the pixel shader applies; holds the clip it replaced.
    /// A clip the pixel shader applies; holds the clip it replaced and, when
    /// that one moved to the stencil to make room, its stencil geometry.
    AnalyticClip(ShaderClip, Option<(u32, u32)>),
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

        let samples = msaa_samples();
        let analytic_aa = samples <= 1;
        let sample_desc = if analytic_aa {
            DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            }
        } else {
            choose_sample_desc(&device, samples)
        };
        let render_target = create_render_target(&device, &swap_chain)?;
        let (tile, depth_view) = if sample_desc.Count > 1 {
            (Some(create_msaa_tile(&device, sample_desc)?), None)
        } else {
            let (_, view) = create_depth_target(&device, width, height, sample_desc)?;
            (None, Some(view))
        };

        let (vertex_shader, pixel_shader, input_layout) = create_shaders(&device)?;

        let image_sampler = create_sampler(&device, D3D11_FILTER_MIN_MAG_MIP_LINEAR)?;
        let glyph_sampler = create_sampler(&device, D3D11_FILTER_MIN_MAG_MIP_POINT)?;
        let rasterizer = create_rasterizer(&device, sample_desc.Count > 1)?;
        let blend = create_blend(&device, true)?;
        let clip_blend = create_blend(&device, false)?;
        let stencil_draw = create_stencil(&device, D3D11_STENCIL_OP_KEEP)?;
        let stencil_push = create_stencil(&device, D3D11_STENCIL_OP_INCR_SAT)?;
        let stencil_pop = create_stencil(&device, D3D11_STENCIL_OP_DECR_SAT)?;
        let target_transform = create_dynamic_buffer(
            &device,
            16,
            windows::Win32::Graphics::Direct3D11::D3D11_BIND_CONSTANT_BUFFER,
        )?;
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
            clip: NO_CLIP,
            analytic_aa,
            _window: window,
            device,
            context,
            swap_chain,
            render_target: Some(render_target),
            tile,
            frame_cache: None,
            tile_hashes: Vec::new(),
            depth_view,
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
            target_transform,
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
            pinned_images: HashSet::new(),
            uploaded_images: Vec::new(),
            missing_images: Vec::new(),
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
        self.clip = NO_CLIP;
        self.indices.clear();
        self.commands.clear();
        self.used_images.clear();
        if self.glyph_atlas_exhausted {
            self.tile_hashes.clear();
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
        let images = self.images.len();
        self.images
            .retain(|key, _| self.used_images.contains(key) || self.pinned_images.contains(key));
        if self.images.len() != images {
            self.tile_hashes.clear();
        }
        self.prepared = true;
        Ok(())
    }

    /// Images uploaded and images missing their pixels since the last call.
    pub(crate) fn take_image_residency(&mut self) -> (Vec<String>, Vec<String>) {
        (
            std::mem::take(&mut self.uploaded_images),
            std::mem::take(&mut self.missing_images),
        )
    }

    pub(crate) fn pin_images<'a>(&mut self, keys: impl IntoIterator<Item = &'a String>) {
        self.pinned_images = keys.into_iter().cloned().collect();
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
        self.depth_view.take();
        self.frame_cache.take();
        self.tile_hashes.clear();
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
        self.render_target = Some(create_render_target(&self.device, &self.swap_chain)?);
        if self.tile.is_none() {
            let (_, view) = create_depth_target(&self.device, width, height, self.sample_desc)?;
            self.depth_view = Some(view);
        }
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
        let bg = rgba(background);
        unsafe {
            self.context.RSSetState(&self.rasterizer);
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
            self.context
                .VSSetConstantBuffers(0, Some(&[Some(self.target_transform.clone())]));
            self.context.PSSetShader(&self.pixel_shader, None);
        }
        let clear_stencil = windows::Win32::Graphics::Direct3D11::D3D11_CLEAR_STENCIL.0;
        if self.tile.is_none() {
            let render_target = self
                .render_target
                .as_ref()
                .ok_or("D3D11 render target is unavailable")?;
            let depth_view = self
                .depth_view
                .as_ref()
                .ok_or("D3D11 stencil target is unavailable")?;
            upload_dynamic(
                &self.context,
                &self.target_transform,
                bytemuck::cast_slice(&[1.0_f32, 1.0, 0.0, 0.0]),
            )?;
            unsafe {
                self.context.ClearRenderTargetView(render_target, &bg);
                self.context
                    .ClearDepthStencilView(depth_view, clear_stencil, 1.0, 0);
                self.context
                    .OMSetRenderTargets(Some(&[Some(render_target.clone())]), Some(depth_view));
            }
            self.set_viewport(self.width, self.height);
            self.replay(None, &[]);
            unsafe { self.context.PSSetShaderResources(0, Some(&[None])) };
            return Ok(());
        }
        // Each tile replays the commands that touch it. The vertex shader maps window
        // NDC onto the tile (scale W/T, H/T plus an offset) so the viewport stays the
        // tile itself; a negative viewport origin hung Intel's driver on some scenes.
        let bounds = self.command_bounds();
        let command_hashes = self.command_hashes();
        let backbuffer: ID3D11Texture2D =
            unsafe { self.swap_chain.GetBuffer(0) }.map_err(win_error)?;
        if self.frame_cache.is_none() {
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            unsafe { backbuffer.GetDesc(&mut desc) };
            desc.BindFlags = 0;
            desc.MiscFlags = 0;
            let mut cache = None;
            unsafe { self.device.CreateTexture2D(&desc, None, Some(&mut cache)) }
                .map_err(win_error)?;
            self.frame_cache = Some(cache.ok_or("D3D11 frame cache was not created")?);
            self.tile_hashes.clear();
        }
        let columns = self.width.div_ceil(MSAA_TILE) as usize;
        let tiles = columns * self.height.div_ceil(MSAA_TILE) as usize;
        if self.tile_hashes.len() != tiles {
            self.tile_hashes = vec![0; tiles];
        }
        let size = MSAA_TILE as f32;
        let mut hashes = std::mem::take(&mut self.tile_hashes);
        let (Some(tile), Some(cache)) = (&self.tile, &self.frame_cache) else {
            return Err("D3D11 MSAA tile is unavailable".into());
        };
        self.set_viewport(MSAA_TILE, MSAA_TILE);
        for y in (0..self.height).step_by(MSAA_TILE as usize) {
            for x in (0..self.width).step_by(MSAA_TILE as usize) {
                let (left, top) = (x as f32, y as f32);
                let area = [left, top, left + size, top + size];
                let slot = (y / MSAA_TILE) as usize * columns + (x / MSAA_TILE) as usize;
                let hash = self.tile_hash(area, &bounds, &command_hashes, bg);
                if hashes[slot] == hash {
                    continue;
                }
                hashes[slot] = hash;
                let transform = tile_transform(self.width, self.height, x, y);
                upload_dynamic(
                    &self.context,
                    &self.target_transform,
                    bytemuck::cast_slice(&transform),
                )?;
                unsafe {
                    self.context.OMSetRenderTargets(
                        Some(&[Some(tile.color_view.clone())]),
                        Some(&tile.depth_view),
                    );
                    self.context.ClearRenderTargetView(&tile.color_view, &bg);
                    self.context
                        .ClearDepthStencilView(&tile.depth_view, clear_stencil, 1.0, 0);
                }
                self.replay(Some(area), &bounds);
                let region = windows::Win32::Graphics::Direct3D11::D3D11_BOX {
                    left: 0,
                    top: 0,
                    front: 0,
                    right: MSAA_TILE.min(self.width - x),
                    bottom: MSAA_TILE.min(self.height - y),
                    back: 1,
                };
                unsafe {
                    self.context.OMSetRenderTargets(None, None);
                    self.context.ResolveSubresource(
                        &tile.resolved,
                        0,
                        &tile.color,
                        0,
                        DXGI_FORMAT_B8G8R8A8_UNORM,
                    );
                    self.context.CopySubresourceRegion(
                        cache,
                        0,
                        x,
                        y,
                        0,
                        &tile.resolved,
                        0,
                        Some(&region),
                    );
                }
            }
        }
        unsafe {
            self.context.PSSetShaderResources(0, Some(&[None]));
            self.context.CopyResource(&backbuffer, cache);
        }
        self.tile_hashes = hashes;
        Ok(())
    }

    /// One hash per command over what it draws (kind, texture, vertices),
    /// computed once per frame; tiles then combine only the visible ones.
    fn command_hashes(&self) -> Vec<u64> {
        self.commands
            .iter()
            .map(|command| {
                let (tag, first, count, texture) = match command {
                    DrawCommand::Draw {
                        first,
                        count,
                        texture,
                    } => (
                        0_u64,
                        *first,
                        *count,
                        match texture {
                            TextureRef::Solid => 0,
                            TextureRef::Glyph(view) | TextureRef::Image(view) => {
                                windows::core::Interface::as_raw(view) as u64
                            }
                        },
                    ),
                    DrawCommand::PushClip { first, count } => (1, *first, *count, 0),
                    DrawCommand::PopClip { first, count } => (2, *first, *count, 0),
                };
                let mut hash = mix_hash(mix_hash(mix_hash(0, tag), texture), u64::from(count));
                for &vertex in &self.indices[first as usize..(first + count) as usize] {
                    let words: &[u32] =
                        bytemuck::cast_slice(bytemuck::bytes_of(&self.vertices[vertex as usize]));
                    for word in words {
                        hash = mix_hash(hash, u64::from(*word));
                    }
                }
                hash
            })
            .collect()
    }

    /// What one tile would draw: the visible commands in order with their
    /// stencil depth, plus the clear colour. Equal hashes mean equal pixels, so
    /// the cached tile is reused. Never zero, so a fresh cache entry misses.
    fn tile_hash(
        &self,
        area: [f32; 4],
        bounds: &[[f32; 4]],
        command_hashes: &[u64],
        background: [f32; 4],
    ) -> u64 {
        let mut hash = 0_u64;
        for channel in background {
            hash = mix_hash(hash, u64::from(channel.to_bits()));
        }
        let mut clip_depth = 0_u64;
        for (index, command) in self.commands.iter().enumerate() {
            let b = bounds[index];
            if b[0] < area[2] && b[2] > area[0] && b[1] < area[3] && b[3] > area[1] {
                hash = mix_hash(mix_hash(hash, clip_depth), command_hashes[index]);
            }
            match command {
                DrawCommand::PushClip { .. } => clip_depth += 1,
                DrawCommand::PopClip { .. } => clip_depth = clip_depth.saturating_sub(1),
                DrawCommand::Draw { .. } => {}
            }
        }
        hash.max(1)
    }

    fn set_viewport(&self, width: u32, height: u32) {
        unsafe {
            self.context.RSSetViewports(Some(&[D3D11_VIEWPORT {
                TopLeftX: 0.0,
                TopLeftY: 0.0,
                Width: width as f32,
                Height: height as f32,
                MinDepth: 0.0,
                MaxDepth: 1.0,
            }]));
        }
    }

    /// Window-pixel bounds of each command's triangles, one pixel wider for
    /// antialiased edges.
    fn command_bounds(&self) -> Vec<[f32; 4]> {
        let (width, height) = (self.width as f32, self.height as f32);
        // A draw inside a stencil clip can only touch the clip's pixels.
        let mut clips: Vec<[f32; 4]> = Vec::new();
        self.commands
            .iter()
            .map(|command| {
                let (DrawCommand::Draw { first, count, .. }
                | DrawCommand::PushClip { first, count }
                | DrawCommand::PopClip { first, count }) = command;
                let mut bounds = [f32::MAX, f32::MAX, f32::MIN, f32::MIN];
                for &index in &self.indices[*first as usize..(*first + *count) as usize] {
                    let [nx, ny] = self.vertices[index as usize].pos;
                    let x = (nx + 1.0) * 0.5 * width;
                    let y = (1.0 - ny) * 0.5 * height;
                    bounds = [
                        bounds[0].min(x),
                        bounds[1].min(y),
                        bounds[2].max(x),
                        bounds[3].max(y),
                    ];
                }
                let mut bounds = [
                    bounds[0] - 1.0,
                    bounds[1] - 1.0,
                    bounds[2] + 1.0,
                    bounds[3] + 1.0,
                ];
                if let Some(clip) = clips.last() {
                    bounds = [
                        bounds[0].max(clip[0]),
                        bounds[1].max(clip[1]),
                        bounds[2].min(clip[2]),
                        bounds[3].min(clip[3]),
                    ];
                }
                match command {
                    DrawCommand::PushClip { .. } => clips.push(bounds),
                    DrawCommand::PopClip { .. } => {
                        clips.pop();
                    }
                    DrawCommand::Draw { .. } => {}
                }
                bounds
            })
            .collect()
    }

    /// Issues the frame's commands. With an `area`, commands whose bounds miss it
    /// are skipped; a skipped clip still moves the stencil depth, so whatever it
    /// would have clipped stays hidden in this tile.
    fn replay(&self, area: Option<[f32; 4]>, bounds: &[[f32; 4]]) {
        let visible = |index: usize| {
            area.is_none_or(|area| {
                let b = bounds[index];
                b[0] < area[2] && b[2] > area[0] && b[1] < area[3] && b[3] > area[1]
            })
        };
        // Consecutive draws with the same texture occupy contiguous index
        // ranges, so a run of them is one DrawIndexed. Draws outside this tile
        // inside a run are harmless: the viewport clips them. State is only set
        // when it changes; a UI frame drops from hundreds of calls to a few.
        #[derive(Clone, Copy, PartialEq)]
        enum State {
            Draw(u32),
            Push(u32),
            Pop(u32),
        }
        let mut state: Option<State> = None;
        let mut bound_texture: Option<usize> = None;
        let mut batch: Option<(u32, u32, usize)> = None;
        let flush = |batch: &mut Option<(u32, u32, usize)>| {
            if let Some((first, count, _)) = batch.take() {
                unsafe { self.context.DrawIndexed(count, first, 0) };
            }
        };
        let set_state = |next: State, state: &mut Option<State>| {
            if *state == Some(next) {
                return;
            }
            let (blend, stencil, depth) = match next {
                State::Draw(depth) => (&self.blend, &self.stencil_draw, depth),
                State::Push(depth) => (&self.clip_blend, &self.stencil_push, depth),
                State::Pop(depth) => (&self.clip_blend, &self.stencil_pop, depth),
            };
            unsafe {
                self.context
                    .OMSetBlendState(Some(blend), Some(&[0.0, 0.0, 0.0, 0.0]), u32::MAX);
                self.context.OMSetDepthStencilState(Some(stencil), depth);
            }
            *state = Some(next);
        };
        let mut clip_depth = 0_u32;
        for (index, command) in self.commands.iter().enumerate() {
            match command {
                DrawCommand::Draw {
                    first,
                    count,
                    texture,
                } => {
                    let key = match texture {
                        TextureRef::Solid => 0,
                        TextureRef::Glyph(view) | TextureRef::Image(view) => {
                            windows::core::Interface::as_raw(view) as usize
                        }
                    };
                    if let Some((batch_first, batch_count, batch_key)) = &mut batch
                        && *batch_key == key
                        && *batch_first + *batch_count == *first
                    {
                        *batch_count += *count;
                        continue;
                    }
                    if !visible(index) {
                        continue;
                    }
                    flush(&mut batch);
                    set_state(State::Draw(clip_depth), &mut state);
                    if bound_texture != Some(key) {
                        unsafe {
                            match texture {
                                TextureRef::Solid => {
                                    self.context.PSSetShaderResources(0, Some(&[None]))
                                }
                                TextureRef::Glyph(view) => {
                                    self.context.PSSetSamplers(
                                        0,
                                        Some(&[Some(self.glyph_sampler.clone())]),
                                    );
                                    self.context
                                        .PSSetShaderResources(0, Some(&[Some(view.clone())]));
                                }
                                TextureRef::Image(view) => {
                                    self.context.PSSetSamplers(
                                        0,
                                        Some(&[Some(self.image_sampler.clone())]),
                                    );
                                    self.context
                                        .PSSetShaderResources(0, Some(&[Some(view.clone())]));
                                }
                            }
                        }
                        bound_texture = Some(key);
                    }
                    batch = Some((*first, *count, key));
                }
                DrawCommand::PushClip { first, count } => {
                    flush(&mut batch);
                    if visible(index) {
                        set_state(State::Push(clip_depth), &mut state);
                        unsafe { self.context.DrawIndexed(*count, *first, 0) };
                    }
                    clip_depth = clip_depth.saturating_add(1);
                }
                DrawCommand::PopClip { first, count } => {
                    flush(&mut batch);
                    if visible(index) {
                        set_state(State::Pop(clip_depth), &mut state);
                        unsafe { self.context.DrawIndexed(*count, *first, 0) };
                    }
                    clip_depth = clip_depth.saturating_sub(1);
                }
            }
        }
        flush(&mut batch);
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
            self.push_vertex(Vertex {
                pos: self.ndc(p.x as f32, p.y as f32),
                uv: texcoord,
                color: rgba,
                mode,
                params: [0.0; 4],
                ..Default::default()
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
            self.push_vertex(Vertex {
                pos: self.ndc(x, y),
                uv: [x - center[0], y - center[1]],
                color: rgba,
                mode: if invert { 4.0 } else { 3.0 },
                params,
                ..Default::default()
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
            self.push_vertex(Vertex {
                pos: self.ndc(p.x as f32, p.y as f32),
                uv: [0.0, 0.0],
                color: rgba(color.multiply_alpha(opacity)),
                mode: 0.0,
                params: [0.0; 4],
                ..Default::default()
            });
            self.indices.push(base + index as u32);
        }
        self.commands.push(DrawCommand::Draw {
            first,
            count: points.len() as u32,
            texture: TextureRef::Solid,
        });
    }

    fn push_vertex(&mut self, mut vertex: Vertex) {
        vertex.dev = [
            (vertex.pos[0] + 1.0) * 0.5 * self.width.max(1) as f32,
            (1.0 - vertex.pos[1]) * 0.5 * self.height.max(1) as f32,
        ];
        vertex.clip = self.clip.rect;
        vertex.clip_radii = self.clip.radii;
        vertex.clip_m0 = self.clip.m0;
        vertex.clip_m1 = self.clip.m1;
        self.vertices.push(vertex);
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
            self.push_vertex(Vertex {
                pos: self.ndc(x, y),
                uv: [u, v],
                color: rgba,
                mode,
                params: [0.0; 4],
                ..Default::default()
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
        let released = image.data.data().is_empty();
        if let Some(cached) = self.images.get_mut(key) {
            if cached.signature == signature {
                return Some(cached.view.clone());
            }
            // The same image after its CPU pixels were released: the texture is the copy.
            if released && cached.signature.1 == image.width && cached.signature.2 == image.height {
                cached.signature = signature;
                return Some(cached.view.clone());
            }
        }
        if released {
            // The texture is gone (device lost): the document decodes it again.
            self.missing_images.push(key.to_string());
            return None;
        }
        let pixels = image_rgba(image)?;
        let cached =
            create_rgba_texture(&self.device, image.width, image.height, &pixels, signature)
                .ok()?;
        let view = cached.view.clone();
        self.images.insert(key.to_string(), cached);
        self.uploaded_images.push(key.to_string());
        // Tile hashes identify textures by pointer; a new texture may reuse a
        // freed one's address, so cached tiles cannot be trusted any more.
        self.tile_hashes.clear();
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

impl D3d11PaintTarget<'_> {
    /// Pushes `clip` onto the stencil instead of the shader.
    fn stencil_shader_clip(&mut self, clip: ShaderClip) -> Option<(u32, u32)> {
        let [r0, r1, r2, r3] = clip.radii.map(f64::from);
        let rect = vello::kurbo::Rect::new(
            f64::from(clip.rect[0]),
            f64::from(clip.rect[1]),
            f64::from(clip.rect[2]),
            f64::from(clip.rect[3]),
        );
        let shape = vello::kurbo::RoundedRect::from_rect(rect, (r0, r1, r2, r3));
        let to_device = Affine::new([
            f64::from(clip.m0[0]),
            f64::from(clip.m0[1]),
            f64::from(clip.m0[2]),
            f64::from(clip.m0[3]),
            f64::from(clip.m1[0]),
            f64::from(clip.m1[1]),
        ])
        .inverse();
        let path = lyon_path(shape.to_path(0.1).elements().iter().copied());
        let mut tess = FillTessellator::new();
        let mut geometry: VertexBuffers<LyonPoint, u32> = VertexBuffers::new();
        tess.tessellate_path(
            &path,
            &FillOptions::default(),
            &mut BuffersBuilder::new(&mut geometry, |vertex: FillVertex| vertex.position()),
        )
        .ok()?;
        // The stencil geometry itself must not be cut by the clip it replaces.
        let current = self.graphics.clip;
        self.graphics.clip = NO_CLIP;
        let (first, count) = self.graphics.append_geometry(
            &geometry.vertices,
            &geometry.indices,
            to_device,
            Color::WHITE,
            0.0,
            |_| [0.0, 0.0],
        );
        self.graphics.clip = current;
        if count == 0 {
            return None;
        }
        self.graphics
            .commands
            .push(DrawCommand::PushClip { first, count });
        Some((first, count))
    }

    /// Fills `path` without MSAA: the interior as tessellated triangles, then a
    /// one-device-pixel strip outside every contour fading from `color` to
    /// transparent, which stands in for the coverage of the edge pixels.
    /// `inset`: `path` already sits half a pixel inside the true edge (a
    /// stroke drawn one pixel thinner), so the strip starts on it and spans the
    /// whole pixel outward instead of straddling it.
    fn fill_feathered(
        &mut self,
        fill: Fill,
        transform: Affine,
        color: Color,
        mut path: BezPath,
        inset: bool,
    ) {
        path.apply_affine(transform);
        let inside = |point: Point| {
            let winding = path.winding(point);
            match fill {
                Fill::NonZero => winding != 0,
                Fill::EvenOdd => winding % 2 != 0,
            }
        };
        let mut contours: Vec<Vec<Point>> = vec![];
        vello::kurbo::flatten(path.iter(), 0.2, |element| match element {
            vello::kurbo::PathEl::MoveTo(point) => contours.push(vec![point]),
            vello::kurbo::PathEl::LineTo(point) => {
                if let Some(contour) = contours.last_mut()
                    && contour
                        .last()
                        .is_none_or(|last| last.distance(point) > 1e-3)
                {
                    contour.push(point);
                }
            }
            _ => {}
        });
        // Each contour with its per-vertex outward miter offsets (one pixel).
        let mut edged: Vec<(Vec<Point>, Vec<vello::kurbo::Vec2>)> = vec![];
        for mut contour in contours {
            if contour.len() > 1 && contour[0].distance(*contour.last().unwrap()) <= 1e-3 {
                contour.pop();
            }
            let n = contour.len();
            if n < 3 {
                continue;
            }
            let left = |a: Point, b: Point| {
                let d = b - a;
                let len = d.hypot().max(1e-9);
                vello::kurbo::Vec2::new(d.y / len, -d.x / len)
            };
            // Which side of this contour is filled: test beside its longest edge.
            let longest = (0..n)
                .max_by(|&i, &j| {
                    let a = contour[i].distance(contour[(i + 1) % n]);
                    let b = contour[j].distance(contour[(j + 1) % n]);
                    a.total_cmp(&b)
                })
                .unwrap_or(0);
            let (a, b) = (contour[longest], contour[(longest + 1) % n]);
            let probe = a.midpoint(b) + left(a, b) * 0.3;
            let outward = if inside(probe) { -1.0 } else { 1.0 };
            let offsets: Vec<vello::kurbo::Vec2> = (0..n)
                .map(|i| {
                    let prev = contour[(i + n - 1) % n];
                    let here = contour[i];
                    let next = contour[(i + 1) % n];
                    let a = left(prev, here) * outward;
                    let b = left(here, next) * outward;
                    let sum = a + b;
                    let length = sum.hypot();
                    if length < 1e-6 {
                        return b;
                    }
                    let miter = sum / length;
                    miter / miter.dot(b).max(0.5)
                })
                .collect();
            edged.push((contour, offsets));
        }
        // The solid interior stops half a pixel inside the edge, where the
        // fringe reaches full colour: edge pixels then get their coverage, not
        // a full pixel of colour plus a fringe beside it. Contours too small to
        // shrink (under ~2px across) keep their edge.
        let back = if inset { 0.0 } else { 0.5 };
        let mut solid = BezPath::new();
        for (contour, offsets) in &edged {
            let bounds = contour.iter().fold(
                vello::kurbo::Rect::from_points(contour[0], contour[0]),
                |r, p| r.union_pt(*p),
            );
            let shrink = if bounds.width().min(bounds.height()) > 2.0 {
                back
            } else {
                0.0
            };
            for (i, (point, offset)) in contour.iter().zip(offsets).enumerate() {
                let p = *point - *offset * shrink;
                if i == 0 {
                    solid.move_to(p);
                } else {
                    solid.line_to(p);
                }
            }
            solid.close_path();
        }
        let lyon = lyon_path(solid.elements().iter().copied());
        let mut tess = FillTessellator::new();
        let mut geometry: VertexBuffers<LyonPoint, u32> = VertexBuffers::new();
        let options = FillOptions::default().with_fill_rule(match fill {
            Fill::EvenOdd => FillRule::EvenOdd,
            Fill::NonZero => FillRule::NonZero,
        });
        if tess
            .tessellate_path(
                &lyon,
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
            Affine::IDENTITY,
            color,
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
        let transparent = color.with_alpha(0.0);
        let out = if inset { 1.0 } else { 0.5 };
        let mut fringe: Vec<(Point, Color)> = vec![];
        for (contour, offsets) in &edged {
            let n = contour.len();
            for i in 0..n {
                let j = (i + 1) % n;
                let (p, q) = (contour[i], contour[j]);
                // A pixel wide, from full colour to none, centred on the edge.
                let (pi, qi) = (p - offsets[i] * back, q - offsets[j] * back);
                let (po, qo) = (p + offsets[i] * out, q + offsets[j] * out);
                fringe.extend_from_slice(&[
                    (pi, color),
                    (qi, color),
                    (qo, transparent),
                    (pi, color),
                    (qo, transparent),
                    (po, transparent),
                ]);
            }
        }
        self.graphics
            .append_colored_triangles(&fringe, Affine::IDENTITY, 1.0);
    }
}

/// The intersection of two shader clips when it is still one rounded rectangle:
/// either has square corners and holds the other, or both are square. Scroll
/// areas inside rounded cards, rounded cards inside scroll areas.
fn combine_clips(current: ShaderClip, next: ShaderClip) -> Option<ShaderClip> {
    if current == NO_CLIP {
        return Some(next);
    }
    // Rotated clips have no rectangle intersection: the stencil takes the inner one.
    if !current.axis_aligned() || !next.axis_aligned() {
        return None;
    }
    let square = |radii: [f32; 4]| radii.iter().all(|r| *r <= 0.0);
    let contains = |outer: [f32; 4], inner: [f32; 4]| {
        outer[0] <= inner[0] + 0.01
            && outer[1] <= inner[1] + 0.01
            && outer[2] >= inner[2] - 0.01
            && outer[3] >= inner[3] - 0.01
    };
    let (a, ar) = (current.rect, current.radii);
    let (b, br) = (next.rect, next.radii);
    if contains(a, b) && square(ar) {
        return Some(next);
    }
    if contains(b, a) && square(br) {
        return Some(current);
    }
    if square(ar) && square(br) {
        let rect = [
            a[0].max(b[0]),
            a[1].max(b[1]),
            a[2].min(b[2]),
            a[3].min(b[3]),
        ];
        // An empty intersection still clips everything: a zero-size rectangle.
        let rect = if rect[0] > rect[2] || rect[1] > rect[3] {
            [rect[0], rect[1], rect[0], rect[1]]
        } else {
            rect
        };
        return Some(ShaderClip::device(rect, [0.0; 4]));
    }
    None
}

/// A (rounded) rectangle or circle as a shader clip. Translate/scale keeps it
/// in device pixels; a rotation (with uniform scale) maps pixels into its space.
fn analytic_clip<S: Shape>(shape: &S, transform: Affine) -> Option<ShaderClip> {
    let [a, b, c, d, e, f] = transform.as_coeffs();
    let (rect, radii) = if let Some(rounded) = shape.as_rounded_rect() {
        let r = rounded.radii();
        (
            rounded.rect(),
            [r.top_left, r.top_right, r.bottom_right, r.bottom_left],
        )
    } else if let Some(circle) = shape.as_circle() {
        // A circle is a square with fully rounded corners.
        (circle.bounding_box(), [circle.radius; 4])
    } else {
        (shape.as_rect()?, [0.0; 4])
    };
    if b.abs() < 1e-6 && c.abs() < 1e-6 && a > 0.0 && d > 0.0 {
        // Uniform enough for the radii: a circle needs a == d.
        let scale = (a * d).sqrt();
        return Some(ShaderClip::device(
            [
                (rect.x0 * a + e) as f32,
                (rect.y0 * d + f) as f32,
                (rect.x1 * a + e) as f32,
                (rect.y1 * d + f) as f32,
            ],
            radii.map(|radius| (radius * scale) as f32),
        ));
    }
    // Rotation and uniform scale only: the columns are orthogonal, equally long.
    let (sx, sy) = ((a * a + b * b).sqrt(), (c * c + d * d).sqrt());
    if (sx - sy).abs() > 1e-4 * sx.max(1.0) || (a * c + b * d).abs() > 1e-4 * sx * sy || sx <= 0.0 {
        return None;
    }
    let inverse = transform.inverse().as_coeffs();
    Some(ShaderClip {
        rect: [
            rect.x0 as f32,
            rect.y0 as f32,
            rect.x1 as f32,
            rect.y1 as f32,
        ],
        radii: radii.map(|radius| radius as f32),
        m0: [
            inverse[0] as f32,
            inverse[1] as f32,
            inverse[2] as f32,
            inverse[3] as f32,
        ],
        m1: [inverse[4] as f32, inverse[5] as f32, sx as f32, 0.0],
    })
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
        if self.graphics.analytic_aa {
            self.fill_feathered(
                fill,
                transform,
                color.multiply_alpha(self.opacity),
                shape.to_path(0.1),
                false,
            );
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
        let mut linear: Vec<(Point, Color)> = Vec::new();
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
                    // Cut the band to the shape's box: colour is linear in t, so
                    // the clipped corners keep exact colours, and the stencil
                    // and every MSAA tile see a few pixels, not a 7x larger quad.
                    let band = clip_polygon_to_rect(
                        &[p0 - across, p0 + across, p1 + across, p1 - across],
                        bounds,
                    );
                    let length2 = axis.hypot2().max(1e-12);
                    let colour = |point: Point| {
                        let t = (point - start).dot(axis) / length2;
                        mix(c0, c1, (t - t0) / (t1 - t0).max(1e-12))
                    };
                    for k in 1..band.len().saturating_sub(1) {
                        linear.extend([
                            (band[0], colour(band[0])),
                            (band[k], colour(band[k])),
                            (band[k + 1], colour(band[k + 1])),
                        ]);
                    }
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
        triangles.append(&mut linear);
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
        if self.graphics.analytic_aa {
            // The outline of the stroke one device pixel thinner, filled solid,
            // then a one-pixel fringe outward: each side's ramp is centred on the
            // true edge, as coverage is. Filling the full-width outline and
            // straddling its edge left a 1.5px icon line solid, i.e. aliased.
            let [a, b, c, d, ..] = transform.as_coeffs();
            let scale = (a * d - b * c).abs().sqrt().max(1e-6);
            let device = stroke.width * scale;
            let mut inner = stroke.clone();
            inner.width = ((device - 1.0).max(0.02)) / scale;
            let outline = vello::kurbo::stroke(
                shape.path_elements(0.1),
                &inner,
                &vello::kurbo::StrokeOpts::default(),
                0.1,
            );
            // Hairlines thinner than a pixel cover only part of it.
            let alpha = self.opacity * (device.min(1.0) as f32);
            self.fill_feathered(
                Fill::NonZero,
                transform,
                color.multiply_alpha(alpha),
                outline,
                true,
            );
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
        // Without MSAA a stencil clip has hard edges. A (rounded) rectangle on
        // axis-aligned transforms is clipped in the pixel shader instead, with
        // coverage, as the innermost clip; others fall back to the stencil.
        if self.graphics.analytic_aa
            && let Some(clip) = analytic_clip(shape, transform)
        {
            let previous = self.graphics.clip;
            if let Some(combined) = combine_clips(previous, clip) {
                self.layers
                    .push(D3d11PaintLayer::AnalyticClip(previous, None));
                self.graphics.clip = combined;
                return;
            }
            // Two clips that are not one rounded rectangle together: the inner
            // (what this content touches) keeps its smooth edge in the shader,
            // the outer moves to the stencil, as MyGo makes outer ones scissors.
            // It moves once, for the rest of its layer: a panel of 600 rounded
            // children costs one stencil draw, not one per child.
            if let Some(layer) = self
                .layers
                .iter()
                .rposition(|layer| matches!(layer, D3d11PaintLayer::AnalyticClip(_, None)))
                && let Some(stencil) = self.stencil_shader_clip(previous)
            {
                if let D3d11PaintLayer::AnalyticClip(_, slot) = &mut self.layers[layer] {
                    *slot = Some(stencil);
                }
                self.layers
                    .push(D3d11PaintLayer::AnalyticClip(NO_CLIP, None));
                self.graphics.clip = clip;
                return;
            }
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
            D3d11PaintLayer::AnalyticClip(previous, stencil) => {
                if let Some((first, count)) = stencil {
                    self.graphics
                        .commands
                        .push(DrawCommand::PopClip { first, count });
                }
                self.graphics.clip = previous;
            }
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
        // Without MSAA a quad covers only the pixels whose centres it contains,
        // so an image on fractional pixels lost its edge column. Draw it one
        // device pixel larger (the sampler clamps to the edge texels) and clip
        // it to its own rectangle in the shader, which gives the edge pixels
        // their coverage.
        if self.graphics.analytic_aa
            && let Some(edge) =
                analytic_clip(&vello::kurbo::Rect::new(0.0, 0.0, width, height), transform)
            && let Some(combined) = combine_clips(self.graphics.clip, edge)
        {
            let [a, b, c, d, ..] = transform.as_coeffs();
            let (sx, sy) = ((a * a + b * b).sqrt(), (c * c + d * d).sqrt());
            if sx > 0.0 && sy > 0.0 {
                let (ex, ey) = (1.0 / sx, 1.0 / sy);
                let corners = [
                    transform * Point::new(-ex, -ey),
                    transform * Point::new(width + ex, -ey),
                    transform * Point::new(width + ex, height + ey),
                    transform * Point::new(-ex, height + ey),
                ];
                let previous = self.graphics.clip;
                self.graphics.clip = combined;
                self.graphics.append_quad_points(
                    corners.map(|point| [point.x as f32, point.y as f32]),
                    [
                        (-ex / width) as f32,
                        (-ey / height) as f32,
                        (1.0 + ex / width) as f32,
                        (1.0 + ey / height) as f32,
                    ],
                    Color::WHITE.multiply_alpha(self.opacity),
                    1.0,
                    TextureRef::Image(view),
                );
                self.graphics.clip = previous;
                return;
            }
        }
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

/// Requested MSAA sample count, from the app (`msaa`); `TARVE_MSAA` overrides it.
static MSAA: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

pub(crate) fn set_msaa(samples: Option<u32>) {
    MSAA.store(samples.unwrap_or(0), std::sync::atomic::Ordering::Relaxed);
}

/// 0: no MSAA, edges get a coverage fringe. Otherwise 2, 4 or 8.
fn msaa_samples() -> u32 {
    let requested = std::env::var("TARVE_MSAA")
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok())
        .unwrap_or_else(|| MSAA.load(std::sync::atomic::Ordering::Relaxed));
    match requested {
        0 | 1 => 0,
        2 | 3 => 2,
        4..=7 => 4,
        _ => 8,
    }
}

fn choose_sample_desc(device: &ID3D11Device, requested: u32) -> DXGI_SAMPLE_DESC {
    for count in [8_u32, 4, 2]
        .into_iter()
        .filter(|count| *count <= requested)
    {
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

/// `scale.xy, offset.zw` taking window NDC to the NDC of the MSAA tile whose
/// top-left corner is window pixel (x, y).
fn tile_transform(width: u32, height: u32, x: u32, y: u32) -> [f32; 4] {
    let size = MSAA_TILE as f32;
    let (width, height) = (width as f32, height as f32);
    [
        width / size,
        height / size,
        (width - 2.0 * x as f32) / size - 1.0,
        1.0 - (height - 2.0 * y as f32) / size,
    ]
}

/// Word-at-a-time multiplicative hash step (FxHash's constant).
fn mix_hash(hash: u64, word: u64) -> u64 {
    (hash.rotate_left(5) ^ word).wrapping_mul(0x517c_c1b7_2722_0a95)
}

/// Sutherland–Hodgman: the part of a convex polygon inside `rect`.
fn clip_polygon_to_rect(polygon: &[Point], rect: vello::kurbo::Rect) -> Vec<Point> {
    let mut points = polygon.to_vec();
    type Edge = (fn(Point) -> f64, f64, bool);
    let edges: [Edge; 4] = [
        (|p| p.x, rect.x0, true),
        (|p| p.x, rect.x1, false),
        (|p| p.y, rect.y0, true),
        (|p| p.y, rect.y1, false),
    ];
    for (axis, limit, lower) in edges {
        let inside = |p: Point| {
            if lower {
                axis(p) >= limit
            } else {
                axis(p) <= limit
            }
        };
        let mut next = Vec::with_capacity(points.len() + 2);
        for (index, &current) in points.iter().enumerate() {
            let previous = points[(index + points.len() - 1) % points.len()];
            let (a, b) = (inside(previous), inside(current));
            if a != b {
                let t = (limit - axis(previous)) / (axis(current) - axis(previous));
                next.push(previous.lerp(current, t));
            }
            if b {
                next.push(current);
            }
        }
        points = next;
        if points.is_empty() {
            break;
        }
    }
    points
}

fn create_msaa_tile(
    device: &ID3D11Device,
    sample_desc: DXGI_SAMPLE_DESC,
) -> Result<MsaaTile, String> {
    let texture = |samples: DXGI_SAMPLE_DESC, bind: u32| -> Result<ID3D11Texture2D, String> {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: MSAA_TILE,
            Height: MSAA_TILE,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: samples,
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: bind,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let mut texture = None;
        unsafe { device.CreateTexture2D(&desc, None, Some(&mut texture)) }.map_err(win_error)?;
        texture.ok_or_else(|| "D3D11 MSAA tile texture was not created".to_string())
    };
    let color = texture(
        sample_desc,
        windows::Win32::Graphics::Direct3D11::D3D11_BIND_RENDER_TARGET.0 as u32,
    )?;
    let resolved = texture(
        DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        0,
    )?;
    let mut color_view = None;
    unsafe { device.CreateRenderTargetView(&color, None, Some(&mut color_view)) }
        .map_err(win_error)?;
    let (_, depth_view) = create_depth_target(device, MSAA_TILE, MSAA_TILE, sample_desc)?;
    Ok(MsaaTile {
        color,
        color_view: color_view.ok_or("D3D11 MSAA tile render-target view was not created")?,
        resolved,
        depth_view,
    })
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
        D3D11_INPUT_ELEMENT_DESC {
            SemanticName: PCSTR(b"TEXCOORD\0".as_ptr()),
            SemanticIndex: 3,
            Format: DXGI_FORMAT_R32G32_FLOAT,
            InputSlot: 0,
            AlignedByteOffset: 52,
            InputSlotClass: D3D11_INPUT_PER_VERTEX_DATA,
            InstanceDataStepRate: 0,
        },
        D3D11_INPUT_ELEMENT_DESC {
            SemanticName: PCSTR(b"TEXCOORD\0".as_ptr()),
            SemanticIndex: 4,
            Format: DXGI_FORMAT_R32G32B32A32_FLOAT,
            InputSlot: 0,
            AlignedByteOffset: 60,
            InputSlotClass: D3D11_INPUT_PER_VERTEX_DATA,
            InstanceDataStepRate: 0,
        },
        D3D11_INPUT_ELEMENT_DESC {
            SemanticName: PCSTR(b"TEXCOORD\0".as_ptr()),
            SemanticIndex: 5,
            Format: DXGI_FORMAT_R32G32B32A32_FLOAT,
            InputSlot: 0,
            AlignedByteOffset: 76,
            InputSlotClass: D3D11_INPUT_PER_VERTEX_DATA,
            InstanceDataStepRate: 0,
        },
        D3D11_INPUT_ELEMENT_DESC {
            SemanticName: PCSTR(b"TEXCOORD\0".as_ptr()),
            SemanticIndex: 6,
            Format: DXGI_FORMAT_R32G32B32A32_FLOAT,
            InputSlot: 0,
            AlignedByteOffset: 92,
            InputSlotClass: D3D11_INPUT_PER_VERTEX_DATA,
            InstanceDataStepRate: 0,
        },
        D3D11_INPUT_ELEMENT_DESC {
            SemanticName: PCSTR(b"TEXCOORD\0".as_ptr()),
            SemanticIndex: 7,
            Format: DXGI_FORMAT_R32G32B32A32_FLOAT,
            InputSlot: 0,
            AlignedByteOffset: 108,
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
    #[test]
    fn shader_clips_combine_when_still_one_rounded_rectangle() {
        use super::{NO_CLIP, ShaderClip, analytic_clip, combine_clips};
        let scroll = ShaderClip::device([0.0, 0.0, 100.0, 100.0], [0.0; 4]);
        let card = ShaderClip::device([10.0, 10.0, 50.0, 50.0], [8.0; 4]);
        assert_eq!(combine_clips(NO_CLIP, card), Some(card));
        assert_eq!(
            combine_clips(scroll, card),
            Some(card),
            "card inside a scroll area"
        );
        assert_eq!(
            combine_clips(card, scroll),
            Some(card),
            "scroll area around a card"
        );
        let overlap = ShaderClip::device([40.0, 40.0, 200.0, 200.0], [0.0; 4]);
        assert_eq!(
            combine_clips(scroll, overlap),
            Some(ShaderClip::device([40.0, 40.0, 100.0, 100.0], [0.0; 4]))
        );
        assert_eq!(
            combine_clips(card, overlap),
            None,
            "a cut rounded corner needs the stencil"
        );
        // A spinning card: rotated clips map pixels into the card's own space.
        let spin = vello::kurbo::Affine::rotate(0.5).then_translate((100.0, 100.0).into());
        let rotated = analytic_clip(
            &vello::kurbo::RoundedRect::new(0.0, 0.0, 28.0, 28.0, 6.0),
            spin,
        )
        .unwrap();
        assert!(!rotated.axis_aligned());
        assert_eq!(rotated.radii, [6.0; 4]);
        assert_eq!(combine_clips(scroll, rotated), None);
        assert!(
            analytic_clip(
                &vello::kurbo::Rect::new(0.0, 0.0, 1.0, 1.0),
                vello::kurbo::Affine::new([2.0, 0.0, 0.5, 1.0, 0.0, 0.0])
            )
            .is_none(),
            "skew falls back"
        );
    }

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
    fn polygon_clipping_keeps_the_part_inside_the_rect() {
        let rect = vello::kurbo::Rect::new(0.0, 0.0, 10.0, 10.0);
        let big = [
            Point::new(-5.0, -5.0),
            Point::new(15.0, -5.0),
            Point::new(15.0, 15.0),
            Point::new(-5.0, 15.0),
        ];
        let clipped = clip_polygon_to_rect(&big, rect);
        let area = |p: &[Point]| {
            (0..p.len())
                .map(|i| {
                    let (a, b) = (p[i], p[(i + 1) % p.len()]);
                    a.x * b.y - b.x * a.y
                })
                .sum::<f64>()
                .abs()
                / 2.0
        };
        assert!((area(&clipped) - 100.0).abs() < 1e-9);
        let diamond = [
            Point::new(5.0, -5.0),
            Point::new(15.0, 5.0),
            Point::new(5.0, 15.0),
            Point::new(-5.0, 5.0),
        ];
        // The 10x10 square minus four corner triangles of area 0 (they touch).
        assert!((area(&clip_polygon_to_rect(&diamond, rect)) - 100.0).abs() < 1e-9);
        let outside = [
            Point::new(20.0, 20.0),
            Point::new(30.0, 20.0),
            Point::new(30.0, 30.0),
        ];
        assert!(clip_polygon_to_rect(&outside, rect).is_empty());
    }

    #[test]
    fn tile_transform_maps_window_pixels_onto_the_tile() {
        let (width, height) = (1300_u32, 900_u32);
        let ndc = |x: f32, y: f32| [x * 2.0 / width as f32 - 1.0, 1.0 - y * 2.0 / height as f32];
        for (tx, ty) in [(0, 0), (512, 0), (1024, 512)] {
            let [sx, sy, ox, oy] = tile_transform(width, height, tx, ty);
            for (px, py) in [(tx, ty), (tx + 512, ty + 512), (tx + 100, ty + 37)] {
                let [nx, ny] = ndc(px as f32, py as f32);
                let (mx, my) = (nx * sx + ox, ny * sy + oy);
                // Tile NDC back to tile pixels.
                let qx = (mx + 1.0) * 0.5 * MSAA_TILE as f32;
                let qy = (1.0 - my) * 0.5 * MSAA_TILE as f32;
                assert!((qx - (px - tx) as f32).abs() < 1e-3, "x {px} -> {qx}");
                assert!((qy - (py - ty) as f32).abs() < 1e-3, "y {py} -> {qy}");
            }
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
