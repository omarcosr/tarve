use super::*;

impl Player {
    pub(super) fn size(&self) -> (u32, u32) {
        let (mut width, mut height) = (0, 0);
        unsafe {
            let _ = self
                .engine
                .GetNativeVideoSize(Some(&mut width), Some(&mut height));
        }
        (width, height)
    }

    pub(super) fn current_time(&self) -> f64 {
        unsafe { self.engine.GetCurrentTime() }
    }

    pub(super) fn event(&self, id: &str, name: &str) -> Value {
        let mut event = unsafe {
            json!({
                "type": "media",
                "id": id,
                "event": name,
                "time": self.engine.GetCurrentTime(),
                "duration": finite(self.engine.GetDuration()),
                "paused": self.engine.IsPaused().as_bool(),
                "videoWidth": self.size.0,
                "videoHeight": self.size.1,
            })
        };
        if let Some(buffered) = self.buffered() {
            event["buffered"] = json!(buffered);
        }
        if name == "loadedmetadata" {
            event["filename"] = json!(match &self.stream {
                Some(stream) => stream.filename(),
                None => self
                    .src
                    .rsplit(['/', '\\', '?'])
                    .next()
                    .unwrap_or_default()
                    .to_string(),
            });
        }
        event
    }

    /// Plays audio stream `index` alone (`audioTracks[i].enabled`).
    pub(super) fn select_audio(&mut self, index: u32) -> Result<(), String> {
        if !self.tracks.iter().any(|track| track.index == index) {
            return Err(format!("no audio track {index}"));
        }
        let engine: IMFMediaEngineEx = self.engine.cast().map_err(win)?;
        unsafe {
            for track in &self.tracks {
                engine
                    .SetStreamSelection(track.index, track.index == index)
                    .map_err(win)?;
            }
            engine.ApplyStreamSelections().map_err(win)?;
        }
        for track in &mut self.tracks {
            track.enabled = track.index == index;
        }
        Ok(())
    }

    pub(super) fn tracks_event(&self, id: &str) -> Value {
        let mut event = self.event(id, "audiotracks");
        event["audioTracks"] = AudioTrack::json(&self.tracks);
        event
    }

    /// The end of the buffered range holding the current time (`HTMLMediaElement.buffered`).
    pub(super) fn buffered(&self) -> Option<f64> {
        unsafe {
            let ranges = self.engine.GetBuffered().ok()?;
            let now = self.engine.GetCurrentTime();
            let mut end = None;
            for index in 0..ranges.GetLength() {
                if let (Ok(start), Ok(stop)) = (ranges.GetStart(index), ranges.GetEnd(index))
                    && start <= now + 0.5
                    && stop >= now
                {
                    end = Some(stop);
                }
            }
            end.filter(|end| end.is_finite())
        }
    }

    /// The remote download opened: the engine reads it as a byte stream, and
    /// what was asked meanwhile is carried out.
    pub(super) fn open_stream(&mut self, stream: Arc<Stream>) -> Result<(), String> {
        self.stream = Some(stream.clone());
        let opening = self.opening.take().unwrap_or(Opening {
            play: false,
            seek: None,
        });
        unsafe {
            let bytes =
                MFCreateMFByteStreamOnStream(&RemoteStream::open(stream.clone())).map_err(win)?;
            if let Ok(described) = bytes.cast::<IMFAttributes>() {
                let _ = described.SetString(
                    &MF_BYTESTREAM_ORIGIN_NAME,
                    &HSTRING::from(self.src.as_str()),
                );
                if let Some(kind) = content_type(&self.src, stream.mime.as_deref()) {
                    let _ = described.SetString(&MF_BYTESTREAM_CONTENT_TYPE, &HSTRING::from(kind));
                }
            }
            let engine: IMFMediaEngineEx = self.engine.cast().map_err(win)?;
            engine
                .SetSourceFromByteStream(&bytes, &BSTR::from(self.src.as_str()))
                .map_err(win)?;
            if let Some(time) = opening.seek {
                self.settle_until = Some(Instant::now() + SETTLE_FOR);
                self.engine.SetCurrentTime(time.max(0.0)).map_err(win)?;
            }
            if opening.play {
                self.engine.Play().map_err(win)?;
            }
        }
        Ok(())
    }

    pub(super) fn error_message(&self) -> String {
        let reason = unsafe { self.engine.GetError() }
            .ok()
            .map(|error| {
                let code = unsafe { error.GetErrorCode() };
                let detail = unsafe { error.GetExtendedErrorCode() }
                    .err()
                    .map(win)
                    .filter(|text| !text.is_empty());
                let kind = match code {
                    1 => "playback aborted",
                    2 => "network error",
                    3 => "the video could not be decoded",
                    4 => "unsupported video format or source",
                    _ => "video error",
                };
                match detail {
                    Some(detail) => format!("{kind}: {detail}"),
                    None => kind.to_string(),
                }
            })
            .unwrap_or_else(|| "video error".into());
        failure(&self.src, reason)
    }

    /// A new picture, if the engine has one due (or `again`: the current one once
    /// more): drawn into the surface, and read back for renderers without the texture.
    pub(super) fn transfer(
        &mut self,
        gpu: &Gpu,
        again: bool,
    ) -> Result<Option<VideoFrame>, String> {
        // Off screen with a picture already: the engine still steps through its
        // pictures (it ends and loops by them), but none is copied or read back.
        let copy = again || !self.hidden || self.generation == 0;
        let mut pts = 0_i64;
        // S_FALSE means "no new picture"; the wrapper would treat it as success.
        let hr = unsafe {
            (Interface::vtable(&self.engine).OnVideoStreamTick)(
                Interface::as_raw(&self.engine),
                &mut pts,
            )
        };
        if (hr != S_OK && !again) || !copy {
            return Ok(None);
        }
        let (width, height) = self.size();
        if width == 0 || height == 0 {
            return Ok(None);
        }
        self.size = (width, height);
        // Only the pixels the screen shows: the video processor scales while it
        // converts, so a 1080p video in a 720p box is drawn (or read back) at 720p.
        let (mut target_width, mut target_height) = match self.display {
            Some((w, h)) => (w.clamp(1, width), h.clamp(1, height)),
            None => (width, height),
        };
        let format = if gpu.renderer && self.nv12 {
            // NV12 planes are subsampled two by two: even sizes.
            target_width = (target_width + 1) & !1;
            target_height = (target_height + 1) & !1;
            DXGI_FORMAT_NV12
        } else {
            DXGI_FORMAT_B8G8R8A8_UNORM
        };
        let reuse = self.surface.as_ref().is_some_and(|surface| {
            surface.width == target_width
                && surface.height == target_height
                && surface.format == format
        });
        if !reuse {
            match create_surface(gpu, target_width, target_height, format) {
                Ok(surface) => self.surface = Some(surface),
                Err(_) if format == DXGI_FORMAT_NV12 => {
                    self.nv12 = false;
                    return self.transfer(gpu, true);
                }
                Err(error) => return Err(error),
            }
        }
        let surface = self.surface.as_mut().unwrap();
        let rect = RECT {
            left: 0,
            top: 0,
            right: target_width as i32,
            bottom: target_height as i32,
        };
        let black = MFARGB {
            rgbBlue: 0,
            rgbGreen: 0,
            rgbRed: 0,
            rgbAlpha: 255,
        };
        let transferred = unsafe {
            self.engine
                .TransferVideoFrame(&surface.texture, None, &rect, Some(&black))
        };
        if let Err(error) = transferred {
            if surface.format == DXGI_FORMAT_NV12 {
                // This video processor cannot write NV12: BGRA from now on.
                self.nv12 = false;
                self.surface = None;
                return self.transfer(gpu, true);
            }
            return Err(win(error));
        }
        self.generation += 1;
        let pixels = if gpu.renderer {
            None
        } else {
            Some(read_back(gpu, surface)?)
        };
        Ok(Some(VideoFrame {
            width,
            height,
            generation: self.generation,
            pixels,
        }))
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        unsafe {
            let _ = self.engine.Shutdown();
        }
    }
}

pub(super) fn plane_view(
    device: &ID3D11Device,
    texture: &ID3D11Texture2D,
    format: DXGI_FORMAT,
) -> Result<ID3D11ShaderResourceView, String> {
    let desc = D3D11_SHADER_RESOURCE_VIEW_DESC {
        Format: format,
        ViewDimension: D3D11_SRV_DIMENSION_TEXTURE2D,
        Anonymous: D3D11_SHADER_RESOURCE_VIEW_DESC_0 {
            Texture2D: D3D11_TEX2D_SRV {
                MostDetailedMip: 0,
                MipLevels: 1,
            },
        },
    };
    let mut view = None;
    unsafe { device.CreateShaderResourceView(texture, Some(&desc), Some(&mut view)) }
        .map_err(win)?;
    view.ok_or_else(|| "video texture view was not created".into())
}

pub(super) fn create_surface(
    gpu: &Gpu,
    width: u32,
    height: u32,
    format: DXGI_FORMAT,
) -> Result<Surface, String> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: format,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };
    let mut texture = None;
    unsafe { gpu.device.CreateTexture2D(&desc, None, Some(&mut texture)) }.map_err(win)?;
    let texture = texture.ok_or("video texture was not created")?;
    let view = match (gpu.renderer, format == DXGI_FORMAT_NV12) {
        (false, _) => None,
        // One texture, two views: luma (R8) and the half-size chroma plane (R8G8).
        (true, true) => Some(VideoView::Nv12 {
            luma: plane_view(&gpu.device, &texture, DXGI_FORMAT_R8_UNORM)?,
            chroma: plane_view(&gpu.device, &texture, DXGI_FORMAT_R8G8_UNORM)?,
            uv: [1.0, 1.0],
            source: None,
        }),
        (true, false) => Some(VideoView::Rgba(plane_view(&gpu.device, &texture, format)?)),
    };
    Ok(Surface {
        texture,
        view,
        format,
        staging: None,
        width,
        height,
    })
}

/// The picture in memory (RGBA), for renderers that cannot sample the texture.
pub(super) fn read_back(gpu: &Gpu, surface: &mut Surface) -> Result<ImageData, String> {
    if surface.staging.is_none() {
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { surface.texture.GetDesc(&mut desc) };
        desc.BindFlags = 0;
        desc.MiscFlags = 0;
        desc.Usage = D3D11_USAGE_STAGING;
        desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
        let mut staging = None;
        unsafe { gpu.device.CreateTexture2D(&desc, None, Some(&mut staging)) }.map_err(win)?;
        surface.staging = staging;
    }
    let staging = surface
        .staging
        .as_ref()
        .ok_or("video staging texture was not created")?;
    unsafe { gpu.context.CopyResource(staging, &surface.texture) };
    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    unsafe {
        gpu.context
            .Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
    }
    .map_err(win)?;
    let (width, height) = (surface.width as usize, surface.height as usize);
    let mut pixels = vec![0_u8; width * height * 4];
    for row in 0..height {
        let source = unsafe {
            std::slice::from_raw_parts(
                (mapped.pData as *const u8).add(row * mapped.RowPitch as usize),
                width * 4,
            )
        };
        let target = &mut pixels[row * width * 4..(row + 1) * width * 4];
        // BGRA to opaque RGBA, a word at a time (vectorized).
        for (to, from) in target
            .as_chunks_mut::<4>()
            .0
            .iter_mut()
            .zip(source.as_chunks::<4>().0)
        {
            let pixel = u32::from_le_bytes(*from);
            *to = ((pixel & 0x00FF_00FF).rotate_left(16) | (pixel & 0x0000_FF00) | 0xFF00_0000)
                .to_le_bytes();
        }
    }
    unsafe { gpu.context.Unmap(staging, 0) };
    Ok(ImageData {
        width: surface.width,
        height: surface.height,
        format: ImageFormat::Rgba8,
        // Opaque: premultiplied is the same, and renderers skip multiplying each pixel.
        alpha_type: ImageAlphaType::AlphaPremultiplied,
        data: Blob::new(Arc::new(pixels)),
    })
}
