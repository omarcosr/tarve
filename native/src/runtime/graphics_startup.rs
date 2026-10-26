//! Graphics startup and recovery: the CPU renderer of the first frames, its hand-over to the GPU,
//! and the recovery policy after a device loss.
use super::*;

impl App {
    /// Opens the window's graphics, on the CPU first when the GPU device is still being created.
    pub(super) fn create_graphics_window_cpu_first(
        &mut self,
        event_loop: &ActiveEventLoop,
        attributes: winit::window::WindowAttributes,
        without_redirection: bool,
        transparent: bool,
    ) -> Result<(Arc<Window>, Graphics), String> {
        // Waiting for the GPU device would hold the first frame (D3D11 creation takes ~60 ms):
        // an opaque window starts on the CPU renderer and switches once the device exists.
        #[cfg(target_os = "windows")]
        let cpu_first = self.document.renderer == crate::protocol::RendererPreference::Auto
            && !transparent
            && std::env::var_os("TARVE_RENDERER").is_none()
            && std::env::var_os("WGPU_BACKEND").is_none()
            && std::env::var_os("TARVE_CPU_FIRST").is_none_or(|value| value != "0")
            && crate::d3d11::prewarm_pending();
        #[cfg(not(target_os = "windows"))]
        let cpu_first = {
            let _ = transparent;
            false
        };
        // Android draws on the GPU too: Vello's pipelines come from a disk cache after the first
        // launch (renderer/pipeline_cache.rs), so the first frame takes ~0.15 s, and the CPU
        // renderer cannot hand the surface over to Vulkan (Android keeps it connected to the CPU).
        if cpu_first {
            self.document.renderer = crate::protocol::RendererPreference::Cpu;
        }
        let created = self.create_graphics_window(event_loop, attributes, without_redirection);
        if cpu_first {
            self.document.renderer = crate::protocol::RendererPreference::Auto;
            self.gpu_upgrade = created.is_ok();
        }
        created
    }
    /// GPU frames are checked against Vello's buffer sizes a frame late (renderer.rs): true when
    /// the last one overflowed and must be drawn again. Polls again shortly while one is pending.
    pub(super) fn poll_gpu_check(&mut self) -> bool {
        let check = match &mut self.graphics {
            GraphicsState::Ready(graphics) => graphics.poll_gpu_check(),
            _ => None,
        };
        self.gpu_check_pending = check == Some(false);
        check == Some(true)
    }
    /// Hands the window from the CPU renderer of the first frames to the GPU, once its device exists.
    pub(super) fn upgrade_graphics(&mut self) {
        #[cfg(target_os = "windows")]
        {
            if !self.gpu_upgrade || crate::d3d11::prewarm_pending() {
                return;
            }
            self.gpu_upgrade = false;
            let (Some(window), GraphicsState::Ready(old)) = (self.window.clone(), &self.graphics)
            else {
                return;
            };
            let (frames, generation) = (old.frames(), old.generation());
            match Graphics::new(
                window,
                self.document.renderer,
                self.document.window.backdrop.transparent(),
            ) {
                Ok(mut graphics) => {
                    graphics.restore_counters(frames, generation.saturating_add(1));
                    self.graphics = GraphicsState::Ready(Box::new(graphics));
                    self.tree.dirty.paint = true;
                    self.request_present_now();
                }
                Err(message) => self.events.push(error(format!(
                    "GPU renderer unavailable, staying on the CPU: {message}"
                ))),
            }
        }
    }
}

pub(crate) fn graphics_fault_action(kind: GraphicsFaultKind) -> GraphicsFaultAction {
    match kind {
        GraphicsFaultKind::DeviceLost | GraphicsFaultKind::Internal => {
            GraphicsFaultAction::RecoverDevice
        }
        GraphicsFaultKind::OutOfMemory | GraphicsFaultKind::Validation => {
            GraphicsFaultAction::Fatal
        }
    }
}

pub(crate) fn graphics_recovery_delay(attempt: u8) -> Duration {
    match attempt {
        0 | 1 => Duration::from_millis(100),
        2 => Duration::from_millis(250),
        _ => Duration::from_millis(500),
    }
}

pub(crate) fn graphics_recovery_failure_action(attempts: u8) -> GraphicsRecoveryFailureAction {
    if attempts >= MAX_GRAPHICS_RECOVERY_ATTEMPTS {
        GraphicsRecoveryFailureAction::Fatal
    } else {
        GraphicsRecoveryFailureAction::RetryAfter(graphics_recovery_delay(attempts))
    }
}

pub(crate) fn graphics_recovery_circuit_action(
    recoveries_in_window: usize,
) -> GraphicsRecoveryCircuitAction {
    if recoveries_in_window >= MAX_GRAPHICS_RECOVERY_EPISODES {
        GraphicsRecoveryCircuitAction::Fatal
    } else {
        GraphicsRecoveryCircuitAction::Allow
    }
}

pub(crate) fn graphics_recoveries_after_stability(
    recovery_episodes: usize,
    stable_for: Duration,
) -> usize {
    if stable_for >= GRAPHICS_RECOVERY_WINDOW {
        0
    } else {
        recovery_episodes
    }
}
