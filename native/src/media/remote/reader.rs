use super::{CHUNK, STALL, Stream};
use std::io::{self, Read, Seek, SeekFrom};
use std::sync::Arc;

/// A seekable reader over a [`Stream`]; reads block until their chunk arrives.
pub(crate) struct Reader {
    stream: Arc<Stream>,
    position: u64,
    /// The stream's epoch when it was made: a later cut retires it.
    epoch: u64,
}

impl Reader {
    pub(crate) fn new(stream: Arc<Stream>) -> Self {
        let epoch = stream.lock().epoch;
        Self {
            stream,
            position: 0,
            epoch,
        }
    }
}

/// A read given up for a newer seek (not `Interrupted`: `read_exact` would retry it).
fn superseded() -> io::Error {
    io::Error::other("a newer seek superseded the read")
}

impl Read for Reader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() || self.position >= self.stream.len {
            return Ok(0);
        }
        let mut state = self.stream.lock();
        if state.epoch != self.epoch {
            return Err(superseded());
        }
        self.stream
            .read_at
            .store(self.position, std::sync::atomic::Ordering::Relaxed);
        let index = (self.position / CHUNK as u64) as usize;
        let offset = (self.position % CHUNK as u64) as usize;
        if state.want != index {
            state.want = index;
            if state.chunks[index].is_none() {
                // A windowed download waits for the reader to move.
                self.stream.ready.notify_all();
            }
        }
        loop {
            if let Some(chunk) = &state.chunks[index] {
                let count = buf.len().min(chunk.len() - offset);
                buf[..count].copy_from_slice(&chunk[offset..offset + count]);
                self.position += count as u64;
                return Ok(count);
            }
            if let Some(error) = &state.error {
                return Err(io::Error::other(error.clone()));
            }
            if state.epoch != self.epoch {
                return Err(superseded());
            }
            // A newer seek waits behind this read: waiting for bytes of the old
            // target would hold it up, so the read fails and the decoder starts over.
            if state.interrupted {
                state.cut = true;
                return Err(superseded());
            }
            let (next, wait) = self
                .stream
                .ready
                .wait_timeout(state, STALL)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state = next;
            if wait.timed_out() && state.chunks[index].is_none() {
                // Recorded on the stream, so the track reports an error (the
                // page can reload it) instead of ending as if it were over.
                let message = crate::media::failure(&self.stream.url, "the network stalled");
                state.error.get_or_insert(message.clone());
                drop(state);
                self.stream.ready.notify_all();
                return Err(io::Error::new(io::ErrorKind::TimedOut, message));
            }
        }
    }
}

impl Seek for Reader {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        let target = match to {
            SeekFrom::Start(offset) => Some(offset),
            SeekFrom::End(delta) => self.stream.len.checked_add_signed(delta),
            SeekFrom::Current(delta) => self.position.checked_add_signed(delta),
        };
        self.position = target
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "seek before start"))?;
        Ok(self.position)
    }
}
