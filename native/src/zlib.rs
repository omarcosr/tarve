//! Synchronous zlib (RFC 1950) and gzip (RFC 1952) streams for the JavaScript runtimes that
//! have no `node:zlib`: node:zlib's `deflateSync`/`inflateSync`/`gzipSync`/`gunzipSync` on
//! txiki.js (the C ABI, bridge/entry_points.rs) and on Android's QuickJS host (android/qjs.rs),
//! and @tarve/headless's PNG encoder (web.rs). PNG image data is a zlib stream; miniz_oxide is
//! the pure-Rust deflate the `png` crate uses.

/// Compression level when the caller gives none: zlib's `Z_DEFAULT_COMPRESSION`.
pub(crate) const DEFAULT_LEVEL: u8 = 6;

/// A zlib-wrapped deflate stream of `data`. `level` is 0 (stored) to 9; 10 is miniz's slowest.
pub(crate) fn deflate(data: &[u8], level: u8) -> Vec<u8> {
    miniz_oxide::deflate::compress_to_vec_zlib(data, level.min(10))
}

/// The bytes of a zlib stream, or why it is not one (a bad header, a checksum mismatch, a truncation).
pub(crate) fn inflate(data: &[u8]) -> Result<Vec<u8>, String> {
    miniz_oxide::inflate::decompress_to_vec_zlib(data)
        .map_err(|error| format!("invalid zlib data ({:?})", error.status))
}

/// zlib's OS_CODE, what Node.js writes in a gzip header on this platform.
const GZIP_OS: u8 = if cfg!(windows) {
    10
} else if cfg!(target_vendor = "apple") {
    19
} else {
    3
};

const CRC_TABLE: [u32; 256] = {
    let mut table = [0_u32; 256];
    let mut n = 0;
    while n < 256 {
        let mut c = n as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 {
                0xedb8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
            k += 1;
        }
        table[n] = c;
        n += 1;
    }
    table
};

/// The CRC-32 (ISO-HDLC, as gzip and PNG use) of `data`.
pub(crate) fn crc32(data: &[u8]) -> u32 {
    !data.iter().fold(!0_u32, |c, &byte| {
        CRC_TABLE[((c ^ u32::from(byte)) & 0xff) as usize] ^ (c >> 8)
    })
}

/// A gzip member of `data`, with the header zlib (and so Node.js) writes: no name, no mtime,
/// XFL from the level, this platform's OS byte.
pub(crate) fn gzip(data: &[u8], level: u8) -> Vec<u8> {
    let level = level.min(10);
    let xfl = if level >= 9 {
        2
    } else if level < 2 {
        4
    } else {
        0
    };
    let mut out = vec![0x1f, 0x8b, 8, 0, 0, 0, 0, 0, xfl, GZIP_OS];
    out.extend(miniz_oxide::deflate::compress_to_vec(data, level));
    out.extend(crc32(data).to_le_bytes());
    out.extend((data.len() as u32).to_le_bytes());
    out
}

const END: &str = "unexpected end of file";

/// What follows a gzip member's header (FEXTRA, FNAME, FCOMMENT and FHCRC skipped).
fn gzip_body(data: &[u8]) -> Result<&[u8], String> {
    if data.len() < 2 {
        return Err(END.into());
    }
    if data[0] != 0x1f || data[1] != 0x8b {
        return Err("incorrect header check".into());
    }
    if data.len() < 10 {
        return Err(END.into());
    }
    if data[2] != 8 {
        return Err("unknown compression method".into());
    }
    let flags = data[3];
    let mut at = 10;
    if flags & 4 != 0 {
        let extra = data.get(at..at + 2).ok_or(END)?;
        at += 2 + usize::from(u16::from_le_bytes([extra[0], extra[1]]));
    }
    for field in [8, 16] {
        if flags & field != 0 {
            at += data
                .get(at..)
                .ok_or(END)?
                .iter()
                .position(|&byte| byte == 0)
                .ok_or(END)?
                + 1;
        }
    }
    if flags & 2 != 0 {
        at += 2;
    }
    data.get(at..).ok_or_else(|| END.into())
}

/// Inflates the raw deflate stream at the start of `data`: its bytes and how much of `data` it took.
fn inflate_raw_prefix(data: &[u8]) -> Result<(Vec<u8>, usize), String> {
    use miniz_oxide::inflate::stream::{InflateState, inflate};
    use miniz_oxide::{DataFormat, MZFlush, MZStatus};
    let mut state = InflateState::new_boxed(DataFormat::Raw);
    let mut output = Vec::new();
    let mut chunk = vec![0_u8; 64 * 1024];
    let mut consumed = 0;
    loop {
        let result = inflate(&mut state, &data[consumed..], &mut chunk, MZFlush::None);
        consumed += result.bytes_consumed;
        output.extend_from_slice(&chunk[..result.bytes_written]);
        match result.status {
            Ok(MZStatus::StreamEnd) => return Ok((output, consumed)),
            Ok(_) | Err(miniz_oxide::MZError::Buf)
                if result.bytes_consumed > 0 || result.bytes_written > 0 => {}
            Ok(_) | Err(miniz_oxide::MZError::Buf) => return Err(END.into()),
            Err(error) => return Err(format!("invalid gzip data ({error:?})")),
        }
    }
}

/// The bytes of a gzip stream; members written one after another (`cat a.gz b.gz`) are joined,
/// as Node.js does. A wrong checksum or length, or a truncation, is an error.
pub(crate) fn gunzip(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut rest = data;
    loop {
        let body = gzip_body(rest)?;
        let (bytes, used) = inflate_raw_prefix(body)?;
        let trailer = body.get(used..used + 8).ok_or(END)?;
        if u32::from_le_bytes([trailer[0], trailer[1], trailer[2], trailer[3]]) != crc32(&bytes) {
            return Err("incorrect data check".into());
        }
        if u32::from_le_bytes([trailer[4], trailer[5], trailer[6], trailer[7]])
            != bytes.len() as u32
        {
            return Err("incorrect length check".into());
        }
        out.extend(bytes);
        rest = &body[used + 8..];
        if rest.len() < 2 || rest[0] != 0x1f || rest[1] != 0x8b {
            return Ok(out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|at| u8::from_str_radix(&text[at..at + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn crc32_matches_the_check_value() {
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn gzip_writes_the_bytes_node_writes() {
        // Node.js 26 `zlib.gzipSync("hello", { level })` (OS byte 0a on Windows, 03 on Linux).
        let os = format!("{GZIP_OS:02x}");
        assert_eq!(
            gzip(b"hello", DEFAULT_LEVEL),
            hex(&format!(
                "1f8b08000000000000{os}cb48cdc9c9070086a6103605000000"
            ))
        );
        assert_eq!(
            gzip(b"hello", 9),
            hex(&format!(
                "1f8b08000000000002{os}cb48cdc9c9070086a6103605000000"
            ))
        );
        assert_eq!(
            gzip(b"hello", 1),
            hex(&format!(
                "1f8b08000000000004{os}cb48cdc9c9070086a6103605000000"
            ))
        );
        assert_eq!(
            gzip(b"", DEFAULT_LEVEL),
            hex(&format!("1f8b08000000000000{os}03000000000000000000"))
        );
    }

    #[test]
    fn gunzip_reads_members_names_and_rejects_damage() {
        let data: Vec<u8> = (0..200_000_u32).map(|n| (n % 251) as u8).collect();
        for level in [0, 1, 6, 9] {
            assert_eq!(gunzip(&gzip(&data, level)).unwrap(), data, "level {level}");
        }
        let mut joined = gzip(b"ab", 6);
        joined.extend(gzip(b"cd", 6));
        assert_eq!(gunzip(&joined).unwrap(), b"abcd");
        // FNAME "a.txt", as `gzip a.txt` writes it.
        let mut named = gzip(b"named", 6);
        named[3] = 8;
        named.splice(10..10, b"a.txt\0".iter().copied());
        assert_eq!(gunzip(&named).unwrap(), b"named");
        let packed = gzip(b"hello hello hello", 6);
        assert_eq!(gunzip(&packed[..packed.len() - 3]).unwrap_err(), END);
        let mut corrupt = packed.clone();
        let at = corrupt.len() - 8;
        corrupt[at] ^= 1;
        assert_eq!(gunzip(&corrupt).unwrap_err(), "incorrect data check");
        assert_eq!(gunzip(b"not gzip").unwrap_err(), "incorrect header check");
        assert_eq!(gunzip(b"").unwrap_err(), END);
    }

    #[test]
    fn deflate_round_trips_at_every_level() {
        let data: Vec<u8> = (0..10_000_u32).map(|n| (n % 251) as u8).collect();
        for level in 0..=9 {
            let packed = deflate(&data, level);
            assert_eq!(packed[0] & 0x0f, 8, "zlib header: deflate method");
            assert_eq!(inflate(&packed).unwrap(), data, "level {level}");
        }
        assert_eq!(
            inflate(&deflate(&[], DEFAULT_LEVEL)).unwrap(),
            Vec::<u8>::new()
        );
    }

    #[test]
    fn inflate_rejects_what_is_not_a_zlib_stream() {
        assert!(inflate(b"not zlib").is_err());
        let packed = deflate(b"hello hello hello", DEFAULT_LEVEL);
        assert!(inflate(&packed[..packed.len() - 2]).is_err(), "truncated");
    }
}
