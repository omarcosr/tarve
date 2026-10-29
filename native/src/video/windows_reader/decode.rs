use super::*;

/// Reads ahead of the clock: decoded pictures into the queue, sound into the feed.
pub(super) fn reader_thread(
    shared: Arc<Shared>,
    url: String,
    manager: SendCom<IMFDXGIDeviceManager>,
) {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let _ = MFStartup(MF_VERSION, MFSTARTUP_FULL);
    }
    let fail = |message: String| {
        shared.lock().error = Some(message);
        (shared.wake)();
    };
    // A decoder without NV12 textures: the Media Engine plays it instead.
    let unsupported = |message: String| {
        shared.lock().unsupported = true;
        fail(message)
    };
    let (reader, remote) = match open(&url, &manager.0) {
        Ok(opened) => opened,
        Err(Fallback::Format(message)) => return unsupported(message),
        Err(Fallback::Other(message)) => return fail(message),
    };
    // A failed download is the cause of a failed read; Media Foundation only saw the read fail.
    let reason = |error: windows::core::Error| {
        remote
            .as_ref()
            .and_then(|stream| stream.error())
            .unwrap_or_else(|| win(error))
    };
    let mut info = match describe(&reader) {
        Ok(info) => info,
        Err(message) => return fail(message),
    };
    let tracks = audio_tracks(&reader, None);
    // The audio decoded: the first until another track is chosen. A first track this
    // machine cannot decode (AC-3 without a Dolby decoder) gives way to one it can, as a
    // browser skips the tracks it cannot play.
    let mut audio_stream = AUDIO_STREAM;
    if let (Some(first), Some(chosen)) = (tracks.first(), tracks.iter().find(|track| track.enabled))
        && first.index != chosen.index
        && let Ok(format) = select_audio_stream(&reader, AUDIO_STREAM, chosen.index, false)
    {
        audio_stream = chosen.index;
        info.audio = format;
    }
    {
        let mut state = shared.lock();
        state.info = Some(info);
        state.remote = remote.clone();
        state.tracks = tracks;
    }
    (shared.wake)();
    let audio_ahead = info.audio.map_or(0, |(channels, rate)| {
        (AUDIO_AHEAD * f64::from(rate) * f64::from(channels)) as usize
    });
    let mut video_off = false;
    let mut audio_off = false;
    // After a seek the source starts at the key frame before the target: the
    // pictures and sound before it are decoded but dropped here, so the queue
    // and the clock start at the target (the last picture at or before it is held).
    let mut skip_before: Option<f64> = None;
    let mut held: Option<(f64, SendCom<IMFSample>)> = None;
    let mut audio_skip_before: Option<f64> = None;
    // Whether a picture came yet.
    let mut pictured = false;
    // A seek made while no stream was selected.
    let mut deferred_seek: Option<f64> = None;
    loop {
        let stream = {
            let mut state = shared.lock();
            loop {
                if state.stop {
                    return;
                }
                // Track switches in order, then only the last seek.
                let mut seek = None;
                for request in std::mem::take(&mut state.requests) {
                    match request {
                        Request::Seek(time) => seek = Some(time),
                        Request::Video(on) if on == video_off => {
                            video_off = !on;
                            let _ = unsafe { reader.SetStreamSelection(VIDEO_STREAM, on) };
                            state.video.clear();
                            if on && let Some(time) = deferred_seek.take() {
                                seek = seek.or(Some(time));
                            }
                        }
                        Request::Video(_) => {}
                        Request::Audio(on) if on == audio_off && info.audio.is_some() => {
                            audio_off = !on;
                            let _ = unsafe { reader.SetStreamSelection(audio_stream, on) };
                            shared
                                .sound
                                .samples
                                .lock()
                                .unwrap_or_else(|p| p.into_inner())
                                .clear();
                            shared.sound.epoch.fetch_add(1, Ordering::Release);
                            state.audio_done = audio_off;
                        }
                        Request::Audio(_) => {}
                        Request::AudioTrack(index) => {
                            match select_audio_stream(&reader, audio_stream, index, audio_off) {
                                Ok(format) => {
                                    audio_stream = index;
                                    info.audio = format.or(info.audio);
                                    if let Some(known) = state.info.as_mut() {
                                        known.audio = info.audio;
                                    }
                                    for track in &mut state.tracks {
                                        track.enabled = track.index == index;
                                    }
                                    shared
                                        .sound
                                        .samples
                                        .lock()
                                        .unwrap_or_else(|p| p.into_inner())
                                        .clear();
                                    shared.sound.epoch.fetch_add(1, Ordering::Release);
                                }
                                Err(message) => state.error = Some(message),
                            }
                        }
                    }
                }
                if let Some(time) = seek {
                    let mut position = PROPVARIANT::default();
                    unsafe {
                        let value = &mut *position.Anonymous.Anonymous;
                        value.vt = VT_I8;
                        value.Anonymous.hVal = (time.max(0.0) * 10_000_000.0) as i64;
                        // With no stream selected (a silent video off screen) the reader
                        // refuses to seek (E_INVALIDARG): it seeks when the picture is back.
                        if video_off && (audio_off || info.audio.is_none()) {
                            deferred_seek = Some(time);
                        } else if let Err(error) =
                            reader.SetCurrentPosition(&GUID::zeroed(), &position)
                        {
                            state.error = Some(win(error));
                        }
                    }
                    state.video.clear();
                    shared
                        .sound
                        .samples
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .clear();
                    shared.sound.epoch.fetch_add(1, Ordering::Release);
                    state.video_done = false;
                    state.audio_done = info.audio.is_none() || audio_off;
                    skip_before = Some(time);
                    audio_skip_before = Some(time);
                    held = None;
                    (shared.wake)();
                }
                let video_full = video_off || state.video_done || state.video.len() >= VIDEO_AHEAD;
                let audio_full = audio_off
                    || state.audio_done
                    || shared
                        .sound
                        .samples
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .len()
                        >= audio_ahead;
                if !video_full && !audio_full {
                    break ANY_STREAM;
                }
                if !video_full {
                    break VIDEO_STREAM;
                }
                if !audio_full {
                    break audio_stream;
                }
                state = shared
                    .changed
                    .wait_timeout(state, REFILL_WAIT)
                    .map(|(state, _)| state)
                    .unwrap_or_else(|p| p.into_inner().0);
            }
        };
        let (mut actual, mut flags, mut timestamp, mut sample) = (0_u32, 0_u32, 0_i64, None);
        let read = unsafe {
            reader.ReadSample(
                stream,
                0,
                Some(&mut actual),
                Some(&mut flags),
                Some(&mut timestamp),
                Some(&mut sample),
            )
        };
        if let Err(error) = read {
            // A decoder that agreed to NV12 but hands out none (VP8).
            if !pictured && error.code() == MF_E_INVALIDMEDIATYPE {
                return unsupported(win(error));
            }
            return fail(reason(error));
        }
        let is_video = unsafe { reader.GetCurrentMediaType(actual) }
            .and_then(|kind| unsafe { kind.GetGUID(&MF_MT_MAJOR_TYPE) })
            .is_ok_and(|major| major == MFMediaType_Video);
        pictured |= is_video;
        let mut state = shared.lock();
        if flags & MF_SOURCE_READERF_ERROR.0 as u32 != 0 {
            state.error = Some(
                remote
                    .as_ref()
                    .and_then(|stream| stream.error())
                    .unwrap_or_else(|| "the video could not be decoded".into()),
            );
            drop(state);
            (shared.wake)();
            return;
        }
        if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
            if is_video {
                if let Some(picture) = held.take() {
                    state.video.push_back(picture);
                }
                state.video_done = true;
            } else {
                state.audio_done = true;
            }
            drop(state);
            (shared.wake)();
            continue;
        }
        let Some(sample) = sample else { continue };
        let time = timestamp as f64 / 10_000_000.0;
        if is_video {
            if let Some(target) = skip_before {
                if time <= target + 0.0005 {
                    // Not past the target yet: this one may be the picture at it.
                    held = Some((time, SendCom(sample)));
                    continue;
                }
                skip_before = None;
            }
            let first = state.video.is_empty();
            if let Some(picture) = held.take() {
                state.video.push_back(picture);
            }
            state.video.push_back((time, SendCom(sample)));
            drop(state);
            if first {
                (shared.wake)();
            }
        } else {
            drop(state);
            if let Ok(buffer) = unsafe { sample.ConvertToContiguousBuffer() } {
                let mut data = std::ptr::null_mut();
                let mut length = 0_u32;
                if unsafe { buffer.Lock(&mut data, None, Some(&mut length)) }.is_ok() {
                    let floats = unsafe {
                        std::slice::from_raw_parts(data as *const f32, length as usize / 4)
                    };
                    // Sound before the seek target is dropped (to the sample): the clock starts there.
                    let skip = match (audio_skip_before, info.audio) {
                        (Some(target), Some((channels, rate))) => {
                            let frames =
                                ((target - time).max(0.0) * f64::from(rate)).round() as usize;
                            let skip = (frames * usize::from(channels)).min(floats.len());
                            if skip < floats.len() {
                                audio_skip_before = None;
                            }
                            skip
                        }
                        _ => 0,
                    };
                    shared
                        .sound
                        .samples
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .extend(floats[skip..].iter().copied());
                    let _ = unsafe { buffer.Unlock() };
                }
            }
        }
    }
}

/// Decodes audio stream `index` (as float) instead of `current`; selected unless muted.
/// Returns its channels and rate.
pub(super) fn select_audio_stream(
    reader: &IMFSourceReader,
    current: u32,
    index: u32,
    muted: bool,
) -> Result<Option<(u16, u32)>, String> {
    unsafe {
        let audio = MFCreateMediaType().map_err(win)?;
        audio
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)
            .map_err(win)?;
        audio
            .SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_Float)
            .map_err(win)?;
        reader
            .SetCurrentMediaType(index, None, &audio)
            .map_err(win)?;
        let _ = reader.SetStreamSelection(current, false);
        reader.SetStreamSelection(index, !muted).map_err(win)?;
        let kind = reader.GetCurrentMediaType(index).map_err(win)?;
        let channels = kind.GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS).ok();
        let rate = kind.GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND).ok();
        Ok(channels
            .zip(rate)
            .filter(|(channels, rate)| *channels > 0 && *rate > 0)
            .map(|(channels, rate)| (channels as u16, rate)))
    }
}

/// The source reader on `url`, and the app's own download behind it for a remote file.
pub(super) fn open(
    url: &str,
    manager: &IMFDXGIDeviceManager,
) -> Result<(IMFSourceReader, Option<Arc<Stream>>), Fallback> {
    // An HLS/DASH manifest: the Source Reader has no parser for it, the Media Engine
    // plays it (Windows 10+), pictures read back from it.
    if is_remote(url) && !streamable(url) {
        return Err(Fallback::Format(
            "adaptive stream: played by the Media Engine".into(),
        ));
    }
    let remote = if is_remote(url) && streamable(url) {
        Some(Stream::open_windowed(url, VIDEO_WINDOW).map_err(Fallback::Other)?)
    } else {
        None
    };
    open_with(url, manager, remote.as_ref()).map(|reader| (reader, remote))
}

pub(super) enum Fallback {
    /// The reader opened, but its decoder does not hand out NV12 textures (VP8).
    Format(String),
    Other(String),
}

pub(super) fn open_with(
    url: &str,
    manager: &IMFDXGIDeviceManager,
    remote: Option<&Arc<Stream>>,
) -> Result<IMFSourceReader, Fallback> {
    let other = |error: windows::core::Error| Fallback::Other(win(error));
    unsafe {
        let mut attributes = None;
        MFCreateAttributes(&mut attributes, 3).map_err(other)?;
        let attributes =
            attributes.ok_or(Fallback::Other("media attributes were not created".into()))?;
        attributes
            .SetUnknown(&MF_SOURCE_READER_D3D_MANAGER, manager)
            .map_err(other)?;
        attributes
            .SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)
            .map_err(other)?;
        // Decoded textures the pixel shader can read: drawn with no copy.
        attributes
            .SetUINT32(
                &MF_SOURCE_READER_D3D11_BIND_FLAGS,
                (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_DECODER.0) as u32,
            )
            .map_err(other)?;
        let reader = match remote {
            Some(stream) => {
                let bytes = MFCreateMFByteStreamOnStream(&RemoteStream::open(stream.clone()))
                    .map_err(other)?;
                // What Media Foundation picks the container parser by.
                if let Ok(described) = bytes.cast::<IMFAttributes>() {
                    let _ = described.SetString(&MF_BYTESTREAM_ORIGIN_NAME, &HSTRING::from(url));
                    if let Some(kind) = content_type(url, stream.mime.as_deref()) {
                        let _ =
                            described.SetString(&MF_BYTESTREAM_CONTENT_TYPE, &HSTRING::from(kind));
                    }
                }
                MFCreateSourceReaderFromByteStream(&bytes, &attributes).map_err(|error| {
                    Fallback::Other(stream.error().unwrap_or_else(|| win(error)))
                })?
            }
            None => MFCreateSourceReaderFromURL(&HSTRING::from(url), &attributes).map_err(other)?,
        };
        let video = MFCreateMediaType().map_err(other)?;
        video
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
            .map_err(other)?;
        video
            .SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)
            .map_err(other)?;
        if let Err(error) = reader.SetCurrentMediaType(VIDEO_STREAM, None, &video) {
            return Err(Fallback::Format(win(error)));
        }
        let audio = MFCreateMediaType().map_err(other)?;
        audio
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)
            .map_err(other)?;
        audio
            .SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_Float)
            .map_err(other)?;
        if reader
            .SetCurrentMediaType(AUDIO_STREAM, None, &audio)
            .is_err()
        {
            let _ = reader.SetStreamSelection(AUDIO_STREAM, false);
        }
        Ok(reader)
    }
}

pub(super) fn describe(reader: &IMFSourceReader) -> Result<Info, String> {
    unsafe {
        let video = reader.GetCurrentMediaType(VIDEO_STREAM).map_err(win)?;
        let packed = video.GetUINT64(&MF_MT_FRAME_SIZE).map_err(win)?;
        let (mut width, mut height) = ((packed >> 32) as u32, packed as u32);
        let mut area = MFVideoArea::default();
        let bytes = std::slice::from_raw_parts_mut(
            (&mut area as *mut MFVideoArea).cast::<u8>(),
            std::mem::size_of::<MFVideoArea>(),
        );
        if video
            .GetBlob(&MF_MT_MINIMUM_DISPLAY_APERTURE, bytes, None)
            .is_ok()
            && area.Area.cx > 0
            && area.Area.cy > 0
        {
            width = area.Area.cx as u32;
            height = area.Area.cy as u32;
        }
        // Only decoded sound: a stream left compressed (no decoder) plays nothing.
        let audio = reader
            .GetCurrentMediaType(AUDIO_STREAM)
            .ok()
            .filter(|kind| {
                kind.GetGUID(&MF_MT_SUBTYPE)
                    .is_ok_and(|subtype| subtype == MFAudioFormat_Float)
            })
            .and_then(|kind| {
                let channels = kind.GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS).ok()?;
                let rate = kind.GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND).ok()?;
                (channels > 0 && rate > 0).then_some((channels as u16, rate))
            });
        let duration = reader
            .GetPresentationAttribute(MEDIA_SOURCE, &MF_PD_DURATION)
            .ok()
            .map(|value| value.Anonymous.Anonymous.Anonymous.uhVal as f64 / 10_000_000.0)
            .filter(|seconds| *seconds > 0.0);
        Ok(Info {
            width,
            height,
            duration,
            audio,
        })
    }
}
