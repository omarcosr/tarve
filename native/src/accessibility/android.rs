//! TalkBack: AccessKit's Android provider, injected into the NativeActivity content view.
//!
//! accesskit_winit only injects into a GameActivity, so the bridge builds the adapter here and
//! forwards its requests to the event loop the way accesskit_winit does on the desktop. Hover
//! events (touch exploration) reach the view because the vendored android-activity finishes
//! them unhandled.

use crate::protocol::Command;
use accesskit::{ActionHandler, ActionRequest, ActivationHandler, TreeUpdate};
use accesskit_android::InjectingAdapter;
use accesskit_winit::{Event, WindowEvent as AccessKitEvent};
use jni::JNIEnv;
use jni::objects::JObject;
use winit::{
    event::WindowEvent,
    event_loop::{ActiveEventLoop, EventLoopProxy},
    window::{Window, WindowId},
};

/// android.R.id.content: the FrameLayout NativeActivity's own view sits in.
const CONTENT_ID: i32 = 0x0102_0002;

struct Forward {
    window_id: WindowId,
    proxy: EventLoopProxy<Command>,
}

impl Forward {
    fn send(&self, window_event: AccessKitEvent) {
        let event = Event {
            window_id: self.window_id,
            window_event,
        };
        let _ = self.proxy.send_event(event.into());
    }
}

impl ActivationHandler for Forward {
    fn request_initial_tree(&mut self) -> Option<TreeUpdate> {
        self.send(AccessKitEvent::InitialTreeRequested);
        None
    }
}

impl ActionHandler for Forward {
    fn do_action(&mut self, request: ActionRequest) {
        self.send(AccessKitEvent::ActionRequested(request));
    }
}

pub(crate) struct Adapter {
    adapter: Option<InjectingAdapter>,
    /// The view the provider is injected into: node bounds are relative to it.
    host: Option<jni::objects::GlobalRef>,
}

impl Adapter {
    pub(crate) fn with_event_loop_proxy(
        _: &ActiveEventLoop,
        window: &Window,
        proxy: EventLoopProxy<Command>,
    ) -> Self {
        let forward = || Forward {
            window_id: window.id(),
            proxy: proxy.clone(),
        };
        let adapter = crate::android::with_env(|env, activity| {
            // The adapter reads the JNI environment of the thread that updates it: this one.
            env.get_java_vm()?.attach_current_thread_permanently()?;
            let host = host_view(env, activity)?;
            let global = env.new_global_ref(&host)?;
            Ok((
                InjectingAdapter::new(env, &host, forward(), forward()),
                global,
            ))
        });
        if let Err(message) = &adapter {
            eprintln!("TalkBack support unavailable: {message}");
        }
        let (adapter, host) =
            adapter.map_or((None, None), |(adapter, host)| (Some(adapter), Some(host)));
        Self { adapter, host }
    }

    /// Where the host view sits in the window (physical px).
    fn origin(&self) -> (f64, f64) {
        let Some(host) = &self.host else {
            return (0.0, 0.0);
        };
        crate::android::with_env(|env, _| {
            let location = env.new_int_array(2)?;
            env.call_method(
                host.as_obj(),
                "getLocationInWindow",
                "([I)V",
                &[(&location).into()],
            )?;
            let mut xy = [0_i32; 2];
            env.get_int_array_region(&location, 0, &mut xy)?;
            Ok((f64::from(xy[0]), f64::from(xy[1])))
        })
        .unwrap_or((0.0, 0.0))
    }

    pub(crate) fn process_event(&mut self, _: &Window, _: &WindowEvent) {}

    pub(crate) fn update_if_active(&mut self, update: impl FnOnce() -> TreeUpdate) {
        // Bounds are relative to the host view, which sits below the status bar while the
        // app's surface (and so the tree) starts at the window's top.
        let origin = self.origin();
        let update = move || {
            let mut update = update();
            let root = update.tree.as_ref().map(|tree| tree.root);
            if let Some((_, node)) = update.nodes.iter_mut().find(|(id, _)| Some(*id) == root) {
                let transform = node.transform().copied().unwrap_or_default();
                node.set_transform(
                    accesskit::Affine::translate((-origin.0, -origin.1)) * transform,
                );
            }
            update
        };
        let Some(adapter) = self.adapter.as_mut() else {
            return;
        };
        // A failed Java call while posting the update (accesskit_android unwraps it) costs
        // the screen reader, not the app.
        let updated = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            adapter.update_if_active(update)
        }));
        if updated.is_err() {
            eprintln!("TalkBack support stopped: the accessibility update failed");
            let _ = crate::android::with_env(|env, _| {
                if env.exception_check()? {
                    env.exception_describe()?;
                    env.exception_clear()?;
                }
                Ok(())
            });
            self.adapter = None;
        }
    }
}

/// NativeActivity's content view, or the window's decor view when it is not laid out yet.
fn host_view<'local>(
    env: &mut JNIEnv<'local>,
    activity: &JObject,
) -> jni::errors::Result<JObject<'local>> {
    let content = env
        .call_method(
            activity,
            "findViewById",
            "(I)Landroid/view/View;",
            &[CONTENT_ID.into()],
        )?
        .l()?;
    if !content.is_null() {
        let view = env
            .call_method(
                &content,
                "getChildAt",
                "(I)Landroid/view/View;",
                &[0.into()],
            )?
            .l()?;
        if !view.is_null() {
            return Ok(view);
        }
    }
    let window = env
        .call_method(activity, "getWindow", "()Landroid/view/Window;", &[])?
        .l()?;
    env.call_method(&window, "getDecorView", "()Landroid/view/View;", &[])?
        .l()
}
