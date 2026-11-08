//! Retained scrolling on the CPU renderer: a frame that scrolls moves the pixels drawn before
//! and redraws only the rest, and the result is the frame drawn whole.
use super::*;
use crate::cpu_display::{CpuRecorder, ScrollBlit, merge_regions, scroll_damage};
use crate::paint::{GradientGeometry, PaintGradient, PaintTarget};
use vello::kurbo::{Affine, Circle, Rect, RoundedRect, Stroke, Vec2};
use vello::peniko::{Color, Fill};

const W: usize = 256;
const H: usize = 192;
const CLIP: Rect = Rect::new(16.0, 16.0, 240.0, 176.0);
const BACKGROUND: Color = Color::from_rgb8(250, 250, 250);

fn record(paint: impl FnOnce(&mut CpuRecorder<'_>)) -> DisplayList {
    let mut images = HashMap::new();
    let mut recorder = CpuRecorder::new(&mut images);
    paint(&mut recorder);
    recorder.finish()
}

fn draw(list: &DisplayList, frame: &mut [u32], region: Rect) {
    let mut context = CpuRenderContext::new(W as u16, H as u16);
    let mut resources = CpuResources::new();
    rasterize_cpu_region(
        &mut context,
        &mut resources,
        list,
        CpuFrame {
            pixels: frame,
            width: W,
            height: H,
            alpha: false,
        },
        &mut Vec::new(),
        None,
        region,
        BACKGROUND,
        None,
        Some(&mut crate::cpu_display::GlyphMasks::new()),
    );
}

fn full_frame(list: &DisplayList) -> Vec<u32> {
    let mut frame = vec![0_u32; W * H];
    draw(list, &mut frame, Rect::new(0.0, 0.0, W as f64, H as f64));
    frame
}

/// What paints a scroll container: a backdrop, rows (with rounded corners and circles, so
/// their edges are antialiased) in content coordinates, and a thumb over them.
struct Scene {
    offset: Vec2,
    gradient_backdrop: bool,
    changed_row: Option<usize>,
}

impl Scene {
    fn at(x: f64, y: f64) -> Self {
        Self {
            offset: Vec2::new(x, y),
            gradient_backdrop: false,
            changed_row: None,
        }
    }

    fn record(&self) -> DisplayList {
        record(|target| {
            let all = Rect::new(0.0, 0.0, W as f64, H as f64);
            if self.gradient_backdrop {
                let gradient = PaintGradient {
                    geometry: GradientGeometry::Linear {
                        start: (0.0, 0.0).into(),
                        end: (0.0, H as f64).into(),
                    },
                    stops: vec![
                        (0.0, Color::from_rgb8(255, 255, 255)),
                        (1.0, Color::from_rgb8(0, 0, 80)),
                    ],
                    repeat: false,
                };
                target.fill_gradient(Affine::IDENTITY, &gradient, &all);
            } else {
                target.fill(Fill::NonZero, Affine::IDENTITY, Color::from_rgb8(30, 30, 36), &all);
            }
            // A window border around everything, as a frameless window draws it.
            target.stroke(
                &Stroke::new(1.25),
                Affine::IDENTITY,
                Color::from_rgb8(90, 90, 90),
                &RoundedRect::new(0.625, 0.625, W as f64 - 0.625, H as f64 - 0.625, 8.0),
            );
            target.push_clip(Fill::NonZero, Affine::IDENTITY, &CLIP);
            assert!(target.scroll_begin(7, CLIP, self.offset));
            for row in 0..30 {
                let y = CLIP.y0 + row as f64 * 24.0;
                let x = CLIP.x0 + (row % 4) as f64 * 9.5;
                let color = if self.changed_row == Some(row) {
                    Color::from_rgb8(255, 40, 40)
                } else {
                    Color::from_rgb8(60 + row as u8 * 5, 120, 200 - row as u8 * 4)
                };
                target.fill(
                    Fill::NonZero,
                    Affine::IDENTITY,
                    color,
                    &RoundedRect::new(x, y + 2.5, x + 300.0, y + 20.5, 5.0),
                );
                target.stroke(
                    &Stroke::new(1.5),
                    Affine::IDENTITY,
                    Color::from_rgb8(240, 240, 240),
                    &Circle::new((x + 12.0, y + 11.5), 6.0),
                );
            }
            target.scroll_end();
            target.pop_layer();
            let top = CLIP.y0 + 4.0 + self.offset.y * 0.1;
            target.fill(
                Fill::NonZero,
                Affine::IDENTITY,
                Color::from_rgb8(200, 200, 200),
                &RoundedRect::new(CLIP.x1 - 7.0, top, CLIP.x1 - 3.0, top + 40.0, 2.0),
            );
        })
    }
}

/// Moves and redraws from `before` to `after` as the renderer does, checks that it gives the
/// frame drawn whole, and returns the area redrawn.
fn assert_scroll_matches(before: &Scene, after: &Scene) -> f64 {
    let (before, after) = (before.record(), after.record());
    let mut frame = full_frame(&before);
    let (blits, regions) =
        scroll_damage(&before, &after).expect("a frame that only scrolls moves pixels");
    for blit in &blits {
        blit.apply(&mut frame, W, H);
    }
    let regions: Vec<Rect> = merge_regions(regions)
        .into_iter()
        .map(|rect| cpu_redraw_region(rect, W as u32, H as u32))
        .collect();
    for region in &regions {
        draw(&after, &mut frame, *region);
    }
    let expected = full_frame(&after);
    let delta = |a: u32, b: u32| {
        [0, 8, 16]
            .iter()
            .map(|shift| (((a >> shift) & 255) as i32 - ((b >> shift) & 255) as i32).abs())
            .max()
            .unwrap_or(0)
    };
    // An edge moved sideways into another tile column can round its coverage one step of 255
    // differently (the rasterizer's tiling, as a partial redraw's first column): no more.
    let wrong: Vec<usize> = (0..W * H)
        .filter(|&i| delta(frame[i], expected[i]) > 1)
        .collect();
    let worst = wrong.iter().map(|&i| delta(frame[i], expected[i])).max().unwrap_or(0);
    if let (Some(first), Some(last)) = (wrong.first(), wrong.last()) {
        panic!(
            "{} pixels differ from a full redraw (by up to {worst}), from {},{} to {},{} (regions {regions:?})",
            wrong.len(),
            first % W,
            first / W,
            last % W,
            last / W
        );
    }
    regions.iter().map(|rect| rect.area()).sum()
}

#[test]
fn scrolling_down_and_up_moves_pixels_and_redraws_only_the_strip_and_the_thumb() {
    let clip = CLIP.area();
    for (from, to) in [(0.0, 13.0), (13.0, 41.0), (41.0, 7.0), (120.0, 119.0)] {
        let area = assert_scroll_matches(&Scene::at(0.0, from), &Scene::at(0.0, to));
        assert!(
            area < clip * 0.5,
            "scrolling {from} -> {to} redrew {area} px² of a {clip} px² view"
        );
    }
}

#[test]
fn scrolling_sideways_moves_pixels_too() {
    let area = assert_scroll_matches(&Scene::at(0.0, 30.0), &Scene::at(17.0, 30.0));
    assert!(area < CLIP.area() * 0.5, "redrew {area} px²");
    assert_scroll_matches(&Scene::at(17.0, 30.0), &Scene::at(3.0, 30.0));
}

#[test]
fn content_that_changes_while_scrolling_is_redrawn() {
    let mut after = Scene::at(0.0, 20.0);
    after.changed_row = Some(2);
    assert_scroll_matches(&Scene::at(0.0, 0.0), &after);
}

#[test]
fn a_backdrop_that_differs_from_pixel_to_pixel_cannot_move_with_the_content() {
    let mut before = Scene::at(0.0, 0.0);
    before.gradient_backdrop = true;
    let mut after = Scene::at(0.0, 10.0);
    after.gradient_backdrop = true;
    assert!(scroll_damage(&before.record(), &after.record()).is_none());
}

#[test]
fn a_scroll_past_the_whole_view_redraws_instead_of_moving() {
    assert!(scroll_damage(&Scene::at(0.0, 0.0).record(), &Scene::at(0.0, 400.0).record()).is_none());
}

#[test]
fn pixel_moves_go_both_ways_without_reading_moved_pixels() {
    let (width, height) = (6, 5);
    let source: Vec<u32> = (0..(width * height) as u32).collect();
    let rect = Rect::new(1.0, 1.0, 5.0, 4.0);
    for (dx, dy) in [(0.0, 1.0), (0.0, -1.0), (1.0, 0.0), (-2.0, 0.0), (1.0, -1.0)] {
        let mut pixels = source.clone();
        ScrollBlit { rect, dx, dy }.apply(&mut pixels, width, height);
        for y in 0..height {
            for x in 0..width {
                let (sx, sy) = (x as f64 - dx, y as f64 - dy);
                let inside = |px: f64, py: f64| (1.0..5.0).contains(&px) && (1.0..4.0).contains(&py);
                let expected = if inside(x as f64, y as f64) && inside(sx, sy) {
                    source[sy as usize * width + sx as usize]
                } else {
                    source[y * width + x]
                };
                assert_eq!(pixels[y * width + x], expected, "move {dx},{dy} at {x},{y}");
            }
        }
    }
}
