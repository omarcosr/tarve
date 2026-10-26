//! The platform's own fling (android.widget.OverScroller, created with the activity): the
//! distance and slow-down of a swipe match the device's other apps, including vendor tuning
//! (One UI flings about 1.75x farther than AOSP's curve).
use super::with_env;
use jni::objects::{GlobalRef, JValue};

pub(crate) struct PlatformFling {
    scroller: GlobalRef,
    last: (i32, i32),
}

const RANGE: i32 = 1 << 28;

impl PlatformFling {
    /// A fling at `velocity` px/s (the finger's direction); None without a JVM.
    pub(crate) fn start(velocity: (f64, f64)) -> Option<Self> {
        with_env(|env, activity| {
            let scroller = env.new_object(
                "android/widget/OverScroller",
                "(Landroid/content/Context;)V",
                &[JValue::Object(activity)],
            )?;
            let ints = [
                0,
                0,
                velocity.0 as i32,
                velocity.1 as i32,
                -RANGE,
                RANGE,
                -RANGE,
                RANGE,
            ];
            let args: Vec<JValue> = ints.iter().map(|value| JValue::Int(*value)).collect();
            env.call_method(&scroller, "fling", "(IIIIIIII)V", &args)?;
            Ok(Self {
                scroller: env.new_global_ref(scroller)?,
                last: (0, 0),
            })
        })
        .ok()
    }

    /// The travel since the last step (px) and whether the fling has ended.
    pub(crate) fn step(&mut self) -> ((f64, f64), bool) {
        let scroller = self.scroller.clone();
        let read = with_env(|env, _| {
            let running = env
                .call_method(scroller.as_obj(), "computeScrollOffset", "()Z", &[])?
                .z()?;
            let x = env
                .call_method(scroller.as_obj(), "getCurrX", "()I", &[])?
                .i()?;
            let y = env
                .call_method(scroller.as_obj(), "getCurrY", "()I", &[])?
                .i()?;
            Ok((running, x, y))
        });
        let Ok((running, x, y)) = read else {
            return ((0.0, 0.0), true);
        };
        let delta = (f64::from(x - self.last.0), f64::from(y - self.last.1));
        self.last = (x, y);
        (delta, !running)
    }
}
