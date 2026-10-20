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
    kurbo::{Affine, BezPath, Cap, Join, PathEl, Point, Rect, RoundedRect, Shape, Stroke, dash},
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
                D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_CREATE_DEVICE_VIDEO_SUPPORT, D3D11_CULL_NONE, D3D11_DEPTH_STENCIL_DESC,
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
                DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL, DXGI_PRESENT_PARAMETERS,
                DXGI_USAGE_RENDER_TARGET_OUTPUT, IDXGIFactory2, IDXGISwapChain1,
                Common::DXGI_ALPHA_MODE_PREMULTIPLIED,
            },
        },
    },
    core::PCSTR,
};
use winit::{
    raw_window_handle::{HasWindowHandle, RawWindowHandle},
    window::Window,
};
use crate::d3d11_overlay::{Composition, LayerFormat, LayerTarget, OverlayPlacement};

use crate::paint::{GlassParams, GradientGeometry, PaintGlyph, PaintGradient, PaintTarget};

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
    /// Rounded-rect modes (5, 9): corner radii top-left, top-right, bottom-right,
    /// bottom-left in device pixels.
    shape: [f32; 4],
    /// Ring mode (9): border widths top, right, bottom, left in device pixels;
    /// the ring is the box minus the box inset by them.
    inner: [f32; 4],
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
    /// An RGBA ClearType atlas page, drawn with `ps_cleartype` (see `cleartype`).
    ClearType(ID3D11ShaderResourceView),
    Image(ID3D11ShaderResourceView),
    /// A `<video>` picture: the same texture shows a new picture each generation.
    /// Its node id: a video in its own composition layer is drawn as a hole.
    Video(VideoView, u64, Arc<str>),
}

/// What a `<video>` texture holds: RGBA, or the decoder's NV12 planes converted while drawn.
#[derive(Clone)]
pub(crate) enum VideoView {
    Rgba(ID3D11ShaderResourceView),
    Nv12 {
        luma: ID3D11ShaderResourceView,
        chroma: ID3D11ShaderResourceView,
        /// The picture's share of the texture (a decoder pads 1080 to 1088).
        uv: [f32; 2],
        /// The texture and array slice holding the picture, to copy it into a
        /// composition layer as is.
        source: Option<(ID3D11Texture2D, u32)>,
    },
}

impl VideoView {
    fn first(&self) -> &ID3D11ShaderResourceView {
        match self {
            Self::Rgba(view) | Self::Nv12 { luma: view, .. } => view,
        }
    }
}

/// A video this frame could show in its own layer.
struct OverlayRequest {
    id: String,
    size: (u32, u32),
    bt709: bool,
    placement: OverlayPlacement,
    view: VideoView,
}

const PUNCH_HASH: u64 = 0x7075_6e63_685f_6c61;

fn hash_str(text: &str) -> u64 {
    text.bytes()
        .fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3)
        })
}

/// Where a video picture can go as a composition layer: axis-aligned, opaque,
/// clipped at most by one axis-aligned rounded rectangle and no stencil clip.
/// `None` keeps it in the UI frame (rotated, translucent, clipped by a path).
fn overlay_placement(
    transform: Affine,
    width: f64,
    height: f64,
    clip: &ShaderClip,
    opacity: f32,
    stencil: bool,
) -> Option<OverlayPlacement> {
    if stencil || opacity < 0.999 || width <= 0.0 || height <= 0.0 {
        return None;
    }
    let [a, b, c, d, e, f] = transform.as_coeffs();
    if b.abs() > 1e-6 || c.abs() > 1e-6 || a <= 0.0 || d <= 0.0 {
        return None;
    }
    let dest = [e as f32, f as f32, (e + a * width) as f32, (f + d * height) as f32];
    let clip = if clip.rect[0] > clip.rect[2] {
        None
    } else if clip.axis_aligned() {
        Some((clip.rect, clip.radii))
    } else {
        return None;
    };
    Some(OverlayPlacement { dest, clip })
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
    /// Liquid glass: two blur passes over the backdrop copy, then the glass quad.
    Glass {
        blur_h: (u32, u32),
        blur_v: (u32, u32),
        quad: (u32, u32),
        /// Window pixels the blur reads and writes (the quad plus three sigmas).
        region: [u32; 4],
        /// sigma, saturate, refraction, highlight, magnify (sigma and refraction in device pixels).
        params: [f32; 5],
        /// Glass commands of one frame with the same non-zero key are drawn as one
        /// surface whose shapes join smoothly (`merge_glass`).
        merge: u64,
        /// Device pixels over which two merged shapes bridge.
        blend: f32,
        /// The shapes of the surface: centre x, y, half width, height, corner radius (device
        /// pixels), opacity. The first is the box this command was appended for.
        shapes: Vec<[f32; 6]>,
    },
}

/// Shapes one glass surface can fuse (the pixel shader's `glassShapes`).
const MAX_GLASS_SHAPES: usize = 8;

/// What one glass draw uploads: the material, the backdrop region and the shapes.
struct GlassSurface<'a> {
    params: [f32; 5],
    region: [u32; 4],
    blend: f32,
    shapes: &'a [[f32; 6]],
}

/// Two window-sized textures the glass passes ping-pong through: the backdrop
/// copy, blurred horizontally into the second and back vertically into the first.
struct Backdrop {
    textures: [ID3D11Texture2D; 2],
    views: [ID3D11ShaderResourceView; 2],
    targets: [ID3D11RenderTargetView; 2],
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
    /// The window shows what is behind it where the UI is translucent.
    transparent: bool,
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
    /// Single-sample path: the retained frame. Only tiles whose commands changed
    /// are redrawn into it (scissored); it is then copied to the back buffer.
    canvas: Option<Canvas>,
    /// What the frame drawn last changed, for Present1: `None` the whole window,
    /// empty nothing (no present), else these dirty rectangles.
    present_rects: Option<Vec<windows::Win32::Foundation::RECT>>,
    /// Where the commands being replayed draw (the canvas or the back buffer);
    /// glass copies its backdrop from it.
    current_target: Option<(ID3D11RenderTargetView, ID3D11Texture2D)>,
    scissor_rasterizer: ID3D11RasterizerState,
    /// GPU time of presented frames (`app.stats().native.phases.gpu`).
    gpu_timer: Option<crate::gpu_timer::GpuTimer>,
    /// Window-sized stencil, single-sample path only.
    depth_view: Option<ID3D11DepthStencilView>,
    /// Scratch for liquid glass; created on the first glass frame, dropped after one without.
    backdrop: Option<Backdrop>,
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
    /// Pixel-shader glass parameters (`cbuffer Glass`), uploaded before each glass draw.
    glass_params: ID3D11Buffer,
    /// The shapes of a merged glass surface (`cbuffer GlassShapes`).
    glass_shapes: ID3D11Buffer,
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
    /// Current `<video>` pictures by node id: textures the video decoder writes.
    video_views: HashMap<String, VideoView>,
    hwnd: HWND,
    factory: IDXGIFactory2,
    /// Videos in their own composition layers (the UI then has alpha).
    composition: Option<Composition>,
    /// DirectComposition is unavailable here: videos stay in the UI frame.
    composition_failed: bool,
    /// Videos this frame could show as layers, and the ones drawn as holes for them.
    overlay_requests: Vec<OverlayRequest>,
    punched: HashSet<String>,
    /// Videos whose layer could not be made (no YUV swap chains): drawn in the frame.
    overlay_blocked: HashSet<String>,
    /// Clears the UI's alpha under a video layer (antialiased at clipped edges).
    punch_blend: ID3D11BlendState,
    /// Why a video is drawn in the frame instead of its own layer (`app.inspect()`).
    overlay_error: Option<String>,
    /// Layers hold the decoder's NV12 as is; off when this GPU composes no YUV
    /// swap chains (layers are then BGRA, converted by one quad at the shown size).
    layer_nv12: bool,
    /// The four corners of that quad.
    layer_vertices: ID3D11Buffer,
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
    /// `textRendering: "cleartype"`: DirectWrite glyphs and their own atlas pages.
    cleartype: cleartype::ClearType,
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
    /// `transparent`: the window composes the UI's alpha over what is behind it
    /// (a transparent or system-material backdrop), through DirectComposition.
    pub(crate) fn new(window: Arc<Window>, transparent: bool) -> Result<Self, String> {
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
            // Sequential, not discard: only it lets Present1 hand DWM dirty rectangles.
            SwapEffect: DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL,
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
        let punch_blend = create_punch_blend(&device)?;
        let stencil_draw = create_stencil(&device, D3D11_STENCIL_OP_KEEP)?;
        let stencil_push = create_stencil(&device, D3D11_STENCIL_OP_INCR_SAT)?;
        let stencil_pop = create_stencil(&device, D3D11_STENCIL_OP_DECR_SAT)?;
        let target_transform = create_dynamic_buffer(
            &device,
            16,
            windows::Win32::Graphics::Direct3D11::D3D11_BIND_CONSTANT_BUFFER,
        )?;
        let glass_params = create_dynamic_buffer(
            &device,
            48,
            windows::Win32::Graphics::Direct3D11::D3D11_BIND_CONSTANT_BUFFER,
        )?;
        let glass_shapes = create_dynamic_buffer(
            &device,
            16 * (1 + 2 * MAX_GLASS_SHAPES),
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
        let layer_vertices =
            create_dynamic_buffer(&device, 4 * size_of::<Vertex>(), D3D11_BIND_VERTEX_BUFFER)?;

        let gpu_timer = crate::gpu_timer::GpuTimer::new(&device);
        let scissor_rasterizer = create_scissor_rasterizer(&device, &rasterizer)?;
        let mut graphics = Self {
            clip: NO_CLIP,
            analytic_aa,
            transparent,
            _window: window,
            device,
            context,
            swap_chain,
            render_target: Some(render_target),
            tile,
            frame_cache: None,
            tile_hashes: Vec::new(),
            canvas: None,
            present_rects: None,
            current_target: None,
            scissor_rasterizer,
            gpu_timer,
            depth_view,
            backdrop: None,
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
            glass_params,
            glass_shapes,
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
            video_views: HashMap::new(),
            hwnd,
            factory,
            composition: None,
            composition_failed: false,
            overlay_requests: Vec::new(),
            punched: HashSet::new(),
            overlay_blocked: HashSet::new(),
            punch_blend,
            overlay_error: None,
            layer_nv12: true,
            layer_vertices,
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
            cleartype: cleartype::ClearType::default(),
            prepared: false,
        };
        // A window swap chain has no alpha: a transparent window starts in composition.
        if transparent && graphics.enter_composition().is_err() {
            graphics.transparent = false;
            graphics.composition_failed = true;
        }
        Ok(graphics)
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
        self.overlay_requests.clear();
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
        if self.cleartype.begin_frame(&self.device, self.transparent) {
            self.tile_hashes.clear();
        }
        let mut target = D3d11PaintTarget {
            graphics: self,
            layers: Vec::with_capacity(8),
            suppressed_clips: 0,
            opacity: 1.0,
        };
        paint(&mut target);
        // Before the vertices go to the GPU: a draw of this frame must see the fused quads.
        self.merge_glass();
        self.sync_overlays();
        let images = self.images.len();
        self.images
            .retain(|key, _| self.used_images.contains(key) || self.pinned_images.contains(key));
        if self.images.len() != images {
            self.tile_hashes.clear();
        }
        self.prepared = true;
        Ok(())
    }

    /// The device, for the video decoder to write pictures the frame samples.
    pub(crate) fn device(&self) -> &ID3D11Device {
        &self.device
    }

    /// Video layers for this frame's requests (when the window can show them),
    /// and the holes the UI draws for them.
    fn sync_overlays(&mut self) {
        let requests = std::mem::take(&mut self.overlay_requests);
        let previous = std::mem::take(&mut self.punched);
        let shown = self._window.is_visible().unwrap_or(false)
            && !self._window.is_minimized().unwrap_or(false);
        let glass = self
            .commands
            .iter()
            .any(|command| matches!(command, DrawCommand::Glass { .. }));
        let enabled = std::env::var_os("TARVE_VIDEO_LAYERS").is_none_or(|value| value != "0");
        // Glass samples the UI behind it, which would not hold the video: draw it in the frame.
        if requests.is_empty() || !shown || glass || !enabled || self.tile.is_some() || self.composition_failed {
            if let Some(composition) = &mut self.composition {
                composition.retain(&HashSet::new());
            }
            return;
        }
        if self.composition.is_none()
            && let Err(error) = self.enter_composition()
        {
            self.overlay_error = Some(format!("video layers unavailable: {error}"));
            self.composition_failed = true;
            return;
        }
        let Some(composition) = self.composition.as_mut() else {
            return;
        };
        let mut kept = HashSet::new();
        let mut fresh_layers = Vec::new();
        for request in requests {
            if self.overlay_blocked.contains(&request.id) || kept.contains(&request.id) {
                continue;
            }
            let mut result = Err(String::new());
            for nv12 in [true, false] {
                if nv12 && !self.layer_nv12 {
                    continue;
                }
                let (format, size) = if nv12 {
                    (LayerFormat::Nv12, request.size)
                } else {
                    // Drawn at the size it is shown (never above its own).
                    let [x0, y0, x1, y1] = request.placement.dest;
                    (
                        LayerFormat::Bgra,
                        (
                            ((x1 - x0).round() as u32).clamp(1, request.size.0.max(1)),
                            ((y1 - y0).round() as u32).clamp(1, request.size.1.max(1)),
                        ),
                    )
                };
                result = composition.set_layer(
                    &self.device,
                    &self.factory,
                    &request.id,
                    size,
                    format,
                    request.bt709,
                    request.placement,
                );
                if result.is_ok() {
                    break;
                }
                if nv12 {
                    // No YUV composition swap chains on this GPU: BGRA layers from now on.
                    self.layer_nv12 = false;
                }
            }
            match result {
                Ok(fresh) => {
                    if fresh {
                        fresh_layers.push((request.id.clone(), request.view.clone(), request.bt709));
                    }
                    self.punched.insert(request.id.clone());
                    kept.insert(request.id);
                }
                Err(error) => {
                    self.overlay_error = Some(format!("video layer for '{}': {error}", request.id));
                    self.overlay_blocked.insert(request.id);
                }
            }
        }
        composition.retain(&kept);
        // Their first picture, so a hole never shows an empty layer.
        for (id, view, bt709) in fresh_layers {
            if let Err(error) = self.fill_layer(&id, &view, bt709) {
                self.overlay_error = Some(format!("video layer for '{id}': {error}"));
            }
        }
        // Holes hash the same whatever picture shows through them: only a change of
        // which videos are layers redraws the UI around them.
        if self.punched != previous {
            self.tile_hashes.clear();
        }
    }

    /// From the window's own swap chain to a composition one (with alpha), shown
    /// by a DirectComposition tree that video layers join.
    fn enter_composition(&mut self) -> Result<(), String> {
        unsafe {
            self.context.OMSetRenderTargets(None, None);
            self.context.Flush();
        }
        let desc = DXGI_SWAP_CHAIN_DESC1 {
            Width: self.width,
            Height: self.height,
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
            AlphaMode: DXGI_ALPHA_MODE_PREMULTIPLIED,
            Flags: 0,
        };
        let swap_chain = unsafe {
            self.factory
                .CreateSwapChainForComposition(&self.device, &desc, None)
        }
        .map_err(win_error)?;
        let composition = Composition::new(&self.device, self.hwnd, &swap_chain)?;
        let render_target = create_render_target(&self.device, &swap_chain)?;
        // The window's own swap chain goes: the composition tree shows the UI from now on.
        self.swap_chain = swap_chain;
        self.render_target = Some(render_target);
        self.canvas = None;
        self.frame_cache = None;
        self.backdrop = None;
        self.tile_hashes.clear();
        self.composition = Some(composition);
        Ok(())
    }

    /// Whether the window composes the UI's alpha (false when composition failed).
    pub(crate) fn shows_alpha(&self) -> bool {
        self.transparent
    }

    /// Videos shown in their own layers, and why one could not be.
    pub(crate) fn video_layers(&self) -> (usize, Option<&str>) {
        (self.punched.len(), self.overlay_error.as_deref())
    }

    /// Whether video `id` is in its own layer: new pictures go there, without a UI frame.
    pub(crate) fn video_layered(&self, id: &str) -> bool {
        self.punched.contains(id) && self.composition.as_ref().is_some_and(|c| c.has(id))
    }

    /// Shows a new picture of a layered video. False when it is not layered.
    pub(crate) fn present_video(&mut self, id: &str, view: &VideoView, bt709: bool) -> Result<bool, D3d11Error> {
        if !self.video_layered(id) {
            return Ok(false);
        }
        self.fill_layer(id, view, bt709)
            .map(|()| true)
            .map_err(|error| D3d11Error::RecoverDevice(format!("video layer present: {error}")))
    }

    /// Puts a picture into video `id`'s layer: copied as is (NV12), or drawn as one
    /// converting quad (BGRA), then presented.
    fn fill_layer(&mut self, id: &str, view: &VideoView, bt709: bool) -> Result<(), String> {
        let Some(composition) = &self.composition else {
            return Ok(());
        };
        let Some(target) = composition.target(id)? else {
            return Ok(());
        };
        match (target.format, view) {
            (
                LayerFormat::Nv12,
                VideoView::Nv12 {
                    source: Some((texture, slice)),
                    ..
                },
            ) => Composition::copy_picture(&self.context, &target, texture, *slice),
            (LayerFormat::Bgra, VideoView::Nv12 { .. }) => self.draw_layer_picture(&target, view, bt709)?,
            _ => return Ok(()),
        }
        composition.present(id)
    }

    /// One quad over a BGRA layer's back buffer, NV12 converted in the pixel shader.
    fn draw_layer_picture(&self, target: &LayerTarget, view: &VideoView, bt709: bool) -> Result<(), String> {
        let VideoView::Nv12 { luma, chroma, uv, .. } = view else {
            return Ok(());
        };
        let Some(render_target) = &target.view else {
            return Ok(());
        };
        let mode = if bt709 { 11.0 } else { 10.0 };
        let corner = |x: f32, y: f32, u: f32, v: f32| Vertex {
            pos: [x, y],
            uv: [u, v],
            color: [1.0; 4],
            mode,
            clip: NO_CLIP.rect,
            clip_radii: NO_CLIP.radii,
            clip_m0: NO_CLIP.m0,
            clip_m1: NO_CLIP.m1,
            ..Default::default()
        };
        // A strip: top-left, top-right, bottom-left, bottom-right.
        let vertices = [
            corner(-1.0, 1.0, 0.0, 0.0),
            corner(1.0, 1.0, uv[0], 0.0),
            corner(-1.0, -1.0, 0.0, uv[1]),
            corner(1.0, -1.0, uv[0], uv[1]),
        ];
        upload_dynamic(&self.context, &self.layer_vertices, bytemuck::cast_slice(&vertices))?;
        upload_dynamic(
            &self.context,
            &self.target_transform,
            bytemuck::cast_slice(&[1.0_f32, 1.0, 0.0, 0.0]),
        )?;
        unsafe {
            self.context
                .OMSetRenderTargets(Some(&[Some(render_target.clone())]), None);
            self.set_viewport(target.size.0, target.size.1);
            self.context.RSSetState(&self.rasterizer);
            self.context.IASetInputLayout(&self.input_layout);
            self.context
                .IASetPrimitiveTopology(windows::Win32::Graphics::Direct3D::D3D11_PRIMITIVE_TOPOLOGY_TRIANGLESTRIP);
            let buffers = [Some(self.layer_vertices.clone())];
            let strides = [size_of::<Vertex>() as u32];
            let offsets = [0_u32];
            self.context.IASetVertexBuffers(
                0,
                1,
                Some(buffers.as_ptr()),
                Some(strides.as_ptr()),
                Some(offsets.as_ptr()),
            );
            self.context.VSSetShader(&self.vertex_shader, None);
            self.context
                .VSSetConstantBuffers(0, Some(&[Some(self.target_transform.clone())]));
            self.context.PSSetShader(&self.pixel_shader, None);
            self.context
                .PSSetSamplers(0, Some(&[Some(self.image_sampler.clone())]));
            self.context
                .PSSetShaderResources(0, Some(&[Some(luma.clone()), Some(chroma.clone())]));
            self.context.OMSetBlendState(None, None, u32::MAX);
            self.context.OMSetDepthStencilState(None, 0);
            self.context.Draw(4, 0);
            self.context.PSSetShaderResources(0, Some(&[None, None]));
            self.context.OMSetRenderTargets(None, None);
        }
        Ok(())
    }

    /// The `<video>` textures the next frame draws, by node id.
    pub(crate) fn set_video_views(&mut self, views: Vec<(String, VideoView)>) {
        self.video_views = views.into_iter().collect();
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

    /// GPU milliseconds of the frames whose timings arrived since the last call.
    pub(crate) fn take_gpu_times(&mut self) -> Vec<f64> {
        self.gpu_timer
            .as_mut()
            .map(|timer| timer.take())
            .unwrap_or_default()
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
        self.canvas = None;
        self.backdrop.take();
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
        if let Some(timer) = &mut self.gpu_timer {
            timer.begin(&self.context);
        }
        let drawn = self.draw_frame(background);
        if let Some(timer) = &mut self.gpu_timer {
            timer.end(&self.context);
        }
        if let Err(error) = drawn {
            return Err(self.classify_gpu_error("D3D11 draw", error));
        }
        // The composition swap chain is flip-discard: it always presents whole frames.
        let rects = if self.composition.is_none() { self.present_rects.take() } else { None };
        let presented = match &rects {
            // Nothing changed: the window already shows this frame.
            Some(rects) if rects.is_empty() => Ok(()),
            Some(rects) => {
                let mut rects = rects.clone();
                let parameters = DXGI_PRESENT_PARAMETERS {
                    DirtyRectsCount: rects.len() as u32,
                    pDirtyRects: rects.as_mut_ptr(),
                    pScrollRect: std::ptr::null_mut(),
                    pScrollOffset: std::ptr::null_mut(),
                };
                unsafe { self.swap_chain.Present1(1, DXGI_PRESENT(0), &parameters).ok() }
            }
            None => unsafe { self.swap_chain.Present(1, DXGI_PRESENT(0)).ok() },
        };
        if let Err(error) = presented {
            return Err(self.classify_windows_gpu_error("DXGI Present", error));
        }
        // Layer moves and holes show with the frame that drew them.
        if let Some(composition) = &mut self.composition
            && let Err(error) = composition.commit()
        {
            return Err(D3d11Error::RecoverDevice(format!("DirectComposition commit: {error}")));
        }
        Ok(())
    }

    fn draw_frame(&mut self, background: Color) -> Result<(), String> {
        self.present_rects = None;
        self.ensure_gpu_buffers()?;
        self.upload_frame_buffers()?;
        let mut bg = rgba(background);
        if self.transparent {
            // Premultiplied, as the composition swap chain is.
            bg = [bg[0] * bg[3], bg[1] * bg[3], bg[2] * bg[3], bg[3]];
        } else if self.composition.is_some() {
            // The UI swap chain has alpha now; the window itself stays opaque.
            bg[3] = 1.0;
        }
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
            self.context.PSSetConstantBuffers(
                1,
                Some(&[
                    Some(self.glass_params.clone()),
                    Some(self.glass_shapes.clone()),
                ]),
            );
        }
        let has_glass = self
            .commands
            .iter()
            .any(|command| matches!(command, DrawCommand::Glass { .. }));
        if has_glass && self.tile.is_none() {
            if self.backdrop.is_none() {
                self.backdrop = Some(create_backdrop(&self.device, self.width, self.height)?);
            }
        } else {
            self.backdrop = None;
        }
        let clear_stencil = windows::Win32::Graphics::Direct3D11::D3D11_CLEAR_STENCIL.0;
        if self.tile.is_none() {
            return self.draw_retained(bg, clear_stencil);
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
        let hashes_fresh = self.tile_hashes.len() != tiles;
        if hashes_fresh {
            self.tile_hashes = vec![0; tiles];
        }
        let size = MSAA_TILE as f32;
        let mut hashes = std::mem::take(&mut self.tile_hashes);
        let mut changed = Vec::new();
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
                changed.push([left, top, (left + size).min(self.width as f32), (top + size).min(self.height as f32)]);
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
        if !hashes_fresh && !partial_redraw_disabled() {
            self.present_rects = Some(merge_rects(changed).into_iter().map(to_rect).collect());
        }
        Ok(())
    }

    /// Single-sample frame: redraws the changed tiles of the retained canvas (all of
    /// it on the first frame, after a resize or when most of it changed), then
    /// copies the canvas to the back buffer.
    fn draw_retained(&mut self, bg: [f32; 4], clear_stencil: u32) -> Result<(), String> {
        let depth_view = self
            .depth_view
            .clone()
            .ok_or("D3D11 stencil target is unavailable")?;
        upload_dynamic(
            &self.context,
            &self.target_transform,
            bytemuck::cast_slice(&[1.0_f32, 1.0, 0.0, 0.0]),
        )?;
        self.set_viewport(self.width, self.height);
        let backbuffer: ID3D11Texture2D =
            unsafe { self.swap_chain.GetBuffer(0) }.map_err(win_error)?;
        if self.canvas.is_none() {
            self.canvas = Some(create_canvas(&self.device, &backbuffer)?);
            self.tile_hashes.clear();
        }
        let canvas = self.canvas.clone().ok_or("D3D11 canvas is unavailable")?;
        let bounds = self.command_bounds();
        let damage = self.damage_rects(&bounds, bg);
        self.present_rects = damage.as_ref().map(|rects| rects.iter().map(|rect| to_rect(*rect)).collect());
        // Nothing changed and nothing to present: the back buffer is not touched either.
        if damage.as_ref().is_some_and(Vec::is_empty) && self.composition.is_none() {
            return Ok(());
        }
        self.current_target = Some((canvas.view.clone(), canvas.texture.clone()));
        unsafe {
            self.context
                .OMSetRenderTargets(Some(&[Some(canvas.view.clone())]), Some(&depth_view));
        }
        let partial = match &damage {
            None => {
                unsafe {
                    self.context.ClearRenderTargetView(&canvas.view, &bg);
                    self.context
                        .ClearDepthStencilView(&depth_view, clear_stencil, 1.0, 0);
                }
                self.replay(None, &[]);
                false
            }
            Some(rects) => {
                unsafe { self.context.RSSetState(&self.scissor_rasterizer) };
                for rect in rects {
                    let scissor = windows::Win32::Foundation::RECT {
                        left: rect[0] as i32,
                        top: rect[1] as i32,
                        right: rect[2] as i32,
                        bottom: rect[3] as i32,
                    };
                    unsafe {
                        self.context.RSSetScissorRects(Some(&[scissor]));
                        canvas
                            .context1
                            .ClearView(&canvas.view, &bg, Some(&[scissor]));
                        self.context
                            .ClearDepthStencilView(&depth_view, clear_stencil, 1.0, 0);
                        self.context.OMSetRenderTargets(
                            Some(&[Some(canvas.view.clone())]),
                            Some(&depth_view),
                        );
                    }
                    self.replay(Some(*rect), &bounds);
                }
                unsafe { self.context.RSSetState(&self.rasterizer) };
                !rects.is_empty()
            }
        };
        unsafe {
            self.context.PSSetShaderResources(0, Some(&[None]));
            self.context.OMSetRenderTargets(None, None);
            self.context.CopyResource(&backbuffer, &canvas.texture);
        }
        self.current_target = None;
        if partial && gpu_damage_check() {
            self.check_partial_redraw(bg, clear_stencil, &canvas, &backbuffer, &depth_view)?;
        }
        Ok(())
    }

    /// The window areas to redraw this frame: the changed tiles merged into
    /// disjoint rectangles, each grown to hold the whole backdrop region of every
    /// glass that draws inside it (glass blurs what lies under it, so its backdrop
    /// must be redrawn in the same pass). Passes may then overlap: each one
    /// redraws its rectangle from scratch. `None`: redraw everything.
    fn damage_rects(&mut self, bounds: &[[f32; 4]], bg: [f32; 4]) -> Option<Vec<[f32; 4]>> {
        let (width, height) = (self.width, self.height);
        let columns = width.div_ceil(DAMAGE_TILE) as usize;
        let tiles = columns * height.div_ceil(DAMAGE_TILE) as usize;
        let fresh = self.tile_hashes.len() != tiles;
        if fresh {
            self.tile_hashes = vec![0; tiles];
        }
        let command_hashes = self.command_hashes();
        let mut hashes = std::mem::take(&mut self.tile_hashes);
        let mut rects = Vec::new();
        for y in (0..height).step_by(DAMAGE_TILE as usize) {
            for x in (0..width).step_by(DAMAGE_TILE as usize) {
                let area = [
                    x as f32,
                    y as f32,
                    (x + DAMAGE_TILE).min(width) as f32,
                    (y + DAMAGE_TILE).min(height) as f32,
                ];
                let slot = (y / DAMAGE_TILE) as usize * columns + (x / DAMAGE_TILE) as usize;
                let hash = self.tile_hash(area, bounds, &command_hashes, bg);
                if hashes[slot] != hash {
                    hashes[slot] = hash;
                    rects.push(area);
                }
            }
        }
        self.tile_hashes = hashes;
        if fresh || partial_redraw_disabled() {
            return None;
        }
        // Per glass: where it draws, and what it reads (its backdrop region).
        let glass: Vec<([f32; 4], [f32; 4])> = self
            .commands
            .iter()
            .enumerate()
            .filter_map(|(index, command)| match command {
                DrawCommand::Glass { region, .. } => {
                    Some((bounds[index], region.map(|value| value as f32)))
                }
                _ => None,
            })
            .collect();
        let mut rects = merge_rects(rects);
        loop {
            let mut grown = false;
            for rect in &mut rects {
                for region in &glass {
                    if overlaps(*rect, region.0) && !contains(*rect, region.1) {
                        *rect = union(*rect, region.1);
                        grown = true;
                    }
                }
            }
            if !grown {
                break;
            }
            rects = merge_rects(rects);
        }
        let damaged: f32 = rects.iter().map(|r| (r[2] - r[0]) * (r[3] - r[1])).sum();
        (damaged <= 0.6 * width as f32 * height as f32).then_some(rects)
    }

    /// TARVE_GPU_DAMAGE_CHECK=1: after a partial redraw, draws the whole frame into
    /// the back buffer and fails if it differs from the canvas. For tests.
    fn check_partial_redraw(
        &mut self,
        bg: [f32; 4],
        clear_stencil: u32,
        canvas: &Canvas,
        backbuffer: &ID3D11Texture2D,
        depth_view: &ID3D11DepthStencilView,
    ) -> Result<(), String> {
        let render_target = self
            .render_target
            .clone()
            .ok_or("D3D11 render target is unavailable")?;
        self.current_target = Some((render_target.clone(), backbuffer.clone()));
        unsafe {
            self.context.ClearRenderTargetView(&render_target, &bg);
            self.context
                .ClearDepthStencilView(depth_view, clear_stencil, 1.0, 0);
            self.context
                .OMSetRenderTargets(Some(&[Some(render_target)]), Some(depth_view));
        }
        self.replay(None, &[]);
        self.current_target = None;
        unsafe {
            self.context.PSSetShaderResources(0, Some(&[None]));
            self.context.OMSetRenderTargets(None, None);
        }
        let expected = self.read_pixels(backbuffer)?;
        let actual = self.read_pixels(&canvas.texture)?;
        let width = self.width as usize;
        let (mut wrong, mut worst) = (0_usize, 0_i32);
        let (mut x0, mut y0, mut x1, mut y1) = (usize::MAX, usize::MAX, 0, 0);
        for (index, (a, b)) in expected
            .as_chunks::<4>()
            .0
            .iter()
            .zip(actual.as_chunks::<4>().0)
            .enumerate()
        {
            let delta = a
                .iter()
                .zip(b)
                .map(|(a, b)| (*a as i32 - *b as i32).abs())
                .max()
                .unwrap_or(0);
            if delta > 2 {
                wrong += 1;
                worst = worst.max(delta);
                let (x, y) = (index % width, index / width);
                (x0, y0, x1, y1) = (x0.min(x), y0.min(y), x1.max(x), y1.max(y));
            }
        }
        // Present what the full redraw produced either way.
        unsafe { self.context.CopyResource(backbuffer, &canvas.texture) };
        if wrong > 0 {
            return Err(format!(
                "D3D11 partial redraw differs from a full redraw in {wrong} pixels within {x0},{y0}..{x1},{y1} (by up to {worst})"
            ));
        }
        Ok(())
    }

    /// Tightly packed BGRA rows of a window-sized texture.
    fn read_pixels(&self, texture: &ID3D11Texture2D) -> Result<Vec<u8>, String> {
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { texture.GetDesc(&mut desc) };
        desc.BindFlags = 0;
        desc.MiscFlags = 0;
        desc.Usage = windows::Win32::Graphics::Direct3D11::D3D11_USAGE_STAGING;
        desc.CPUAccessFlags = windows::Win32::Graphics::Direct3D11::D3D11_CPU_ACCESS_READ.0 as u32;
        let mut staging = None;
        unsafe { self.device.CreateTexture2D(&desc, None, Some(&mut staging)) }
            .map_err(win_error)?;
        let staging = staging.ok_or("D3D11 staging texture was not created")?;
        unsafe { self.context.CopyResource(&staging, texture) };
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe {
            self.context.Map(
                &staging,
                0,
                windows::Win32::Graphics::Direct3D11::D3D11_MAP_READ,
                0,
                Some(&mut mapped),
            )
        }
        .map_err(win_error)?;
        let (width, height) = (desc.Width as usize, desc.Height as usize);
        let mut pixels = Vec::with_capacity(width * height * 4);
        for row in 0..height {
            let start = unsafe { (mapped.pData as *const u8).add(row * mapped.RowPitch as usize) };
            pixels.extend_from_slice(unsafe { std::slice::from_raw_parts(start, width * 4) });
        }
        unsafe { self.context.Unmap(&staging, 0) };
        Ok(pixels)
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
                            TextureRef::Glyph(view)
                            | TextureRef::ClearType(view)
                            | TextureRef::Image(view) => {
                                windows::core::Interface::as_raw(view) as u64
                            }
                            // A new picture in the same texture must repaint its tiles.
                            // A hole for a composition layer stays the same as pictures change.
                            TextureRef::Video(_, _, id) if self.punched.contains(&**id) => {
                                mix_hash(PUNCH_HASH, hash_str(id))
                            }
                            TextureRef::Video(view, generation, _) => mix_hash(
                                windows::core::Interface::as_raw(view.first()) as u64,
                                *generation,
                            ),
                        },
                    ),
                    DrawCommand::PushClip { first, count } => (1, *first, *count, 0),
                    DrawCommand::PopClip { first, count } => (2, *first, *count, 0),
                    DrawCommand::Glass {
                        quad,
                        params,
                        blend,
                        shapes,
                        ..
                    } => {
                        let mut seed = mix_hash(0, u64::from(blend.to_bits()));
                        for value in params.iter().chain(shapes.iter().flatten()) {
                            seed = mix_hash(seed, u64::from(value.to_bits()));
                        }
                        (3, quad.0, quad.1, seed)
                    }
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
                DrawCommand::Draw { .. } | DrawCommand::Glass { .. } => {}
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
                let (first, count) = match command {
                    DrawCommand::Draw { first, count, .. }
                    | DrawCommand::PushClip { first, count }
                    | DrawCommand::PopClip { first, count } => (first, count),
                    DrawCommand::Glass { quad, .. } => (&quad.0, &quad.1),
                };
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
                    DrawCommand::Draw { .. } | DrawCommand::Glass { .. } => {}
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
            ClearType(u32),
            Push(u32),
            Pop(u32),
            Punch(u32),
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
                State::ClearType(depth) => (
                    self.cleartype.pipeline().map_or(&self.blend, |(_, blend)| blend),
                    &self.stencil_draw,
                    depth,
                ),
                State::Punch(depth) => (&self.punch_blend, &self.stencil_draw, depth),
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
        // ClearType draws swap in their own pixel shader; everything else uses the main one.
        let mut cleartype_shader = false;
        let use_cleartype = |on: bool, current: &mut bool| {
            if *current == on {
                return;
            }
            let shader = match self.cleartype.pipeline() {
                Some((shader, _)) if on => shader,
                _ => &self.pixel_shader,
            };
            unsafe { self.context.PSSetShader(shader, None) };
            *current = on;
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
                        TextureRef::Glyph(view)
                        | TextureRef::ClearType(view)
                        | TextureRef::Image(view) => {
                            windows::core::Interface::as_raw(view) as usize
                        }
                        TextureRef::Video(_, _, id) if self.punched.contains(&**id) => {
                            // The video shows through: clear the UI's alpha under it.
                            flush(&mut batch);
                            if visible(index) {
                                use_cleartype(false, &mut cleartype_shader);
                                set_state(State::Punch(clip_depth), &mut state);
                                unsafe { self.context.DrawIndexed(*count, *first, 0) };
                            }
                            continue;
                        }
                        TextureRef::Video(view, _, _) => {
                            windows::core::Interface::as_raw(view.first()) as usize
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
                    let cleartype = matches!(texture, TextureRef::ClearType(_));
                    use_cleartype(cleartype, &mut cleartype_shader);
                    set_state(
                        if cleartype { State::ClearType(clip_depth) } else { State::Draw(clip_depth) },
                        &mut state,
                    );
                    if bound_texture != Some(key) {
                        unsafe {
                            match texture {
                                TextureRef::Solid => {
                                    self.context.PSSetShaderResources(0, Some(&[None]))
                                }
                                TextureRef::Glyph(view) | TextureRef::ClearType(view) => {
                                    self.context.PSSetSamplers(
                                        0,
                                        Some(&[Some(self.glyph_sampler.clone())]),
                                    );
                                    self.context
                                        .PSSetShaderResources(0, Some(&[Some(view.clone())]));
                                }
                                TextureRef::Video(view, _, _) => {
                                    self.context.PSSetSamplers(
                                        0,
                                        Some(&[Some(self.image_sampler.clone())]),
                                    );
                                    match view {
                                        VideoView::Rgba(rgba) => self
                                            .context
                                            .PSSetShaderResources(0, Some(&[Some(rgba.clone())])),
                                        VideoView::Nv12 { luma, chroma, .. } => {
                                            self.context.PSSetShaderResources(
                                                0,
                                                Some(&[Some(luma.clone()), Some(chroma.clone())]),
                                            )
                                        }
                                    }
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
                        use_cleartype(false, &mut cleartype_shader);
                        set_state(State::Push(clip_depth), &mut state);
                        unsafe { self.context.DrawIndexed(*count, *first, 0) };
                    }
                    clip_depth = clip_depth.saturating_add(1);
                }
                DrawCommand::PopClip { first, count } => {
                    flush(&mut batch);
                    if visible(index) {
                        use_cleartype(false, &mut cleartype_shader);
                        set_state(State::Pop(clip_depth), &mut state);
                        unsafe { self.context.DrawIndexed(*count, *first, 0) };
                    }
                    clip_depth = clip_depth.saturating_sub(1);
                }
                DrawCommand::Glass {
                    blur_h,
                    blur_v,
                    quad,
                    region,
                    params,
                    blend,
                    shapes,
                    ..
                } => {
                    flush(&mut batch);
                    if !visible(index) {
                        continue;
                    }
                    use_cleartype(false, &mut cleartype_shader);
                    let surface = GlassSurface {
                        params: *params,
                        region: *region,
                        blend: *blend,
                        shapes,
                    };
                    let blurred = self.blur_backdrop(*blur_h, *blur_v, &surface);
                    // The blur passes changed the render target and pipeline state.
                    state = None;
                    bound_texture = None;
                    set_state(State::Draw(clip_depth), &mut state);
                    unsafe { self.context.DrawIndexed(quad.1, quad.0, 0) };
                    if blurred {
                        unsafe { self.context.PSSetShaderResources(0, Some(&[None])) };
                    }
                }
            }
        }
        flush(&mut batch);
        use_cleartype(false, &mut cleartype_shader);
    }

    /// Copies the backdrop under a glass box, blurs it in place and leaves it bound
    /// as `tex0` for the glass quad. False (tint only) without a usable backdrop.
    fn blur_backdrop(
        &self,
        blur_h: (u32, u32),
        blur_v: (u32, u32),
        surface: &GlassSurface,
    ) -> bool {
        let region = surface.region;
        let (Some(backdrop), Some(render_target), Some(depth_view), None) = (
            &self.backdrop,
            &self.render_target,
            &self.depth_view,
            &self.tile,
        ) else {
            let _ = self.upload_glass_params(surface, 0.0);
            return false;
        };
        let (render_target, backbuffer) = match &self.current_target {
            Some((view, texture)) => (view, texture.clone()),
            None => match unsafe { self.swap_chain.GetBuffer::<ID3D11Texture2D>(0) } {
                Ok(backbuffer) => (render_target, backbuffer),
                Err(_) => {
                    let _ = self.upload_glass_params(surface, 0.0);
                    return false;
                }
            },
        };
        // Wide blurs run at half resolution: a quarter of the pixels, half the taps,
        // and nothing a blur that wide would show is lost.
        let half = surface.params[0] >= HALF_RES_BLUR_SIGMA;
        if self
            .upload_glass_params(surface, if half { 2.0 } else { 1.0 })
            .is_err()
        {
            return false;
        }
        let area = windows::Win32::Graphics::Direct3D11::D3D11_BOX {
            left: region[0],
            top: region[1],
            front: 0,
            right: region[2],
            bottom: region[3],
            back: 1,
        };
        unsafe {
            self.context.OMSetRenderTargets(None, None);
            self.context.CopySubresourceRegion(
                &backdrop.textures[0],
                0,
                region[0],
                region[1],
                0,
                &backbuffer,
                0,
                Some(&area),
            );
            self.context
                .OMSetBlendState(Some(&self.blend), Some(&[0.0, 0.0, 0.0, 0.0]), u32::MAX);
            self.context.OMSetDepthStencilState(None, 0);
            self.context
                .PSSetSamplers(0, Some(&[Some(self.image_sampler.clone())]));
            // The passes write only the backdrop textures, inside the region: no
            // scissor (a partial redraw's is in window pixels, not half ones).
            let rasterizer = self.context.RSGetState().ok();
            self.context.RSSetState(&self.rasterizer);
            if half {
                self.context.RSSetViewports(Some(&[D3D11_VIEWPORT {
                    TopLeftX: 0.0,
                    TopLeftY: 0.0,
                    Width: self.width as f32 / 2.0,
                    Height: self.height as f32 / 2.0,
                    MinDepth: 0.0,
                    MaxDepth: 1.0,
                }]));
            }
            self.context
                .OMSetRenderTargets(Some(&[Some(backdrop.targets[1].clone())]), None);
            self.context
                .PSSetShaderResources(0, Some(&[Some(backdrop.views[0].clone())]));
            self.context.DrawIndexed(blur_h.1, blur_h.0, 0);
            self.context.PSSetShaderResources(0, Some(&[None]));
            self.context
                .OMSetRenderTargets(Some(&[Some(backdrop.targets[0].clone())]), None);
            self.context
                .PSSetShaderResources(0, Some(&[Some(backdrop.views[1].clone())]));
            self.context.DrawIndexed(blur_v.1, blur_v.0, 0);
            self.context.PSSetShaderResources(0, Some(&[None]));
            if half {
                self.set_viewport(self.width, self.height);
            }
            if let Some(rasterizer) = rasterizer {
                self.context.RSSetState(&rasterizer);
            }
            self.context
                .OMSetRenderTargets(Some(&[Some(render_target.clone())]), Some(depth_view));
            self.context
                .PSSetShaderResources(0, Some(&[Some(backdrop.views[0].clone())]));
        }
        true
    }

    fn upload_glass_params(&self, surface: &GlassSurface, available: f32) -> Result<(), String> {
        let (params, region) = (surface.params, surface.region);
        upload_dynamic(
            &self.context,
            &self.glass_params,
            bytemuck::cast_slice(&[
                params[0],
                params[1],
                params[2],
                params[3],
                self.width as f32,
                self.height as f32,
                available,
                params[4],
                region[0] as f32,
                region[1] as f32,
                region[2] as f32,
                region[3] as f32,
            ]),
        )?;
        // The shapes relative to the first one's centre, which the quad's uv is measured from.
        let count = surface.shapes.len().min(MAX_GLASS_SHAPES);
        let mut data = vec![0.0_f32; 4 * (1 + 2 * MAX_GLASS_SHAPES)];
        data[0] = count as f32;
        data[1] = surface.blend;
        let origin = surface
            .shapes
            .first()
            .map_or([0.0, 0.0], |shape| [shape[0], shape[1]]);
        for (index, shape) in surface.shapes.iter().take(count).enumerate() {
            let at = 4 + index * 8;
            data[at..at + 8].copy_from_slice(&[
                shape[0] - origin[0],
                shape[1] - origin[1],
                shape[2],
                shape[3],
                shape[4],
                shape[5],
                0.0,
                0.0,
            ]);
        }
        upload_dynamic(
            &self.context,
            &self.glass_shapes,
            bytemuck::cast_slice(&data),
        )
    }

    /// Fuses the glass commands that share a `merge` key into the first of them: its
    /// shape list grows, its quad and blur passes widen to the union, the others are
    /// dropped. Later members therefore paint where the first one does, under what
    /// was painted between them. Runs once per prepared frame, before the vertex
    /// upload (every draw of the frame, presented or captured, replays the result).
    fn merge_glass(&mut self) {
        let mut index = 0;
        while index < self.commands.len() {
            let key = match &self.commands[index] {
                DrawCommand::Glass { merge, .. } if *merge != 0 => *merge,
                _ => {
                    index += 1;
                    continue;
                }
            };
            let mut absorbed = Vec::new();
            for (later, command) in self.commands.iter().enumerate().skip(index + 1) {
                if let DrawCommand::Glass {
                    merge,
                    shapes,
                    region,
                    ..
                } = command
                    && *merge == key
                    && absorbed.len() + 1 < MAX_GLASS_SHAPES
                {
                    absorbed.push((later, shapes[0], *region));
                }
            }
            if absorbed.is_empty() {
                index += 1;
                continue;
            }
            let (width, height) = (self.width, self.height);
            let DrawCommand::Glass {
                blur_h,
                blur_v,
                quad,
                region,
                blend,
                shapes,
                ..
            } = &mut self.commands[index]
            else {
                unreachable!()
            };
            for (_, shape, more) in &absorbed {
                shapes.push(*shape);
                region[0] = region[0].min(more[0]);
                region[1] = region[1].min(more[1]);
                region[2] = region[2].max(more[2]);
                region[3] = region[3].max(more[3]);
            }
            let origin = shapes[0];
            let reach = *blend + 1.0;
            let mut bounds = [f32::MAX, f32::MAX, f32::MIN, f32::MIN];
            for shape in shapes.iter() {
                bounds[0] = bounds[0].min(shape[0] - shape[2] - reach);
                bounds[1] = bounds[1].min(shape[1] - shape[3] - reach);
                bounds[2] = bounds[2].max(shape[0] + shape[2] + reach);
                bounds[3] = bounds[3].max(shape[1] + shape[3] + reach);
            }
            let area = [
                region[0] as f32,
                region[1] as f32,
                region[2] as f32,
                region[3] as f32,
            ];
            let passes = [
                (blur_h.0, area, false),
                (blur_v.0, area, false),
                (quad.0, bounds, true),
            ];
            for (first, b, own_uv) in passes {
                let base = self.indices[first as usize] as usize;
                let corners = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];
                for (vertex, [x, y]) in self.vertices[base..base + 4].iter_mut().zip(corners) {
                    vertex.pos = [
                        x * 2.0 / width.max(1) as f32 - 1.0,
                        1.0 - y * 2.0 / height.max(1) as f32,
                    ];
                    if own_uv {
                        vertex.uv = [x - origin[0], y - origin[1]];
                    }
                }
            }
            for (later, _, _) in absorbed.iter().rev() {
                self.commands.remove(*later);
            }
            index += 1;
        }
    }

    pub(crate) fn capture(&mut self, background: Color, path: &str) -> Result<(), D3d11Error> {
        if !self.prepared {
            return Err(D3d11Error::Request(
                "D3D11 frame was not prepared before capture".into(),
            ));
        }
        // Capture the current prepared command list. Flip-model swapchain buffers are not
        // retained-frame storage, so never read them without drawing this frame first.
        // Videos in layers are drawn into the capture (a capture has no layers).
        let punched = std::mem::take(&mut self.punched);
        let drawn = self.draw_frame(background);
        self.punched = punched;
        if let Err(error) = drawn {
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

    /// One quad whose pixels evaluate a solid rounded rectangle (mode 5) from its
    /// distance field, antialiased like `fill_feathered`: full inside, fading
    /// over the pixel that straddles the edge. Circles and pills this way cost
    /// four vertices instead of a flattened, tessellated, feathered outline.
    fn append_round_rect_quad(
        &mut self,
        center: [f32; 2],
        half: [f32; 2],
        radii: [f32; 4],
        color: Color,
    ) {
        self.append_sdf_quad(center, half, radii, [0.0; 4], 5.0, color);
    }

    /// The ring between a rounded box and the same box inset by `widths` (top,
    /// right, bottom, left): a border whose sides differ, from its distance
    /// fields, so the corner arcs stay exact.
    fn append_round_rect_ring(
        &mut self,
        center: [f32; 2],
        half: [f32; 2],
        radii: [f32; 4],
        widths: [f32; 4],
        color: Color,
    ) {
        self.append_sdf_quad(center, half, radii, widths, 9.0, color);
    }

    fn append_sdf_quad(
        &mut self,
        center: [f32; 2],
        half: [f32; 2],
        radii: [f32; 4],
        widths: [f32; 4],
        mode: f32,
        color: Color,
    ) {
        let first = self.indices.len() as u32;
        let base = self.vertices.len() as u32;
        let rgba = rgba(color);
        let (x0, y0, x1, y1) = (
            center[0] - half[0] - 1.0,
            center[1] - half[1] - 1.0,
            center[0] + half[0] + 1.0,
            center[1] + half[1] + 1.0,
        );
        for [x, y] in [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] {
            self.push_vertex(Vertex {
                pos: self.ndc(x, y),
                uv: [x - center[0], y - center[1]],
                color: rgba,
                mode,
                params: [half[0], half[1], radii[0], 0.0],
                shape: radii,
                inner: widths,
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

    /// Liquid glass over a rounded box: `center`/`half`/`radius` in device pixels,
    /// `params` = sigma, saturate, refraction, highlight, magnify (sigma and refraction in
    /// pixels); `merge`/`blend` fuse it with the other boxes of the same key.
    #[allow(clippy::too_many_arguments)]
    fn append_glass(
        &mut self,
        center: [f32; 2],
        half: [f32; 2],
        radius: f32,
        tint: Color,
        opacity: f32,
        params: [f32; 5],
        merge: u64,
        blend: f32,
    ) {
        // The copy must hold what the lens reaches past the edge, plus the blur taps around
        // that, plus the bridge to a merged neighbour.
        let reach = params[2].ceil()
            + (params[0] * 6.0).ceil()
            + 2.0
            + if merge == 0 { 0.0 } else { blend.ceil() };
        let (width, height) = (self.width.max(1) as f32, self.height.max(1) as f32);
        let x0 = (center[0] - half[0] - reach).floor().clamp(0.0, width);
        let y0 = (center[1] - half[1] - reach).floor().clamp(0.0, height);
        let x1 = (center[0] + half[0] + reach).ceil().clamp(0.0, width);
        let y1 = (center[1] + half[1] + reach).ceil().clamp(0.0, height);
        if x1 <= x0 || y1 <= y0 {
            return;
        }
        // The blur passes cover the region unclipped: the glass quad applies the clip.
        let clip = std::mem::replace(&mut self.clip, NO_CLIP);
        let mut pass = |mode: f32| {
            let first = self.indices.len() as u32;
            let base = self.vertices.len() as u32;
            for [x, y] in [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] {
                self.push_vertex(Vertex {
                    pos: self.ndc(x, y),
                    uv: [0.0, 0.0],
                    color: [1.0; 4],
                    mode,
                    params: [0.0; 4],
                    ..Default::default()
                });
            }
            self.indices
                .extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
            (first, 6)
        };
        let blur_h = pass(6.0);
        let blur_v = pass(7.0);
        self.clip = clip;
        let first = self.indices.len() as u32;
        let base = self.vertices.len() as u32;
        let rgba = rgba(tint);
        let (qx0, qy0, qx1, qy1) = (
            center[0] - half[0] - 1.0,
            center[1] - half[1] - 1.0,
            center[0] + half[0] + 1.0,
            center[1] + half[1] + 1.0,
        );
        for [x, y] in [[qx0, qy0], [qx1, qy0], [qx1, qy1], [qx0, qy1]] {
            self.push_vertex(Vertex {
                pos: self.ndc(x, y),
                uv: [x - center[0], y - center[1]],
                color: rgba,
                mode: 8.0,
                params: [half[0], half[1], radius, opacity],
                shape: [radius; 4],
                ..Default::default()
            });
        }
        self.indices
            .extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
        self.commands.push(DrawCommand::Glass {
            blur_h,
            blur_v,
            quad: (first, 6),
            region: [x0 as u32, y0 as u32, x1 as u32, y1 as u32],
            params,
            merge,
            blend,
            shapes: vec![[center[0], center[1], half[0], half[1], radius, opacity]],
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
        // Winding from the flattened contours, skipping those whose box does not
        // hold the point: a path of hundreds of dots (an SVG dot matrix) asked the
        // whole path once per contour, quadratic in the dot count.
        let boxes: Vec<vello::kurbo::Rect> = contours
            .iter()
            .map(|contour| {
                contour.iter().fold(
                    vello::kurbo::Rect::from_points(contour[0], contour[0]),
                    |r, p| r.union_pt(*p),
                )
            })
            .collect();
        let inside = |point: Point| {
            let mut winding = 0i32;
            for (contour, bounds) in contours.iter().zip(&boxes) {
                if point.y < bounds.y0 || point.y > bounds.y1 || point.x > bounds.x1 {
                    continue;
                }
                let n = contour.len();
                for i in 0..n {
                    let (a, b) = (contour[i], contour[(i + 1) % n]);
                    if (a.y <= point.y) != (b.y <= point.y) {
                        let x = a.x + (point.y - a.y) / (b.y - a.y) * (b.x - a.x);
                        if x > point.x {
                            winding += if b.y > a.y { 1 } else { -1 };
                        }
                    }
                }
            }
            match fill {
                Fill::NonZero => winding != 0,
                Fill::EvenOdd => winding % 2 != 0,
            }
        };
        // Each contour with its per-vertex outward miter offsets (one pixel).
        let mut edged: Vec<(Vec<Point>, Vec<vello::kurbo::Vec2>)> = vec![];
        for mut contour in contours.clone() {
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
            if let Some((center, half, radii)) = sdf_round_rect(shape, transform) {
                self.graphics.append_round_rect_quad(
                    center,
                    half,
                    radii,
                    color.multiply_alpha(self.opacity),
                );
                return;
            }
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

    fn fill_ring(
        &mut self,
        transform: Affine,
        outer: &RoundedRect,
        widths: [f64; 4],
        color: Color,
    ) {
        if self.suppressed_clips > 0 {
            return;
        }
        if self.graphics.analytic_aa
            && let Some(scale) = uniform_scale(transform)
            && let Some((center, half, radii)) = sdf_round_rect(outer, transform)
        {
            self.graphics.append_round_rect_ring(
                center,
                half,
                radii,
                widths.map(|width| (width.max(0.0) * scale) as f32),
                color.multiply_alpha(self.opacity),
            );
            return;
        }
        let rect = outer.rect();
        let [top, right, bottom, left] = widths;
        let inner = Rect::new(
            rect.x0 + left,
            rect.y0 + top,
            (rect.x1 - right).max(rect.x0 + left),
            (rect.y1 - bottom).max(rect.y0 + top),
        );
        let radii = outer.radii();
        let mut ring = outer.to_path(0.1);
        ring.extend(
            RoundedRect::from_rect(
                inner,
                crate::paint::inner_corner_radii(
                    [
                        radii.top_left,
                        radii.top_right,
                        radii.bottom_right,
                        radii.bottom_left,
                    ],
                    widths,
                ),
            )
            .path_elements(0.1),
        );
        self.fill(Fill::EvenOdd, transform, color, &ring);
    }

    fn stroke<S: Shape>(&mut self, stroke: &Stroke, transform: Affine, color: Color, shape: &S) {
        if self.suppressed_clips > 0 {
            return;
        }
        if self.graphics.analytic_aa {
            // A circle's outline: one ring quad.
            if stroke.dash_pattern.is_empty()
                && let Some(circle) = shape.as_circle()
                && stroke.width > 0.0
                && stroke.width < circle.radius * 2.0
                && let Some(scale) = uniform_scale(transform)
                && let Some((center, half, radii)) = sdf_round_rect(
                    &vello::kurbo::Circle::new(circle.center, circle.radius + stroke.width / 2.0),
                    transform,
                )
            {
                let width = (stroke.width * scale) as f32;
                self.graphics.append_round_rect_ring(
                    center,
                    half,
                    radii,
                    [width; 4],
                    color.multiply_alpha(self.opacity),
                );
                return;
            }
            // Round dots (zero-length round-capped segments, as a dot-matrix
            // chart draws hundreds of): each one a circle quad.
            if stroke.dash_pattern.is_empty()
                && stroke.start_cap == vello::kurbo::Cap::Round
                && stroke.end_cap == vello::kurbo::Cap::Round
                && let Some(scale) = uniform_scale(transform)
                && let Some(dots) = dot_centers(shape, stroke.width)
            {
                let radius = (stroke.width * scale / 2.0) as f32;
                let color = color.multiply_alpha(self.opacity);
                for dot in dots {
                    let p = transform * dot;
                    self.graphics.append_round_rect_quad(
                        [p.x as f32, p.y as f32],
                        [radius, radius],
                        [radius; 4],
                        color,
                    );
                }
                return;
            }
            // The outline of the stroke one device pixel thinner, filled solid,
            // then a one-pixel fringe outward: each side's ramp is centred on the
            // true edge, as coverage is. Filling the full-width outline and
            // straddling its edge left a 1.5px icon line solid, i.e. aliased.
            let [a, b, c, d, ..] = transform.as_coeffs();
            let scale = (a * d - b * c).abs().sqrt().max(1e-6);
            let device = stroke.width * scale;
            let mut inner = stroke.clone();
            inner.width = ((device - 1.0).max(0.02)) / scale;
            // A butt-capped dash ends where its fringe starts, so the ramp would
            // centre half a pixel past the dash's true end: shorten each dash by a
            // pixel (half at each end) and widen each gap to match.
            if !inner.dash_pattern.is_empty() && inner.start_cap == vello::kurbo::Cap::Butt {
                let px = 1.0 / scale;
                let mut pattern = inner.dash_pattern.to_vec();
                if pattern.len() % 2 == 1 {
                    pattern.extend_from_within(..);
                }
                for (i, length) in pattern.iter_mut().enumerate() {
                    if i % 2 == 0 {
                        *length = (*length - px).max(0.01);
                    } else {
                        *length += px;
                    }
                }
                inner.dash_pattern = pattern.into_iter().collect();
                inner.dash_offset -= px / 2.0;
            }
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

    fn glass(
        &mut self,
        transform: Affine,
        rect: vello::kurbo::Rect,
        radius: f64,
        tint: Color,
        glass: &GlassParams,
    ) {
        if self.suppressed_clips > 0 {
            return;
        }
        let coeffs = transform.as_coeffs();
        let (scale_x, scale_y) = (coeffs[0].abs(), coeffs[3].abs());
        let scale = (scale_x * scale_y).sqrt();
        let center = transform * rect.center();
        let half = [
            (rect.width() * scale_x / 2.0) as f32,
            (rect.height() * scale_y / 2.0) as f32,
        ];
        if half[0] <= 0.0 || half[1] <= 0.0 {
            return;
        }
        self.graphics.append_glass(
            [center.x as f32, center.y as f32],
            half,
            ((radius * scale) as f32).min(half[0].min(half[1])).max(0.0),
            tint,
            self.opacity,
            [
                (glass.blur * scale as f32 / 2.0).clamp(0.0, 32.0).max(0.01),
                glass.saturate.clamp(0.0, 4.0),
                (glass.refraction * scale as f32).clamp(0.0, 48.0),
                glass.highlight.clamp(0.0, 1.0),
                glass.magnify.clamp(0.0, 0.3),
            ],
            glass.merge,
            (glass.blend * scale as f32).clamp(0.0, 256.0),
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

    fn draw_video(&mut self, id: &str, frame: &crate::video::VideoFrame, transform: Affine) {
        if self.suppressed_clips > 0 {
            return;
        }
        let Some(view) = self.graphics.video_views.get(id).cloned() else {
            // No texture on this device (the decoder is reading back): the copy in memory.
            if let Some(pixels) = &frame.pixels {
                self.draw_image(&format!("video:{id}"), pixels, frame.pixel_transform(transform));
            }
            return;
        };
        let (width, height) = (f64::from(frame.width), f64::from(frame.height));
        let corners = [
            transform * Point::new(0.0, 0.0),
            transform * Point::new(width, 0.0),
            transform * Point::new(width, height),
            transform * Point::new(0.0, height),
        ];
        // NV12 converts in the pixel shader: BT.709 for HD pictures, BT.601 below.
        let mode = match &view {
            VideoView::Rgba(_) => 1.0,
            VideoView::Nv12 { .. } if frame.height >= 720 => 11.0,
            VideoView::Nv12 { .. } => 10.0,
        };
        let uv = match &view {
            VideoView::Nv12 { uv, .. } => [0.0, 0.0, uv[0], uv[1]],
            VideoView::Rgba(_) => [0.0, 0.0, 1.0, 1.0],
        };
        let stencil = self.layers.iter().any(|layer| {
            matches!(
                layer,
                D3d11PaintLayer::Clip(Some(_)) | D3d11PaintLayer::AnalyticClip(_, Some(_))
            )
        });
        if let VideoView::Nv12 { source: Some(_), .. } = &view
            && let Some(placement) = overlay_placement(
                transform,
                width,
                height,
                &self.graphics.clip,
                self.opacity,
                stencil,
            )
        {
            self.graphics.overlay_requests.push(OverlayRequest {
                id: id.to_string(),
                size: (frame.width, frame.height),
                bt709: frame.height >= 720,
                placement,
                view: view.clone(),
            });
        }
        self.graphics.append_quad_points(
            corners.map(|point| [point.x as f32, point.y as f32]),
            uv,
            Color::WHITE.multiply_alpha(self.opacity),
            mode,
            TextureRef::Video(view, frame.generation, Arc::from(id)),
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
        // DirectWrite gets static faces only; variable-font instances stay with swash.
        let cleartype = self.graphics.cleartype.active() && normalized_coords.is_empty();
        for glyph in glyphs {
            let baseline = transform * Point::new(f64::from(glyph.x), f64::from(glyph.y));
            let (base_x, subpixel_x) = quantize_glyph_position(baseline.x as f32);
            let (base_y, subpixel_y) = quantize_glyph_position(baseline.y as f32);
            let cleartype_entry = if cleartype {
                self.graphics
                    .cleartype_entry(font, font_size, glyph.id, subpixel_x, subpixel_y, scale)
            } else {
                None
            };
            let subpixel = cleartype_entry.is_some();
            let Some(entry) = cleartype_entry.or_else(|| {
                self.graphics.glyph_entry(
                    font,
                    font_size,
                    normalized_coords,
                    glyph.id,
                    subpixel_x,
                    subpixel_y,
                    scale,
                )
            }) else {
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
                if subpixel { TextureRef::ClearType(view) } else { TextureRef::Glyph(view) },
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

mod cleartype;
mod dwrite_glyphs;
mod prewarm;
mod text_rendering;
pub(crate) use text_rendering::set_text_rendering;
pub(crate) use prewarm::{prewarm_device, prewarm_pending};
use prewarm::create_device;
fn create_device_now() -> Result<(ID3D11Device, ID3D11DeviceContext), String> {
    // Video support lets `<video>` decode on this device (no copy to draw it);
    // a driver without video falls back to a device without it.
    create_device_with(D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT)
        .or_else(|_| create_device_with(D3D11_CREATE_DEVICE_BGRA_SUPPORT))
}
fn create_device_with(
    flags: windows::Win32::Graphics::Direct3D11::D3D11_CREATE_DEVICE_FLAG,
) -> Result<(ID3D11Device, ID3D11DeviceContext), String> {
    let mut device = None;
    let mut context = None;
    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            flags,
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
        D3D11_INPUT_ELEMENT_DESC {
            SemanticName: PCSTR(b"TEXCOORD\0".as_ptr()),
            SemanticIndex: 8,
            Format: DXGI_FORMAT_R32G32B32A32_FLOAT,
            InputSlot: 0,
            AlignedByteOffset: 124,
            InputSlotClass: D3D11_INPUT_PER_VERTEX_DATA,
            InstanceDataStepRate: 0,
        },
        D3D11_INPUT_ELEMENT_DESC {
            SemanticName: PCSTR(b"TEXCOORD\0".as_ptr()),
            SemanticIndex: 9,
            Format: DXGI_FORMAT_R32G32B32A32_FLOAT,
            InputSlot: 0,
            AlignedByteOffset: 140,
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

/// Multiplies the target by `1 - coverage` (colour and alpha): where a video layer
/// shows, the UI becomes transparent, with antialiased edges along its clip.
fn create_punch_blend(device: &ID3D11Device) -> Result<ID3D11BlendState, String> {
    let mut targets = [D3D11_RENDER_TARGET_BLEND_DESC::default(); 8];
    targets[0] = D3D11_RENDER_TARGET_BLEND_DESC {
        BlendEnable: true.into(),
        SrcBlend: windows::Win32::Graphics::Direct3D11::D3D11_BLEND_ZERO,
        DestBlend: D3D11_BLEND_INV_SRC_ALPHA,
        BlendOp: D3D11_BLEND_OP_ADD,
        SrcBlendAlpha: windows::Win32::Graphics::Direct3D11::D3D11_BLEND_ZERO,
        DestBlendAlpha: D3D11_BLEND_INV_SRC_ALPHA,
        BlendOpAlpha: D3D11_BLEND_OP_ADD,
        RenderTargetWriteMask: D3D11_COLOR_WRITE_ENABLE_ALL.0 as u8,
    };
    let desc = D3D11_BLEND_DESC {
        AlphaToCoverageEnable: false.into(),
        IndependentBlendEnable: false.into(),
        RenderTarget: targets,
    };
    let mut state = None;
    unsafe { device.CreateBlendState(&desc, Some(&mut state)) }.map_err(win_error)?;
    state.ok_or_else(|| "D3D11 punch blend state was not created".into())
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

fn create_backdrop(device: &ID3D11Device, width: u32, height: u32) -> Result<Backdrop, String> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width.max(1),
        Height: height.max(1),
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: (D3D11_BIND_SHADER_RESOURCE.0
            | windows::Win32::Graphics::Direct3D11::D3D11_BIND_RENDER_TARGET.0)
            as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };
    let make = || -> Result<(ID3D11Texture2D, ID3D11ShaderResourceView, ID3D11RenderTargetView), String> {
        let mut texture = None;
        unsafe { device.CreateTexture2D(&desc, None, Some(&mut texture)) }.map_err(win_error)?;
        let texture = texture.ok_or("D3D11 backdrop texture was not created")?;
        let mut view = None;
        unsafe { device.CreateShaderResourceView(&texture, None, Some(&mut view)) }
            .map_err(win_error)?;
        let mut target = None;
        unsafe { device.CreateRenderTargetView(&texture, None, Some(&mut target)) }
            .map_err(win_error)?;
        Ok((
            texture,
            view.ok_or("D3D11 backdrop view was not created")?,
            target.ok_or("D3D11 backdrop target was not created")?,
        ))
    };
    let (texture_a, view_a, target_a) = make()?;
    let (texture_b, view_b, target_b) = make()?;
    Ok(Backdrop {
        textures: [texture_a, texture_b],
        views: [view_a, view_b],
        targets: [target_a, target_b],
    })
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

/// The scale of a transform that only scales evenly and translates.
fn uniform_scale(transform: Affine) -> Option<f64> {
    let [a, b, c, d, ..] = transform.as_coeffs();
    (b == 0.0 && c == 0.0 && a > 0.0 && (a - d).abs() <= a * 1e-6).then_some(a)
}

/// Centre, half size and corner radii (top-left, top-right, bottom-right,
/// bottom-left) in device pixels of a circle or a rounded rectangle, under a
/// transform that keeps it one.
fn sdf_round_rect<S: Shape>(
    shape: &S,
    transform: Affine,
) -> Option<([f32; 2], [f32; 2], [f32; 4])> {
    let scale = uniform_scale(transform)?;
    let (rect, radii) = if let Some(circle) = shape.as_circle() {
        (
            vello::kurbo::Rect::from_center_size(
                circle.center,
                (circle.radius * 2.0, circle.radius * 2.0),
            ),
            [circle.radius; 4],
        )
    } else {
        let rounded = shape.as_rounded_rect()?;
        let radii = rounded.radii();
        (
            rounded.rect(),
            [
                radii.top_left,
                radii.top_right,
                radii.bottom_right,
                radii.bottom_left,
            ],
        )
    };
    let center = transform * rect.center();
    let half = [
        (rect.width() * scale / 2.0) as f32,
        (rect.height() * scale / 2.0) as f32,
    ];
    if !(half[0] > 0.0 && half[1] > 0.0) {
        return None;
    }
    Some((
        [center.x as f32, center.y as f32],
        half,
        radii.map(|radius| ((radius * scale) as f32).clamp(0.0, half[0].min(half[1]))),
    ))
}

/// The dots of a path made only of zero-length segments (`M x y h.01`, at
/// most a twentieth of the stroke width long): where each round cap pair
/// draws a circle. None for any other path.
fn dot_centers<S: Shape>(shape: &S, width: f64) -> Option<Vec<Point>> {
    let mut dots = vec![];
    let mut start: Option<Point> = None;
    for element in shape.path_elements(0.1) {
        match element {
            PathEl::MoveTo(point) => start = Some(point),
            PathEl::LineTo(point) => {
                let from = start.take()?;
                if from.distance(point) > width * 0.05 {
                    return None;
                }
                dots.push(from.midpoint(point));
            }
            _ => return None,
        }
    }
    (!dots.is_empty()).then_some(dots)
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
    fn round_dots_and_rounded_rects_take_the_quad_path() {
        use super::{dot_centers, sdf_round_rect, uniform_scale};
        use vello::kurbo::{Affine, BezPath, Circle, Point, Rect, RoundedRect};
        let dots = BezPath::from_svg("M10 20h.01M16.5 20h.01").unwrap();
        let found = dots_of(&dots, 3.0).unwrap();
        assert_eq!(found.len(), 2);
        assert!(
            found[0].distance(Point::new(10.005, 20.0)) < 1e-9
                && found[1].distance(Point::new(16.505, 20.0)) < 1e-9
        );
        let line = BezPath::from_svg("M0 0h4").unwrap();
        assert_eq!(dots_of(&line, 3.0), None, "a real segment is not a dot");
        let curve = BezPath::from_svg("M0 0q1 1 2 0").unwrap();
        assert_eq!(dots_of(&curve, 3.0), None);
        fn dots_of(path: &BezPath, width: f64) -> Option<Vec<Point>> {
            dot_centers(path, width)
        }

        let at = Affine::translate((5.0, 7.0)) * Affine::scale(2.0);
        assert_eq!(uniform_scale(at), Some(2.0));
        assert_eq!(uniform_scale(Affine::scale_non_uniform(2.0, 3.0)), None);
        assert_eq!(uniform_scale(Affine::rotate(0.3)), None);
        assert_eq!(
            sdf_round_rect(&RoundedRect::new(0.0, 0.0, 20.0, 10.0, 4.0), at),
            Some(([25.0, 17.0], [20.0, 10.0], [8.0; 4]))
        );
        assert_eq!(
            sdf_round_rect(&Circle::new((1.0, 1.0), 3.0), Affine::IDENTITY),
            Some(([1.0, 1.0], [3.0, 3.0], [3.0; 4]))
        );
        assert_eq!(
            sdf_round_rect(
                &RoundedRect::new(0.0, 0.0, 20.0, 10.0, (4.0, 0.0, 12.0, 0.0)),
                Affine::IDENTITY
            ),
            Some(([10.0, 5.0], [10.0, 5.0], [4.0, 0.0, 5.0, 0.0])),
            "mixed corner radii take the quad too, each clamped to the half size"
        );
        assert_eq!(
            sdf_round_rect(&Rect::new(0.0, 0.0, 4.0, 4.0), Affine::IDENTITY),
            None
        );
    }

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
        for (name, bytes) in [
            ("vertex", VERTEX_SHADER),
            ("pixel", PIXEL_SHADER),
            ("ClearType pixel", cleartype::PIXEL_SHADER),
        ] {
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
    fn damage_rects_merge_when_they_overlap_or_touch() {
        let merged = merge_rects(vec![
            [0.0, 0.0, 128.0, 128.0],
            [128.0, 0.0, 256.0, 128.0],
            [512.0, 512.0, 640.0, 640.0],
            [600.0, 600.0, 700.0, 700.0],
            [900.0, 0.0, 1000.0, 50.0],
        ]);
        let mut merged: Vec<[i32; 4]> = merged.iter().map(|r| r.map(|v| v as i32)).collect();
        merged.sort();
        assert_eq!(
            merged,
            vec![[0, 0, 256, 128], [512, 512, 700, 700], [900, 0, 1000, 50]]
        );
        // A chain merges into one box even when only its ends were listed apart.
        let chain = merge_rects(vec![
            [0.0, 0.0, 10.0, 10.0],
            [20.0, 0.0, 30.0, 10.0],
            [10.0, 0.0, 20.0, 10.0],
        ]);
        assert_eq!(chain, vec![[0.0, 0.0, 30.0, 10.0]]);
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
    fn a_video_layer_takes_axis_aligned_opaque_pictures_only() {
        let at = Affine::translate((10.0, 20.0)) * Affine::scale(0.5);
        // Unclipped: the picture's rectangle on screen.
        let placement = overlay_placement(at, 640.0, 360.0, &NO_CLIP, 1.0, false).unwrap();
        assert_eq!(placement.dest, [10.0, 20.0, 330.0, 200.0]);
        assert_eq!(placement.visible(), ([10.0, 20.0, 330.0, 200.0], [0.0; 4]));
        // A rounded clip (object-fit: cover, border-radius) clips the layer with its corners.
        let clip = ShaderClip::device([50.0, 20.0, 290.0, 200.0], [8.0, 8.0, 8.0, 8.0]);
        let clipped = overlay_placement(at, 640.0, 360.0, &clip, 1.0, false).unwrap();
        assert_eq!(clipped.visible(), ([50.0, 20.0, 290.0, 200.0], [8.0; 4]));
        // Rotated, mirrored, translucent, a rotated clip or a path clip: drawn in the frame.
        assert!(overlay_placement(Affine::rotate(0.3), 640.0, 360.0, &NO_CLIP, 1.0, false).is_none());
        assert!(overlay_placement(Affine::scale_non_uniform(-1.0, 1.0), 640.0, 360.0, &NO_CLIP, 1.0, false).is_none());
        assert!(overlay_placement(at, 640.0, 360.0, &NO_CLIP, 0.5, false).is_none());
        let mut rotated = clip;
        rotated.m0 = [0.0, 1.0, -1.0, 0.0];
        assert!(overlay_placement(at, 640.0, 360.0, &rotated, 1.0, false).is_none());
        assert!(overlay_placement(at, 640.0, 360.0, &NO_CLIP, 1.0, true).is_none());
        assert!(overlay_placement(at, 0.0, 360.0, &NO_CLIP, 1.0, false).is_none());
    }

    #[test]
    fn a_hole_for_a_video_layer_hashes_the_same_for_every_picture() {
        // The hole's hash leaves out the picture: new pictures redraw no UI tile.
        assert_eq!(hash_str("clip"), hash_str("clip"));
        assert_ne!(hash_str("clip"), hash_str("clip2"));
        assert_ne!(mix_hash(PUNCH_HASH, hash_str("clip")), mix_hash(PUNCH_HASH, hash_str("other")));
    }

    #[test]
    #[ignore = "writes shaders/*.dxbc; run after editing shaders/ui.hlsl"]
    fn regenerate_d3d11_shaders() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/shaders");
        for (entry, target, file) in [
            (&b"vs_main\0"[..], &b"vs_5_0\0"[..], "ui.vs.dxbc"),
            (&b"ps_main\0"[..], &b"ps_5_0\0"[..], "ui.ps.dxbc"),
            (&b"ps_cleartype\0"[..], &b"ps_5_0\0"[..], "cleartype.ps.dxbc"),
        ] {
            let blob = compile_shader(SOURCE, entry, target).unwrap();
            std::fs::write(dir.join(file), blob_bytes(&blob)).unwrap();
        }
        std::fs::write(dir.join("ui.hlsl.fnv"), format!("{}\n", source_hash())).unwrap();
    }
}

/// Gaussian sigma (device pixels) from which liquid glass blurs at half resolution.
const HALF_RES_BLUR_SIGMA: f32 = 3.0;

/// Edge of the square tiles whose command hashes decide what the single-sample
/// path redraws.
const DAMAGE_TILE: u32 = 128;

/// The retained single-sample frame.
#[derive(Clone)]
struct Canvas {
    texture: ID3D11Texture2D,
    view: ID3D11RenderTargetView,
    /// For `ClearView`, which clears a rectangle.
    context1: windows::Win32::Graphics::Direct3D11::ID3D11DeviceContext1,
}

fn create_canvas(device: &ID3D11Device, backbuffer: &ID3D11Texture2D) -> Result<Canvas, String> {
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe { backbuffer.GetDesc(&mut desc) };
    desc.BindFlags = windows::Win32::Graphics::Direct3D11::D3D11_BIND_RENDER_TARGET.0 as u32;
    desc.MiscFlags = 0;
    desc.CPUAccessFlags = 0;
    desc.Usage = D3D11_USAGE_DEFAULT;
    let mut texture = None;
    unsafe { device.CreateTexture2D(&desc, None, Some(&mut texture)) }.map_err(win_error)?;
    let texture = texture.ok_or("D3D11 canvas was not created")?;
    let mut view = None;
    unsafe { device.CreateRenderTargetView(&texture, None, Some(&mut view)) }.map_err(win_error)?;
    use windows::core::Interface;
    let context1 = unsafe { device.GetImmediateContext() }
        .map_err(win_error)?
        .cast::<windows::Win32::Graphics::Direct3D11::ID3D11DeviceContext1>()
        .map_err(win_error)?;
    Ok(Canvas {
        texture,
        view: view.ok_or("D3D11 canvas view was not created")?,
        context1,
    })
}

fn create_scissor_rasterizer(
    device: &ID3D11Device,
    base: &ID3D11RasterizerState,
) -> Result<ID3D11RasterizerState, String> {
    let mut desc = D3D11_RASTERIZER_DESC::default();
    unsafe { base.GetDesc(&mut desc) };
    desc.ScissorEnable = true.into();
    let mut state = None;
    unsafe { device.CreateRasterizerState(&desc, Some(&mut state)) }.map_err(win_error)?;
    state.ok_or_else(|| "D3D11 scissor rasterizer state was not created".into())
}

/// A damage rectangle as a whole-pixel Win32 RECT (damage is tile-aligned already).
fn to_rect(rect: [f32; 4]) -> windows::Win32::Foundation::RECT {
    windows::Win32::Foundation::RECT {
        left: rect[0].floor() as i32,
        top: rect[1].floor() as i32,
        right: rect[2].ceil() as i32,
        bottom: rect[3].ceil() as i32,
    }
}

fn overlaps(a: [f32; 4], b: [f32; 4]) -> bool {
    a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
}

fn contains(outer: [f32; 4], inner: [f32; 4]) -> bool {
    outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3]
}

fn union(a: [f32; 4], b: [f32; 4]) -> [f32; 4] {
    [
        a[0].min(b[0]),
        a[1].min(b[1]),
        a[2].max(b[2]),
        a[3].max(b[3]),
    ]
}

/// Merges rectangles that overlap or share an edge into their bounding boxes
/// until none do: few, disjoint scissor passes.
pub(crate) fn merge_rects(mut rects: Vec<[f32; 4]>) -> Vec<[f32; 4]> {
    let touches =
        |a: [f32; 4], b: [f32; 4]| a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
    let mut merged = true;
    while merged {
        merged = false;
        let mut index = 0;
        while index < rects.len() {
            let mut other = index + 1;
            while other < rects.len() {
                if touches(rects[index], rects[other]) {
                    let absorbed = rects.swap_remove(other);
                    rects[index] = union(rects[index], absorbed);
                    merged = true;
                } else {
                    other += 1;
                }
            }
            index += 1;
        }
    }
    rects
}

/// TARVE_GPU_DAMAGE_CHECK=1: compare every partial redraw with a full one.
fn gpu_damage_check() -> bool {
    static CHECK: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *CHECK.get_or_init(|| {
        std::env::var_os("TARVE_GPU_DAMAGE_CHECK").is_some_and(|value| value == "1")
    })
}

/// TARVE_GPU_FULL_REDRAW=1: redraw every frame whole (for A/B measurements).
fn partial_redraw_disabled() -> bool {
    static FULL: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *FULL
        .get_or_init(|| std::env::var_os("TARVE_GPU_FULL_REDRAW").is_some_and(|value| value == "1"))
}
