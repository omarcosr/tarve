//! The audio streams of a file: name, language, codec and whether this machine decodes them.
use super::*;

/// An audio stream of a file, as `HTMLMediaElement.audioTracks` lists it: `index` is
/// the stream's number in the file (the same for the Source Reader and the Media Engine).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct AudioTrack {
    pub index: u32,
    pub label: String,
    pub language: String,
    pub enabled: bool,
    /// The stream's codec (`aac`, `ac3`, `eac3`, `dts`…), empty when unknown.
    pub codec: String,
    /// A decoder on this machine turns it into sound (a track that is not would
    /// play silent); None when the path cannot tell (the Media Engine's).
    pub playable: Option<bool>,
}

/// A short name for an audio subtype (`MF_MT_SUBTYPE`), as the container calls it.
pub(crate) fn audio_codec(subtype: &GUID) -> String {
    let known: &[(GUID, &str)] = &[
        (MFAudioFormat_AAC, "aac"),
        (MFAudioFormat_MP3, "mp3"),
        (MFAudioFormat_MPEG, "mp2"),
        (MFAudioFormat_Dolby_AC3, "ac3"),
        (MFAudioFormat_Dolby_AC3_SPDIF, "ac3"),
        (MFAudioFormat_Dolby_DDPlus, "eac3"),
        (MFAudioFormat_DTS, "dts"),
        (MFAudioFormat_FLAC, "flac"),
        (MFAudioFormat_Opus, "opus"),
        (MFAudioFormat_ALAC, "alac"),
        (MFAudioFormat_PCM, "pcm"),
        (MFAudioFormat_Float, "pcm"),
        (MFAudioFormat_WMAudioV8, "wma"),
        (MFAudioFormat_WMAudioV9, "wma"),
        (MFAudioFormat_AMR_NB, "amr"),
    ];
    if let Some((_, name)) = known.iter().find(|(guid, _)| guid == subtype) {
        return (*name).to_string();
    }
    // Media Foundation's audio subtypes are a FOURCC or a WAVE_FORMAT tag in Data1.
    let bytes = subtype.data1.to_le_bytes();
    if bytes.iter().all(|byte| byte.is_ascii_alphanumeric()) {
        String::from_utf8_lossy(&bytes).trim().to_ascii_lowercase()
    } else {
        String::new()
    }
}

impl AudioTrack {
    pub(crate) fn json(tracks: &[AudioTrack]) -> serde_json::Value {
        serde_json::Value::Array(
            tracks
                .iter()
                .map(|track| {
                    {
                    let mut json = serde_json::json!({"id": track.index, "label": track.label, "language": track.language, "enabled": track.enabled, "codec": track.codec});
                    if let Some(playable) = track.playable {
                        json["playable"] = playable.into();
                    }
                    json
                }
                })
                .collect(),
        )
    }
}

/// A string attribute of stream `index` (its language, its name), empty when absent.
fn stream_string(reader: &IMFSourceReader, index: u32, key: &GUID) -> String {
    use windows::Win32::System::Com::StructuredStorage::PropVariantClear;
    use windows::Win32::System::Variant::VT_LPWSTR;
    unsafe {
        let Ok(mut value) = reader.GetPresentationAttribute(index, key) else {
            return String::new();
        };
        let text = if value.Anonymous.Anonymous.vt == VT_LPWSTR {
            value
                .Anonymous
                .Anonymous
                .Anonymous
                .pwszVal
                .to_string()
                .unwrap_or_default()
        } else {
            String::new()
        };
        let _ = PropVariantClear(&mut value);
        text
    }
}

/// The audio streams of the file `reader` opened; `enabled` marks `playing` (the
/// first playable one when None). A stream is playable when the reader accepts float
/// output for it (a decoder exists): asked before anything is read.
pub(crate) fn audio_tracks(reader: &IMFSourceReader, playing: Option<u32>) -> Vec<AudioTrack> {
    let float = unsafe {
        MFCreateMediaType().ok().filter(|kind| {
            kind.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).is_ok()
                && kind.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_Float).is_ok()
        })
    };
    let mut tracks = Vec::new();
    for index in 0..64_u32 {
        let kind = match unsafe { reader.GetNativeMediaType(index, 0) } {
            Ok(kind) => kind,
            Err(error) if error.code() == MF_E_INVALIDSTREAMNUMBER => break,
            Err(_) => continue,
        };
        if unsafe { kind.GetGUID(&MF_MT_MAJOR_TYPE) }.is_ok_and(|major| major == MFMediaType_Audio)
        {
            let subtype = unsafe { kind.GetGUID(&MF_MT_SUBTYPE) }.unwrap_or_default();
            let playable = float.as_ref().is_some_and(|float| unsafe {
                reader.SetCurrentMediaType(index, None, float).is_ok()
            });
            tracks.push(AudioTrack {
                index,
                label: stream_string(reader, index, &MF_SD_STREAM_NAME),
                language: stream_string(reader, index, &MF_SD_LANGUAGE),
                enabled: false,
                codec: audio_codec(&subtype),
                playable: Some(playable),
            });
        }
    }
    let playing = playing.or_else(|| {
        tracks
            .iter()
            .find(|track| track.playable == Some(true))
            .or(tracks.first())
            .map(|track| track.index)
    });
    for track in &mut tracks {
        track.enabled = Some(track.index) == playing;
    }
    tracks
}
