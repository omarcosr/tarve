//! Android: the platform's MediaPlayer decodes and plays the sound (`dev.tarve.TarveVideo`,
//! packages/core/android/java), keeping picture and sound in sync on its clock. Pictures come
//! from an ImageReader as YUV 4:2:0, on the player's own thread; they are converted to RGBA
//! there (no larger than `MAX_SIDE`) and handed to the renderer in memory, and that thread
//! wakes the event loop. Only `timeupdate` runs on a 250 ms timer.

use super::{VideoFrame, VideoLoad, media_error};
use crate::media::failure;
use jni::JNIEnv;
use jni::objects::{GlobalRef, JByteBuffer, JClass, JObject, JString, JValue};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use vello::peniko::{Blob, ImageAlphaType, ImageData, ImageFormat};

const TIME_UPDATE: Duration = Duration::from_millis(250);
/// Larger pictures are subsampled while converting: the renderer scales them anyway.
const MAX_SIDE: usize = 1280;
const CLASS: &str = "dev.tarve.TarveVideo";

/// What the player's threads leave for the event loop.
#[derive(Default)]
struct Shared {
    picture: Option<(u32, u32, Vec<u8>)>,
    events: Vec<(String, f64)>,
}

static PLAYERS: Mutex<Option<HashMap<i64, Arc<Mutex<Shared>>>>> = Mutex::new(None);
static NEXT_HANDLE: AtomicI64 = AtomicI64::new(1);
static WAKE: OnceLock<Arc<dyn Fn() + Send + Sync>> = OnceLock::new();

fn shared(handle: i64) -> Option<Arc<Mutex<Shared>>> {
    PLAYERS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()?
        .get(&handle)
        .cloned()
}

fn wake() {
    if let Some(wake) = WAKE.get() {
        wake();
    }
}

extern "system" fn native_event(
    mut env: JNIEnv,
    _: JClass,
    handle: i64,
    event: JString,
    value: f64,
) {
    let Ok(event) = env.get_string(&event).map(String::from) else {
        return;
    };
    if let Some(shared) = shared(handle) {
        shared
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .events
            .push((event, value));
        wake();
    }
}

#[allow(clippy::too_many_arguments)]
extern "system" fn native_frame(
    env: JNIEnv,
    _: JClass,
    handle: i64,
    width: i32,
    height: i32,
    y: JByteBuffer,
    u: JByteBuffer,
    v: JByteBuffer,
    y_row: i32,
    uv_row: i32,
    uv_pixel: i32,
) {
    let Some(shared) = shared(handle) else {
        return;
    };
    let plane = |buffer: &JByteBuffer| -> Option<&[u8]> {
        let address = env.get_direct_buffer_address(buffer).ok()?;
        let length = env.get_direct_buffer_capacity(buffer).ok()?;
        // SAFETY: the Image's plane stays mapped until onImageAvailable returns (after this call).
        Some(unsafe { std::slice::from_raw_parts(address, length) })
    };
    let (Some(y), Some(u), Some(v)) = (plane(&y), plane(&u), plane(&v)) else {
        return;
    };
    let source = Yuv {
        width: width.max(0) as usize,
        height: height.max(0) as usize,
        y,
        u,
        v,
        y_row: y_row.max(0) as usize,
        uv_row: uv_row.max(0) as usize,
        uv_pixel: uv_pixel.max(1) as usize,
    };
    if let Some(picture) = source.to_rgba() {
        shared.lock().unwrap_or_else(|p| p.into_inner()).picture = Some(picture);
        wake();
    }
}

/// An RGBA picture from the GPU copy (TarveVideo.GpuCopy), already at most MAX_SIDE.
extern "system" fn native_frame_rgba(
    env: JNIEnv,
    _: JClass,
    handle: i64,
    width: i32,
    height: i32,
    rgba: JByteBuffer,
    row: i32,
) {
    let Some(shared) = shared(handle) else {
        return;
    };
    let (Ok(address), Ok(length)) = (
        env.get_direct_buffer_address(&rgba),
        env.get_direct_buffer_capacity(&rgba),
    ) else {
        return;
    };
    // SAFETY: the Image's plane stays mapped until onImageAvailable returns (after this call).
    let source = unsafe { std::slice::from_raw_parts(address, length) };
    if let Some(picture) = copy_rgba(
        source,
        width.max(0) as usize,
        height.max(0) as usize,
        row.max(0) as usize,
    ) {
        shared.lock().unwrap_or_else(|p| p.into_inner()).picture = Some(picture);
        wake();
    }
}

/// Tightly packed opaque RGBA from rows `row` bytes apart.
fn copy_rgba(
    source: &[u8],
    width: usize,
    height: usize,
    row: usize,
) -> Option<(u32, u32, Vec<u8>)> {
    let line = width * 4;
    if width == 0 || height == 0 || row < line || source.len() < row * (height - 1) + line {
        return None;
    }
    let mut out = Vec::with_capacity(line * height);
    for y in 0..height {
        out.extend_from_slice(&source[y * row..y * row + line]);
    }
    for pixel in out.chunks_exact_mut(4) {
        pixel[3] = 255;
    }
    Some((width as u32, height as u32, out))
}

/// One YUV 4:2:0 picture as an ImageReader hands it over.
struct Yuv<'a> {
    width: usize,
    height: usize,
    y: &'a [u8],
    u: &'a [u8],
    v: &'a [u8],
    y_row: usize,
    uv_row: usize,
    uv_pixel: usize,
}

impl Yuv<'_> {
    /// RGBA (BT.601, limited range), every `step`th pixel so neither side passes MAX_SIDE.
    fn to_rgba(&self) -> Option<(u32, u32, Vec<u8>)> {
        if self.width == 0 || self.height == 0 {
            return None;
        }
        let step = self.width.max(self.height).div_ceil(MAX_SIDE).max(1);
        let (out_w, out_h) = (self.width.div_ceil(step), self.height.div_ceil(step));
        let mut out = vec![255_u8; out_w * out_h * 4];
        for row in 0..out_h {
            let sy = row * step;
            for column in 0..out_w {
                let sx = column * step;
                let luma = i32::from(*self.y.get(sy * self.y_row + sx)?) - 16;
                let chroma = (sy / 2) * self.uv_row + (sx / 2) * self.uv_pixel;
                let cb = i32::from(*self.u.get(chroma)?) - 128;
                let cr = i32::from(*self.v.get(chroma)?) - 128;
                let c = 298 * luma;
                let at = (row * out_w + column) * 4;
                out[at] = ((c + 409 * cr + 128) >> 8).clamp(0, 255) as u8;
                out[at + 1] = ((c - 100 * cb - 208 * cr + 128) >> 8).clamp(0, 255) as u8;
                out[at + 2] = ((c + 516 * cb + 128) >> 8).clamp(0, 255) as u8;
            }
        }
        Some((out_w as u32, out_h as u32, out))
    }
}

fn video_class<'local>(
    env: &mut JNIEnv<'local>,
    activity: &JObject,
) -> jni::errors::Result<JClass<'local>> {
    let loader = env
        .call_method(activity, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])?
        .l()?;
    let name = env.new_string(CLASS)?;
    let class = env
        .call_method(
            &loader,
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[JValue::Object(&name)],
        )?
        .l()?;
    let class = JClass::from(class);
    static REGISTERED: OnceLock<()> = OnceLock::new();
    if REGISTERED.get().is_none() {
        env.register_native_methods(
            &class,
            &[
                jni::NativeMethod {
                    name: "nativeEvent".into(),
                    sig: "(JLjava/lang/String;D)V".into(),
                    fn_ptr: native_event as *mut std::ffi::c_void,
                },
                jni::NativeMethod {
                    name: "nativeFrame".into(),
                    sig: "(JIILjava/nio/ByteBuffer;Ljava/nio/ByteBuffer;Ljava/nio/ByteBuffer;III)V"
                        .into(),
                    fn_ptr: native_frame as *mut std::ffi::c_void,
                },
                jni::NativeMethod {
                    name: "nativeFrameRgba".into(),
                    sig: "(JIILjava/nio/ByteBuffer;I)V".into(),
                    fn_ptr: native_frame_rgba as *mut std::ffi::c_void,
                },
            ],
        )?;
        let _ = REGISTERED.set(());
    }
    Ok(class)
}

struct Player {
    handle: i64,
    object: GlobalRef,
    shared: Arc<Mutex<Shared>>,
    src: String,
    playing: bool,
    ended: bool,
    metadata: bool,
    duration: Option<f64>,
    size: (u32, u32),
    looped: bool,
    muted: bool,
    volume: f32,
    generation: u64,
    next_update: Option<Instant>,
}

impl Player {
    fn new(load: &VideoLoad<'_>) -> Result<Self, String> {
        let handle = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
        let shared = Arc::new(Mutex::new(Shared::default()));
        PLAYERS
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get_or_insert_with(HashMap::new)
            .insert(handle, shared.clone());
        let object = crate::android::with_env(|env, activity| {
            let class = video_class(env, activity)?;
            let src = env.new_string(load.src)?;
            let object = env.new_object(
                class,
                "(Landroid/content/Context;JLjava/lang/String;ZZF)V",
                &[
                    JValue::Object(activity),
                    JValue::Long(handle),
                    JValue::Object(&src),
                    JValue::Bool(u8::from(load.looped)),
                    JValue::Bool(u8::from(load.muted)),
                    JValue::Float(load.volume),
                ],
            )?;
            env.new_global_ref(object)
        });
        let object = match object {
            Ok(object) => object,
            Err(message) => {
                forget(handle);
                return Err(message);
            }
        };
        Ok(Self {
            handle,
            object,
            shared,
            src: load.src.to_string(),
            playing: false,
            ended: false,
            metadata: false,
            duration: None,
            size: (0, 0),
            looped: load.looped,
            muted: load.muted,
            volume: load.volume,
            generation: 0,
            next_update: None,
        })
    }

    fn call(
        &self,
        name: &str,
        sig: &str,
        args: &[JValue],
    ) -> Option<jni::objects::JValueOwned<'static>> {
        crate::android::with_env(|env, _| {
            let value = env.call_method(self.object.as_obj(), name, sig, args)?;
            // Primitive results only: nothing borrows the local frame.
            Ok(match value {
                jni::objects::JValueOwned::Double(d) => jni::objects::JValueOwned::Double(d),
                jni::objects::JValueOwned::Int(i) => jni::objects::JValueOwned::Int(i),
                _ => jni::objects::JValueOwned::Void,
            })
        })
        .ok()
    }

    fn time(&self) -> f64 {
        self.call("position", "()D", &[])
            .and_then(|v| v.d().ok())
            .unwrap_or(0.0)
    }

    fn play(&mut self) -> bool {
        if self.playing {
            return false;
        }
        if self.ended {
            self.seek(0.0);
            self.ended = false;
        }
        self.playing = true;
        self.next_update = Some(Instant::now() + TIME_UPDATE);
        self.call("play", "()V", &[]);
        true
    }

    fn pause(&mut self) -> bool {
        if !self.playing {
            return false;
        }
        self.playing = false;
        self.next_update = None;
        self.call("pause", "()V", &[]);
        true
    }

    fn seek(&mut self, time: f64) {
        self.call("seek", "(D)V", &[JValue::Double(time.max(0.0))]);
    }

    fn set(&mut self, looped: Option<bool>, muted: Option<bool>, volume: Option<f64>) {
        self.looped = looped.unwrap_or(self.looped);
        self.muted = muted.unwrap_or(self.muted);
        self.volume = volume.map_or(self.volume, |v| v.clamp(0.0, 1.0) as f32);
        self.call(
            "set",
            "(ZZF)V",
            &[
                JValue::Bool(u8::from(self.looped)),
                JValue::Bool(u8::from(self.muted)),
                JValue::Float(self.volume),
            ],
        );
    }

    fn event(&self, id: &str, name: &str) -> Value {
        json!({
            "type": "media",
            "id": id,
            "event": name,
            "time": self.time(),
            "duration": self.duration,
            "paused": !self.playing,
            "videoWidth": self.size.0,
            "videoHeight": self.size.1,
        })
    }
}

fn forget(handle: i64) {
    if let Some(players) = PLAYERS.lock().unwrap_or_else(|p| p.into_inner()).as_mut() {
        players.remove(&handle);
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        forget(self.handle);
        self.call("release", "()V", &[]);
    }
}

pub(crate) struct Videos {
    players: HashMap<String, Player>,
    changed: Vec<(String, Option<VideoFrame>)>,
}

impl Videos {
    pub(crate) fn new(wake: impl Fn() + Send + Sync + 'static) -> Self {
        let _ = WAKE.set(Arc::new(wake));
        Self {
            players: HashMap::new(),
            changed: Vec::new(),
        }
    }

    pub(crate) fn handles(&self, id: &str) -> bool {
        self.players.contains_key(id)
    }

    /// MediaPlayer plays the sound itself (its clock keeps it in sync): no mixer.
    pub(crate) fn load<Mixer>(
        &mut self,
        id: &str,
        load: VideoLoad<'_>,
        _mixer: Option<Mixer>,
    ) -> Vec<Value> {
        if self.players.remove(id).is_some() {
            self.changed.push((id.to_string(), None));
        }
        match Player::new(&load) {
            Ok(player) => {
                self.players.insert(id.to_string(), player);
                Vec::new()
            }
            Err(message) => vec![media_error(id, failure(load.src, message))],
        }
    }

    pub(crate) fn command(
        &mut self,
        id: &str,
        action: &str,
        time: Option<f64>,
        volume: Option<f64>,
        muted: Option<bool>,
        looped: Option<bool>,
    ) -> Vec<Value> {
        if action == "unload" {
            if self.players.remove(id).is_some() {
                self.changed.push((id.to_string(), None));
            }
            return Vec::new();
        }
        let Some(player) = self.players.get_mut(id) else {
            return vec![media_error(id, "media not loaded")];
        };
        let event = match action {
            "play" => player.play().then_some("play"),
            "pause" => player.pause().then_some("pause"),
            "seek" => {
                player.seek(time.unwrap_or(0.0));
                None
            }
            "set" => {
                player.set(looped, muted, volume);
                None
            }
            _ => None,
        };
        event
            .map(|name| vec![player.event(id, name)])
            .unwrap_or_default()
    }

    pub(crate) fn tick(&mut self, now: Instant) -> Vec<Value> {
        let mut out = Vec::new();
        let mut failed = Vec::new();
        for (id, player) in &mut self.players {
            let (picture, events) = {
                let mut shared = player.shared.lock().unwrap_or_else(|p| p.into_inner());
                (shared.picture.take(), std::mem::take(&mut shared.events))
            };
            for (event, value) in events {
                match event.as_str() {
                    "loadedmetadata" => {
                        player.metadata = true;
                        player.duration = (value > 0.0).then_some(value);
                        let width = player
                            .call("width", "()I", &[])
                            .and_then(|v| v.i().ok())
                            .unwrap_or(0);
                        let height = player
                            .call("height", "()I", &[])
                            .and_then(|v| v.i().ok())
                            .unwrap_or(0);
                        player.size = (width.max(0) as u32, height.max(0) as u32);
                        out.push(player.event(id, "loadedmetadata"));
                    }
                    "seeked" => out.push(player.event(id, "seeked")),
                    "ended" => {
                        player.playing = false;
                        player.ended = true;
                        player.next_update = None;
                        out.push(player.event(id, "pause"));
                        out.push(player.event(id, "ended"));
                    }
                    "error" => failed.push((
                        id.clone(),
                        failure(
                            &player.src,
                            format!("the video could not be played (MediaPlayer error {value})"),
                        ),
                    )),
                    _ => {}
                }
            }
            if let Some((width, height, pixels)) = picture {
                player.generation += 1;
                let (shown_w, shown_h) = if player.size.0 > 0 {
                    player.size
                } else {
                    (width, height)
                };
                self.changed.push((
                    id.clone(),
                    Some(VideoFrame {
                        width: shown_w,
                        height: shown_h,
                        generation: player.generation,
                        pixels: Some(ImageData {
                            width,
                            height,
                            format: ImageFormat::Rgba8,
                            alpha_type: ImageAlphaType::Alpha,
                            data: Blob::new(Arc::new(pixels)),
                        }),
                    }),
                ));
            }
            if player.playing && player.next_update.is_some_and(|at| at <= now) {
                player.next_update = Some(now + TIME_UPDATE);
                out.push(player.event(id, "timeupdate"));
            }
        }
        for (id, message) in failed {
            self.players.remove(&id);
            self.changed.push((id.clone(), None));
            out.push(media_error(&id, message));
        }
        out
    }

    pub(crate) fn take_frames(&mut self) -> Vec<(String, Option<VideoFrame>)> {
        std::mem::take(&mut self.changed)
    }

    /// Pictures arrive at the video's own size (at most MAX_SIDE); the renderer scales them.
    pub(crate) fn set_display_sizes(&mut self, _sizes: impl Fn(&str) -> Option<(u32, u32)>) {}

    pub(crate) fn take_repaint(&mut self) -> Vec<String> {
        Vec::new()
    }

    pub(crate) fn set_visible(&mut self, _visible: impl Fn(&str) -> bool) {}

    /// Only `timeupdate` needs a timer; pictures and player events wake the loop.
    pub(crate) fn deadline(&self) -> Option<Instant> {
        self.players
            .values()
            .filter_map(|player| player.next_update)
            .min()
    }
}

#[cfg(test)]
mod tests {
    use super::Yuv;

    #[test]
    fn yuv_converts_to_rgba_and_subsamples_large_pictures() {
        let (y, u, v) = (vec![235_u8; 4], vec![128_u8; 1], vec![128_u8; 1]);
        let picture = Yuv {
            width: 2,
            height: 2,
            y: &y,
            u: &u,
            v: &v,
            y_row: 2,
            uv_row: 1,
            uv_pixel: 1,
        }
        .to_rgba()
        .unwrap();
        assert_eq!((picture.0, picture.1), (2, 2));
        assert_eq!(&picture.2[..4], &[255, 255, 255, 255]);
        let big = vec![16_u8; 2560 * 2];
        let chroma = vec![128_u8; 1280];
        let small = Yuv {
            width: 2560,
            height: 2,
            y: &big,
            u: &chroma,
            v: &chroma,
            y_row: 2560,
            uv_row: 1280,
            uv_pixel: 1,
        }
        .to_rgba()
        .unwrap();
        assert_eq!((small.0, small.1), (1280, 1));
        assert_eq!(&small.2[..4], &[0, 0, 0, 255]);
    }
}
