//! What the system asks of the UI: the text size (Android's font scale) and whether to animate.
//! Process-wide like the settings they mirror. The runtime reads them when its window opens
//! and when the app comes back to the foreground, and sends them to the app as an
//! `environment` event; `TARVE_FONT_SCALE` and `TARVE_REDUCED_MOTION` override them.

use crate::protocol::Node;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

static TEXT_SCALE: AtomicU32 = AtomicU32::new(0x3f80_0000);
static REDUCED_MOTION: AtomicBool = AtomicBool::new(false);

/// How much larger than its style the system wants text: 1 unless it asks otherwise.
pub(crate) fn text_scale() -> f32 {
    f32::from_bits(TEXT_SCALE.load(Ordering::Relaxed))
}

/// The system asks for no animation: style transitions apply at once.
pub(crate) fn reduced_motion() -> bool {
    REDUCED_MOTION.load(Ordering::Relaxed)
}

/// A style's `fontSize` scaled by the system's text size.
pub(crate) fn scaled(size: Option<f64>) -> Option<f32> {
    size.map(|size| size as f32 * text_scale())
}

/// A hasher seeded with the text scale: what text shapes from changes with it.
pub(crate) fn scaled_hasher() -> std::hash::DefaultHasher {
    let mut hasher = std::hash::DefaultHasher::new();
    std::hash::Hash::hash(&text_scale().to_bits(), &mut hasher);
    hasher
}

impl Node {
    /// `fontSize` (or the kind's default) scaled by the system's text size.
    pub fn font_size(&self, fallback: f32) -> f32 {
        self.number("fontSize", fallback) * text_scale()
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Environment {
    pub(crate) text_scale: f32,
    pub(crate) reduced_motion: bool,
    /// A finger, not a mouse: the app may grow its targets (CSS `pointer: coarse`).
    pub(crate) coarse_pointer: bool,
}

impl Environment {
    pub(crate) fn current() -> Self {
        Self {
            text_scale: text_scale(),
            reduced_motion: reduced_motion(),
            coarse_pointer: cfg!(target_os = "android"),
        }
    }

    pub(crate) fn event(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "environment",
            "fontScale": self.text_scale,
            "reducedMotion": self.reduced_motion,
            "pointer": if self.coarse_pointer { "coarse" } else { "fine" },
        })
    }

    /// Applies `self` process-wide; true when the text scale changed.
    pub(crate) fn apply(&self) -> bool {
        REDUCED_MOTION.store(self.reduced_motion, Ordering::Relaxed);
        let scale = self.text_scale.to_bits();
        TEXT_SCALE.swap(scale, Ordering::Relaxed) != scale
    }
}

/// The system's settings now, after the environment variable overrides.
pub(crate) fn read() -> Environment {
    let (system_scale, system_reduced) = system();
    let text_scale = std::env::var("TARVE_FONT_SCALE")
        .ok()
        .and_then(|value| value.trim().parse::<f32>().ok())
        .unwrap_or(system_scale);
    let reduced_motion = match std::env::var("TARVE_REDUCED_MOTION").as_deref() {
        Ok("1" | "true") => true,
        Ok("0" | "false") => false,
        _ => system_reduced,
    };
    Environment {
        text_scale: if text_scale.is_finite() {
            text_scale.clamp(0.5, 3.0)
        } else {
            1.0
        },
        reduced_motion,
        coarse_pointer: cfg!(target_os = "android"),
    }
}

/// Android: `Configuration.fontScale` and the developer/accessibility "remove animations"
/// (an animator duration scale of 0).
#[cfg(target_os = "android")]
fn system() -> (f32, bool) {
    crate::android::with_env(|env, activity| {
        let resources = env
            .call_method(
                activity,
                "getResources",
                "()Landroid/content/res/Resources;",
                &[],
            )?
            .l()?;
        let configuration = env
            .call_method(
                &resources,
                "getConfiguration",
                "()Landroid/content/res/Configuration;",
                &[],
            )?
            .l()?;
        let scale = env.get_field(&configuration, "fontScale", "F")?.f()?;
        let resolver = env
            .call_method(
                activity,
                "getContentResolver",
                "()Landroid/content/ContentResolver;",
                &[],
            )?
            .l()?;
        let name = env.new_string("animator_duration_scale")?;
        let animator = env
            .call_static_method(
                "android/provider/Settings$Global",
                "getFloat",
                "(Landroid/content/ContentResolver;Ljava/lang/String;F)F",
                &[(&resolver).into(), (&name).into(), 1.0_f32.into()],
            )?
            .f()?;
        Ok((scale, animator == 0.0))
    })
    .unwrap_or((1.0, false))
}

/// Windows: Settings > Accessibility > Visual effects > Animation effects.
#[cfg(windows)]
fn system() -> (f32, bool) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SPI_GETCLIENTAREAANIMATION, SystemParametersInfoW,
    };
    let mut animate: i32 = 1;
    // SAFETY: SPI_GETCLIENTAREAANIMATION writes one BOOL to the pointer.
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_GETCLIENTAREAANIMATION,
            0,
            (&mut animate as *mut i32).cast(),
            0,
        )
    };
    (1.0, ok != 0 && animate == 0)
}

#[cfg(not(any(target_os = "android", windows)))]
fn system() -> (f32, bool) {
    (1.0, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_environment_event_names_the_pointer_and_scale() {
        let event = Environment {
            text_scale: 1.3,
            reduced_motion: true,
            coarse_pointer: true,
        }
        .event();
        assert_eq!(event["type"], "environment");
        assert_eq!(event["pointer"], "coarse");
        assert_eq!(event["reducedMotion"], true);
        assert!((event["fontScale"].as_f64().unwrap() - 1.3).abs() < 1e-6);
    }
}
