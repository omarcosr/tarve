//! The Media Engine's audio streams.
use super::*;

/// A string or GUID stream attribute of the engine's stream `index`.
fn engine_attribute(
    engine: &IMFMediaEngineEx,
    index: u32,
    key: &windows::core::GUID,
) -> (String, Option<windows::core::GUID>) {
    use windows::Win32::System::Com::StructuredStorage::PropVariantClear;
    use windows::Win32::System::Variant::{VT_CLSID, VT_LPWSTR};
    unsafe {
        let Ok(mut value) = engine.GetStreamAttribute(index, key) else {
            return (String::new(), None);
        };
        let inner = &value.Anonymous.Anonymous;
        let out = if inner.vt == VT_LPWSTR {
            (
                inner.Anonymous.pwszVal.to_string().unwrap_or_default(),
                None,
            )
        } else if inner.vt == VT_CLSID && !inner.Anonymous.puuid.is_null() {
            (String::new(), Some(*inner.Anonymous.puuid))
        } else {
            (String::new(), None)
        };
        let _ = PropVariantClear(&mut value);
        out
    }
}

/// The engine's audio streams, numbered as it numbers them.
pub(super) fn engine_tracks(engine: &IMFMediaEngine) -> Vec<AudioTrack> {
    let Ok(engine) = engine.cast::<IMFMediaEngineEx>() else {
        return Vec::new();
    };
    let count = unsafe { engine.GetNumberOfStreams() }.unwrap_or(0);
    (0..count)
        .filter(|&index| {
            engine_attribute(&engine, index, &MF_MT_MAJOR_TYPE).1 == Some(MFMediaType_Audio)
        })
        .map(|index| {
            let subtype = engine_attribute(&engine, index, &MF_MT_SUBTYPE).1;
            AudioTrack {
                index,
                label: engine_attribute(&engine, index, &MF_SD_STREAM_NAME).0,
                language: engine_attribute(&engine, index, &MF_SD_LANGUAGE).0,
                enabled: unsafe { engine.GetStreamSelection(index) }.is_ok_and(|on| on.as_bool()),
                codec: subtype.as_ref().map(audio_codec).unwrap_or_default(),
                // The engine does not say whether its decoder plays the stream: an MFT
                // can be registered for AC-3 and still not decode it.
                playable: None,
            }
        })
        .collect()
}
