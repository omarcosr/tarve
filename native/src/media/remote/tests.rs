use super::{CHUNK, Reader, Stream};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::TcpListener;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Chunks in the served file; each byte is the index of its chunk.
const COUNT: usize = 40;

/// A slow network (about 800 KB/s, so a 16-chunk run takes about five seconds)
/// serving ranges of a file whose bytes tell their chunk.
fn serve_slowly() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let body: Arc<Vec<u8>> = Arc::new((0..COUNT * CHUNK).map(|at| (at / CHUNK) as u8).collect());
    std::thread::spawn(move || {
        for connection in listener.incoming() {
            let Ok(mut connection) = connection else {
                continue;
            };
            let body = body.clone();
            std::thread::spawn(move || {
                let mut reader = BufReader::new(connection.try_clone().unwrap());
                loop {
                    let mut range = (0, body.len() - 1);
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).unwrap_or(0) == 0 {
                            return;
                        }
                        if line == "\r\n" {
                            break;
                        }
                        if let Some(value) = line.to_ascii_lowercase().strip_prefix("range: bytes=")
                        {
                            let (start, end) = value.trim().split_once('-').unwrap();
                            range = (start.parse().unwrap(), end.parse().unwrap());
                        }
                    }
                    let (start, end): (usize, usize) = range;
                    let end = end.min(body.len() - 1);
                    let head = format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Type: video/mp4\r\nContent-Length: {}\r\nContent-Range: bytes {start}-{end}/{}\r\n\r\n",
                        end + 1 - start,
                        body.len()
                    );
                    if connection.write_all(head.as_bytes()).is_err() {
                        return;
                    }
                    for piece in body[start..=end].chunks(32 * 1024) {
                        if connection.write_all(piece).is_err() {
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(40));
                    }
                }
            });
        }
    });
    format!("http://{address}/long.mp4")
}

/// Reads one byte at chunk `index`: which chunk the bytes there say they are.
fn byte_at(reader: &mut Reader, index: usize) -> std::io::Result<u8> {
    reader.seek(SeekFrom::Start((index * CHUNK) as u64))?;
    let mut byte = [0];
    reader.read_exact(&mut byte)?;
    Ok(byte[0])
}

#[test]
fn a_seek_drops_the_run_under_way_for_the_new_position() {
    let stream = Stream::open_windowed(&serve_slowly(), 64).unwrap();
    // The download is in its first run (chunks 1 to 16, about five seconds).
    std::thread::sleep(Duration::from_millis(300));
    stream.seeking();
    let started = Instant::now();
    assert_eq!(byte_at(&mut Reader::new(stream.clone()), 30).unwrap(), 30);
    assert!(
        started.elapsed() < Duration::from_millis(2500),
        "the seek waited {:?} for the run before it",
        started.elapsed()
    );
}

#[test]
fn a_newer_seek_cuts_a_read_waiting_for_the_old_target() {
    let stream = Stream::open_windowed(&serve_slowly(), 64).unwrap();
    let waiting = stream.clone();
    let started = Instant::now();
    let old = std::thread::spawn(move || {
        let mut reader = Reader::new(waiting);
        let result = byte_at(&mut reader, 35);
        (result.is_err(), started.elapsed(), reader)
    });
    std::thread::sleep(Duration::from_millis(300));
    assert!(!stream.cut(), "nothing cut before the seek");
    stream.interrupt();
    let (failed, after, mut old) = old.join().unwrap();
    assert!(failed, "the read for the old target gave up");
    assert!(after < Duration::from_millis(1500), "it waited {after:?}");
    assert!(stream.cut());
    // The decoder takes the seek: its demuxer opens again on a new reader.
    assert!(stream.resume(), "the cut is reported once");
    assert!(!stream.resume());
    assert!(
        byte_at(&mut old, 0).is_err(),
        "the retired reader stays retired"
    );
    let started = Instant::now();
    assert_eq!(byte_at(&mut Reader::new(stream.clone()), 25).unwrap(), 25);
    assert!(
        started.elapsed() < Duration::from_millis(2500),
        "the new target waited {:?}",
        started.elapsed()
    );
}
