//! Slider geometry, shared by painting (`tree/slider.rs`) and pointer hit-testing so
//! the thumb is always where a press puts it.
use vello::kurbo::{Point, Rect};

/// Track inset from the box ends when `trackThickness` is a number (room for the default thumb).
pub(crate) const DEFAULT_TRACK_INSET: f64 = 8.0;
pub(crate) const DEFAULT_TRACK_THICKNESS: f64 = 4.0;
pub(crate) const DEFAULT_THUMB_SIZE: f64 = 14.0;

/// The slider's resolved sizes (CSS px), from its style for the current state.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct SliderMetrics {
    /// Track thickness across the axis; `None` fills the box (`trackThickness: "fill"`).
    pub thickness: Option<f64>,
    /// Distance from the box's ends to the track's ends along the axis.
    pub inset: f64,
    /// Thumb box (width, height) in screen axes; 0 in either hides it.
    pub thumb: (f64, f64),
}

impl Default for SliderMetrics {
    fn default() -> Self {
        Self {
            thickness: Some(DEFAULT_TRACK_THICKNESS),
            inset: DEFAULT_TRACK_INSET,
            thumb: (DEFAULT_THUMB_SIZE, DEFAULT_THUMB_SIZE),
        }
    }
}

impl SliderMetrics {
    pub(crate) fn thumb_visible(&self) -> bool {
        self.thumb.0 > 0.0 && self.thumb.1 > 0.0
    }
}

/// Where the track, the filled part and the thumb sit for a value.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct SliderGeometry {
    pub track: Rect,
    /// From the track's start (left, or bottom when vertical) to the thumb's centre.
    pub fill: Rect,
    pub thumb: Rect,
    pub center: Point,
    pub vertical: bool,
    /// The thumb centre's travel along the axis: (at min, at max).
    travel: (f64, f64),
}

impl SliderGeometry {
    /// The thumb's centre travels the track, kept inside the box: when the thumb is
    /// longer than the inset its centre stops half a thumb from the box's ends (CSS
    /// `input[type=range]`); a hidden thumb lets the fill reach both ends.
    pub(crate) fn new(rect: Rect, vertical: bool, ratio: f64, metrics: &SliderMetrics) -> Self {
        let ratio = if ratio.is_finite() {
            ratio.clamp(0.0, 1.0)
        } else {
            0.0
        };
        let (along, cross) = if vertical {
            (rect.height(), rect.width())
        } else {
            (rect.width(), rect.height())
        };
        let thickness = metrics
            .thickness
            .unwrap_or(cross)
            .clamp(0.0, cross.max(0.0));
        let inset = metrics.inset.clamp(0.0, (along / 2.0).max(0.0));
        let length = (along - 2.0 * inset).max(0.0);
        let thumb_along = if metrics.thumb_visible() {
            if vertical {
                metrics.thumb.1
            } else {
                metrics.thumb.0
            }
        } else {
            0.0
        };
        let pad = (thumb_along / 2.0 - inset).clamp(0.0, length / 2.0);
        let (thumb_w, thumb_h) = if metrics.thumb_visible() {
            metrics.thumb
        } else {
            (0.0, 0.0)
        };
        if vertical {
            let x = rect.center().x;
            let track = Rect::new(
                x - thickness / 2.0,
                rect.y0 + inset,
                x + thickness / 2.0,
                rect.y1 - inset,
            );
            let travel = (track.y1 - pad, track.y0 + pad);
            let y = travel.0 + (travel.1 - travel.0) * ratio;
            Self {
                track,
                fill: Rect::new(track.x0, y, track.x1, track.y1),
                thumb: Rect::from_center_size((x, y), (thumb_w, thumb_h)),
                center: Point::new(x, y),
                vertical,
                travel,
            }
        } else {
            let y = rect.center().y;
            let track = Rect::new(
                rect.x0 + inset,
                y - thickness / 2.0,
                rect.x1 - inset,
                y + thickness / 2.0,
            );
            let travel = (track.x0 + pad, track.x1 - pad);
            let x = travel.0 + (travel.1 - travel.0) * ratio;
            Self {
                track,
                fill: Rect::new(track.x0, track.y0, x, track.y1),
                thumb: Rect::from_center_size((x, y), (thumb_w, thumb_h)),
                center: Point::new(x, y),
                vertical,
                travel,
            }
        }
    }

    /// The value ratio (0..=1) a pointer at `point` sets.
    pub(crate) fn ratio_at(&self, point: Point) -> f64 {
        let (start, end) = self.travel;
        let position = if self.vertical { point.y } else { point.x };
        let span = end - start;
        if span.abs() < 1.0 {
            // No travel to speak of (a box no longer than its thumb): the nearer end.
            return if (position - start).abs() <= (position - end).abs() {
                0.0
            } else {
                1.0
            };
        }
        ((position - start) / span).clamp(0.0, 1.0)
    }
}
