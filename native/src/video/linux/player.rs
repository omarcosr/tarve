use super::*;

impl Player {
    pub(super) fn new(
        gst: &'static Gst,
        load: &VideoLoad<'_>,
        wake: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<Self, String> {
        let uri = if load.src.contains("://") {
            load.src.to_string()
        } else {
            let path = std::path::absolute(load.src).unwrap_or_else(|_| load.src.into());
            let mut error = std::ptr::null_mut();
            let uri = unsafe {
                (gst.gst_filename_to_uri)(c(&path.to_string_lossy()).as_ptr(), &mut error)
            };
            if uri.is_null() {
                return Err(take_error(gst, error, "invalid video path"));
            }
            let text = unsafe { CStr::from_ptr(uri) }
                .to_string_lossy()
                .into_owned();
            unsafe { (gst.g_free)(uri.cast()) };
            text
        };
        let make = |factory: &str| {
            let element =
                unsafe { (gst.gst_element_factory_make)(c(factory).as_ptr(), std::ptr::null()) };
            if element.is_null() {
                Err(format!(
                    "the GStreamer element {factory} is missing (install gstreamer1.0-plugins-base)"
                ))
            } else {
                Ok(element)
            }
        };
        let pipeline = make("playbin")?;
        unsafe { (gst.gst_object_ref_sink)(pipeline) };
        let mut player = Self {
            gst,
            pipeline,
            sink: std::ptr::null_mut(),
            bus: std::ptr::null_mut(),
            signal: Box::new(Signal {
                picture: AtomicBool::new(false),
                preroll: AtomicBool::new(false),
                message: AtomicBool::new(false),
                wake,
            }),
            src: load.src.to_string(),
            size: (0, 0),
            generation: 0,
            looped: load.looped,
            playing: false,
            ended: false,
            metadata: false,
            seeking: false,
            rate: 1.0,
            next_update: None,
            buffering: false,
            audio_track: None,
            text_track: None,
        };
        let sink = make("appsink")?;
        player.sink = sink;
        let caps = unsafe {
            (gst.gst_caps_from_string)(c"video/x-raw,format=RGBA,pixel-aspect-ratio=1/1".as_ptr())
        };
        unsafe {
            (gst.g_object_set)(sink, c"caps".as_ptr(), caps, std::ptr::null::<c_char>());
            (gst.gst_mini_object_unref)(caps);
            // Only the newest picture matters: a late one is dropped, never queued.
            (gst.g_object_set)(
                sink,
                c"max-buffers".as_ptr(),
                1 as c_uint,
                std::ptr::null::<c_char>(),
            );
            (gst.g_object_set)(
                sink,
                c"drop".as_ptr(),
                1 as c_int,
                std::ptr::null::<c_char>(),
            );
            let callbacks = AppSinkCallbacks {
                eos: None,
                new_preroll: Some(on_preroll),
                new_sample: Some(on_sample),
                rest: [std::ptr::null_mut(); 8],
            };
            let data = &*player.signal as *const Signal as Ptr;
            (gst.gst_app_sink_set_callbacks)(sink, &callbacks, data, None);
            (gst.g_object_set)(
                pipeline,
                c"video-sink".as_ptr(),
                sink,
                std::ptr::null::<c_char>(),
            );
            (gst.g_object_set)(
                pipeline,
                c"uri".as_ptr(),
                c(&uri).as_ptr(),
                std::ptr::null::<c_char>(),
            );
            if std::env::var_os("TARVE_AUDIO").is_some_and(|value| value == "silent") {
                let quiet = make("fakesink")?;
                (gst.g_object_set)(
                    quiet,
                    c"sync".as_ptr(),
                    1 as c_int,
                    std::ptr::null::<c_char>(),
                );
                (gst.g_object_set)(
                    pipeline,
                    c"audio-sink".as_ptr(),
                    quiet,
                    std::ptr::null::<c_char>(),
                );
            }
            player.bus = (gst.gst_element_get_bus)(pipeline);
            (gst.gst_bus_set_sync_handler)(player.bus, Some(on_message), data, None);
        }
        if player.remote() {
            // A network stream goes to a file on disk as it downloads: its buffering
            // range answers `buffered` (a plain stream answers nothing).
            let mut flags: c_int = 0;
            unsafe {
                (gst.g_object_get)(
                    pipeline,
                    c"flags".as_ptr(),
                    &mut flags as *mut c_int,
                    std::ptr::null::<c_char>(),
                );
                (gst.g_object_set)(
                    pipeline,
                    c"flags".as_ptr(),
                    flags | PLAY_FLAG_DOWNLOAD,
                    c"ring-buffer-max-size".as_ptr(),
                    DOWNLOAD_BYTES,
                    std::ptr::null::<c_char>(),
                );
            }
        }
        player.set(None, Some(load.muted), Some(f64::from(load.volume)));
        // The text flag stays on while it prerolls (playbin builds the subtitle overlay
        // then); no subtitles show until one is chosen (`textTracks`), as in a browser.
        // Paused: the first picture and the metadata arrive without playing.
        unsafe { (gst.gst_element_set_state)(pipeline, STATE_PAUSED) };
        Ok(player)
    }

    pub(super) fn set(&mut self, looped: Option<bool>, muted: Option<bool>, volume: Option<f64>) {
        if let Some(looped) = looped {
            self.looped = looped;
        }
        unsafe {
            if let Some(muted) = muted {
                (self.gst.g_object_set)(
                    self.pipeline,
                    c"mute".as_ptr(),
                    c_int::from(muted),
                    std::ptr::null::<c_char>(),
                );
            }
            if let Some(volume) = volume {
                (self.gst.g_object_set)(
                    self.pipeline,
                    c"volume".as_ptr(),
                    volume.clamp(0.0, 1.0),
                    std::ptr::null::<c_char>(),
                );
            }
        }
    }

    pub(super) fn query(&self, duration: bool) -> Option<f64> {
        let mut value = 0_i64;
        let found = unsafe {
            if duration {
                (self.gst.gst_element_query_duration)(self.pipeline, FORMAT_TIME, &mut value)
            } else {
                (self.gst.gst_element_query_position)(self.pipeline, FORMAT_TIME, &mut value)
            }
        };
        (found != 0 && value >= 0).then(|| value as f64 / 1e9)
    }

    pub(super) fn seek(&mut self, time: f64) {
        let nanos = (time.max(0.0) * 1e9) as i64;
        if self.seek_at(nanos) {
            self.seeking = true;
            self.ended = false;
        }
    }

    /// A flushing seek to `nanos` at the player's rate.
    pub(super) fn seek_at(&self, nanos: i64) -> bool {
        unsafe {
            if (self.rate - 1.0).abs() < 1e-9 {
                (self.gst.gst_element_seek_simple)(
                    self.pipeline,
                    FORMAT_TIME,
                    SEEK_FLUSH | SEEK_ACCURATE,
                    nanos,
                ) != 0
            } else {
                (self.gst.gst_element_seek)(
                    self.pipeline,
                    self.rate,
                    FORMAT_TIME,
                    SEEK_FLUSH | SEEK_ACCURATE,
                    SEEK_TYPE_SET,
                    nanos,
                    SEEK_TYPE_NONE,
                    -1,
                ) != 0
            }
        }
    }

    /// `playbackRate`: a seek to where it is, at the new rate.
    pub(super) fn set_rate(&mut self, rate: f64) {
        self.rate = rate.clamp(0.0625, 16.0);
        let at = self.query(false).unwrap_or(0.0);
        self.seek_at((at * 1e9) as i64);
    }

    pub(super) fn play(&mut self) -> bool {
        if self.playing {
            return false;
        }
        if self.ended {
            // Like a browser: play() after the end starts over.
            self.seek(0.0);
        }
        self.playing = true;
        self.next_update = Some(Instant::now() + TIME_UPDATE);
        // Still refilling: it starts once the buffering message says 100 %.
        if !self.buffering {
            unsafe { (self.gst.gst_element_set_state)(self.pipeline, STATE_PLAYING) };
        }
        true
    }

    pub(super) fn pause(&mut self) -> bool {
        if !self.playing {
            return false;
        }
        self.playing = false;
        self.next_update = None;
        unsafe { (self.gst.gst_element_set_state)(self.pipeline, STATE_PAUSED) };
        true
    }

    pub(super) fn event(&self, id: &str, name: &str) -> Value {
        let duration = self.query(true);
        let mut event = json!({
            "type": "media",
            "id": id,
            "event": name,
            "time": self.query(false).unwrap_or(0.0),
            "duration": duration,
            "paused": !self.playing,
            "videoWidth": self.size.0,
            "videoHeight": self.size.1,
        });
        if let Some(buffered) = duration.and_then(|duration| self.buffered(duration)) {
            event["buffered"] = json!(buffered);
        }
        if name == "loadedmetadata" {
            event["filename"] = json!(self.filename());
        }
        event
    }

    /// playbin's audio streams (`n-audio`), the playing one (`current-audio`) enabled.
    pub(super) fn audio_tracks(&self) -> Value {
        let (mut count, mut current): (c_int, c_int) = (0, -1);
        unsafe {
            (self.gst.g_object_get)(
                self.pipeline,
                c"n-audio".as_ptr(),
                &mut count as *mut c_int,
                c"current-audio".as_ptr(),
                &mut current as *mut c_int,
                std::ptr::null::<c_char>(),
            );
        }
        let current = self
            .audio_track
            .filter(|index| *index < count)
            .unwrap_or(current);
        Value::Array(
            (0..count.max(0))
                .map(|index| {
                    let (title, language) = self.stream_tags(c"get-audio-tags", index);
                    let label = if title.is_empty() { format!("Audio {}", index + 1) } else { title };
                    json!({"id": index, "label": label, "language": language, "enabled": index == current.max(0)})
                })
                .collect(),
        )
    }

    /// The title and language code playbin read from stream `index` (`get-audio-tags`,
    /// `get-text-tags`).
    pub(super) fn stream_tags(&self, signal: &std::ffi::CStr, index: c_int) -> (String, String) {
        let mut tags: Ptr = std::ptr::null_mut();
        unsafe {
            (self.gst.g_signal_emit_by_name)(
                self.pipeline,
                signal.as_ptr(),
                index,
                &mut tags as *mut Ptr,
            );
        }
        if tags.is_null() {
            return (String::new(), String::new());
        }
        let read = |tag: &std::ffi::CStr| -> String {
            let mut value: *mut c_char = std::ptr::null_mut();
            unsafe {
                if (self.gst.gst_tag_list_get_string)(tags, tag.as_ptr(), &mut value) == 0
                    || value.is_null()
                {
                    return String::new();
                }
                let text = CStr::from_ptr(value).to_string_lossy().into_owned();
                (self.gst.g_free)(value.cast());
                text
            }
        };
        let tags_read = (read(c"title"), read(c"language-code"));
        unsafe { (self.gst.gst_mini_object_unref)(tags) };
        tags_read
    }

    /// playbin's text streams (`n-text`), the one shown enabled while the text flag is on.
    pub(super) fn text_tracks(&self) -> Value {
        let (mut count, mut current, mut flags): (c_int, c_int, c_int) = (0, -1, 0);
        unsafe {
            (self.gst.g_object_get)(
                self.pipeline,
                c"n-text".as_ptr(),
                &mut count as *mut c_int,
                c"current-text".as_ptr(),
                &mut current as *mut c_int,
                c"flags".as_ptr(),
                &mut flags as *mut c_int,
                std::ptr::null::<c_char>(),
            );
        }
        let showing = flags & PLAY_FLAG_TEXT != 0;
        Value::Array(
            (0..count.max(0))
                .map(|index| {
                    let (title, language) = self.stream_tags(c"get-text-tags", index);
                    let label = if title.is_empty() { format!("Subtitles {}", index + 1) } else { title };
                    json!({"id": index, "label": label, "language": language, "enabled": showing && index == current})
                })
                .collect(),
        )
    }

    /// Shows text stream `index` (playbin draws it over the picture) or none.
    pub(super) fn select_text(&mut self, index: Option<u32>) {
        self.text_track = index;
        if !self.metadata {
            return;
        }
        let mut flags: c_int = 0;
        unsafe {
            (self.gst.g_object_get)(
                self.pipeline,
                c"flags".as_ptr(),
                &mut flags as *mut c_int,
                std::ptr::null::<c_char>(),
            );
            let flags = match index {
                Some(_) => flags | PLAY_FLAG_TEXT,
                None => flags & !PLAY_FLAG_TEXT,
            };
            match index {
                Some(index) => (self.gst.g_object_set)(
                    self.pipeline,
                    c"current-text".as_ptr(),
                    index as c_int,
                    c"flags".as_ptr(),
                    flags,
                    std::ptr::null::<c_char>(),
                ),
                None => (self.gst.g_object_set)(
                    self.pipeline,
                    c"flags".as_ptr(),
                    flags,
                    std::ptr::null::<c_char>(),
                ),
            }
        }
    }

    /// `audioTracks[index].enabled = true`: playbin's `current-audio`.
    pub(super) fn select_audio(&mut self, index: u32) {
        self.audio_track = Some(index as c_int);
        unsafe {
            (self.gst.g_object_set)(
                self.pipeline,
                c"current-audio".as_ptr(),
                index as c_int,
                std::ptr::null::<c_char>(),
            );
        }
    }

    /// End of the buffered range (a network stream's download; a local file is whole).
    pub(super) fn buffered(&self, duration: f64) -> Option<f64> {
        if !self.remote() {
            return Some(duration);
        }
        unsafe {
            let query = (self.gst.gst_query_new_buffering)(FORMAT_PERCENT);
            if query.is_null() {
                return None;
            }
            let answered = (self.gst.gst_element_query)(self.pipeline, query) != 0;
            let (mut format, mut start, mut stop, mut total) = (0, 0_i64, 0_i64, 0_i64);
            if answered {
                (self.gst.gst_query_parse_buffering_range)(
                    query,
                    &mut format,
                    &mut start,
                    &mut stop,
                    &mut total,
                );
            }
            (self.gst.gst_mini_object_unref)(query);
            (answered && stop > 0).then(|| duration * (stop as f64 / PERCENT_MAX).min(1.0))
        }
    }

    /// Bus messages since the last call, as media events.
    pub(super) fn messages(&mut self, id: &str, out: &mut Vec<Value>) -> Result<(), String> {
        if !self.signal.message.swap(false, Ordering::AcqRel) {
            return Ok(());
        }
        loop {
            let message = unsafe { (self.gst.gst_bus_pop)(self.bus) };
            if message.is_null() {
                return Ok(());
            }
            let kind = unsafe {
                *(message
                    .cast::<u8>()
                    .add(MESSAGE_TYPE_OFFSET)
                    .cast::<c_uint>())
            };
            let mut failed = None;
            match kind {
                MESSAGE_ERROR => {
                    let mut error = std::ptr::null_mut();
                    let mut debug = std::ptr::null_mut();
                    unsafe { (self.gst.gst_message_parse_error)(message, &mut error, &mut debug) };
                    if !debug.is_null() {
                        unsafe { (self.gst.g_free)(debug.cast()) };
                    }
                    failed = Some(take_error(self.gst, error, "the video could not be played"));
                }
                MESSAGE_EOS if self.looped => self.seek(0.0),
                MESSAGE_EOS => {
                    self.playing = false;
                    self.ended = true;
                    self.next_update = None;
                    unsafe { (self.gst.gst_element_set_state)(self.pipeline, STATE_PAUSED) };
                    out.push(self.event(id, "pause"));
                    out.push(self.event(id, "ended"));
                }
                // A network stream ran short: hold the pipeline until it refills (as
                // playbin's applications do), `waiting` (while it plays) then `canplay`.
                MESSAGE_BUFFERING => {
                    let mut percent = 100;
                    unsafe { (self.gst.gst_message_parse_buffering)(message, &mut percent) };
                    if percent < 100 && !self.buffering && self.metadata {
                        self.buffering = true;
                        if self.playing {
                            unsafe {
                                (self.gst.gst_element_set_state)(self.pipeline, STATE_PAUSED)
                            };
                            out.push(self.event(id, "waiting"));
                        }
                    } else if percent >= 100 && self.buffering {
                        self.buffering = false;
                        if self.playing {
                            unsafe {
                                (self.gst.gst_element_set_state)(self.pipeline, STATE_PLAYING)
                            };
                        }
                        out.push(self.event(id, "canplay"));
                    }
                }
                MESSAGE_ASYNC_DONE if self.seeking => {
                    self.seeking = false;
                    out.push(self.event(id, "seeked"));
                }
                MESSAGE_DURATION_CHANGED if self.metadata => {
                    out.push(self.event(id, "durationchange"))
                }
                _ => {}
            }
            unsafe { (self.gst.gst_mini_object_unref)(message) };
            if let Some(message) = failed {
                return Err(message);
            }
        }
    }

    /// The newest picture, if one arrived since the last call.
    pub(super) fn picture(&mut self) -> Option<VideoFrame> {
        let sample = if self.signal.picture.swap(false, Ordering::AcqRel) {
            unsafe { (self.gst.gst_app_sink_try_pull_sample)(self.sink, 0) }
        } else {
            std::ptr::null_mut()
        };
        let sample = if sample.is_null() && self.signal.preroll.swap(false, Ordering::AcqRel) {
            unsafe { (self.gst.gst_app_sink_try_pull_preroll)(self.sink, 0) }
        } else {
            sample
        };
        if sample.is_null() {
            return None;
        }
        let frame = self.copy(sample);
        unsafe { (self.gst.gst_mini_object_unref)(sample) };
        frame
    }

    pub(super) fn copy(&mut self, sample: Ptr) -> Option<VideoFrame> {
        let gst = self.gst;
        let caps = unsafe { (gst.gst_sample_get_caps)(sample) };
        let buffer = unsafe { (gst.gst_sample_get_buffer)(sample) };
        if caps.is_null() || buffer.is_null() {
            return None;
        }
        let structure = unsafe { (gst.gst_caps_get_structure)(caps, 0) };
        let (mut width, mut height) = (0, 0);
        unsafe {
            (gst.gst_structure_get_int)(structure, c"width".as_ptr(), &mut width);
            (gst.gst_structure_get_int)(structure, c"height".as_ptr(), &mut height);
        }
        if width <= 0 || height <= 0 {
            return None;
        }
        let (width, height) = (width as usize, height as usize);
        let mut map = MapInfo {
            memory: std::ptr::null_mut(),
            flags: 0,
            data: std::ptr::null_mut(),
            size: 0,
            maxsize: 0,
            user_data: [std::ptr::null_mut(); 4],
            reserved: [std::ptr::null_mut(); 4],
        };
        if unsafe { (gst.gst_buffer_map)(buffer, &mut map, MAP_READ) } == 0 {
            return None;
        }
        // RGBA rows are 4-byte aligned already: the stride is width × 4.
        let bytes = width * height * 4;
        let pixels = (map.size >= bytes)
            .then(|| unsafe { std::slice::from_raw_parts(map.data, bytes) }.to_vec());
        unsafe { (gst.gst_buffer_unmap)(buffer, &mut map) };
        let pixels = pixels?;
        self.size = (width as u32, height as u32);
        self.generation += 1;
        Some(VideoFrame {
            width: self.size.0,
            height: self.size.1,
            generation: self.generation,
            pixels: Some(ImageData {
                width: self.size.0,
                height: self.size.1,
                format: ImageFormat::Rgba8,
                alpha_type: ImageAlphaType::Alpha,
                data: Blob::new(Arc::new(pixels)),
            }),
        })
    }
}
