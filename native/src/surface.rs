//! `<surface>`: a box of the window another renderer presents into, as XAML's
//! `SwapChainPanel` or Android's `SurfaceView` — libmpv, a game engine, a plugin's GPU code.
//! The `ready` event carries the handle a producer of this process presents through
//! (`handleType`) and the box's size in device pixels; `resize` follows layout. Producers
//! render at that size.
//!
//! - `ISwapChainPanelNative` (Windows, D3D11 renderer): the box is a DirectComposition visual
//!   under the UI showing a composition swap chain its producer owns and presents on its own
//!   thread, without a UI frame. The UI draws a hole for it, and whatever paints over the box
//!   shows on top. The producer calls `SetSwapChain` on the handle as on a XAML panel, or the
//!   app hands over an `IDXGISwapChain*` it exposes (libmpv's `display-swapchain`) with the
//!   `surface` command's `attach` action.
//! - `TarveFrames` (Linux on X11 and Wayland, any renderer, and wherever there is no swap
//!   chain host): the producer hands pictures to `tarve_surface_present` (this library's C ABI,
//!   any thread) or `app.surface(id).present`; the UI composes them as part of its frame, so
//!   everything — clips, rounded corners, transforms, controls drawn over it — applies, as a
//!   toolkit embedding libmpv's render API does.
//! - `X11Window` (Linux on X11, `<surface native>`): a child window of the app's window,
//!   moved and sized with layout, the producer draws into (libmpv's `wid`, GL/Vulkan on it).
//!   Fastest on X11, but a native child view: it shows above the UI drawn over its box.

use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;

/// What the window can give a surface.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Host {
    /// The GPU renderer is still starting (Windows): surfaces wait for it.
    Pending,
    /// Pictures composed by the UI.
    Frames,
    /// D3D11 renderer: composition swap chains under the UI.
    #[cfg(target_os = "windows")]
    Composition,
    /// An X11 window (its id): child windows for `<surface native>`, else frames.
    #[cfg(target_os = "linux")]
    X11(u32),
}

/// How one surface presents.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Mode {
    Frames,
    /// GL into GPU images the UI composes, on the device with this serial.
    #[cfg(all(target_os = "linux", feature = "vello-gpu"))]
    Gl(u64),
    #[cfg(target_os = "windows")]
    Composition,
    #[cfg(target_os = "linux")]
    X11(u32),
}

impl Host {
    #[cfg_attr(not(target_os = "linux"), allow(unused_variables))]
    fn mode(self, native: bool) -> Option<Mode> {
        match self {
            Host::Pending => None,
            Host::Frames => Some(Mode::Frames),
            #[cfg(target_os = "windows")]
            Host::Composition => Some(Mode::Composition),
            #[cfg(target_os = "linux")]
            Host::X11(parent) if native => Some(Mode::X11(parent)),
            #[cfg(target_os = "linux")]
            Host::X11(_) => Some(Mode::Frames),
        }
    }
}

/// A `TarveGL` surface's images, and the ring it replaces until it shows a picture.
#[cfg(all(target_os = "linux", feature = "vello-gpu"))]
struct GlPresenter {
    slot: Arc<crate::surface_gl::Slot>,
    ring: crate::surface_gl::Ring,
    /// What the tree draws: an empty image Vello replaces with the shown texture.
    image: vello::peniko::ImageData,
    previous: Option<vello::peniko::ImageData>,
}

#[cfg(all(target_os = "linux", feature = "vello-gpu"))]
fn ring_image(ring: &crate::surface_gl::Ring) -> vello::peniko::ImageData {
    vello::peniko::ImageData {
        data: vello::peniko::Blob::new(Arc::new([0_u8; 0])),
        format: vello::peniko::ImageFormat::Rgba8,
        alpha_type: vello::peniko::ImageAlphaType::Alpha,
        width: ring.width,
        height: ring.height,
    }
}

/// A picture a `TarveGL` surface's producer finished: the UI draws `texture` where `image` is.
#[cfg(all(target_os = "linux", feature = "vello-gpu"))]
pub(crate) struct GlPicture {
    pub id: String,
    pub image: vello::peniko::ImageData,
    pub texture: vello::wgpu::Texture,
    /// The previous ring's image, no longer drawn.
    pub replaced: Option<vello::peniko::ImageData>,
}

enum Presenter {
    Frames(Arc<frames::Slot>),
    #[cfg(all(target_os = "linux", feature = "vello-gpu"))]
    Gl(Box<GlPresenter>),
    #[cfg(target_os = "windows")]
    Panel(platform::Panel),
    #[cfg(target_os = "linux")]
    Child(x11::Child),
}

impl Presenter {
    fn close(self) {
        match self {
            Presenter::Frames(_) => {}
            #[cfg(all(target_os = "linux", feature = "vello-gpu"))]
            Presenter::Gl(gl) => gl.slot.close(),
            #[cfg(target_os = "windows")]
            Presenter::Panel(panel) => panel.close(),
            #[cfg(target_os = "linux")]
            Presenter::Child(child) => child.close(),
        }
    }
}

pub(crate) struct Surfaces {
    entries: HashMap<String, Entry>,
    wake: Arc<dyn Fn() + Send + Sync>,
    #[cfg(target_os = "linux")]
    x11: Option<Arc<x11rb::rust_connection::RustConnection>>,
    /// The Vulkan device GL surfaces export images from, its serial, and why GL cannot be used.
    #[cfg(all(target_os = "linux", feature = "vello-gpu"))]
    gl: Option<(Arc<crate::surface_gl::Interop>, u64)>,
    #[cfg(all(target_os = "linux", feature = "vello-gpu"))]
    gl_serial: u64,
    #[cfg(all(target_os = "linux", feature = "vello-gpu"))]
    released: Vec<vello::peniko::ImageData>,
}

struct Entry {
    /// x, y, width, height in device pixels.
    bounds: [i32; 4],
    mode: Mode,
    presenter: Presenter,
}

fn size(bounds: [i32; 4]) -> (u32, u32) {
    (bounds[2].max(0) as u32, bounds[3].max(0) as u32)
}

fn event(id: &str, name: &str, bounds: [i32; 4], scale: f64) -> Value {
    let (width, height) = size(bounds);
    json!({
        "type": "surface",
        "id": id,
        "event": name,
        "width": width,
        "height": height,
        "scale": scale,
    })
}

impl Surfaces {
    pub(crate) fn new(wake: impl Fn() + Send + Sync + 'static) -> Self {
        Self {
            entries: HashMap::new(),
            wake: Arc::new(wake),
            #[cfg(target_os = "linux")]
            x11: None,
            #[cfg(all(target_os = "linux", feature = "vello-gpu"))]
            gl: None,
            #[cfg(all(target_os = "linux", feature = "vello-gpu"))]
            gl_serial: 0,
            #[cfg(all(target_os = "linux", feature = "vello-gpu"))]
            released: Vec::new(),
        }
    }

    /// The renderer's Vulkan device (Linux GPU renderer), or none: GL surfaces need it, and
    /// GL on the same device and driver. A new device makes them `ready` again.
    #[cfg(all(target_os = "linux", feature = "vello-gpu"))]
    pub(crate) fn set_gl(&mut self, vulkan: Option<(vello::wgpu::Device, vello::wgpu::Queue)>) {
        let same = match (&self.gl, &vulkan) {
            (Some((interop, _)), Some((device, _))) => interop.device == *device,
            (None, None) => true,
            _ => false,
        };
        if same {
            return;
        }
        self.gl = vulkan.and_then(|(device, queue)| {
            if std::env::var_os("TARVE_SURFACE_GL").is_some_and(|value| value == "0") {
                return None;
            }
            let interop = crate::surface_gl::Interop::new(device, queue)?;
            if let Err(error) = interop.gl_matches() {
                eprintln!("[tarve] <surface> GL interop unavailable, frames instead: {error}");
                return None;
            }
            self.gl_serial += 1;
            Some((Arc::new(interop), self.gl_serial))
        });
    }

    fn retire(&mut self, presenter: Presenter) {
        #[cfg(all(target_os = "linux", feature = "vello-gpu"))]
        if let Presenter::Gl(gl) = &presenter {
            self.released.push(gl.image.clone());
            self.released.extend(gl.previous.clone());
        }
        presenter.close();
    }

    /// Images of GL surfaces gone or remade: the renderer drops their textures.
    #[cfg(all(target_os = "linux", feature = "vello-gpu"))]
    pub(crate) fn take_released(&mut self) -> Vec<vello::peniko::ImageData> {
        std::mem::take(&mut self.released)
    }

    /// Frames become GL where the device allows it.
    #[allow(unused_mut)]
    fn upgrade(&self, mut mode: Mode) -> Mode {
        #[cfg(all(target_os = "linux", feature = "vello-gpu"))]
        if mode == Mode::Frames
            && let Some((_, serial)) = &self.gl
        {
            mode = Mode::Gl(*serial);
        }
        mode
    }

    /// Runs the GPU's completion callbacks: images the UI is done with go back to producers.
    #[cfg(all(target_os = "linux", feature = "vello-gpu"))]
    pub(crate) fn poll_gpu(&self) {
        if let Some((interop, _)) = &self.gl
            && self
                .entries
                .values()
                .any(|entry| matches!(entry.presenter, Presenter::Gl(_)))
        {
            let _ = interop.device.poll(vello::wgpu::PollType::Poll);
        }
    }

    /// Pictures GL producers finished since the last call. Images they replace go back to
    /// producers once the GPU is done with them.
    #[cfg(all(target_os = "linux", feature = "vello-gpu"))]
    pub(crate) fn take_gl(&mut self) -> Vec<GlPicture> {
        let Some((interop, _)) = &self.gl else {
            return Vec::new();
        };
        // Runs the callbacks of finished submissions (releases below).
        let _ = interop.device.poll(vello::wgpu::PollType::Poll);
        let mut pictures = Vec::new();
        for (id, entry) in &mut self.entries {
            let Presenter::Gl(gl) = &mut entry.presenter else {
                continue;
            };
            let Some((index, retiring)) = gl.slot.take() else {
                continue;
            };
            if !retiring.is_empty() {
                let slot = gl.slot.clone();
                interop
                    .queue
                    .on_submitted_work_done(move || slot.release(&retiring));
            }
            pictures.push(GlPicture {
                id: id.clone(),
                image: gl.image.clone(),
                texture: gl.ring.textures[index].clone(),
                replaced: gl.previous.take(),
            });
        }
        pictures
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The presenter of a surface in `mode`, and its handle and `handleType`.
    #[allow(unused_variables)]
    fn create(
        &mut self,
        mode: Mode,
        bounds: [i32; 4],
    ) -> Result<(Presenter, String, &'static str), String> {
        match mode {
            Mode::Frames => {
                let slot = frames::register(self.wake.clone());
                let handle = slot.handle().to_string();
                Ok((Presenter::Frames(slot), handle, "TarveFrames"))
            }
            #[cfg(all(target_os = "linux", feature = "vello-gpu"))]
            Mode::Gl(_) => {
                let (interop, _) = self.gl.as_ref().ok_or("no Vulkan device for GL surfaces")?;
                let (width, height) = size(bounds);
                let ring = interop.ring(width, height)?;
                let slot = crate::surface_gl::Slot::new(self.wake.clone());
                slot.set_ring(&ring);
                let handle = slot.handle().to_string();
                let image = ring_image(&ring);
                Ok((
                    Presenter::Gl(Box::new(GlPresenter {
                        slot,
                        ring,
                        image,
                        previous: None,
                    })),
                    handle,
                    "TarveGL",
                ))
            }
            #[cfg(target_os = "windows")]
            Mode::Composition => {
                let panel = platform::Panel::new(self.wake.clone());
                let handle = panel.handle().to_string();
                Ok((Presenter::Panel(panel), handle, "ISwapChainPanelNative"))
            }
            #[cfg(target_os = "linux")]
            Mode::X11(parent) => {
                let connection = match &self.x11 {
                    Some(connection) => connection.clone(),
                    None => {
                        let (connection, _) = x11rb::rust_connection::RustConnection::connect(None)
                            .map_err(|error| format!("surface: X11 connection: {error}"))?;
                        let connection = Arc::new(connection);
                        self.x11 = Some(connection.clone());
                        connection
                    }
                };
                let child = x11::Child::new(connection, parent, bounds)?;
                let handle = child.window().to_string();
                Ok((Presenter::Child(child), handle, "X11Window"))
            }
        }
    }

    /// A `ready` event and the presenter; a native view that cannot be made falls back to
    /// frames (the event says why in `message`).
    fn announce(
        &mut self,
        id: &str,
        mode: Mode,
        bounds: [i32; 4],
        scale: f64,
    ) -> (Value, Mode, Presenter) {
        let (mode, made, failure) = match self.create(mode, bounds) {
            Ok(made) => (mode, made, None),
            Err(message) => {
                let made = self
                    .create(Mode::Frames, bounds)
                    .expect("frames never fail");
                (Mode::Frames, made, Some(message))
            }
        };
        let (presenter, handle, kind) = made;
        let mut ready = event(id, "ready", bounds, scale);
        ready["handle"] = Value::from(handle);
        ready["handleType"] = Value::from(kind);
        if let Some(message) = failure {
            ready["message"] = Value::from(message);
        }
        (ready, mode, presenter)
    }

    /// Follows the tree's surfaces (`boxes`: device pixels, and whether it asks for a native
    /// view): a new one is `ready`; one whose way of presenting changes (the GPU renderer gave
    /// way to the CPU, `native` toggled) is `ready` again with its new handle; a resized one
    /// reports `resize`; a removed one `destroyed` (its presenter goes).
    pub(crate) fn sync(
        &mut self,
        boxes: Vec<(String, [i32; 4], bool)>,
        scale: f64,
        host: Host,
    ) -> Vec<Value> {
        let mut events = Vec::new();
        let mut seen = std::collections::HashSet::with_capacity(boxes.len());
        for (id, bounds, native) in boxes {
            let Some(mode) = host.mode(native).map(|mode| self.upgrade(mode)) else {
                // Not announced yet: it is announced once the renderer is known.
                continue;
            };
            seen.insert(id.clone());
            if self.entries.get(&id).is_none_or(|entry| entry.mode != mode) {
                if let Some(old) = self.entries.remove(&id) {
                    self.retire(old.presenter);
                }
                let (ready, mode, presenter) = self.announce(&id, mode, bounds, scale);
                events.push(ready);
                self.entries.insert(
                    id,
                    Entry {
                        bounds,
                        mode,
                        presenter,
                    },
                );
                continue;
            }
            let entry = self.entries.get_mut(&id).unwrap();
            if entry.bounds != bounds {
                #[cfg(target_os = "linux")]
                if let Presenter::Child(child) = &entry.presenter {
                    child.place(bounds);
                }
                let resized = size(entry.bounds) != size(bounds);
                // GL: a ring at the new size; the old picture shows until the first new one.
                #[cfg(all(target_os = "linux", feature = "vello-gpu"))]
                if resized
                    && let Presenter::Gl(gl) = &mut entry.presenter
                    && let Some((interop, _)) = &self.gl
                {
                    let (width, height) = size(bounds);
                    match interop.ring(width, height) {
                        Ok(ring) => {
                            gl.slot.set_ring(&ring);
                            let image = ring_image(&ring);
                            let old = std::mem::replace(&mut gl.image, image);
                            gl.previous.get_or_insert(old);
                            gl.ring = ring;
                        }
                        Err(error) => eprintln!("[tarve] <surface> GL resize: {error}"),
                    }
                }
                entry.bounds = bounds;
                if resized {
                    events.push(event(&id, "resize", bounds, scale));
                }
            }
        }
        if host == Host::Pending {
            return events;
        }
        let gone: Vec<String> = self
            .entries
            .keys()
            .filter(|id| !seen.contains(*id))
            .cloned()
            .collect();
        for id in gone {
            if let Some(entry) = self.entries.remove(&id) {
                self.retire(entry.presenter);
                events.push(event(&id, "destroyed", entry.bounds, scale));
            }
        }
        events
    }

    /// The pictures producers presented since the last call, by node id.
    pub(crate) fn take_frames(&self) -> Vec<(String, frames::Picture)> {
        self.entries
            .iter()
            .filter_map(|(id, entry)| match &entry.presenter {
                Presenter::Frames(slot) => Some((id.clone(), slot.take()?)),
                #[allow(unreachable_patterns)]
                _ => None,
            })
            .collect()
    }

    /// The `surface` command: `attach` an `IDXGISwapChain*` (decimal or `0x` hex) of this
    /// process to surface `id`, or `detach` it (Windows composition surfaces).
    pub(crate) fn command(
        &mut self,
        id: &str,
        action: &str,
        #[allow(unused_variables)] swap_chain: Option<&str>,
    ) -> Result<(), String> {
        #[cfg(target_os = "windows")]
        if let Some(Entry {
            presenter: Presenter::Panel(panel),
            ..
        }) = self.entries.get(id)
        {
            return match action {
                "attach" => {
                    let text = swap_chain.ok_or("surface attach needs swapChain")?.trim();
                    let pointer = match text.strip_prefix("0x").or_else(|| text.strip_prefix("0X"))
                    {
                        Some(hex) => usize::from_str_radix(hex, 16),
                        None => text.parse::<usize>(),
                    }
                    .map_err(|_| format!("surface swapChain is not a pointer: '{text}'"))?;
                    panel.attach_raw(pointer)
                }
                "detach" => {
                    panel.set(None);
                    Ok(())
                }
                other => Err(format!("unknown surface action '{other}'")),
            };
        }
        let _ = action;
        Err(format!(
            "surface '{id}': attach/detach hand over a DXGI swap chain (ISwapChainPanelNative surfaces); this one presents through its ready event's handle"
        ))
    }

    /// The swap chains to show, by node id.
    #[cfg(target_os = "windows")]
    pub(crate) fn chains(&self) -> Vec<(String, windows::Win32::Graphics::Dxgi::IDXGISwapChain1)> {
        self.entries
            .iter()
            .filter_map(|(id, entry)| match &entry.presenter {
                Presenter::Panel(panel) => Some((id.clone(), panel.chain()?)),
                _ => None,
            })
            .collect()
    }
}

/// `TarveFrames`: producers hand pictures over by handle, from any thread.
pub(crate) mod frames {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex, Weak};

    /// A picture as the renderer draws it: RGBA, straight alpha, rows packed.
    pub(crate) struct Picture {
        pub width: u32,
        pub height: u32,
        pub rgba: Vec<u8>,
    }

    pub(crate) struct Slot {
        handle: u64,
        picture: Mutex<Option<Picture>>,
        wake: Arc<dyn Fn() + Send + Sync>,
    }

    static SLOTS: Mutex<Option<HashMap<u64, Weak<Slot>>>> = Mutex::new(None);
    static NEXT: AtomicU64 = AtomicU64::new(1);

    pub(crate) fn register(wake: Arc<dyn Fn() + Send + Sync>) -> Arc<Slot> {
        let handle = NEXT.fetch_add(1, Ordering::Relaxed);
        let slot = Arc::new(Slot {
            handle,
            picture: Mutex::new(None),
            wake,
        });
        SLOTS
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .get_or_insert_with(HashMap::new)
            .insert(handle, Arc::downgrade(&slot));
        slot
    }

    impl Slot {
        pub(crate) fn handle(&self) -> u64 {
            self.handle
        }

        pub(crate) fn take(&self) -> Option<Picture> {
            self.picture.lock().ok()?.take()
        }
    }

    impl Drop for Slot {
        fn drop(&mut self) {
            if let Some(slots) = SLOTS
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .as_mut()
            {
                slots.remove(&self.handle);
            }
        }
    }

    /// Pixel layouts `tarve_surface_present` takes: bytes in memory order.
    pub(crate) const RGBA: u32 = 0;
    pub(crate) const BGRA: u32 = 1;
    /// The fourth byte is padding (libmpv's `rgb0`/`bgr0`): shown opaque.
    pub(crate) const RGBX: u32 = 2;
    pub(crate) const BGRX: u32 = 3;

    /// Converts and stores a picture for surface `handle`; the newest picture wins.
    pub(crate) fn present(
        handle: u64,
        pixels: &[u8],
        width: u32,
        height: u32,
        stride: usize,
        format: u32,
    ) -> Result<(), i32> {
        if width == 0 || height == 0 || width > 16384 || height > 16384 || format > BGRX {
            return Err(-2);
        }
        let row = width as usize * 4;
        if stride < row || pixels.len() < stride * (height as usize - 1) + row {
            return Err(-2);
        }
        let slot = SLOTS
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .as_ref()
            .and_then(|slots| slots.get(&handle)?.upgrade())
            .ok_or(-1)?;
        let mut rgba = Vec::with_capacity(row * height as usize);
        for y in 0..height as usize {
            let line = &pixels[y * stride..y * stride + row];
            match format {
                RGBA => rgba.extend_from_slice(line),
                _ => {
                    let swap = format == BGRA || format == BGRX;
                    let opaque = format == RGBX || format == BGRX;
                    rgba.extend(line.as_chunks::<4>().0.iter().flat_map(|&[c0, g, c2, a]| {
                        let (r, b) = if swap { (c2, c0) } else { (c0, c2) };
                        [r, g, b, if opaque { 255 } else { a }]
                    }));
                }
            }
        }
        let fresh = {
            let mut picture = slot.picture.lock().map_err(|_| -3)?;
            picture
                .replace(Picture {
                    width,
                    height,
                    rgba,
                })
                .is_none()
        };
        // One wake per batch: the loop takes the newest picture.
        if fresh {
            (slot.wake)();
        }
        Ok(())
    }

    /// Shows `width`×`height` pixels (`stride` bytes per row, 0 for packed; `format` 0 RGBA,
    /// 1 BGRA, 2 RGBX, 3 BGRX, straight alpha) in the `<surface>` whose `TarveFrames` handle
    /// is `handle`. Any thread; the pixels are copied before it returns. 0 on success, -1 when
    /// the surface is gone, -2 for invalid arguments.
    ///
    /// # Safety
    /// `pixels` points to `stride` × `height` readable bytes.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn tarve_surface_present(
        handle: u64,
        pixels: *const u8,
        width: u32,
        height: u32,
        stride: u32,
        format: u32,
    ) -> i32 {
        if pixels.is_null() || height == 0 {
            return -2;
        }
        let stride = if stride == 0 {
            width as usize * 4
        } else {
            stride as usize
        };
        // SAFETY: the caller promises stride × height readable bytes.
        let bytes = unsafe { std::slice::from_raw_parts(pixels, stride * height as usize) };
        match present(handle, bytes, width, height, stride, format) {
            Ok(()) => 0,
            Err(code) => code,
        }
    }
}

/// X11: a child window per surface, on a connection of the runtime's own (winit keeps its own).
#[cfg(target_os = "linux")]
mod x11 {
    use std::sync::Arc;
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{
        ConfigureWindowAux, ConnectionExt, CreateWindowAux, EventMask, WindowClass,
    };
    use x11rb::rust_connection::RustConnection;

    pub(crate) struct Child {
        connection: Arc<RustConnection>,
        window: u32,
    }

    impl Child {
        pub(crate) fn new(
            connection: Arc<RustConnection>,
            parent: u32,
            bounds: [i32; 4],
        ) -> Result<Self, String> {
            let fail =
                |error: &dyn std::fmt::Display| format!("surface: X11 child window: {error}");
            let window = connection.generate_id().map_err(|e| fail(&e))?;
            let [x, y, width, height] = bounds;
            connection
                .create_window(
                    x11rb::COPY_DEPTH_FROM_PARENT,
                    window,
                    parent,
                    x as i16,
                    y as i16,
                    width.max(1) as u16,
                    height.max(1) as u16,
                    0,
                    WindowClass::INPUT_OUTPUT,
                    x11rb::COPY_FROM_PARENT,
                    // Black until the producer draws; no events selected, so pointer and keys
                    // propagate to the app's window.
                    &CreateWindowAux::new()
                        .background_pixel(0)
                        .event_mask(EventMask::NO_EVENT),
                )
                .map_err(|e| fail(&e))?
                .check()
                .map_err(|e| fail(&e))?;
            connection.map_window(window).map_err(|e| fail(&e))?;
            connection.flush().map_err(|e| fail(&e))?;
            Ok(Self { connection, window })
        }

        pub(crate) fn window(&self) -> u32 {
            self.window
        }

        pub(crate) fn place(&self, bounds: [i32; 4]) {
            let [x, y, width, height] = bounds;
            let aux = ConfigureWindowAux::new()
                .x(x)
                .y(y)
                .width(width.max(1) as u32)
                .height(height.max(1) as u32);
            let _ = self.connection.configure_window(self.window, &aux);
            let _ = self.connection.flush();
        }

        pub(crate) fn close(self) {
            let _ = self.connection.destroy_window(self.window);
            let _ = self.connection.flush();
        }
    }
}

#[cfg(target_os = "windows")]
#[allow(non_snake_case)]
mod platform {
    use std::ffi::c_void;
    use std::sync::{Arc, Mutex, Weak};
    use windows::Win32::Foundation::{E_NOINTERFACE, S_OK};
    use windows::Win32::Graphics::Dxgi::{IDXGISwapChain, IDXGISwapChain1};
    use windows::core::{HRESULT, IUnknown, IUnknown_Vtbl, Interface, implement, interface};

    /// `windows.ui.xaml.media.dxinterop.h`'s panel interface, which producers written
    /// for XAML hosts already speak.
    #[interface("F92F19D2-3ADE-45A6-A20C-F6F1EA90554B")]
    pub(crate) unsafe trait ISwapChainPanelNative: IUnknown {
        fn SetSwapChain(&self, swap_chain: *mut c_void) -> HRESULT;
    }

    /// What a producer does with the `ready` event's handle.
    #[cfg(test)]
    pub(crate) unsafe fn producer_sets(handle: usize, chain: *mut c_void) -> HRESULT {
        let raw = handle as *mut c_void;
        let panel = unsafe { ISwapChainPanelNative::from_raw_borrowed(&raw) }.unwrap();
        unsafe { panel.SetSwapChain(chain) }
    }

    /// A producer keeping the handle (an AddRef).
    #[cfg(test)]
    pub(crate) fn producer_keeps(handle: usize) -> ISwapChainPanelNative {
        let raw = handle as *mut c_void;
        unsafe { ISwapChainPanelNative::from_raw_borrowed(&raw) }
            .unwrap()
            .clone()
    }

    /// DXGI objects are free-threaded: a producer's thread hands the swap chain over.
    struct Chain(IDXGISwapChain1);
    unsafe impl Send for Chain {}

    pub(crate) struct Slot {
        chain: Mutex<Option<Chain>>,
        wake: Arc<dyn Fn() + Send + Sync>,
    }

    impl Slot {
        fn set(&self, chain: Option<IDXGISwapChain1>) {
            if let Ok(mut current) = self.chain.lock() {
                let same = match (&*current, &chain) {
                    (Some(Chain(a)), Some(b)) => a.as_raw() == b.as_raw(),
                    (None, None) => true,
                    _ => false,
                };
                if same {
                    return;
                }
                *current = chain.map(Chain);
            }
            (self.wake)();
        }
    }

    /// A raw `IDXGISwapChain*` as a composition swap chain (`IDXGISwapChain1`).
    ///
    /// # Safety
    /// `pointer` is null or a live `IDXGISwapChain` of this process.
    unsafe fn swap_chain(pointer: *mut c_void) -> Result<Option<IDXGISwapChain1>, ()> {
        if pointer.is_null() {
            return Ok(None);
        }
        let chain = unsafe { IDXGISwapChain::from_raw_borrowed(&pointer) }.ok_or(())?;
        chain.cast::<IDXGISwapChain1>().map(Some).map_err(|_| ())
    }

    #[implement(ISwapChainPanelNative)]
    struct PanelNative {
        /// Gone once the element is: a late `SetSwapChain` does nothing.
        slot: Weak<Slot>,
    }

    impl ISwapChainPanelNative_Impl for PanelNative_Impl {
        unsafe fn SetSwapChain(&self, pointer: *mut c_void) -> HRESULT {
            let Ok(chain) = (unsafe { swap_chain(pointer) }) else {
                return E_NOINTERFACE;
            };
            if let Some(slot) = self.slot.upgrade() {
                slot.set(chain);
            }
            S_OK
        }
    }

    /// One element's panel: the COM object producers call, and what they gave it.
    pub(crate) struct Panel {
        slot: Arc<Slot>,
        native: ISwapChainPanelNative,
    }

    impl Panel {
        pub(crate) fn new(wake: Arc<dyn Fn() + Send + Sync>) -> Self {
            let slot = Arc::new(Slot {
                chain: Mutex::new(None),
                wake,
            });
            let native: ISwapChainPanelNative = PanelNative {
                slot: Arc::downgrade(&slot),
            }
            .into();
            Self { slot, native }
        }

        /// The `ISwapChainPanelNative*` producers call (valid while the element lives;
        /// a producer that keeps it AddRefs it).
        pub(crate) fn handle(&self) -> usize {
            self.native.as_raw() as usize
        }

        pub(crate) fn chain(&self) -> Option<IDXGISwapChain1> {
            let current = self.slot.chain.lock().ok()?;
            current.as_ref().map(|Chain(chain)| chain.clone())
        }

        pub(crate) fn set(&self, chain: Option<IDXGISwapChain1>) {
            self.slot.set(chain);
        }

        pub(crate) fn attach_raw(&self, pointer: usize) -> Result<(), String> {
            if pointer == 0 {
                self.set(None);
                return Ok(());
            }
            let chain = unsafe { swap_chain(pointer as *mut c_void) }
                .map_err(|()| "surface swapChain is not an IDXGISwapChain1".to_string())?;
            self.set(chain);
            Ok(())
        }

        /// The element is gone: its swap chain is let go, the panel ignores later calls.
        pub(crate) fn close(self) {
            if let Ok(mut current) = self.slot.chain.lock() {
                *current = None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn surfaces_report_ready_resize_and_destroyed() {
        let mut surfaces = Surfaces::new(|| {});
        let events = surfaces.sync(
            vec![("player".into(), [0, 0, 640, 360], false)],
            1.5,
            Host::Frames,
        );
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["type"], "surface");
        assert_eq!(events[0]["event"], "ready");
        assert_eq!(events[0]["handleType"], "TarveFrames");
        assert_eq!(events[0]["width"], 640);
        assert_eq!(events[0]["scale"], 1.5);
        assert!(
            surfaces
                .sync(
                    vec![("player".into(), [5, 5, 640, 360], false)],
                    1.5,
                    Host::Frames
                )
                .is_empty()
        );
        let events = surfaces.sync(
            vec![("player".into(), [0, 0, 800, 450], false)],
            1.5,
            Host::Frames,
        );
        assert_eq!(events[0]["event"], "resize");
        assert_eq!(events[0]["height"], 450);
        let events = surfaces.sync(vec![], 1.5, Host::Frames);
        assert_eq!(events[0]["event"], "destroyed");
        assert!(surfaces.is_empty());
    }

    #[test]
    fn surfaces_wait_for_the_renderer_and_are_announced_again_when_it_changes() {
        let mut surfaces = Surfaces::new(|| {});
        assert!(
            surfaces
                .sync(
                    vec![("player".into(), [0, 0, 10, 10], false)],
                    1.0,
                    Host::Pending
                )
                .is_empty()
        );
        assert!(surfaces.is_empty());
        #[cfg(target_os = "windows")]
        {
            let events = surfaces.sync(
                vec![("player".into(), [0, 0, 10, 10], false)],
                1.0,
                Host::Composition,
            );
            assert_eq!(events[0]["handleType"], "ISwapChainPanelNative");
            // The D3D11 device was lost and the CPU renders: frames from now on.
            let events = surfaces.sync(
                vec![("player".into(), [0, 0, 10, 10], false)],
                1.0,
                Host::Frames,
            );
            assert_eq!(events[0]["event"], "ready");
            assert_eq!(events[0]["handleType"], "TarveFrames");
        }
        assert!(surfaces.command("player", "attach", Some("1")).is_err());
    }

    #[test]
    fn producers_present_frames_by_handle_from_any_thread() {
        let wakes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = wakes.clone();
        let mut surfaces = Surfaces::new(move || {
            counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        });
        let events = surfaces.sync(
            vec![("player".into(), [0, 0, 2, 2], false)],
            1.0,
            Host::Frames,
        );
        let handle: u64 = events[0]["handle"].as_str().unwrap().parse().unwrap();
        // BGRX with a padded stride, from another thread, twice before the loop looks.
        let pixels: Vec<u8> = vec![
            1, 2, 3, 0, 4, 5, 6, 0, 99, 99, //
            7, 8, 9, 0, 10, 11, 12, 0, 99, 99,
        ];
        std::thread::spawn(move || {
            for _ in 0..2 {
                let code = unsafe {
                    frames::tarve_surface_present(handle, pixels.as_ptr(), 2, 2, 10, frames::BGRX)
                };
                assert_eq!(code, 0);
            }
        })
        .join()
        .unwrap();
        assert_eq!(
            wakes.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "one wake per batch"
        );
        let taken = surfaces.take_frames();
        assert_eq!(taken.len(), 1);
        let (id, picture) = &taken[0];
        assert_eq!(id, "player");
        assert_eq!((picture.width, picture.height), (2, 2));
        assert_eq!(
            picture.rgba,
            vec![3, 2, 1, 255, 6, 5, 4, 255, 9, 8, 7, 255, 12, 11, 10, 255]
        );
        assert!(surfaces.take_frames().is_empty());
        let rgba = [0_u8; 16];
        assert_eq!(
            unsafe { frames::tarve_surface_present(handle, rgba.as_ptr(), 2, 2, 4, frames::RGBA) },
            -2,
            "stride below a row"
        );
        assert_eq!(
            unsafe { frames::tarve_surface_present(handle, rgba.as_ptr(), 2, 2, 0, 9) },
            -2,
            "unknown format"
        );
        surfaces.sync(vec![], 1.0, Host::Frames);
        assert_eq!(
            unsafe { frames::tarve_surface_present(handle, rgba.as_ptr(), 2, 2, 0, frames::RGBA) },
            -1,
            "gone"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn a_producer_hands_its_swap_chain_to_the_panel_or_the_app_attaches_it() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use windows::Win32::Foundation::HMODULE;
        use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_WARP;
        use windows::Win32::Graphics::Direct3D11::{
            D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION, D3D11CreateDevice,
        };
        use windows::Win32::Graphics::Dxgi::Common::{
            DXGI_ALPHA_MODE_IGNORE, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC,
        };
        use windows::Win32::Graphics::Dxgi::{
            CreateDXGIFactory2, DXGI_CREATE_FACTORY_FLAGS, DXGI_SCALING_STRETCH,
            DXGI_SWAP_CHAIN_DESC1, DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL,
            DXGI_USAGE_RENDER_TARGET_OUTPUT, IDXGIFactory2,
        };
        use windows::core::Interface;

        let mut device = None;
        unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_WARP,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                None,
            )
        }
        .unwrap();
        let device = device.unwrap();
        let factory: IDXGIFactory2 =
            unsafe { CreateDXGIFactory2(DXGI_CREATE_FACTORY_FLAGS(0)) }.unwrap();
        let desc = DXGI_SWAP_CHAIN_DESC1 {
            Width: 64,
            Height: 32,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
            BufferCount: 2,
            Scaling: DXGI_SCALING_STRETCH,
            SwapEffect: DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL,
            AlphaMode: DXGI_ALPHA_MODE_IGNORE,
            ..Default::default()
        };
        let chain = unsafe { factory.CreateSwapChainForComposition(&device, &desc, None) }.unwrap();

        let wakes = Arc::new(AtomicUsize::new(0));
        let counted = wakes.clone();
        let mut surfaces = Surfaces::new(move || {
            counted.fetch_add(1, Ordering::SeqCst);
        });
        let events = surfaces.sync(
            vec![("player".into(), [0, 0, 64, 32], false)],
            1.0,
            Host::Composition,
        );
        let handle: usize = events[0]["handle"].as_str().unwrap().parse().unwrap();

        // As a XAML producer would: through the panel interface.
        let kept = platform::producer_keeps(handle);
        assert!(unsafe { platform::producer_sets(handle, chain.as_raw()) }.is_ok());
        assert_eq!(wakes.load(Ordering::SeqCst), 1);
        assert_eq!(surfaces.chains()[0].1.as_raw(), chain.as_raw());
        assert!(unsafe { platform::producer_sets(handle, std::ptr::null_mut()) }.is_ok());
        assert!(surfaces.chains().is_empty());

        // As libmpv's `display-swapchain`: the app attaches the pointer.
        let pointer = format!("{:#x}", chain.as_raw() as usize);
        surfaces
            .command("player", "attach", Some(&pointer))
            .unwrap();
        assert_eq!(surfaces.chains().len(), 1);
        surfaces.command("player", "detach", None).unwrap();
        assert!(surfaces.chains().is_empty());
        assert_eq!(wakes.load(Ordering::SeqCst), 4);
        assert!(surfaces.command("player", "attach", Some("nope")).is_err());

        // Once the element is gone the panel ignores its producer.
        surfaces.sync(vec![], 1.0, Host::Composition);
        assert!(unsafe { platform::producer_sets(handle, chain.as_raw()) }.is_ok());
        drop(kept);
        assert_eq!(wakes.load(Ordering::SeqCst), 4);
    }

    /// X11: a child window of the app's window per surface, following layout. Needs a display.
    #[cfg(target_os = "linux")]
    #[test]
    fn x11_surfaces_are_child_windows_that_follow_layout() {
        use x11rb::connection::Connection;
        use x11rb::protocol::xproto::{ConnectionExt, CreateWindowAux, WindowClass};
        if std::env::var_os("DISPLAY").is_none() {
            eprintln!("no DISPLAY: skipped");
            return;
        }
        let (connection, screen) = x11rb::rust_connection::RustConnection::connect(None).unwrap();
        let root = connection.setup().roots[screen].root;
        let parent = connection.generate_id().unwrap();
        connection
            .create_window(
                0,
                parent,
                root,
                0,
                0,
                400,
                300,
                0,
                WindowClass::INPUT_OUTPUT,
                0,
                &CreateWindowAux::new(),
            )
            .unwrap()
            .check()
            .unwrap();
        let mut surfaces = Surfaces::new(|| {});
        let events = surfaces.sync(
            vec![("player".into(), [10, 40, 200, 100], true)],
            1.0,
            Host::X11(parent),
        );
        assert_eq!(events[0]["event"], "ready");
        assert_eq!(events[0]["handleType"], "X11Window");
        let child: u32 = events[0]["handle"].as_str().unwrap().parse().unwrap();
        let tree = connection.query_tree(parent).unwrap().reply().unwrap();
        assert_eq!(tree.children, vec![child]);
        let geometry = |connection: &x11rb::rust_connection::RustConnection| {
            let g = connection.get_geometry(child).unwrap().reply().unwrap();
            (g.x, g.y, g.width, g.height)
        };
        assert_eq!(geometry(&connection), (10, 40, 200, 100));
        // Moved only: placed again, no resize event.
        assert!(
            surfaces
                .sync(
                    vec![("player".into(), [30, 50, 200, 100], true)],
                    1.0,
                    Host::X11(parent)
                )
                .is_empty()
        );
        assert_eq!(geometry(&connection), (30, 50, 200, 100));
        let events = surfaces.sync(
            vec![("player".into(), [30, 50, 320, 180], true)],
            1.0,
            Host::X11(parent),
        );
        assert_eq!(events[0]["event"], "resize");
        assert_eq!(geometry(&connection), (30, 50, 320, 180));
        // Without `native` the same window composes frames instead.
        let events = surfaces.sync(
            vec![("player".into(), [30, 50, 320, 180], false)],
            1.0,
            Host::X11(parent),
        );
        assert_eq!(events[0]["handleType"], "TarveFrames");
        let tree = connection.query_tree(parent).unwrap().reply().unwrap();
        assert!(tree.children.is_empty());
        surfaces.sync(vec![], 1.0, Host::X11(parent));
        let tree = connection.query_tree(parent).unwrap().reply().unwrap();
        assert!(tree.children.is_empty());
        connection.destroy_window(parent).unwrap();
        connection.flush().unwrap();
    }
}
