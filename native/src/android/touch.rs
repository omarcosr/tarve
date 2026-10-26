//! Touch as a mouse, with Android's gestures: a tap clicks; a finger that moves past the touch
//! slop scrolls along the axis it started on (or drags a slider, a splitter or a `draggable`
//! under it); a finger held still for a long press presses and drags (text selection); a swipe
//! keeps scrolling after the finger lifts with Android's fling curve.
//!
//! Scrolling follows the finger's position and the fling follows the clock, whatever the frame
//! rate: frames only sample them.

use std::sync::Mutex;
use std::time::{Duration, Instant};
use winit::dpi::PhysicalPosition;
use winit::event::{
    DeviceId, ElementState, MouseButton, MouseScrollDelta, Touch, TouchPhase, WindowEvent,
};

/// Movement (dp) after which a touch scrolls or drags instead of tapping (ViewConfiguration).
const SLOP: f64 = 8.0;
/// A finger held this long without passing the slop presses (ViewConfiguration's long press).
const LONG_PRESS: Duration = Duration::from_millis(400);
/// Fling speeds (dp/s) Android starts with and caps at (ViewConfiguration).
const FLING_MIN: f64 = 50.0;
const FLING_MAX: f64 = 8000.0;
/// The finger samples the release velocity is fitted over (VelocityTracker's horizon).
const HORIZON: Duration = Duration::from_millis(100);

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Pending,
    Pressed,
    Scrolling,
}

struct Gesture {
    id: u64,
    start: PhysicalPosition<f64>,
    last: PhysicalPosition<f64>,
    began: Instant,
    mode: Mode,
    /// The axis a scroll moves along, (x, y): the one the swipe started mostly along, kept until
    /// the finger lifts, so a vertical swipe over a horizontal list scrolls only the page.
    axes: (f64, f64),
    /// Recent finger positions, for the release velocity.
    samples: Vec<(Instant, PhysicalPosition<f64>)>,
    /// The touch stopped a fling: lifting it does not click.
    caught_fling: bool,
}

/// A fling: the platform's OverScroller (`android::fling`), or AOSP's curve without a JVM.
struct Fling {
    device: DeviceId,
    curve: Curve,
}

enum Curve {
    Platform(super::fling::PlatformFling),
    Spline(Spline),
}

/// AOSP's OverScroller spline: it covers `distance` over `duration`, its speed falling as
/// (1 - t/T)^(N-1), starting at the finger's release velocity.
struct Spline {
    started: Instant,
    duration: f64,
    /// Total travel (px), signed per axis, and what was already scrolled.
    distance: (f64, f64),
    done: f64,
}

const FLING_EXPONENT: f64 = 2.857;

impl Spline {
    /// Android's fling for a release speed of `speed` dp/s along the unit `direction`.
    fn new(speed: f64, direction: (f64, f64), scale: f64) -> Self {
        // OverScroller: deceleration ln(0.78)/ln(0.9), inflexion 0.35, friction 0.015, gravity
        // in dp: 9.80665 * 39.37 * 160 * 0.84.
        let decel = 0.78f64.ln() / 0.9f64.ln();
        let friction = 0.015 * 9.80665 * 39.37 * 160.0 * 0.84;
        let l = (0.35 * speed / friction).ln();
        let distance = friction * (decel / (decel - 1.0) * l).exp() * scale;
        Self {
            started: Instant::now(),
            duration: (l / (decel - 1.0)).exp(),
            distance: (distance * direction.0, distance * direction.1),
            done: 0.0,
        }
    }

    /// The scroll since the last step, and whether the fling has ended.
    fn step(&mut self) -> ((f64, f64), bool) {
        let t = (self.started.elapsed().as_secs_f64() / self.duration).min(1.0);
        let reached = 1.0 - (1.0 - t).powf(FLING_EXPONENT);
        let part = reached - self.done;
        self.done = reached;
        ((self.distance.0 * part, self.distance.1 * part), t >= 1.0)
    }
}

/// The finger driving the pointer and a running fling (the event loop's thread only).
static GESTURE: Mutex<Option<Gesture>> = Mutex::new(None);
static FLING: Mutex<Option<Fling>> = Mutex::new(None);
/// Where the scroll in progress started: its events go to the scroll area under the finger's
/// first touch, as on Android, and hover nothing (a touch screen has no hover).
static ORIGIN: Mutex<Option<PhysicalPosition<f64>>> = Mutex::new(None);

/// The point the scroll events of the current swipe or fling target.
pub(crate) fn scroll_origin() -> Option<PhysicalPosition<f64>> {
    *ORIGIN.lock().unwrap_or_else(|p| p.into_inner())
}

/// The next step of a running fling (once a frame), or nothing once it has stopped.
pub(crate) fn fling_step() -> Vec<WindowEvent> {
    let mut fling = FLING.lock().unwrap_or_else(|p| p.into_inner());
    let Some(f) = fling.as_mut() else {
        return vec![];
    };
    let ((dx, dy), ended) = match &mut f.curve {
        Curve::Platform(platform) => platform.step(),
        Curve::Spline(spline) => spline.step(),
    };
    let device = f.device;
    if ended {
        *fling = None;
        return vec![
            scroll(device, dx, dy, TouchPhase::Ended),
            WindowEvent::CursorLeft { device_id: device },
        ];
    }
    vec![scroll(device, dx, dy, TouchPhase::Moved)]
}

/// Stops a running fling (it ran into an end).
pub(crate) fn stop_fling() {
    *FLING.lock().unwrap_or_else(|p| p.into_inner()) = None;
}

/// Whether a fling is running (the event loop keeps drawing frames for it).
pub(crate) fn flinging() -> bool {
    FLING.lock().unwrap_or_else(|p| p.into_inner()).is_some()
}

fn moved(device_id: DeviceId, position: PhysicalPosition<f64>) -> WindowEvent {
    WindowEvent::CursorMoved {
        device_id,
        position,
    }
}

fn button(device_id: DeviceId, state: ElementState) -> WindowEvent {
    WindowEvent::MouseInput {
        device_id,
        state,
        button: MouseButton::Left,
    }
}

fn scroll(device_id: DeviceId, x: f64, y: f64, phase: TouchPhase) -> WindowEvent {
    WindowEvent::MouseWheel {
        device_id,
        delta: MouseScrollDelta::PixelDelta(PhysicalPosition::new(x, y)),
        phase,
    }
}

/// The finger's velocity (px/s) at release: a least-squares line through the samples of the
/// last `HORIZON`, as Android's VelocityTracker fits them. Zero when it had stopped.
fn release_velocity(samples: &[(Instant, PhysicalPosition<f64>)]) -> (f64, f64) {
    let Some(&(last, _)) = samples.last() else {
        return (0.0, 0.0);
    };
    // Android drops the velocity of a finger still for 40 ms; samples here carry their arrival
    // time, a frame or two after the touch, so the margin is wider.
    if last.elapsed() > Duration::from_millis(80) {
        return (0.0, 0.0);
    }
    let recent: Vec<(f64, f64, f64)> = samples
        .iter()
        .filter(|(at, _)| last.duration_since(*at) <= HORIZON)
        .map(|(at, p)| (-(last.duration_since(*at).as_secs_f64()), p.x, p.y))
        .collect();
    let n = recent.len() as f64;
    let mean_t = recent.iter().map(|s| s.0).sum::<f64>() / n;
    let spread: f64 = recent.iter().map(|s| (s.0 - mean_t).powi(2)).sum();
    if recent.len() < 2 || spread < 1e-6 {
        return (0.0, 0.0);
    }
    let slope = |pick: fn(&(f64, f64, f64)) -> f64| {
        let mean = recent.iter().map(pick).sum::<f64>() / n;
        recent
            .iter()
            .map(|s| (s.0 - mean_t) * (pick(s) - mean))
            .sum::<f64>()
            / spread
    };
    (slope(|s| s.1), slope(|s| s.2))
}

/// The mouse events one touch stands for. `scale` is the window's pixels per dp;
/// `drags_under` says whether a finger first put down at that point is over something a
/// moving finger drags (a slider, a splitter, a `draggable`) rather than scrolls.
pub(crate) fn translate(
    touch: &Touch,
    scale: f64,
    drags_under: impl FnOnce(PhysicalPosition<f64>) -> bool,
) -> Vec<WindowEvent> {
    let device = touch.device_id;
    let position = touch.location;
    let mut gesture = GESTURE.lock().unwrap_or_else(|p| p.into_inner());
    // One finger drives the pointer; the others are ignored until it lifts.
    if gesture.as_ref().is_some_and(|g| g.id != touch.id) {
        return vec![];
    }
    match touch.phase {
        TouchPhase::Started => {
            // A finger on the screen stops a fling, as on Android, without clicking.
            let caught_fling = FLING
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .take()
                .is_some();
            *gesture = Some(Gesture {
                id: touch.id,
                start: position,
                last: position,
                began: Instant::now(),
                mode: Mode::Pending,
                axes: (1.0, 1.0),
                samples: vec![(Instant::now(), position)],
                caught_fling,
            });
            vec![]
        }
        TouchPhase::Moved => {
            let Some(g) = gesture.as_mut() else {
                return vec![];
            };
            let now = Instant::now();
            g.samples
                .retain(|(at, _)| now.duration_since(*at) <= HORIZON * 2);
            g.samples.push((now, position));
            let (sx, sy) = (position.x - g.start.x, position.y - g.start.y);
            let slop = SLOP * scale;
            let events = match g.mode {
                Mode::Pending if sx.hypot(sy) > slop && drags_under(g.start) => {
                    g.mode = Mode::Pressed;
                    vec![
                        moved(device, g.start),
                        button(device, ElementState::Pressed),
                        moved(device, position),
                    ]
                }
                Mode::Pending if sx.hypot(sy) > slop => {
                    g.mode = Mode::Scrolling;
                    *ORIGIN.lock().unwrap_or_else(|p| p.into_inner()) = Some(g.start);
                    // The scroll starts from where the finger crossed the slop, so it does not jump.
                    let (x, y) = if sy.abs() >= sx.abs() {
                        g.axes = (0.0, 1.0);
                        (0.0, sy - slop.copysign(sy))
                    } else {
                        g.axes = (1.0, 0.0);
                        (sx - slop.copysign(sx), 0.0)
                    };
                    vec![scroll(device, x, y, TouchPhase::Started)]
                }
                Mode::Pending if g.began.elapsed() >= LONG_PRESS => {
                    g.mode = Mode::Pressed;
                    vec![
                        moved(device, g.start),
                        button(device, ElementState::Pressed),
                        moved(device, position),
                    ]
                }
                Mode::Pending => vec![],
                Mode::Pressed => vec![moved(device, position)],
                Mode::Scrolling => {
                    let (dx, dy) = (position.x - g.last.x, position.y - g.last.y);
                    vec![scroll(
                        device,
                        dx * g.axes.0,
                        dy * g.axes.1,
                        TouchPhase::Moved,
                    )]
                }
            };
            if g.mode != Mode::Pending {
                g.last = position;
            }
            events
        }
        TouchPhase::Ended => {
            let Some(g) = gesture.take() else {
                return vec![];
            };
            let leave = WindowEvent::CursorLeft { device_id: device };
            match g.mode {
                Mode::Pending if g.caught_fling => vec![leave],
                Mode::Pending => vec![
                    moved(device, position),
                    button(device, ElementState::Pressed),
                    button(device, ElementState::Released),
                    leave,
                ],
                Mode::Pressed => vec![
                    moved(device, position),
                    button(device, ElementState::Released),
                    leave,
                ],
                Mode::Scrolling => {
                    // The lift's position counts, as Android's VelocityTracker adds ACTION_UP,
                    // and the content follows the finger to it.
                    let mut samples = g.samples;
                    samples.push((Instant::now(), position));
                    let rest = (
                        (position.x - g.last.x) * g.axes.0,
                        (position.y - g.last.y) * g.axes.1,
                    );
                    let (vx, vy) = release_velocity(&samples);
                    let (vx, vy) = (vx * g.axes.0, vy * g.axes.1);
                    let speed = vx.hypot(vy) / scale;
                    let rest = scroll(device, rest.0, rest.1, TouchPhase::Moved);
                    if speed < FLING_MIN {
                        return vec![rest, scroll(device, 0.0, 0.0, TouchPhase::Ended), leave];
                    }
                    // A fling continues the finger's direction, as its moves did.
                    let capped = speed.min(FLING_MAX) / speed;
                    let velocity = (vx * capped, vy * capped);
                    let direction = (vx / vx.hypot(vy), vy / vx.hypot(vy));
                    let curve = super::fling::PlatformFling::start(velocity).map_or_else(
                        || Curve::Spline(Spline::new(speed.min(FLING_MAX), direction, scale)),
                        Curve::Platform,
                    );
                    *FLING.lock().unwrap_or_else(|p| p.into_inner()) =
                        Some(Fling { device, curve });
                    vec![rest]
                }
            }
        }
        TouchPhase::Cancelled => match gesture.take().map(|g| g.mode) {
            Some(Mode::Pressed) => vec![
                button(device, ElementState::Released),
                WindowEvent::CursorLeft { device_id: device },
            ],
            Some(_) => vec![WindowEvent::CursorLeft { device_id: device }],
            None => vec![],
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fling_matches_android_overscroller() {
        let mut fling = Spline::new(3000.0, (0.0, 1.0), 1.0);
        // OverScroller flings 3000 dp/s about 1.3k dp over about 1.25 s.
        assert!(
            (fling.distance.1 - 1310.0).abs() < 20.0,
            "{}",
            fling.distance.1
        );
        assert!((fling.duration - 1.247).abs() < 0.02, "{}", fling.duration);
        // Its starting speed is the release speed.
        let initial = fling.distance.1 * FLING_EXPONENT / fling.duration;
        assert!((initial - 3000.0).abs() < 60.0, "{initial}");
        fling.started -= Duration::from_secs(2);
        let ((_, dy), ended) = fling.step();
        assert!(ended && (dy - fling.distance.1).abs() < 1e-6);
    }

    #[test]
    fn release_velocity_fits_the_recent_samples() {
        let now = Instant::now();
        let samples: Vec<_> = (0..10)
            .map(|i| {
                (
                    now - Duration::from_millis(90 - i * 10),
                    PhysicalPosition::new(0.0, i as f64 * 20.0),
                )
            })
            .collect();
        let (vx, vy) = release_velocity(&samples);
        assert!(vx.abs() < 1e-6 && (vy - 2000.0).abs() < 1.0, "{vy}");
    }
}
