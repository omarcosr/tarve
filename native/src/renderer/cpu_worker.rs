//! The CPU renderer's raster thread: a frame's display list is rasterized there while the
//! window's thread applies the app's next update, lays it out and records it. The window's
//! thread presents the finished pixels (softbuffer's surface belongs to it).
use super::*;
use std::sync::{Condvar, mpsc};

/// The raster thread's state: the rasterizer and the retained frame it draws into.
pub(super) struct CpuRaster {
    pub(super) context: CpuRenderContext,
    pub(super) resources: CpuResources,
    pub(super) scratch: Vec<u8>,
    pub(super) shadows: ShadowCache,
    pub(super) masks: crate::cpu_display::GlyphMasks,
    /// The retained frame, packed for softbuffer, and its size.
    pub(super) pixels: Vec<u32>,
    pub(super) size: (u16, u16),
    /// The context's helper threads (`cpu_render_settings`).
    pub(super) threads: u16,
}

/// One frame to rasterize: the region of `list` that changed.
pub(super) struct CpuJob {
    pub(super) list: Arc<DisplayList>,
    pub(super) region: vello::kurbo::Rect,
    pub(super) size: (u16, u16),
    pub(super) background: vello::peniko::Color,
    pub(super) alpha: bool,
    pub(super) scale: f64,
}

impl CpuRaster {
    fn draw(&mut self, job: &CpuJob) -> Result<vello::kurbo::Rect, String> {
        let (width, height) = (usize::from(job.size.0), usize::from(job.size.1));
        let full = vello::kurbo::Rect::new(0.0, 0.0, width as f64, height as f64);
        let mut region = job.region;
        if self.size != job.size || self.pixels.len() != width * height {
            self.pixels.clear();
            self.pixels.resize(width * height, 0);
            self.size = job.size;
            region = full;
            // A window resized across the helper threshold rasterizes with its new count.
            let settings = cpu_render_settings(width * height);
            if settings.num_threads != self.threads {
                self.threads = settings.num_threads;
                self.context = CpuRenderContext::new_with(job.size.0, job.size.1, settings);
            }
        }
        rasterize_cpu_region(
            &mut self.context,
            &mut self.resources,
            &job.list,
            CpuFrame {
                pixels: &mut self.pixels,
                width,
                height,
                alpha: job.alpha,
            },
            &mut self.scratch,
            Some(&mut self.shadows),
            region,
            job.background,
            Some(job.scale),
            Some(&mut self.masks),
        );
        if region != full && cpu_damage_check() {
            check_partial_redraw(
                &mut self.context,
                &mut self.resources,
                &job.list,
                &self.pixels,
                width,
                height,
                region,
                job.background,
                job.alpha,
            )
            .map_err(|error| match error {
                RenderError::Fatal(message) | RenderError::RecoverDevice(message) => message,
            })?;
        }
        self.shadows.next_frame();
        Ok(region)
    }
}

/// The last finished job's region (or its error), until the window's thread takes it.
type Finished = (Mutex<Option<Result<vello::kurbo::Rect, String>>>, Condvar);

/// The raster thread. TARVE_CPU_PIPELINE=0 rasterizes each frame before presenting it, as
/// the window's thread did itself.
pub(super) struct CpuWorker {
    pub(super) raster: Arc<Mutex<CpuRaster>>,
    jobs: Option<mpsc::Sender<CpuJob>>,
    finished: Arc<Finished>,
    thread: Option<std::thread::JoinHandle<()>>,
    in_flight: bool,
    pub(super) pipelined: bool,
}

impl CpuWorker {
    /// `wake` runs on the raster thread when a frame is done (a redraw request presents it).
    pub(super) fn new(
        (width, height): (u16, u16),
        wake: impl Fn() + Send + 'static,
    ) -> Result<Self, String> {
        let settings = cpu_render_settings(usize::from(width) * usize::from(height));
        let raster = Arc::new(Mutex::new(CpuRaster {
            threads: settings.num_threads,
            context: CpuRenderContext::new_with(width, height, settings),
            resources: CpuResources::new(),
            scratch: Vec::new(),
            shadows: ShadowCache::new(),
            masks: crate::cpu_display::GlyphMasks::new(),
            pixels: Vec::new(),
            size: (0, 0),
        }));
        let finished: Arc<Finished> = Arc::new((Mutex::new(None), Condvar::new()));
        let (jobs, receiver) = mpsc::channel::<CpuJob>();
        let thread = {
            let raster = raster.clone();
            let finished = finished.clone();
            std::thread::Builder::new()
                .name("tarve-cpu-raster".into())
                .spawn(move || {
                    for job in receiver {
                        let result = match raster.lock() {
                            Ok(mut raster) => raster.draw(&job),
                            Err(_) => Err("CPU raster state poisoned".into()),
                        };
                        drop(job);
                        if let Ok(mut slot) = finished.0.lock() {
                            *slot = Some(result);
                        }
                        finished.1.notify_all();
                        wake();
                    }
                })
                .map_err(|error| format!("CPU raster thread: {error}"))?
        };
        Ok(Self {
            raster,
            jobs: Some(jobs),
            finished,
            thread: Some(thread),
            in_flight: false,
            pipelined: std::env::var_os("TARVE_CPU_PIPELINE").is_none_or(|value| value != "0"),
        })
    }

    pub(super) fn submit(&mut self, job: CpuJob) -> Result<(), String> {
        let jobs = self.jobs.as_ref().ok_or("CPU raster thread stopped")?;
        jobs.send(job)
            .map_err(|_| "CPU raster thread stopped".to_string())?;
        self.in_flight = true;
        Ok(())
    }

    /// Waits for the job in flight, if any: the region it drew.
    pub(super) fn settle(&mut self) -> Result<Option<vello::kurbo::Rect>, String> {
        if !self.in_flight {
            return Ok(None);
        }
        let (slot, ready) = &*self.finished;
        let mut slot = slot.lock().map_err(|_| "CPU raster result poisoned")?;
        while slot.is_none() {
            slot = ready.wait(slot).map_err(|_| "CPU raster result poisoned")?;
        }
        self.in_flight = false;
        slot.take().expect("checked above").map(Some)
    }
}

impl Drop for CpuWorker {
    fn drop(&mut self) {
        self.jobs = None;
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
