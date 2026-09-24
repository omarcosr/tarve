use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, Ordering},
};

use crate::paint::PaintTarget;
use resvg::usvg;
use vello::{
    kurbo::{Affine, BezPath, Cap, Join, Rect, Stroke},
    peniko::{Blob, Color, Fill, ImageAlphaType, ImageData, ImageFormat},
};

const MAX_FALLBACK_RASTER_DIMENSION: u32 = 2048;
const MAX_COLOR_TREE_CACHE_ENTRIES: usize = 4;
const MAX_RASTER_CACHE_ENTRIES: usize = 2;
const CURRENT_COLOR_ROOT: &str = "color=\"#000000\"";
const CURRENT_COLOR_MARKER: &str = "data-tarve-current-color=\"1\"";
static NEXT_FALLBACK_IMAGE_KEY: AtomicU64 = AtomicU64::new(1);

pub(crate) type SvgScene = Arc<CompiledSvg>;

pub(crate) struct CompiledSvg {
    source: Arc<str>,
    tree: Arc<usvg::Tree>,
    vector: bool,
    current_color: bool,
    scene_id: u64,
    color_trees: Mutex<Vec<(u32, Arc<usvg::Tree>)>>,
    rasters: Mutex<Vec<RasterSvg>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct RasterKey {
    width: u32,
    height: u32,
    color: u32,
}

#[derive(Clone)]
struct RasterSvg {
    cache_key: RasterKey,
    image_key: String,
    image: ImageData,
}

pub(crate) fn compile(source: &str) -> Result<SvgScene, String> {
    let tree = Arc::new(
        usvg::Tree::from_str(source, &usvg::Options::default())
            .map_err(|error| error.to_string())?,
    );
    Ok(Arc::new(CompiledSvg {
        source: Arc::from(source),
        vector: vector_compatible(tree.root()),
        current_color: source.contains(CURRENT_COLOR_MARKER) && source.contains("currentColor"),
        scene_id: NEXT_FALLBACK_IMAGE_KEY.fetch_add(1, Ordering::Relaxed),
        tree,
        color_trees: Mutex::new(Vec::new()),
        rasters: Mutex::new(Vec::new()),
    }))
}

pub(crate) fn draw<P: PaintTarget>(
    target: &mut P,
    scene: &SvgScene,
    rect: Rect,
    foreground: Color,
    device_scale: f64,
) {
    let tree = tree_for_foreground(scene, foreground);
    if !scene.vector {
        if let Some(raster) = raster_for(scene, &tree, rect, foreground, device_scale) {
            draw_raster(target, &raster, rect, device_scale);
        }
        return;
    }

    let size = tree.size();
    let width = f64::from(size.width());
    let height = f64::from(size.height());
    if width <= 0.0 || height <= 0.0 || rect.width() <= 0.0 || rect.height() <= 0.0 {
        return;
    }

    let content_scale = (rect.width() / width).min(rect.height() / height);
    let tx = rect.x0 + (rect.width() - width * content_scale) * 0.5;
    let ty = rect.y0 + (rect.height() - height * content_scale) * 0.5;
    let viewport =
        Affine::scale(device_scale) * Affine::translate((tx, ty)) * Affine::scale(content_scale);
    paint_group(target, tree.root(), viewport, 1.0);
}

fn vector_compatible(group: &usvg::Group) -> bool {
    if group.should_isolate() {
        return false;
    }

    group.children().iter().all(|node| match node {
        usvg::Node::Group(child) => vector_compatible(child),
        usvg::Node::Path(path) => {
            path.rendering_mode() == usvg::ShapeRendering::GeometricPrecision
                && path
                    .fill()
                    .is_none_or(|fill| matches!(fill.paint(), usvg::Paint::Color(_)))
                && path.stroke().is_none_or(|stroke| {
                    matches!(stroke.paint(), usvg::Paint::Color(_))
                        && stroke.linejoin() != usvg::LineJoin::MiterClip
                })
        }
        usvg::Node::Image(_) | usvg::Node::Text(_) => false,
    })
}

fn tree_for_foreground(scene: &CompiledSvg, foreground: Color) -> Arc<usvg::Tree> {
    if !scene.current_color {
        return scene.tree.clone();
    }

    let color_key = color_key(foreground);
    {
        let cache = scene
            .color_trees
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((_, tree)) = cache.iter().find(|(key, _)| *key == color_key) {
            return tree.clone();
        }
    }

    let resolved = scene.source.replacen(
        CURRENT_COLOR_ROOT,
        &format!("color=\"{}\"", css_color(foreground)),
        1,
    );
    let Ok(tree) = usvg::Tree::from_str(&resolved, &usvg::Options::default()) else {
        return scene.tree.clone();
    };
    let tree = Arc::new(tree);
    let mut cache = scene
        .color_trees
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((_, cached)) = cache.iter().find(|(key, _)| *key == color_key) {
        return cached.clone();
    }
    if cache.len() == MAX_COLOR_TREE_CACHE_ENTRIES {
        cache.remove(0);
    }
    cache.push((color_key, tree.clone()));
    tree
}

fn raster_for(
    scene: &CompiledSvg,
    tree: &usvg::Tree,
    rect: Rect,
    foreground: Color,
    device_scale: f64,
) -> Option<RasterSvg> {
    let (width, height) = raster_dimensions(tree, rect, device_scale)?;
    let cache_key = RasterKey {
        width,
        height,
        color: if scene.current_color {
            color_key(foreground)
        } else {
            0
        },
    };
    {
        let cache = scene
            .rasters
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(raster) = cache.iter().find(|raster| raster.cache_key == cache_key) {
            return Some(raster.clone());
        }
    }

    let image = rasterize(tree, width, height).ok()?;
    let raster = RasterSvg {
        cache_key,
        image_key: format!(
            "tarve-svg-fallback-{}-{}x{}-{:08x}",
            scene.scene_id, width, height, cache_key.color
        ),
        image,
    };
    let mut cache = scene
        .rasters
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(existing) = cache
        .iter()
        .find(|existing| existing.cache_key == cache_key)
    {
        return Some(existing.clone());
    }
    if cache.len() == MAX_RASTER_CACHE_ENTRIES {
        cache.remove(0);
    }
    cache.push(raster.clone());
    Some(raster)
}

fn raster_dimensions(tree: &usvg::Tree, rect: Rect, device_scale: f64) -> Option<(u32, u32)> {
    let size = tree.size();
    let intrinsic_width = f64::from(size.width());
    let intrinsic_height = f64::from(size.height());
    if intrinsic_width <= 0.0
        || intrinsic_height <= 0.0
        || rect.width() <= 0.0
        || rect.height() <= 0.0
        || !device_scale.is_finite()
        || device_scale <= 0.0
    {
        return None;
    }
    let contain = (rect.width() / intrinsic_width).min(rect.height() / intrinsic_height);
    let mut width = (intrinsic_width * contain * device_scale).ceil().max(1.0);
    let mut height = (intrinsic_height * contain * device_scale).ceil().max(1.0);
    let largest = width.max(height);
    if largest > f64::from(MAX_FALLBACK_RASTER_DIMENSION) {
        let scale = f64::from(MAX_FALLBACK_RASTER_DIMENSION) / largest;
        width = (width * scale).round().max(1.0);
        height = (height * scale).round().max(1.0);
    }
    Some((width as u32, height as u32))
}

fn rasterize(tree: &usvg::Tree, width: u32, height: u32) -> Result<ImageData, String> {
    let intrinsic = tree.size();
    let scale = (width as f32 / intrinsic.width()).min(height as f32 / intrinsic.height());
    let mut pixmap = resvg::tiny_skia::Pixmap::new(width, height)
        .ok_or_else(|| format!("SVG fallback raster target is too large: {width}x{height}"))?;
    resvg::render(
        tree,
        resvg::tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );
    Ok(ImageData {
        width,
        height,
        format: ImageFormat::Rgba8,
        alpha_type: ImageAlphaType::AlphaPremultiplied,
        data: Blob::new(Arc::new(pixmap.take())),
    })
}

fn draw_raster<P: PaintTarget>(target: &mut P, raster: &RasterSvg, rect: Rect, device_scale: f64) {
    let image = &raster.image;
    if image.width == 0 || image.height == 0 || rect.width() <= 0.0 || rect.height() <= 0.0 {
        return;
    }
    let content_scale =
        (rect.width() / f64::from(image.width)).min(rect.height() / f64::from(image.height));
    let tx = rect.x0 + (rect.width() - f64::from(image.width) * content_scale) * 0.5;
    let ty = rect.y0 + (rect.height() - f64::from(image.height) * content_scale) * 0.5;
    target.draw_image(
        &raster.image_key,
        image,
        Affine::scale(device_scale) * Affine::translate((tx, ty)) * Affine::scale(content_scale),
    );
}

fn paint_group<P: PaintTarget>(
    target: &mut P,
    group: &usvg::Group,
    viewport: Affine,
    parent_opacity: f32,
) {
    let opacity = parent_opacity * group.opacity().get();
    for node in group.children() {
        match node {
            usvg::Node::Group(child) => {
                paint_group(target, child, viewport, opacity);
            }
            usvg::Node::Path(path) if path.is_visible() => {
                paint_path(target, path, viewport, opacity);
            }
            // Svg TSX/Icon nodes do not expose embedded images or text.
            usvg::Node::Image(_) | usvg::Node::Text(_) | usvg::Node::Path(_) => {}
        }
    }
}

fn paint_path<P: PaintTarget>(target: &mut P, path: &usvg::Path, viewport: Affine, opacity: f32) {
    let shape = to_bez_path(path.data());
    let transform = viewport * to_affine(path.abs_transform());

    match path.paint_order() {
        usvg::PaintOrder::FillAndStroke => {
            paint_fill(target, path, transform, opacity, &shape);
            paint_stroke(target, path, transform, opacity, &shape);
        }
        usvg::PaintOrder::StrokeAndFill => {
            paint_stroke(target, path, transform, opacity, &shape);
            paint_fill(target, path, transform, opacity, &shape);
        }
    }
}

fn paint_fill<P: PaintTarget>(
    target: &mut P,
    path: &usvg::Path,
    transform: Affine,
    opacity: f32,
    shape: &BezPath,
) {
    let Some(fill) = path.fill() else { return };
    let Some(color) = paint_color(fill.paint(), opacity * fill.opacity().get()) else {
        return;
    };
    let rule = match fill.rule() {
        usvg::FillRule::EvenOdd => Fill::EvenOdd,
        usvg::FillRule::NonZero => Fill::NonZero,
    };
    target.fill(rule, transform, color, shape);
}

fn paint_stroke<P: PaintTarget>(
    target: &mut P,
    path: &usvg::Path,
    transform: Affine,
    opacity: f32,
    shape: &BezPath,
) {
    let Some(stroke) = path.stroke() else { return };
    let Some(color) = paint_color(stroke.paint(), opacity * stroke.opacity().get()) else {
        return;
    };
    let mut style = Stroke::new(f64::from(stroke.width().get()))
        .with_caps(match stroke.linecap() {
            usvg::LineCap::Butt => Cap::Butt,
            usvg::LineCap::Round => Cap::Round,
            usvg::LineCap::Square => Cap::Square,
        })
        .with_join(match stroke.linejoin() {
            usvg::LineJoin::Round => Join::Round,
            usvg::LineJoin::Bevel => Join::Bevel,
            usvg::LineJoin::Miter | usvg::LineJoin::MiterClip => Join::Miter,
        })
        .with_miter_limit(f64::from(stroke.miterlimit().get()));
    if let Some(dashes) = stroke.dasharray() {
        style = style.with_dashes(
            f64::from(stroke.dashoffset()),
            dashes.iter().map(|value| f64::from(*value)),
        );
    }
    target.stroke(&style, transform, color, shape);
}

fn paint_color(paint: &usvg::Paint, opacity: f32) -> Option<Color> {
    let usvg::Paint::Color(value) = paint else {
        return None;
    };
    let color = Color::from_rgb8(value.red, value.green, value.blue);
    Some(color.multiply_alpha(opacity.clamp(0.0, 1.0)))
}

fn color_key(color: Color) -> u32 {
    let rgba = color.to_rgba8();
    u32::from_be_bytes([rgba.r, rgba.g, rgba.b, rgba.a])
}

fn css_color(color: Color) -> String {
    let rgba = color.to_rgba8();
    format!("#{:02x}{:02x}{:02x}{:02x}", rgba.r, rgba.g, rgba.b, rgba.a)
}

fn to_affine(transform: usvg::Transform) -> Affine {
    Affine::new([
        f64::from(transform.sx),
        f64::from(transform.ky),
        f64::from(transform.kx),
        f64::from(transform.sy),
        f64::from(transform.tx),
        f64::from(transform.ty),
    ])
}

fn to_bez_path(path: &usvg::tiny_skia_path::Path) -> BezPath {
    use usvg::tiny_skia_path::PathSegment;

    let mut result = BezPath::new();
    for segment in path.segments() {
        match segment {
            PathSegment::MoveTo(point) => {
                result.move_to((f64::from(point.x), f64::from(point.y)));
            }
            PathSegment::LineTo(point) => {
                result.line_to((f64::from(point.x), f64::from(point.y)));
            }
            PathSegment::QuadTo(control, point) => {
                result.quad_to(
                    (f64::from(control.x), f64::from(control.y)),
                    (f64::from(point.x), f64::from(point.y)),
                );
            }
            PathSegment::CubicTo(control1, control2, point) => {
                result.curve_to(
                    (f64::from(control1.x), f64::from(control1.y)),
                    (f64::from(control2.x), f64::from(control2.y)),
                    (f64::from(point.x), f64::from(point.y)),
                );
            }
            PathSegment::Close => result.close_path(),
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usvg_normalizes_geometry_and_resolves_current_color_without_sentinel_collisions() {
        let scene = compile(
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" color="#000000" data-tarve-current-color="1" fill="none"><rect x="2" y="2" width="5" height="5" fill="#010203"/><path d="M6 12h12" stroke="currentColor"/></svg>"##,
        )
        .unwrap();
        assert!(scene.vector);
        assert!(scene.current_color);

        let resolved = tree_for_foreground(&scene, Color::from_rgba8(200, 10, 20, 128));
        assert_eq!(resolved.root().children().len(), 2);
        let usvg::Node::Path(literal) = &resolved.root().children()[0] else {
            panic!("usvg should normalize rect geometry to a path");
        };
        let literal = literal.fill().expect("literal fill");
        assert!(matches!(
            literal.paint(),
            usvg::Paint::Color(value) if (value.red, value.green, value.blue) == (1, 2, 3)
        ));

        let usvg::Node::Path(dynamic) = &resolved.root().children()[1] else {
            panic!("usvg should normalize path geometry");
        };
        let dynamic = dynamic.stroke().expect("currentColor stroke");
        assert!(matches!(
            dynamic.paint(),
            usvg::Paint::Color(value) if (value.red, value.green, value.blue) == (200, 10, 20)
        ));
        assert!((dynamic.opacity().get() - 128.0 / 255.0).abs() < 0.01);
    }

    #[test]
    fn complex_usvg_features_use_size_aware_bounded_resvg_fallback() {
        let scene = compile(
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><defs><linearGradient id="g"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient></defs><rect width="24" height="24" fill="url(#g)"/></svg>"##,
        )
        .unwrap();
        assert!(!scene.vector);
        assert!(scene.rasters.lock().unwrap().is_empty());

        let tree = tree_for_foreground(&scene, Color::from_rgb8(1, 2, 3));
        let one_x = raster_for(
            &scene,
            &tree,
            Rect::new(0.0, 0.0, 24.0, 24.0),
            Color::from_rgb8(1, 2, 3),
            1.0,
        )
        .unwrap();
        assert_eq!((one_x.image.width, one_x.image.height), (24, 24));

        let two_x = raster_for(
            &scene,
            &tree,
            Rect::new(0.0, 0.0, 24.0, 24.0),
            Color::from_rgb8(1, 2, 3),
            2.0,
        )
        .unwrap();
        assert_eq!((two_x.image.width, two_x.image.height), (48, 48));
        assert_eq!(scene.rasters.lock().unwrap().len(), 2);

        let same_two_x = raster_for(
            &scene,
            &tree,
            Rect::new(0.0, 0.0, 24.0, 24.0),
            Color::from_rgb8(1, 2, 3),
            2.0,
        )
        .unwrap();
        assert_eq!(same_two_x.image.data.id(), two_x.image.data.id());

        let large = raster_for(
            &scene,
            &tree,
            Rect::new(0.0, 0.0, 4096.0, 4096.0),
            Color::from_rgb8(1, 2, 3),
            2.0,
        )
        .unwrap();
        assert_eq!((large.image.width, large.image.height), (2048, 2048));
        assert_eq!(scene.rasters.lock().unwrap().len(), 2);
        assert!(
            large
                .image
                .data
                .data()
                .as_chunks::<4>()
                .0
                .iter()
                .any(|pixel| pixel[3] != 0)
        );
    }

    #[test]
    fn resvg_fallback_tracks_current_color_and_exact_rendering_features() {
        let scene = compile(
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8" color="#000000" data-tarve-current-color="1"><g opacity="0.5"><rect width="8" height="8" fill="currentColor"/></g></svg>"##,
        )
        .unwrap();
        assert!(!scene.vector, "group opacity requires isolated composition");

        let red = Color::from_rgb8(240, 0, 0);
        let red_tree = tree_for_foreground(&scene, red);
        let red_raster =
            raster_for(&scene, &red_tree, Rect::new(0.0, 0.0, 8.0, 8.0), red, 1.0).unwrap();
        let pixel = &red_raster.image.data.data()[(4 * 8 + 4) * 4..][..4];
        assert!(pixel[0] > 100 && pixel[1] == 0 && pixel[2] == 0 && pixel[3] > 100);

        let crisp = compile(
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><path d="M0 4h8" stroke="#fff" shape-rendering="crispEdges"/></svg>"##,
        )
        .unwrap();
        assert!(!crisp.vector);

        let miter_clip = compile(
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><path d="M0 8L4 0l4 8" fill="none" stroke="#fff" stroke-linejoin="miter-clip"/></svg>"##,
        )
        .unwrap();
        assert!(!miter_clip.vector);
    }
}
