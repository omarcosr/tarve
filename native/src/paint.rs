use std::{collections::HashMap, sync::Arc};

use vello::{
    Glyph, Scene,
    kurbo::{Affine, Shape, Stroke},
    peniko::{Color, Fill, FontData, ImageBrush, ImageData, ImageFormat},
};
use vello_cpu::{
    Image as CpuImage, ImageSource as CpuImageSource, Pixmap, RenderContext, Resources,
    color::PremulRgba8,
};

#[derive(Clone, Copy)]
pub(crate) struct PaintGlyph {
    pub id: u32,
    pub x: f32,
    pub y: f32,
}

pub(crate) trait PaintTarget {
    fn fill<S: Shape>(&mut self, fill: Fill, transform: Affine, color: Color, shape: &S);
    fn stroke<S: Shape>(&mut self, stroke: &Stroke, transform: Affine, color: Color, shape: &S);
    fn push_clip<S: Shape>(&mut self, fill: Fill, transform: Affine, shape: &S);
    fn pop_layer(&mut self);
    fn draw_image(&mut self, key: &str, image: &ImageData, transform: Affine);
    fn draw_glyphs(
        &mut self,
        font: &FontData,
        font_size: f32,
        normalized_coords: &[i16],
        transform: Affine,
        color: Color,
        glyphs: &[PaintGlyph],
    );
}

impl PaintTarget for Scene {
    fn fill<S: Shape>(&mut self, fill: Fill, transform: Affine, color: Color, shape: &S) {
        self.fill(fill, transform, color, None, shape);
    }

    fn stroke<S: Shape>(&mut self, stroke: &Stroke, transform: Affine, color: Color, shape: &S) {
        self.stroke(stroke, transform, color, None, shape);
    }

    fn push_clip<S: Shape>(&mut self, fill: Fill, transform: Affine, shape: &S) {
        self.push_clip_layer(fill, transform, shape);
    }

    fn pop_layer(&mut self) {
        self.pop_layer();
    }

    fn draw_image(&mut self, _key: &str, image: &ImageData, transform: Affine) {
        self.draw_image(&ImageBrush::new(image.clone()), transform);
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
        self.draw_glyphs(font)
            .font_size(font_size)
            .normalized_coords(normalized_coords)
            .transform(transform)
            .brush(color)
            .draw(
                Fill::NonZero,
                glyphs.iter().map(|glyph| Glyph {
                    id: glyph.id,
                    x: glyph.x,
                    y: glyph.y,
                }),
            );
    }
}

pub(crate) struct CpuPaintTarget<'a> {
    context: &'a mut RenderContext,
    resources: &'a mut Resources,
    images: &'a mut HashMap<String, Arc<Pixmap>>,
}

impl<'a> CpuPaintTarget<'a> {
    pub(crate) fn new(
        context: &'a mut RenderContext,
        resources: &'a mut Resources,
        images: &'a mut HashMap<String, Arc<Pixmap>>,
    ) -> Self {
        Self {
            context,
            resources,
            images,
        }
    }

    fn image_pixmap(image: &ImageData) -> Option<Pixmap> {
        let width = u16::try_from(image.width).ok()?;
        let height = u16::try_from(image.height).ok()?;
        let source = image.data.data();
        if source.len() != usize::from(width) * usize::from(height) * 4 {
            return None;
        }
        let mut pixels = Vec::with_capacity(usize::from(width) * usize::from(height));
        for pixel in source.as_chunks::<4>().0 {
            let (r, g, b, a) = match image.format {
                ImageFormat::Rgba8 => (pixel[0], pixel[1], pixel[2], pixel[3]),
                ImageFormat::Bgra8 => (pixel[2], pixel[1], pixel[0], pixel[3]),
                _ => return None,
            };
            let premultiply =
                |channel: u8| -> u8 { ((u16::from(channel) * u16::from(a) + 127) / 255) as u8 };
            let (r, g, b) = match image.alpha_type {
                vello::peniko::ImageAlphaType::Alpha => {
                    (premultiply(r), premultiply(g), premultiply(b))
                }
                vello::peniko::ImageAlphaType::AlphaPremultiplied => (r, g, b),
            };
            pixels.push(PremulRgba8::from_u8_array([r, g, b, a]));
        }
        Some(Pixmap::from_parts(pixels, width, height))
    }
}

impl PaintTarget for CpuPaintTarget<'_> {
    fn fill<S: Shape>(&mut self, fill: Fill, transform: Affine, color: Color, shape: &S) {
        self.context.set_fill_rule(fill);
        self.context.set_transform(transform);
        self.context.set_paint(color);
        self.context.fill_path(&shape.to_path(0.1));
    }

    fn stroke<S: Shape>(&mut self, stroke: &Stroke, transform: Affine, color: Color, shape: &S) {
        self.context.set_stroke(stroke.clone());
        self.context.set_transform(transform);
        self.context.set_paint(color);
        self.context.stroke_path(&shape.to_path(0.1));
    }

    fn push_clip<S: Shape>(&mut self, fill: Fill, transform: Affine, shape: &S) {
        self.context.set_fill_rule(fill);
        self.context.set_transform(transform);
        self.context.push_clip_layer(&shape.to_path(0.1));
    }

    fn pop_layer(&mut self) {
        self.context.pop_layer();
    }

    fn draw_image(&mut self, key: &str, image: &ImageData, transform: Affine) {
        if !self.images.contains_key(key)
            && let Some(pixmap) = Self::image_pixmap(image)
        {
            self.images.insert(key.to_string(), Arc::new(pixmap));
        }
        let Some(pixmap) = self.images.get(key).cloned() else {
            return;
        };
        self.context.set_transform(transform);
        self.context.set_paint(CpuImage {
            image: CpuImageSource::Pixmap(pixmap),
            sampler: vello_cpu::peniko::ImageSampler::default(),
        });
        self.context.fill_rect(&vello_cpu::kurbo::Rect::new(
            0.0,
            0.0,
            f64::from(image.width),
            f64::from(image.height),
        ));
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
        self.context.set_transform(transform);
        self.context.set_paint(color);
        self.context
            .glyph_run(self.resources, font)
            .font_size(font_size)
            .normalized_coords(normalized_coords)
            .fill_glyphs(glyphs.iter().map(|glyph| vello_cpu::Glyph {
                id: glyph.id,
                x: glyph.x,
                y: glyph.y,
            }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vello::kurbo::{Affine, Rect};

    #[test]
    fn cpu_target_rasterizes_shared_paint_commands() {
        let mut context = RenderContext::new(16, 16);
        let mut resources = Resources::new();
        let mut images = HashMap::new();
        {
            let mut target = CpuPaintTarget::new(&mut context, &mut resources, &mut images);
            target.fill(
                Fill::NonZero,
                Affine::IDENTITY,
                Color::from_rgb8(255, 0, 0),
                &Rect::new(2.0, 2.0, 14.0, 14.0),
            );
        }
        context.flush();
        let mut pixmap = Pixmap::new(16, 16);
        context.render(&mut pixmap, &mut resources);

        let center = pixmap.data()[8 * 16 + 8];
        assert_eq!(center.to_u8_array(), [255, 0, 0, 255]);
        assert_eq!(pixmap.data()[0].to_u8_array(), [0, 0, 0, 0]);
    }
}
