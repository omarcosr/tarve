//! `TarveGL` surfaces (Linux, Vulkan renderer): a producer renders with OpenGL straight into GPU
//! memory the UI's Vulkan device composes — no copy through the CPU, no readback, no upload.
//!
//! Each surface owns a ring of `BUFFERS` RGBA8 Vulkan images whose memory is exported as opaque
//! fds (`VK_KHR_external_memory_fd`). A producer thread makes Tarve's EGL context current
//! (`tarve_surface_gl_make_current`; libmpv's render API is created and run under it), and per
//! picture calls `tarve_surface_gl_begin`, renders into the FBO it binds, then
//! `tarve_surface_gl_end`. The producer draws into one ordinary GL texture per surface (its FBO
//! keeps its name; producers that cache GL state per FBO stay right while images cycle and are
//! remade underneath); end copies it on the GPU into a free shared image (imported with
//! `GL_EXT_memory_object_fd`), fences and flushes, and returns. A waiter thread waits for the GPU,
//! then hands the picture to the UI as the newest one (mailbox: the producer never blocks, a
//! picture the UI did not show yet is replaced), and the UI's next frame copies it into Vello's
//! image atlas on the GPU.
//!
//! The images are linear (no compressed layouts to reconcile between the two APIs). GL and Vulkan
//! must run on the same device and driver (their UUIDs are compared once); otherwise surfaces use
//! `TarveFrames`.

use ash::vk;
use khronos_egl as egl;
use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::{CStr, c_char, c_void};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak, mpsc};
use vello::wgpu;

/// Pictures in flight per surface: shown, being retired by the GPU, ready, being drawn.
const BUFFERS: usize = 4;

/// The images a surface renders into, for one size and device.
pub(crate) struct Ring {
    pub width: u32,
    pub height: u32,
    pub buffers: Vec<Arc<SharedImage>>,
    pub textures: Vec<wgpu::Texture>,
}

/// One image's exported memory, as GL imports it.
pub(crate) struct SharedImage {
    id: u64,
    width: u32,
    height: u32,
    size: u64,
    linear: bool,
    fd: OwnedFd,
}

#[derive(Default)]
struct State {
    /// The current ring's images (an older ring's pictures are dropped).
    images: Vec<Arc<SharedImage>>,
    writing: Option<u64>,
    fenced: Option<u64>,
    ready: Option<u64>,
    shown: Option<u64>,
    retiring: Vec<u64>,
    closed: bool,
}

impl State {
    fn busy(&self, id: u64) -> bool {
        self.writing == Some(id)
            || self.fenced == Some(id)
            || self.shown == Some(id)
            || self.retiring.contains(&id)
    }
}

pub(crate) struct Slot {
    handle: u64,
    state: Mutex<State>,
    wake: Arc<dyn Fn() + Send + Sync>,
    fences: Mutex<Option<mpsc::Sender<(Fence, u64)>>>,
}

static SLOTS: Mutex<Option<HashMap<u64, Weak<Slot>>>> = Mutex::new(None);
static NEXT_HANDLE: AtomicU64 = AtomicU64::new(1 << 40);
static NEXT_IMAGE: AtomicU64 = AtomicU64::new(1);

fn slot(handle: u64) -> Option<Arc<Slot>> {
    SLOTS
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .as_ref()?
        .get(&handle)?
        .upgrade()
}

impl Slot {
    pub(crate) fn new(wake: Arc<dyn Fn() + Send + Sync>) -> Arc<Self> {
        let handle = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
        let slot = Arc::new(Self {
            handle,
            state: Mutex::new(State::default()),
            wake,
            fences: Mutex::new(None),
        });
        SLOTS
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .get_or_insert_with(HashMap::new)
            .insert(handle, Arc::downgrade(&slot));
        slot
    }

    pub(crate) fn handle(&self) -> u64 {
        self.handle
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    /// A new ring (size or device changed): pictures of the old one are not shown again.
    pub(crate) fn set_ring(&self, ring: &Ring) {
        let mut state = self.state();
        *state = State {
            images: ring.buffers.clone(),
            closed: state.closed,
            ..State::default()
        };
    }

    /// The UI takes the newest picture: its index in the ring, and the ids the GPU must finish
    /// with before producers reuse them (`release` them once the queue is done).
    pub(crate) fn take(&self) -> Option<(usize, Vec<u64>)> {
        let mut state = self.state();
        let ready = state.ready.take()?;
        let index = state.images.iter().position(|image| image.id == ready)?;
        if let Some(previous) = state.shown.replace(ready) {
            state.retiring.push(previous);
        }
        Some((index, state.retiring.clone()))
    }

    pub(crate) fn release(&self, ids: &[u64]) {
        self.state().retiring.retain(|id| !ids.contains(id));
    }

    pub(crate) fn close(&self) {
        self.state().closed = true;
        SLOTS
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .as_mut()
            .map(|slots| slots.remove(&self.handle));
        self.fences
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .take();
    }

    /// The picture behind `fence` finished on the GPU.
    fn finished(&self, id: u64) {
        {
            let mut state = self.state();
            if state.fenced != Some(id) {
                return;
            }
            state.fenced = None;
            if state.closed || !state.images.iter().any(|image| image.id == id) {
                return;
            }
            state.ready = Some(id);
        }
        (self.wake)();
    }

    /// Fences go to one waiter thread per surface, in order.
    fn wait_for(self: &Arc<Self>, fence: Fence, id: u64) {
        let mut fences = self
            .fences
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if fences.is_none() {
            let (sender, receiver) = mpsc::channel::<(Fence, u64)>();
            let weak = Arc::downgrade(self);
            let spawned = std::thread::Builder::new()
                .name("tarve-surface-fence".into())
                .spawn(move || {
                    for (fence, id) in receiver {
                        fence.wait();
                        match weak.upgrade() {
                            Some(slot) => slot.finished(id),
                            None => return,
                        }
                    }
                });
            if spawned.is_err() {
                fence.wait();
                self.finished(id);
                return;
            }
            *fences = Some(sender);
        }
        if let Some(Err(mpsc::SendError((fence, id)))) =
            fences.as_ref().map(|s| s.send((fence, id)))
        {
            fence.wait();
            self.finished(id);
        }
    }
}

// ---------------------------------------------------------------- Vulkan side

/// Device and driver UUIDs.
type Uuids = ([u8; 16], [u8; 16]);

/// Whether the Vulkan device can export what GL imports, and which tiling to use.
pub(crate) struct Interop {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    /// Device and driver UUIDs, compared with GL's.
    uuids: Uuids,
}

impl Interop {
    pub(crate) fn new(device: wgpu::Device, queue: wgpu::Queue) -> Option<Self> {
        let uuids = unsafe {
            let hal = device.as_hal::<wgpu::hal::api::Vulkan>()?;
            if !hal
                .enabled_device_extensions()
                .contains(&ash::khr::external_memory_fd::NAME)
            {
                return None;
            }
            let instance = hal.shared_instance().raw_instance();
            let mut id = vk::PhysicalDeviceIDProperties::default();
            let mut properties = vk::PhysicalDeviceProperties2::default().push_next(&mut id);
            instance.get_physical_device_properties2(hal.raw_physical_device(), &mut properties);
            (id.device_uuid, id.driver_uuid)
        };
        Some(Self {
            device,
            queue,
            uuids,
        })
    }

    /// GL on this thread's default EGL display runs on the same device and driver.
    pub(crate) fn gl_matches(&self) -> Result<(), String> {
        static PROBE: OnceLock<Result<Uuids, String>> = OnceLock::new();
        // On a thread of its own: the context it makes current there goes with it.
        let gl = PROBE.get_or_init(|| {
            std::thread::spawn(|| {
                let context = Context::new()?;
                let uuids = context.uuids();
                drop(context);
                uuids
            })
            .join()
            .unwrap_or_else(|_| Err("GL probe panicked".into()))
        });
        match gl {
            Ok(gl) if *gl == self.uuids => Ok(()),
            Ok(_) => Err("GL and Vulkan run on different devices or drivers".into()),
            Err(error) => Err(error.clone()),
        }
    }

    /// A ring of `BUFFERS` exportable images of `width`×`height`.
    pub(crate) fn ring(&self, width: u32, height: u32) -> Result<Ring, String> {
        let (width, height) = (width.clamp(1, 16384), height.clamp(1, 16384));
        let mut buffers = Vec::with_capacity(BUFFERS);
        let mut textures = Vec::with_capacity(BUFFERS);
        for _ in 0..BUFFERS {
            let (image, texture) = self.image(width, height)?;
            buffers.push(Arc::new(image));
            textures.push(texture);
        }
        // The images' first use moves them out of UNDEFINED (whose contents may be discarded)
        // before GL ever writes them; afterwards they are only ever copy sources.
        let scratch = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("tarve-surface-prime"),
            size: wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let mut encoder = self.device.create_command_encoder(&Default::default());
        for texture in &textures {
            encoder.copy_texture_to_texture(
                texture.as_image_copy(),
                scratch.as_image_copy(),
                wgpu::Extent3d {
                    width: 1,
                    height: 1,
                    depth_or_array_layers: 1,
                },
            );
        }
        self.queue.submit([encoder.finish()]);
        Ok(Ring {
            width,
            height,
            buffers,
            textures,
        })
    }

    fn image(&self, width: u32, height: u32) -> Result<(SharedImage, wgpu::Texture), String> {
        let hal = unsafe { self.device.as_hal::<wgpu::hal::api::Vulkan>() }
            .ok_or("not a Vulkan device")?;
        let device = hal.raw_device();
        let instance = hal.shared_instance().raw_instance();
        let physical = hal.raw_physical_device();
        let usage = vk::ImageUsageFlags::TRANSFER_SRC
            | vk::ImageUsageFlags::TRANSFER_DST
            | vk::ImageUsageFlags::SAMPLED
            | vk::ImageUsageFlags::COLOR_ATTACHMENT;
        let supports = |tiling: vk::ImageTiling| {
            let mut external = vk::PhysicalDeviceExternalImageFormatInfo::default()
                .handle_type(vk::ExternalMemoryHandleTypeFlags::OPAQUE_FD);
            let info = vk::PhysicalDeviceImageFormatInfo2::default()
                .format(vk::Format::R8G8B8A8_UNORM)
                .ty(vk::ImageType::TYPE_2D)
                .tiling(tiling)
                .usage(usage)
                .push_next(&mut external);
            let mut external_properties = vk::ExternalImageFormatProperties::default();
            let mut properties =
                vk::ImageFormatProperties2::default().push_next(&mut external_properties);
            let ok = unsafe {
                instance.get_physical_device_image_format_properties2(
                    physical,
                    &info,
                    &mut properties,
                )
            }
            .is_ok();
            let limits = properties.image_format_properties.max_extent;
            ok && external_properties
                .external_memory_properties
                .external_memory_features
                .contains(vk::ExternalMemoryFeatureFlags::EXPORTABLE)
                && limits.width >= width
                && limits.height >= height
        };
        let linear = if supports(vk::ImageTiling::LINEAR) {
            true
        } else if supports(vk::ImageTiling::OPTIMAL) {
            false
        } else {
            return Err("RGBA8 images cannot be exported as opaque fds".into());
        };
        let mut external = vk::ExternalMemoryImageCreateInfo::default()
            .handle_types(vk::ExternalMemoryHandleTypeFlags::OPAQUE_FD);
        let info = vk::ImageCreateInfo::default()
            .image_type(vk::ImageType::TYPE_2D)
            .format(vk::Format::R8G8B8A8_UNORM)
            .extent(vk::Extent3D {
                width,
                height,
                depth: 1,
            })
            .mip_levels(1)
            .array_layers(1)
            .samples(vk::SampleCountFlags::TYPE_1)
            .tiling(if linear {
                vk::ImageTiling::LINEAR
            } else {
                vk::ImageTiling::OPTIMAL
            })
            .usage(usage)
            .sharing_mode(vk::SharingMode::EXCLUSIVE)
            .initial_layout(vk::ImageLayout::UNDEFINED)
            .push_next(&mut external);
        let fail = |what: &str, error: vk::Result| format!("{what}: {error}");
        unsafe {
            let image = device
                .create_image(&info, None)
                .map_err(|e| fail("vkCreateImage", e))?;
            let requirements = device.get_image_memory_requirements(image);
            let types = instance.get_physical_device_memory_properties(physical);
            let Some(memory_type) = (0..types.memory_type_count).find(|&index| {
                requirements.memory_type_bits & (1 << index) != 0
                    && types.memory_types[index as usize]
                        .property_flags
                        .contains(vk::MemoryPropertyFlags::DEVICE_LOCAL)
            }) else {
                device.destroy_image(image, None);
                return Err("no device-local memory for an exported image".into());
            };
            let mut export = vk::ExportMemoryAllocateInfo::default()
                .handle_types(vk::ExternalMemoryHandleTypeFlags::OPAQUE_FD);
            let mut dedicated = vk::MemoryDedicatedAllocateInfo::default().image(image);
            let allocate = vk::MemoryAllocateInfo::default()
                .allocation_size(requirements.size)
                .memory_type_index(memory_type)
                .push_next(&mut export)
                .push_next(&mut dedicated);
            let memory = match device.allocate_memory(&allocate, None) {
                Ok(memory) => memory,
                Err(error) => {
                    device.destroy_image(image, None);
                    return Err(fail("vkAllocateMemory", error));
                }
            };
            if let Err(error) = device.bind_image_memory(image, memory, 0) {
                device.free_memory(memory, None);
                device.destroy_image(image, None);
                return Err(fail("vkBindImageMemory", error));
            }
            let loader = ash::khr::external_memory_fd::Device::new(instance, device);
            let fd = match loader.get_memory_fd(
                &vk::MemoryGetFdInfoKHR::default()
                    .memory(memory)
                    .handle_type(vk::ExternalMemoryHandleTypeFlags::OPAQUE_FD),
            ) {
                Ok(fd) => OwnedFd::from_raw_fd(fd),
                Err(error) => {
                    device.free_memory(memory, None);
                    device.destroy_image(image, None);
                    return Err(fail("vkGetMemoryFdKHR", error));
                }
            };
            let extent = wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            };
            let hal_texture = hal.texture_from_raw(
                image,
                &wgpu::hal::TextureDescriptor {
                    label: Some("tarve-surface"),
                    size: extent,
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    usage: wgpu::TextureUses::COPY_SRC | wgpu::TextureUses::RESOURCE,
                    memory_flags: wgpu::hal::MemoryFlags::empty(),
                    view_formats: Vec::new(),
                },
                None,
                wgpu::hal::vulkan::TextureMemory::Dedicated(memory),
            );
            drop(hal);
            let texture = self
                .device
                .create_texture_from_hal::<wgpu::hal::api::Vulkan>(
                    hal_texture,
                    &wgpu::TextureDescriptor {
                        label: Some("tarve-surface"),
                        size: extent,
                        mip_level_count: 1,
                        sample_count: 1,
                        dimension: wgpu::TextureDimension::D2,
                        format: wgpu::TextureFormat::Rgba8Unorm,
                        usage: wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::TEXTURE_BINDING,
                        view_formats: &[],
                    },
                );
            Ok((
                SharedImage {
                    id: NEXT_IMAGE.fetch_add(1, Ordering::Relaxed),
                    width,
                    height,
                    size: requirements.size,
                    linear,
                    fd,
                },
                texture,
            ))
        }
    }
}

// ---------------------------------------------------------------- GL side

const EGL_PLATFORM_SURFACELESS_MESA: egl::Enum = 0x31DD;
const GL_TEXTURE_2D: u32 = 0x0DE1;
const GL_RGBA8: u32 = 0x8058;
const GL_FRAMEBUFFER: u32 = 0x8D40;
const GL_READ_FRAMEBUFFER: u32 = 0x8CA8;
const GL_DRAW_FRAMEBUFFER: u32 = 0x8CA9;
const GL_COLOR_BUFFER_BIT: u32 = 0x4000;
const GL_NEAREST: u32 = 0x2600;
const GL_COLOR_ATTACHMENT0: u32 = 0x8CE0;
const GL_FRAMEBUFFER_COMPLETE: u32 = 0x8CD5;
const GL_HANDLE_TYPE_OPAQUE_FD_EXT: u32 = 0x9586;
const GL_DEDICATED_MEMORY_OBJECT_EXT: u32 = 0x9581;
const GL_TEXTURE_TILING_EXT: u32 = 0x9580;
const GL_OPTIMAL_TILING_EXT: i32 = 0x9584;
const GL_LINEAR_TILING_EXT: i32 = 0x9585;
const GL_NUM_DEVICE_UUIDS_EXT: u32 = 0x9596;
const GL_DEVICE_UUID_EXT: u32 = 0x9597;
const GL_DRIVER_UUID_EXT: u32 = 0x9598;

type EglInstance = egl::DynamicInstance<egl::EGL1_5>;

struct Egl {
    instance: EglInstance,
    display: egl::Display,
}

// SAFETY: EGL displays and the instance's function table are usable from any thread.
unsafe impl Send for Egl {}
unsafe impl Sync for Egl {}

fn egl() -> Result<&'static Egl, String> {
    static EGL: OnceLock<Result<Egl, String>> = OnceLock::new();
    EGL.get_or_init(|| {
        let instance =
            unsafe { EglInstance::load_required() }.map_err(|error| format!("libEGL: {error}"))?;
        let surfaceless = unsafe {
            instance.get_platform_display(
                EGL_PLATFORM_SURFACELESS_MESA,
                egl::DEFAULT_DISPLAY,
                &[egl::ATTRIB_NONE],
            )
        };
        let display = match surfaceless {
            Ok(display) => display,
            Err(error) => unsafe { instance.get_display(egl::DEFAULT_DISPLAY) }
                .ok_or_else(|| format!("no EGL display (surfaceless: {error})"))?,
        };
        instance
            .initialize(display)
            .map_err(|error| format!("eglInitialize: {error}"))?;
        Ok(Egl { instance, display })
    })
    .as_ref()
    .map_err(Clone::clone)
}

macro_rules! gl_functions {
    ($($name:ident: fn($($arg:ty),*) $(-> $ret:ty)?;)*) => {
        #[allow(non_snake_case)]
        struct Gl { $($name: unsafe extern "system" fn($($arg),*) $(-> $ret)?,)* }
        impl Gl {
            fn load(egl: &Egl) -> Result<Self, String> {
                Ok(Self { $($name: {
                    let f = egl.instance.get_proc_address(stringify!($name))
                        .ok_or(concat!("GL function ", stringify!($name), " is missing"))?;
                    // SAFETY: the driver's entry point of that name has this signature.
                    unsafe { std::mem::transmute::<extern "system" fn(), unsafe extern "system" fn($($arg),*) $(-> $ret)?>(f) }
                },)* })
            }
        }
    };
}

gl_functions! {
    glCreateMemoryObjectsEXT: fn(i32, *mut u32);
    glMemoryObjectParameterivEXT: fn(u32, u32, *const i32);
    glImportMemoryFdEXT: fn(u32, u64, u32, i32);
    glDeleteMemoryObjectsEXT: fn(i32, *const u32);
    glGenTextures: fn(i32, *mut u32);
    glDeleteTextures: fn(i32, *const u32);
    glBindTexture: fn(u32, u32);
    glTexParameteri: fn(u32, u32, i32);
    glTexStorageMem2DEXT: fn(u32, i32, u32, i32, i32, u32, u64);
    glGenFramebuffers: fn(i32, *mut u32);
    glDeleteFramebuffers: fn(i32, *const u32);
    glBindFramebuffer: fn(u32, u32);
    glFramebufferTexture2D: fn(u32, u32, u32, u32, i32);
    glCheckFramebufferStatus: fn(u32) -> u32;
    glViewport: fn(i32, i32, i32, i32);
    glFlush: fn();
    glFinish: fn();
    glGetIntegerv: fn(u32, *mut i32);
    glGetUnsignedBytevEXT: fn(u32, *mut u8);
    glGetUnsignedBytei_vEXT: fn(u32, u32, *mut u8);
    glGetError: fn() -> u32;
    glTexStorage2D: fn(u32, i32, u32, i32, i32);
    glBlitFramebuffer: fn(i32, i32, i32, i32, i32, i32, i32, i32, u32, u32);
}

/// What one GL context imported: per image, its memory object and texture.
struct Import {
    memory: u32,
    texture: u32,
}

/// Where a surface's producer draws in one context: an ordinary texture and FBO of the surface's
/// size, copied into the shared image at the end of each picture. The producer only ever sees this
/// one FBO (its name stays while the surface lives), never the shared images being cycled and
/// remade underneath.
struct Canvas {
    fbo: u32,
    texture: u32,
    width: u32,
    height: u32,
}

/// The FBO a picture is copied into: one per ring position of a surface, with that position's
/// current shared image attached.
struct Target {
    fbo: u32,
    texture: u32,
}

/// Tarve's EGL context of one producer thread.
struct Context {
    egl: &'static Egl,
    context: egl::Context,
    gl: Gl,
    imports: HashMap<u64, Import>,
    targets: HashMap<(u64, usize), Target>,
    canvases: HashMap<u64, Canvas>,
    /// Per surface, the picture under way: its canvas and shared-image FBOs and size.
    drawing: HashMap<u64, (u32, u32, u32, u32)>,
}

impl Context {
    fn new() -> Result<Self, String> {
        let egl = egl()?;
        let instance = &egl.instance;
        instance
            .bind_api(egl::OPENGL_API)
            .map_err(|error| format!("eglBindAPI: {error}"))?;
        let config = instance
            .choose_first_config(
                egl.display,
                &[egl::RENDERABLE_TYPE, egl::OPENGL_BIT, egl::NONE],
            )
            .map_err(|error| format!("eglChooseConfig: {error}"))?;
        // Surfaceless displays may have no configs: a context needs none to render into FBOs.
        let no_config = instance
            .query_string(Some(egl.display), egl::EXTENSIONS)
            .is_ok_and(|extensions| {
                extensions
                    .to_string_lossy()
                    .split(' ')
                    .any(|name| name == "EGL_KHR_no_config_context")
            });
        let config = match config {
            Some(config) => config,
            // SAFETY: EGL_NO_CONFIG_KHR, accepted with EGL_KHR_no_config_context.
            None if no_config => unsafe { egl::Config::from_ptr(std::ptr::null_mut()) },
            None => return Err("no OpenGL EGL config".into()),
        };
        let context = instance
            .create_context(egl.display, config, None, &[egl::NONE])
            .map_err(|error| format!("eglCreateContext: {error}"))?;
        instance
            .make_current(egl.display, None, None, Some(context))
            .map_err(|error| format!("eglMakeCurrent: {error}"))?;
        let gl = Gl::load(egl)?;
        Ok(Self {
            egl,
            context,
            gl,
            imports: HashMap::new(),
            targets: HashMap::new(),
            canvases: HashMap::new(),
            drawing: HashMap::new(),
        })
    }

    fn make_current(&self) -> Result<(), String> {
        let instance = &self.egl.instance;
        if instance.get_current_context() == Some(self.context) {
            return Ok(());
        }
        instance
            .make_current(self.egl.display, None, None, Some(self.context))
            .map_err(|error| format!("eglMakeCurrent: {error}"))
    }

    fn uuids(&self) -> Result<Uuids, String> {
        let (mut device, mut driver) = ([0_u8; 16], [0_u8; 16]);
        let mut count = 0;
        unsafe {
            (self.gl.glGetIntegerv)(GL_NUM_DEVICE_UUIDS_EXT, &mut count);
            if count < 1 {
                return Err("GL reports no device UUID".into());
            }
            (self.gl.glGetUnsignedBytei_vEXT)(GL_DEVICE_UUID_EXT, 0, device.as_mut_ptr());
            (self.gl.glGetUnsignedBytevEXT)(GL_DRIVER_UUID_EXT, driver.as_mut_ptr());
        }
        Ok((device, driver))
    }

    /// The texture over `image`, importing it the first time.
    fn texture(&mut self, image: &SharedImage) -> Result<u32, String> {
        if let Some(import) = self.imports.get(&image.id) {
            return Ok(import.texture);
        }
        let gl = &self.gl;
        let fd = image
            .fd
            .try_clone()
            .map_err(|error| format!("dup: {error}"))?;
        unsafe {
            // Errors the producer's own calls left pending are not this import's.
            for _ in 0..16 {
                if (gl.glGetError)() == 0 {
                    break;
                }
            }
            let (mut memory, mut texture) = (0, 0);
            (gl.glCreateMemoryObjectsEXT)(1, &mut memory);
            (gl.glMemoryObjectParameterivEXT)(memory, GL_DEDICATED_MEMORY_OBJECT_EXT, &1);
            // GL owns the fd from here.
            let raw = fd.as_raw_fd();
            std::mem::forget(fd);
            (gl.glImportMemoryFdEXT)(memory, image.size, GL_HANDLE_TYPE_OPAQUE_FD_EXT, raw);
            (gl.glGenTextures)(1, &mut texture);
            (gl.glBindTexture)(GL_TEXTURE_2D, texture);
            let tiling = if image.linear {
                GL_LINEAR_TILING_EXT
            } else {
                GL_OPTIMAL_TILING_EXT
            };
            (gl.glTexParameteri)(GL_TEXTURE_2D, GL_TEXTURE_TILING_EXT, tiling);
            (gl.glTexStorageMem2DEXT)(
                GL_TEXTURE_2D,
                1,
                GL_RGBA8,
                image.width as i32,
                image.height as i32,
                memory,
                0,
            );
            (gl.glBindTexture)(GL_TEXTURE_2D, 0);
            let error = (gl.glGetError)();
            let import = Import { memory, texture };
            if error != 0 {
                self.delete(import);
                return Err(format!(
                    "GL import of a surface image failed (error {error:#x})"
                ));
            }
            self.imports.insert(image.id, import);
            Ok(texture)
        }
    }

    /// The copy-destination FBO of ring position `index` of surface `handle`, with `image` attached.
    fn fbo(&mut self, handle: u64, index: usize, image: &SharedImage) -> Result<u32, String> {
        let texture = self.texture(image)?;
        let gl = &self.gl;
        unsafe {
            let target = match self.targets.get_mut(&(handle, index)) {
                Some(target) => target,
                _ => {
                    let mut fbo = 0;
                    (gl.glGenFramebuffers)(1, &mut fbo);
                    self.targets
                        .insert((handle, index), Target { fbo, texture: 0 });
                    self.targets.get_mut(&(handle, index)).unwrap()
                }
            };
            (gl.glBindFramebuffer)(GL_FRAMEBUFFER, target.fbo);
            if target.texture != texture {
                (gl.glFramebufferTexture2D)(
                    GL_FRAMEBUFFER,
                    GL_COLOR_ATTACHMENT0,
                    GL_TEXTURE_2D,
                    texture,
                    0,
                );
                target.texture = texture;
                let status = (gl.glCheckFramebufferStatus)(GL_FRAMEBUFFER);
                if status != GL_FRAMEBUFFER_COMPLETE {
                    target.texture = 0;
                    return Err(format!("surface framebuffer incomplete ({status:#x})"));
                }
            }
            Ok(target.fbo)
        }
    }

    /// The canvas FBO of surface `handle` at `width`×`height`, bound.
    fn canvas(&mut self, handle: u64, width: u32, height: u32) -> Result<u32, String> {
        let gl = &self.gl;
        unsafe {
            let canvas = self.canvases.entry(handle).or_insert_with(|| {
                let mut fbo = 0;
                (gl.glGenFramebuffers)(1, &mut fbo);
                Canvas {
                    fbo,
                    texture: 0,
                    width: 0,
                    height: 0,
                }
            });
            (gl.glBindFramebuffer)(GL_FRAMEBUFFER, canvas.fbo);
            if canvas.texture == 0 || canvas.width != width || canvas.height != height {
                if canvas.texture != 0 {
                    (gl.glFramebufferTexture2D)(
                        GL_FRAMEBUFFER,
                        GL_COLOR_ATTACHMENT0,
                        GL_TEXTURE_2D,
                        0,
                        0,
                    );
                    (gl.glDeleteTextures)(1, &canvas.texture);
                }
                let mut texture = 0;
                (gl.glGenTextures)(1, &mut texture);
                (gl.glBindTexture)(GL_TEXTURE_2D, texture);
                (gl.glTexStorage2D)(GL_TEXTURE_2D, 1, GL_RGBA8, width as i32, height as i32);
                (gl.glBindTexture)(GL_TEXTURE_2D, 0);
                (gl.glFramebufferTexture2D)(
                    GL_FRAMEBUFFER,
                    GL_COLOR_ATTACHMENT0,
                    GL_TEXTURE_2D,
                    texture,
                    0,
                );
                *canvas = Canvas {
                    fbo: canvas.fbo,
                    texture,
                    width,
                    height,
                };
                let status = (gl.glCheckFramebufferStatus)(GL_FRAMEBUFFER);
                if status != GL_FRAMEBUFFER_COMPLETE {
                    return Err(format!("surface canvas incomplete ({status:#x})"));
                }
            }
            Ok(canvas.fbo)
        }
    }

    fn delete(&self, import: Import) {
        let gl = &self.gl;
        unsafe {
            (gl.glDeleteTextures)(1, &import.texture);
            (gl.glDeleteMemoryObjectsEXT)(1, &import.memory);
        }
    }

    /// Drops imports of images no surface holds any more, and the FBOs of surfaces gone.
    fn prune(&mut self, live: &dyn Fn(u64) -> bool, surface_live: &dyn Fn(u64) -> bool) {
        let stale: Vec<u64> = self
            .imports
            .keys()
            .copied()
            .filter(|id| !live(*id))
            .collect();
        for id in stale {
            if let Some(import) = self.imports.remove(&id) {
                // Detached first wherever it is attached.
                for target in self.targets.values_mut() {
                    if target.texture == import.texture {
                        unsafe {
                            (self.gl.glBindFramebuffer)(GL_FRAMEBUFFER, target.fbo);
                            (self.gl.glFramebufferTexture2D)(
                                GL_FRAMEBUFFER,
                                GL_COLOR_ATTACHMENT0,
                                GL_TEXTURE_2D,
                                0,
                                0,
                            );
                        }
                        target.texture = 0;
                    }
                }
                self.delete(import);
            }
        }
        let gone: Vec<(u64, usize)> = self
            .targets
            .keys()
            .copied()
            .filter(|(handle, _)| !surface_live(*handle))
            .collect();
        for key in gone {
            if let Some(target) = self.targets.remove(&key) {
                unsafe { (self.gl.glDeleteFramebuffers)(1, &target.fbo) };
            }
        }
        let gone: Vec<u64> = self
            .canvases
            .keys()
            .copied()
            .filter(|handle| !surface_live(*handle))
            .collect();
        for handle in gone {
            if let Some(canvas) = self.canvases.remove(&handle) {
                unsafe {
                    (self.gl.glDeleteFramebuffers)(1, &canvas.fbo);
                    (self.gl.glDeleteTextures)(1, &canvas.texture);
                }
            }
            self.drawing.remove(&handle);
        }
    }

    fn fence(&self) -> Result<Fence, String> {
        let sync = unsafe {
            self.egl.instance.create_sync(
                self.egl.display,
                egl::SYNC_FENCE as egl::Enum,
                &[egl::ATTRIB_NONE],
            )
        }
        .map_err(|error| format!("eglCreateSync: {error}"))?;
        unsafe { (self.gl.glFlush)() };
        Ok(Fence {
            egl: self.egl,
            sync,
        })
    }
}

impl Drop for Context {
    fn drop(&mut self) {
        if self.make_current().is_ok() {
            for (_, target) in std::mem::take(&mut self.targets) {
                unsafe { (self.gl.glDeleteFramebuffers)(1, &target.fbo) };
            }
            for (_, canvas) in std::mem::take(&mut self.canvases) {
                unsafe {
                    (self.gl.glDeleteFramebuffers)(1, &canvas.fbo);
                    (self.gl.glDeleteTextures)(1, &canvas.texture);
                }
            }
            for (_, import) in std::mem::take(&mut self.imports) {
                self.delete(import);
            }
        }
        let instance = &self.egl.instance;
        let _ = instance.make_current(self.egl.display, None, None, None);
        let _ = instance.destroy_context(self.egl.display, self.context);
    }
}

/// A GL fence, waited for on the surface's waiter thread.
struct Fence {
    egl: &'static Egl,
    sync: egl::Sync,
}

// SAFETY: EGL sync objects belong to the display and may be waited for from any thread.
unsafe impl Send for Fence {}

impl Fence {
    fn wait(self) {
        let instance = &self.egl.instance;
        let _ = unsafe { instance.client_wait_sync(self.egl.display, self.sync, 0, egl::FOREVER) };
        let _ = unsafe { instance.destroy_sync(self.egl.display, self.sync) };
    }
}

thread_local! {
    static CONTEXT: RefCell<Option<Context>> = const { RefCell::new(None) };
}

fn with_context<T>(f: impl FnOnce(&mut Context) -> Result<T, String>) -> Result<T, String> {
    CONTEXT.with(|cell| {
        let mut cell = cell.borrow_mut();
        if cell.is_none() {
            *cell = Some(Context::new()?);
        }
        let context = cell.as_mut().unwrap();
        context.make_current()?;
        f(context)
    })
}

fn report(result: Result<i32, String>) -> i32 {
    match result {
        Ok(code) => code,
        Err(message) => {
            eprintln!("[tarve] surface GL: {message}");
            -3
        }
    }
}

/// Makes Tarve's OpenGL context current on this thread (creating it the first time): create
/// and free a producer's GL resources under it (libmpv's `mpv_render_context_create`/`_free`).
/// 0 on success, -3 when no GL context can be made.
#[unsafe(no_mangle)]
pub extern "C" fn tarve_surface_gl_make_current() -> i32 {
    report(with_context(|_| Ok(0)))
}

/// `eglGetProcAddress`, in the shape libmpv's `get_proc_address` takes (`ctx` is ignored).
#[unsafe(no_mangle)]
pub extern "C" fn tarve_surface_gl_get_proc_address(
    _ctx: *mut c_void,
    name: *const c_char,
) -> *mut c_void {
    if name.is_null() {
        return std::ptr::null_mut();
    }
    let Ok(egl) = egl() else {
        return std::ptr::null_mut();
    };
    // SAFETY: a NUL-terminated name from the caller.
    let Ok(name) = unsafe { CStr::from_ptr(name) }.to_str() else {
        return std::ptr::null_mut();
    };
    egl.instance
        .get_proc_address(name)
        .map_or(std::ptr::null_mut(), |f| f as *mut c_void)
}

/// The address of `tarve_surface_gl_get_proc_address`, for FFI callers that cannot take one.
#[unsafe(no_mangle)]
pub extern "C" fn tarve_surface_gl_proc_address_fn() -> u64 {
    tarve_surface_gl_get_proc_address as *const () as usize as u64
}

/// Starts a picture of `TarveGL` surface `handle` on this thread: makes Tarve's context current
/// and binds the surface's FBO (`*fbo`, `*width`×`*height`: render the whole of it). The FBO's
/// name stays the same for the surface's life; its size follows the surface. Its first row is the
/// picture's top, as a texture's: libmpv renders upright with `FLIP_Y` 0; a scene drawn with GL's
/// y-up window convention flips its projection. 0 on success, -1 when the surface is gone, -2 for
/// null arguments, -4 when no image is free yet (all in flight, or the surface has none yet): try
/// again in a few milliseconds; -3 on a GL failure.
///
/// # Safety
/// `fbo`, `width` and `height` are writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tarve_surface_gl_begin(
    handle: u64,
    fbo: *mut u32,
    width: *mut u32,
    height: *mut u32,
) -> i32 {
    if fbo.is_null() || width.is_null() || height.is_null() {
        return -2;
    }
    let Some(slot) = slot(handle) else {
        return -1;
    };
    report(with_context(|context| {
        let (index, image) = {
            let mut state = slot.state();
            // A begin without an end abandons that picture; one the UI has not taken yet is
            // replaced (mailbox).
            state.writing = None;
            state.ready = None;
            let free = state
                .images
                .iter()
                .enumerate()
                .find(|(_, image)| !state.busy(image.id))
                .map(|(index, image)| (index, image.clone()));
            let Some((index, image)) = free else {
                // Every image is still in use: the UI's loop releases them once the GPU is done.
                drop(state);
                (slot.wake)();
                return Ok(-4);
            };
            state.writing = Some(image.id);
            (index, image)
        };
        // Images and surfaces that went away since: their GL objects go too.
        let (surfaces, images): (Vec<u64>, Vec<u64>) = {
            let slots = SLOTS.lock().unwrap_or_else(|poison| poison.into_inner());
            let live: Vec<Arc<Slot>> = slots
                .iter()
                .flat_map(|slots| slots.values())
                .filter_map(Weak::upgrade)
                .collect();
            drop(slots);
            (
                live.iter().map(|slot| slot.handle).collect(),
                live.iter()
                    .flat_map(|slot| {
                        slot.state()
                            .images
                            .iter()
                            .map(|image| image.id)
                            .collect::<Vec<_>>()
                    })
                    .collect(),
            )
        };
        context.prune(&|id| images.contains(&id), &|handle| {
            surfaces.contains(&handle)
        });
        let target = context.fbo(handle, index, &image)?;
        let canvas = context.canvas(handle, image.width, image.height)?;
        context
            .drawing
            .insert(handle, (canvas, target, image.width, image.height));
        unsafe {
            (context.gl.glViewport)(0, 0, image.width as i32, image.height as i32);
            *fbo = canvas;
            *width = image.width;
            *height = image.height;
        }
        Ok(0)
    }))
}

/// Ends the picture `tarve_surface_gl_begin` started: copies it into the shared image on the GPU,
/// fences it and returns at once; the UI shows it once the GPU has drawn it. 0 on success, -1 when
/// the surface is gone, -4 without a begin (or when the surface changed size meanwhile: that
/// picture is dropped).
#[unsafe(no_mangle)]
pub extern "C" fn tarve_surface_gl_end(handle: u64) -> i32 {
    let Some(slot) = slot(handle) else {
        return -1;
    };
    report(with_context(|context| {
        let drawing = context.drawing.remove(&handle);
        let id = {
            let mut state = slot.state();
            let Some(id) = state.writing.take() else {
                return Ok(-4);
            };
            state.fenced = Some(id);
            id
        };
        if let Some((canvas, target, width, height)) = drawing {
            let (w, h) = (width as i32, height as i32);
            unsafe {
                (context.gl.glBindFramebuffer)(GL_READ_FRAMEBUFFER, canvas);
                (context.gl.glBindFramebuffer)(GL_DRAW_FRAMEBUFFER, target);
                (context.gl.glBlitFramebuffer)(
                    0,
                    0,
                    w,
                    h,
                    0,
                    0,
                    w,
                    h,
                    GL_COLOR_BUFFER_BIT,
                    GL_NEAREST,
                );
                // The canvas stays bound, as the producer left it.
                (context.gl.glBindFramebuffer)(GL_FRAMEBUFFER, canvas);
            }
        }
        match context.fence() {
            Ok(fence) => slot.wait_for(fence, id),
            Err(error) => {
                // No fence: wait here instead.
                eprintln!("[tarve] surface GL: {error}");
                unsafe { (context.gl.glFinish)() };
                slot.finished(id);
            }
        }
        Ok(0)
    }))
}

#[cfg(test)]
mod tests {
    /// GL interop needs an EGL display with OpenGL and the memory object extensions.
    #[test]
    fn a_gl_context_reports_its_device() {
        match super::Context::new().and_then(|context| context.uuids()) {
            Ok((device, _)) => assert_ne!(device, [0; 16]),
            Err(error) => eprintln!("no GL here: {error}"),
        }
    }
}
