//! DirectWrite glyph rasterization: Windows' hinting and ClearType filtering for
//! the same font bytes and glyph ids the text layout shaped with.

use std::{collections::HashMap, mem::ManuallyDrop};

use vello::peniko::FontData;
use windows::Win32::Graphics::DirectWrite::{
    DWRITE_FACTORY_TYPE_ISOLATED, DWRITE_FONT_FACE_TYPE_UNKNOWN, DWRITE_FONT_FILE_TYPE_UNKNOWN,
    DWRITE_FONT_SIMULATIONS_NONE, DWRITE_GLYPH_OFFSET, DWRITE_GLYPH_RUN,
    DWRITE_GRID_FIT_MODE_DEFAULT, DWRITE_MEASURING_MODE_NATURAL,
    DWRITE_RENDERING_MODE1_NATURAL_SYMMETRIC, DWRITE_TEXT_ANTIALIAS_MODE_CLEARTYPE,
    DWRITE_TEXTURE_CLEARTYPE_3x1, DWriteCreateFactory, IDWriteFactory5, IDWriteFontFace,
    IDWriteInMemoryFontFileLoader,
};

/// One glyph's coverage, a byte per colour channel (RGBA, alpha the average), placed
/// like a swash image: `left` from the pen, `top` above the baseline.
pub(super) struct Mask {
    pub(super) left: i32,
    pub(super) top: i32,
    pub(super) width: u32,
    pub(super) height: u32,
    pub(super) rgba: Vec<u8>,
}

pub(super) struct DWriteGlyphs {
    factory: IDWriteFactory5,
    loader: IDWriteInMemoryFontFileLoader,
    /// Per font file and face index; `None`: DirectWrite cannot read it.
    faces: HashMap<(u64, u32), Option<IDWriteFontFace>>,
    /// The system's ClearType tuning (Control Panel's "Adjust ClearType text").
    contrast: f32,
    level: f32,
}

impl DWriteGlyphs {
    /// Needs Windows 10 1703+ (in-memory font files).
    pub(super) fn new() -> Result<Self, String> {
        let error = |error: windows::core::Error| format!("DirectWrite: {error}");
        let factory: IDWriteFactory5 =
            unsafe { DWriteCreateFactory(DWRITE_FACTORY_TYPE_ISOLATED) }.map_err(error)?;
        let loader = unsafe { factory.CreateInMemoryFontFileLoader() }.map_err(error)?;
        unsafe { factory.RegisterFontFileLoader(&loader) }.map_err(error)?;
        let params = unsafe { factory.CreateRenderingParams() }.map_err(error)?;
        let (contrast, level) =
            unsafe { (params.GetEnhancedContrast(), params.GetClearTypeLevel()) };
        Ok(Self {
            factory,
            loader,
            faces: HashMap::new(),
            contrast: contrast.max(0.0),
            level: level.clamp(0.0, 1.0),
        })
    }

    fn face(&mut self, font: &FontData) -> Option<IDWriteFontFace> {
        let key = (font.data.id(), font.index);
        if let Some(face) = self.faces.get(&key) {
            return face.clone();
        }
        let face = self.create_face(font);
        self.faces.insert(key, face.clone());
        face
    }

    fn create_face(&self, font: &FontData) -> Option<IDWriteFontFace> {
        let bytes = font.data.data();
        // No owner object: DirectWrite keeps its own copy of the bytes.
        let file = unsafe {
            self.loader.CreateInMemoryFontFileReference(
                &self.factory,
                bytes.as_ptr().cast(),
                u32::try_from(bytes.len()).ok()?,
                None,
            )
        }
        .ok()?;
        let mut supported = Default::default();
        let mut file_type = DWRITE_FONT_FILE_TYPE_UNKNOWN;
        let mut face_type = DWRITE_FONT_FACE_TYPE_UNKNOWN;
        let mut faces = 0;
        unsafe { file.Analyze(&mut supported, &mut file_type, Some(&mut face_type), &mut faces) }
            .ok()?;
        if !supported.as_bool() || font.index >= faces {
            return None;
        }
        unsafe {
            self.factory
                .CreateFontFace(face_type, &[Some(file)], font.index, DWRITE_FONT_SIMULATIONS_NONE)
        }
        .ok()
    }

    /// Rasterizes glyph `glyph_id` at `size` physical pixels, its pen moved by
    /// (`offset_x`, `offset_y`) pixels. `None`: the font or glyph is not DirectWrite's to draw.
    pub(super) fn rasterize(
        &mut self,
        font: &FontData,
        size: f32,
        glyph_id: u32,
        offset_x: f32,
        offset_y: f32,
    ) -> Option<Mask> {
        let face = self.face(font)?;
        let index = u16::try_from(glyph_id).ok()?;
        let advance = 0.0_f32;
        let offset = DWRITE_GLYPH_OFFSET::default();
        let run = DWRITE_GLYPH_RUN {
            fontFace: ManuallyDrop::new(Some(face)),
            fontEmSize: size,
            glyphCount: 1,
            glyphIndices: &index,
            glyphAdvances: &advance,
            glyphOffsets: &offset,
            isSideways: false.into(),
            bidiLevel: 0,
        };
        let analysis = unsafe {
            self.factory.CreateGlyphRunAnalysis(
                &run,
                None,
                DWRITE_RENDERING_MODE1_NATURAL_SYMMETRIC,
                DWRITE_MEASURING_MODE_NATURAL,
                DWRITE_GRID_FIT_MODE_DEFAULT,
                DWRITE_TEXT_ANTIALIAS_MODE_CLEARTYPE,
                offset_x,
                offset_y,
            )
        };
        drop(ManuallyDrop::into_inner(run.fontFace));
        let analysis = analysis.ok()?;
        let bounds = unsafe { analysis.GetAlphaTextureBounds(DWRITE_TEXTURE_CLEARTYPE_3x1) }.ok()?;
        let width = u32::try_from(bounds.right - bounds.left).unwrap_or(0);
        let height = u32::try_from(bounds.bottom - bounds.top).unwrap_or(0);
        if width == 0 || height == 0 {
            return Some(Mask { left: bounds.left, top: -bounds.top, width: 0, height: 0, rgba: Vec::new() });
        }
        let mut rgb = vec![0_u8; width as usize * height as usize * 3];
        unsafe { analysis.CreateAlphaTexture(DWRITE_TEXTURE_CLEARTYPE_3x1, &bounds, &mut rgb) }
            .ok()?;
        Some(Mask {
            left: bounds.left,
            top: -bounds.top,
            width,
            height,
            rgba: self.tune(&rgb),
        })
    }

    /// RGB coverage to RGBA with the system's ClearType level (colour fringe) and
    /// enhanced contrast (stem darkening), as Direct2D applies them.
    fn tune(&self, rgb: &[u8]) -> Vec<u8> {
        let k = self.contrast;
        let contrast = |c: f32| c * (k + 1.0) / (c * k + 1.0);
        let mut rgba = Vec::with_capacity(rgb.len() / 3 * 4);
        for pixel in rgb.as_chunks::<3>().0 {
            let [r, g, b] = pixel.map(|c| f32::from(c) / 255.0);
            let average = (r + g + b) / 3.0;
            let channel = |c: f32| {
                let c = average + (c - average) * self.level;
                (contrast(c.clamp(0.0, 1.0)) * 255.0).round() as u8
            };
            rgba.extend_from_slice(&[channel(r), channel(g), channel(b), channel(average)]);
        }
        rgba
    }
}

impl Drop for DWriteGlyphs {
    fn drop(&mut self) {
        let _ = unsafe { self.factory.UnregisterFontFileLoader(&self.loader) };
    }
}
