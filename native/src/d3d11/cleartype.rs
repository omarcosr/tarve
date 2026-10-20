//! ClearType text for the D3D11 renderer (`textRendering: "cleartype"`).
//!
//! DirectWrite rasterizes each glyph with Windows' own hinting and subpixel
//! filtering into RGBA atlas pages; `ps_cleartype` then blends every colour
//! channel with its own coverage (dual-source blending). Subpixel coverage needs an
//! opaque destination, so a transparent window keeps the grayscale path.

use std::collections::HashMap;

use vello::peniko::FontData;
use windows::Win32::Graphics::{
    Direct3D11::{
        D3D11_BIND_SHADER_RESOURCE, D3D11_BLEND_DESC, D3D11_BLEND_INV_SRC1_ALPHA,
        D3D11_BLEND_INV_SRC1_COLOR, D3D11_BLEND_ONE, D3D11_BLEND_OP_ADD, D3D11_BOX,
        D3D11_COLOR_WRITE_ENABLE_ALL, D3D11_RENDER_TARGET_BLEND_DESC, D3D11_SUBRESOURCE_DATA,
        D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, ID3D11BlendState, ID3D11Device,
        ID3D11DeviceContext, ID3D11PixelShader, ID3D11Texture2D,
    },
    Dxgi::Common::{DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_SAMPLE_DESC},
};

use super::{
    D3d11Graphics, GLYPH_ATLAS_SIZE, GlyphAtlas, GlyphEntry, GlyphKey, MAX_GLYPH_ATLASES,
    dwrite_glyphs::{DWriteGlyphs, Mask},
    text_rendering::cleartype_requested,
    win_error,
};

/// DXBC of `ps_cleartype` in `shaders/ui.hlsl`, regenerated with the other shaders.
pub(super) const PIXEL_SHADER: &[u8] = include_bytes!("../shaders/cleartype.ps.dxbc");

struct Pipeline {
    shader: ID3D11PixelShader,
    blend: ID3D11BlendState,
    rasterizer: DWriteGlyphs,
    atlases: Vec<GlyphAtlas>,
    /// `None`: DirectWrite could not draw it; the grayscale path does.
    glyphs: HashMap<GlyphKey, Option<GlyphEntry>>,
    exhausted: bool,
}

impl Pipeline {
    fn new(device: &ID3D11Device) -> Result<Self, String> {
        let mut shader = None;
        unsafe { device.CreatePixelShader(PIXEL_SHADER, None, Some(&mut shader)) }
            .map_err(win_error)?;
        Ok(Self {
            shader: shader.ok_or("ClearType pixel shader was not created")?,
            blend: create_blend(device)?,
            rasterizer: DWriteGlyphs::new()?,
            atlases: Vec::new(),
            glyphs: HashMap::new(),
            exhausted: false,
        })
    }

    fn allocate(&mut self, device: &ID3D11Device, width: u32, height: u32) -> Option<(usize, u32, u32)> {
        for (page, atlas) in self.atlases.iter_mut().enumerate() {
            if let Some((x, y)) = atlas.allocate(width + 1, height + 1) {
                return Some((page, x, y));
            }
        }
        if self.atlases.len() >= MAX_GLYPH_ATLASES {
            // Full: grayscale for the rest of the frame, a fresh atlas next frame.
            self.exhausted = true;
            return None;
        }
        let mut atlas = create_atlas(device).ok()?;
        let (x, y) = atlas.allocate(width + 1, height + 1)?;
        self.atlases.push(atlas);
        Some((self.atlases.len() - 1, x, y))
    }
}

#[derive(Default)]
pub(super) struct ClearType {
    pipeline: Option<Pipeline>,
    /// DirectWrite or the shader failed once: grayscale from then on.
    unavailable: bool,
    active: bool,
}

impl ClearType {
    /// Decides whether this frame draws ClearType. True when cached glyphs were
    /// dropped, so retained tiles must redraw.
    pub(super) fn begin_frame(&mut self, device: &ID3D11Device, transparent: bool) -> bool {
        self.active = !transparent && !self.unavailable && cleartype_requested();
        if self.active && self.pipeline.is_none() {
            match Pipeline::new(device) {
                Ok(pipeline) => self.pipeline = Some(pipeline),
                Err(error) => {
                    eprintln!("Tarve: ClearType text unavailable, using grayscale: {error}");
                    self.unavailable = true;
                    self.active = false;
                }
            }
        }
        match &mut self.pipeline {
            Some(pipeline) if pipeline.exhausted => {
                pipeline.glyphs.clear();
                pipeline.atlases.clear();
                pipeline.exhausted = false;
                true
            }
            _ => false,
        }
    }

    pub(super) fn active(&self) -> bool {
        self.active
    }

    /// The shader and blend state ClearType draws use.
    pub(super) fn pipeline(&self) -> Option<(&ID3D11PixelShader, &ID3D11BlendState)> {
        self.pipeline.as_ref().map(|pipeline| (&pipeline.shader, &pipeline.blend))
    }
}

impl D3d11Graphics {
    /// A glyph's ClearType mask in an atlas page. `None`: draw it in grayscale.
    pub(super) fn cleartype_entry(
        &mut self,
        font: &FontData,
        font_size: f32,
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
            coords: Vec::new(),
        };
        let pipeline = self.cleartype.pipeline.as_mut()?;
        if let Some(entry) = pipeline.glyphs.get(&key) {
            return entry.clone();
        }
        self.glyph_rasterizations += 1;
        let Some(mask) = pipeline.rasterizer.rasterize(
            font,
            physical_size,
            glyph_id,
            f32::from(subpixel_x) / 4.0,
            f32::from(subpixel_y) / 4.0,
        ) else {
            pipeline.glyphs.insert(key, None);
            return None;
        };
        let entry = if mask.width == 0 || mask.height == 0 {
            GlyphEntry { view: None, uv: [0.0; 4], left: mask.left, top: mask.top, width: 0, height: 0 }
        } else {
            let (page, x, y) = pipeline.allocate(&self.device, mask.width, mask.height)?;
            let atlas = &pipeline.atlases[page];
            upload(&self.context, &atlas._texture, x, y, &mask);
            let size = GLYPH_ATLAS_SIZE as f32;
            GlyphEntry {
                view: Some(atlas.view.clone()),
                uv: [
                    x as f32 / size,
                    y as f32 / size,
                    (x + mask.width) as f32 / size,
                    (y + mask.height) as f32 / size,
                ],
                left: mask.left,
                top: mask.top,
                width: mask.width,
                height: mask.height,
            }
        };
        pipeline.glyphs.insert(key, Some(entry.clone()));
        Some(entry)
    }
}

/// result = text × coverage + destination × (1 − coverage), per colour channel:
/// the pixel shader's second output carries the coverage.
fn create_blend(device: &ID3D11Device) -> Result<ID3D11BlendState, String> {
    let mut targets = [D3D11_RENDER_TARGET_BLEND_DESC::default(); 8];
    targets[0] = D3D11_RENDER_TARGET_BLEND_DESC {
        BlendEnable: true.into(),
        SrcBlend: D3D11_BLEND_ONE,
        DestBlend: D3D11_BLEND_INV_SRC1_COLOR,
        BlendOp: D3D11_BLEND_OP_ADD,
        SrcBlendAlpha: D3D11_BLEND_ONE,
        DestBlendAlpha: D3D11_BLEND_INV_SRC1_ALPHA,
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
    state.ok_or_else(|| "ClearType blend state was not created".into())
}

fn create_atlas(device: &ID3D11Device) -> Result<GlyphAtlas, String> {
    let zeros = vec![0_u8; (GLYPH_ATLAS_SIZE * GLYPH_ATLAS_SIZE * 4) as usize];
    let desc = D3D11_TEXTURE2D_DESC {
        Width: GLYPH_ATLAS_SIZE,
        Height: GLYPH_ATLAS_SIZE,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_R8G8B8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };
    let data = D3D11_SUBRESOURCE_DATA {
        pSysMem: zeros.as_ptr().cast(),
        SysMemPitch: GLYPH_ATLAS_SIZE * 4,
        SysMemSlicePitch: 0,
    };
    let mut texture: Option<ID3D11Texture2D> = None;
    unsafe { device.CreateTexture2D(&desc, Some(&data), Some(&mut texture)) }.map_err(win_error)?;
    let texture = texture.ok_or("ClearType glyph atlas was not created")?;
    let mut view = None;
    unsafe { device.CreateShaderResourceView(&texture, None, Some(&mut view)) }.map_err(win_error)?;
    Ok(GlyphAtlas {
        _texture: texture,
        view: view.ok_or("ClearType glyph atlas view was not created")?,
        x: 0,
        y: 0,
        row_height: 0,
    })
}

fn upload(context: &ID3D11DeviceContext, texture: &ID3D11Texture2D, x: u32, y: u32, mask: &Mask) {
    let region = D3D11_BOX {
        left: x,
        top: y,
        front: 0,
        right: x + mask.width,
        bottom: y + mask.height,
        back: 1,
    };
    unsafe {
        context.UpdateSubresource(texture, 0, Some(&region), mask.rgba.as_ptr().cast(), mask.width * 4, 0)
    };
}
