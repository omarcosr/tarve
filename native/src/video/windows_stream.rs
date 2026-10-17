//! A remote `<video>` src read through the app's own HTTP download (the one
//! `<audio>` uses) instead of Media Foundation's network source: the moov box at
//! the end of a file is fetched with one range request, a server without ranges
//! downloads at full speed, and only a window around the playback position stays
//! in memory. Media Foundation reads it as an `IStream`.

use crate::media::remote::{Reader, Stream};
use std::io::{Read, Seek, SeekFrom};
use std::sync::{Arc, Mutex};
use windows::Win32::Foundation::{E_FAIL, E_NOTIMPL, S_FALSE, S_OK, STG_E_ACCESSDENIED, STG_E_INVALIDFUNCTION};
use windows::Win32::System::Com::{
    ISequentialStream_Impl, IStream, IStream_Impl, LOCKTYPE, STATFLAG, STATSTG, STGC, STGM_READ, STGTY_STREAM,
    STREAM_SEEK, STREAM_SEEK_CUR, STREAM_SEEK_END, STREAM_SEEK_SET,
};
use windows::core::{HRESULT, Ref, implement};

/// Chunks (256 KB) a video keeps downloaded ahead of playback: 16 MB.
pub(super) const VIDEO_WINDOW: usize = 64;

#[implement(IStream)]
pub(super) struct RemoteStream {
    reader: Mutex<Reader>,
    len: u64,
}

impl RemoteStream {
    pub(super) fn open(stream: Arc<Stream>) -> IStream {
        let len = stream.len;
        Self { reader: Mutex::new(Reader::new(stream)), len }.into()
    }
}

/// Whether `url` is a progressive file this stream can serve (not an HLS or DASH manifest).
pub(super) fn streamable(url: &str) -> bool {
    let path = url.split(['?', '#']).next().unwrap_or(url).to_ascii_lowercase();
    !(path.ends_with(".m3u8") || path.ends_with(".mpd") || path.ends_with(".ism/manifest"))
}

/// The content type Media Foundation picks a parser by: the server's, else the extension's.
pub(super) fn content_type(url: &str, mime: Option<&str>) -> Option<&'static str> {
    let path = url.split(['?', '#']).next().unwrap_or(url).to_ascii_lowercase();
    let by_mime = mime.and_then(|mime| match mime {
        "video/mp4" | "audio/mp4" | "application/mp4" => Some("video/mp4"),
        "video/webm" | "audio/webm" => Some("video/webm"),
        "video/quicktime" => Some("video/quicktime"),
        "video/x-matroska" => Some("video/x-matroska"),
        "video/mp2t" => Some("video/mp2t"),
        "video/x-ms-wmv" => Some("video/x-ms-wmv"),
        "video/x-msvideo" => Some("video/x-msvideo"),
        _ => None,
    });
    by_mime.or_else(|| {
        let extension = path.rsplit('.').next()?;
        Some(match extension {
            "mp4" | "m4v" | "m4a" => "video/mp4",
            "webm" => "video/webm",
            "mov" => "video/quicktime",
            "mkv" => "video/x-matroska",
            "ts" => "video/mp2t",
            "wmv" => "video/x-ms-wmv",
            "avi" => "video/x-msvideo",
            _ => return None,
        })
    })
}

impl ISequentialStream_Impl for RemoteStream_Impl {
    fn Read(&self, pv: *mut core::ffi::c_void, cb: u32, pcbread: *mut u32) -> HRESULT {
        if pv.is_null() {
            return STG_E_INVALIDFUNCTION;
        }
        let buffer = unsafe { std::slice::from_raw_parts_mut(pv.cast::<u8>(), cb as usize) };
        let mut reader = self.reader.lock().unwrap_or_else(|p| p.into_inner());
        let mut total = 0;
        while total < buffer.len() {
            match reader.read(&mut buffer[total..]) {
                Ok(0) => break,
                Ok(count) => total += count,
                // The download failed: Media Foundation reports it; the stream keeps the reason.
                Err(_) if total == 0 => return E_FAIL,
                Err(_) => break,
            }
        }
        if !pcbread.is_null() {
            unsafe { *pcbread = total as u32 };
        }
        if total < buffer.len() { S_FALSE } else { S_OK }
    }

    fn Write(&self, _pv: *const core::ffi::c_void, _cb: u32, _pcbwritten: *mut u32) -> HRESULT {
        STG_E_ACCESSDENIED
    }
}

impl IStream_Impl for RemoteStream_Impl {
    fn Seek(&self, dlibmove: i64, dworigin: STREAM_SEEK, plibnewposition: *mut u64) -> windows::core::Result<()> {
        let to = match dworigin {
            STREAM_SEEK_SET => SeekFrom::Start(dlibmove.max(0) as u64),
            STREAM_SEEK_CUR => SeekFrom::Current(dlibmove),
            STREAM_SEEK_END => SeekFrom::End(dlibmove),
            _ => return Err(STG_E_INVALIDFUNCTION.into()),
        };
        let position = self
            .reader
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .seek(to)
            .map_err(|_| windows::core::Error::from(STG_E_INVALIDFUNCTION))?;
        if !plibnewposition.is_null() {
            unsafe { *plibnewposition = position };
        }
        Ok(())
    }

    fn SetSize(&self, _libnewsize: u64) -> windows::core::Result<()> {
        Err(STG_E_ACCESSDENIED.into())
    }

    fn CopyTo(&self, _pstm: Ref<'_, IStream>, _cb: u64, _pcbread: *mut u64, _pcbwritten: *mut u64) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn Commit(&self, _grfcommitflags: &STGC) -> windows::core::Result<()> {
        Ok(())
    }

    fn Revert(&self) -> windows::core::Result<()> {
        Ok(())
    }

    fn LockRegion(&self, _liboffset: u64, _cb: u64, _dwlocktype: &LOCKTYPE) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn UnlockRegion(&self, _liboffset: u64, _cb: u64, _dwlocktype: u32) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn Stat(&self, pstatstg: *mut STATSTG, _grfstatflag: &STATFLAG) -> windows::core::Result<()> {
        if pstatstg.is_null() {
            return Err(STG_E_INVALIDFUNCTION.into());
        }
        unsafe {
            *pstatstg = STATSTG {
                r#type: STGTY_STREAM.0 as u32,
                cbSize: self.len,
                grfMode: STGM_READ,
                ..Default::default()
            };
        }
        Ok(())
    }

    fn Clone(&self) -> windows::core::Result<IStream> {
        Err(E_NOTIMPL.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_a_parser_by_type_or_extension_and_leaves_manifests_to_media_foundation() {
        assert_eq!(content_type("https://a.test/v.mp4?sig=1", None), Some("video/mp4"));
        assert_eq!(content_type("https://a.test/v", Some("video/webm")), Some("video/webm"));
        assert_eq!(content_type("https://a.test/v.MOV", Some("text/plain")), Some("video/quicktime"));
        assert_eq!(content_type("https://a.test/v", None), None);
        assert!(streamable("https://a.test/v.mp4"));
        assert!(!streamable("https://a.test/live/index.m3u8?token=x"));
        assert!(!streamable("https://a.test/dash/manifest.mpd"));
    }
}
