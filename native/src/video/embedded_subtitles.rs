//! Text subtitle tracks read straight from the container, for backends whose decoder does
//! not hand them out: Matroska (`S_TEXT/UTF8`, `S_TEXT/ASS`, `S_TEXT/SSA`, `S_TEXT/WEBVTT`)
//! and MP4 (`tx3g`, `wvtt`). Payloads of other tracks are skipped by seeking.

use super::text_cues::{Cue, TextTrack, sample_text};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};

type Found = (Vec<TextTrack>, HashMap<u32, Vec<Cue>>);

/// The file's text tracks and all their cues; `None` when it is neither Matroska nor MP4.
/// `matroska`: also read Matroska (every cluster header: the whole file).
pub(crate) fn read<R: Read + Seek>(mut source: R, matroska_too: bool) -> Option<Found> {
    let mut head = [0u8; 8];
    source.read_exact(&mut head).ok()?;
    source.seek(SeekFrom::Start(0)).ok()?;
    if matroska_too && head[..4] == [0x1A, 0x45, 0xDF, 0xA3] {
        return matroska(&mut source);
    }
    if matches!(&head[4..8], b"ftyp" | b"moov" | b"mdat" | b"free" | b"wide") {
        return mp4(&mut source);
    }
    None
}

fn finish(mut tracks: Vec<TextTrack>, mut cues: HashMap<u32, Vec<Cue>>) -> Found {
    for list in cues.values_mut() {
        list.sort_by(|a, b| a.start.total_cmp(&b.start));
    }
    for (number, track) in tracks.iter_mut().enumerate() {
        if track.label.is_empty() {
            track.label = format!("Subtitles {}", number + 1);
        }
    }
    (tracks, cues)
}

// --- Matroska -------------------------------------------------------------------------

/// An EBML variable-size integer: (value without the length marker, its byte length).
fn vint<R: Read>(source: &mut R, keep_marker: bool) -> Option<(u64, usize)> {
    let mut first = [0u8; 1];
    source.read_exact(&mut first).ok()?;
    let length = first[0].leading_zeros() as usize + 1;
    if length > 8 {
        return None;
    }
    let mut value = u64::from(if keep_marker {
        first[0]
    } else {
        (u16::from(first[0]) & (0xFF_u16 >> length)) as u8
    });
    let mut rest = [0u8; 8];
    source.read_exact(&mut rest[..length - 1]).ok()?;
    for byte in &rest[..length - 1] {
        value = (value << 8) | u64::from(*byte);
    }
    Some((value, length))
}

const UNKNOWN: u64 = u64::MAX;

/// An element header: id and data size (`UNKNOWN` for an unknown size).
fn element<R: Read>(source: &mut R) -> Option<(u32, u64)> {
    let (id, _) = vint(source, true)?;
    let (size, length) = vint(source, false)?;
    let all_ones = (1u64 << (7 * length)) - 1;
    Some((id as u32, if size == all_ones { UNKNOWN } else { size }))
}

fn bytes<R: Read>(source: &mut R, size: u64) -> Option<Vec<u8>> {
    if size > 16 << 20 {
        return None;
    }
    let mut data = vec![0u8; size as usize];
    source.read_exact(&mut data).ok()?;
    Some(data)
}

fn uint(data: &[u8]) -> u64 {
    data.iter()
        .fold(0, |value, byte| (value << 8) | u64::from(*byte))
}

struct MkvTrack {
    number: u64,
    kind: u64,
    codec: String,
    language: String,
    name: String,
}

fn matroska<R: Read + Seek>(source: &mut R) -> Option<Found> {
    let end_of_file = source.seek(SeekFrom::End(0)).ok()?;
    source.seek(SeekFrom::Start(0)).ok()?;
    let (_, size) = element(source)?;
    source.seek(SeekFrom::Current(size as i64)).ok()?;
    let (id, size) = element(source)?;
    if id != 0x1853_8067 {
        return None;
    }
    let segment_end = if size == UNKNOWN {
        end_of_file
    } else {
        source.stream_position().ok()? + size
    };
    let mut scale = 1_000_000.0_f64;
    let mut text: HashMap<u64, (String, u32)> = HashMap::new();
    let mut tracks = Vec::new();
    let mut cues: HashMap<u32, Vec<Cue>> = HashMap::new();
    let mut cluster_time = 0u64;
    // Top-level children of the Segment, and the children of Clusters and BlockGroups,
    // are walked flat: their headers are read, everything else is skipped.
    let mut ends: Vec<u64> = vec![segment_end];
    let mut group: Option<(Vec<u8>, Option<u64>)> = None;
    loop {
        let at = source.stream_position().ok()?;
        while ends.last().is_some_and(|end| at >= *end) {
            ends.pop();
            if let Some((block, duration)) = group.take() {
                block_cue(&block, duration, cluster_time, scale, &text, &mut cues);
            }
        }
        if ends.is_empty() || at >= end_of_file {
            break;
        }
        let Some((id, size)) = element(source) else {
            break;
        };
        let start = source.stream_position().ok()?;
        let end = if size == UNKNOWN {
            *ends.last().unwrap()
        } else {
            start + size
        };
        match id {
            // Cluster, BlockGroup: walk inside.
            0x1F43_B675 | 0xA0 => {
                if id == 0xA0 {
                    group = Some((Vec::new(), None));
                }
                ends.push(end);
                continue;
            }
            0xE7 => cluster_time = uint(&bytes(source, size)?),
            0x1549_A966 => {
                let info = bytes(source, size)?;
                let mut cursor = std::io::Cursor::new(&info[..]);
                while let Some((child, length)) = element(&mut cursor) {
                    let data = bytes(&mut cursor, length)?;
                    if child == 0x2A_D7B1 {
                        scale = uint(&data) as f64;
                    }
                }
            }
            0x1654_AE6B => {
                let all = bytes(source, size)?;
                for track in mkv_tracks(&all) {
                    if track.kind != 0x11 || !track.codec.starts_with("S_TEXT/") {
                        continue;
                    }
                    let format = match track.codec.as_str() {
                        "S_TEXT/ASS" | "S_TEXT/SSA" => "ssa",
                        "S_TEXT/WEBVTT" => "webvtt",
                        _ => "text",
                    };
                    let index = track.number as u32;
                    text.insert(track.number, (format.into(), index));
                    tracks.push(TextTrack {
                        index,
                        label: track.name,
                        language: if track.language == "und" {
                            String::new()
                        } else {
                            track.language
                        },
                        enabled: false,
                    });
                }
            }
            // SimpleBlock, or a BlockGroup's Block: only subtitle tracks' payloads are read.
            0xA3 | 0xA1 => {
                let (number, length) = vint(source, false)?;
                if text.contains_key(&number) {
                    let mut block = number.to_be_bytes().to_vec();
                    block.extend(bytes(source, size - length as u64)?);
                    match (&mut group, id) {
                        (Some((slot, _)), 0xA1) => *slot = block,
                        _ => block_cue(&block, None, cluster_time, scale, &text, &mut cues),
                    }
                }
            }
            0x9B => {
                let duration = uint(&bytes(source, size)?);
                if let Some((_, slot)) = &mut group {
                    *slot = Some(duration);
                }
            }
            _ => {}
        }
        source.seek(SeekFrom::Start(end)).ok()?;
    }
    Some(finish(tracks, cues))
}

fn mkv_tracks(data: &[u8]) -> Vec<MkvTrack> {
    let mut out = Vec::new();
    let mut cursor = std::io::Cursor::new(data);
    while let Some((id, size)) = element(&mut cursor) {
        let Some(entry) = bytes(&mut cursor, size) else {
            break;
        };
        if id != 0xAE {
            continue;
        }
        let mut track = MkvTrack {
            number: 0,
            kind: 0,
            codec: String::new(),
            language: "eng".into(),
            name: String::new(),
        };
        let mut fields = std::io::Cursor::new(&entry[..]);
        while let Some((field, length)) = element(&mut fields) {
            let Some(value) = bytes(&mut fields, length) else {
                break;
            };
            let text = || {
                String::from_utf8_lossy(&value)
                    .trim_end_matches('\0')
                    .to_string()
            };
            match field {
                0xD7 => track.number = uint(&value),
                0x83 => track.kind = uint(&value),
                0x86 => track.codec = text(),
                0x22_B59C => track.language = text(),
                0x22_B59D => track.language = text(),
                0x536E => track.name = text(),
                _ => {}
            }
        }
        out.push(track);
    }
    out
}

/// A block (prefixed with its 8-byte track number) as a cue.
fn block_cue(
    block: &[u8],
    duration: Option<u64>,
    cluster_time: u64,
    scale: f64,
    text: &HashMap<u64, (String, u32)>,
    cues: &mut HashMap<u32, Vec<Cue>>,
) {
    if block.len() < 11 {
        return;
    }
    let number = u64::from_be_bytes(block[..8].try_into().unwrap_or_default());
    let Some((format, index)) = text.get(&number) else {
        return;
    };
    let relative = i16::from_be_bytes([block[8], block[9]]);
    let start = (cluster_time as f64 + f64::from(relative)) * scale / 1e9;
    let length = duration.map_or(4.0, |duration| duration as f64 * scale / 1e9);
    let line = sample_text(&block[11..], format);
    if !line.is_empty() {
        cues.entry(*index).or_default().push(Cue {
            start,
            end: start + length.max(0.1),
            text: line,
        });
    }
}

// --- MP4 ------------------------------------------------------------------------------

fn mp4_box<R: Read + Seek>(source: &mut R) -> Option<([u8; 4], u64, u64)> {
    let start = source.stream_position().ok()?;
    let mut head = [0u8; 8];
    source.read_exact(&mut head).ok()?;
    let mut size = u64::from(u32::from_be_bytes(head[..4].try_into().ok()?));
    let mut header = 8;
    if size == 1 {
        let mut large = [0u8; 8];
        source.read_exact(&mut large).ok()?;
        size = u64::from_be_bytes(large);
        header = 16;
    } else if size == 0 {
        size = source.seek(SeekFrom::End(0)).ok()? - start;
        source.seek(SeekFrom::Start(start + 8)).ok()?;
    }
    if size < header {
        return None;
    }
    Some((head[4..8].try_into().ok()?, start + header, start + size))
}

/// The children of a box held in memory: (kind, payload).
fn children(data: &[u8]) -> Vec<([u8; 4], &[u8])> {
    let mut out = Vec::new();
    let mut at = 0;
    while at + 8 <= data.len() {
        let size = u32::from_be_bytes(data[at..at + 4].try_into().unwrap_or_default()) as usize;
        let (size, header) = if size == 1 && at + 16 <= data.len() {
            (
                u64::from_be_bytes(data[at + 8..at + 16].try_into().unwrap_or_default()) as usize,
                16,
            )
        } else if size == 0 {
            (data.len() - at, 8)
        } else {
            (size, 8)
        };
        if size < header || at + size > data.len() {
            break;
        }
        out.push((
            data[at + 4..at + 8].try_into().unwrap_or_default(),
            &data[at + header..at + size],
        ));
        at += size;
    }
    out
}

fn child<'a>(data: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    children(data)
        .into_iter()
        .find(|(name, _)| name == kind)
        .map(|(_, payload)| payload)
}

fn be32(data: &[u8], at: usize) -> u32 {
    data.get(at..at + 4)
        .map_or(0, |b| u32::from_be_bytes(b.try_into().unwrap_or_default()))
}

fn mp4<R: Read + Seek>(source: &mut R) -> Option<Found> {
    let end = source.seek(SeekFrom::End(0)).ok()?;
    source.seek(SeekFrom::Start(0)).ok()?;
    let mut moov = None;
    while source.stream_position().ok()? < end {
        let Some((kind, start, stop)) = mp4_box(source) else {
            break;
        };
        if &kind == b"moov" {
            moov = bytes(source, stop - start);
            break;
        }
        source.seek(SeekFrom::Start(stop)).ok()?;
    }
    let moov = moov?;
    let mut tracks = Vec::new();
    let mut cues: HashMap<u32, Vec<Cue>> = HashMap::new();
    for (kind, trak) in children(&moov) {
        if &kind != b"trak" {
            continue;
        }
        let Some(mdia) = child(trak, b"mdia") else {
            continue;
        };
        let handler = child(mdia, b"hdlr")
            .and_then(|h| h.get(8..12))
            .unwrap_or_default();
        if handler != b"sbtl" && handler != b"text" && handler != b"subt" {
            continue;
        }
        let Some(mdhd) = child(mdia, b"mdhd") else {
            continue;
        };
        let (timescale, packed) = if mdhd.first() == Some(&1) {
            (be32(mdhd, 20), u16::from_be_bytes([mdhd[32], mdhd[33]]))
        } else {
            (
                be32(mdhd, 12),
                u16::from_be_bytes([*mdhd.get(20)?, *mdhd.get(21)?]),
            )
        };
        let language: String = [(packed >> 10) & 31, (packed >> 5) & 31, packed & 31]
            .iter()
            .map(|c| char::from(*c as u8 + 0x60))
            .collect();
        let id = child(trak, b"tkhd").map_or(tracks.len() as u32 + 1, |tkhd| {
            be32(tkhd, if tkhd[0] == 1 { 20 } else { 12 })
        });
        let name = child(trak, b"udta")
            .and_then(|u| child(u, b"name"))
            .map(|n| {
                String::from_utf8_lossy(n)
                    .trim_end_matches('\0')
                    .to_string()
            })
            .unwrap_or_default();
        let Some(stbl) = child(mdia, b"minf").and_then(|m| child(m, b"stbl")) else {
            continue;
        };
        let format = match child(stbl, b"stsd").and_then(|s| s.get(12..16)) {
            Some(b"tx3g") => "text",
            Some(b"wvtt") => "webvtt",
            _ => continue,
        };
        tracks.push(TextTrack {
            index: id,
            label: name,
            language: if language == "und" {
                String::new()
            } else {
                language
            },
            enabled: false,
        });
        let samples = sample_table(stbl);
        let list = cues.entry(id).or_default();
        let scale = f64::from(timescale.max(1));
        for (offset, size, start, duration) in samples {
            if size == 0 || source.seek(SeekFrom::Start(offset)).is_err() {
                continue;
            }
            let Some(data) = bytes(source, u64::from(size)) else {
                continue;
            };
            let line = sample_text(&data, format);
            if !line.is_empty() {
                let start = start as f64 / scale;
                list.push(Cue {
                    start,
                    end: start + (duration as f64 / scale).max(0.1),
                    text: line,
                });
            }
        }
    }
    Some(finish(tracks, cues))
}

/// Every sample of a track: file offset, size, start and duration in timescale units.
fn sample_table(stbl: &[u8]) -> Vec<(u64, u32, u64, u64)> {
    let full = |kind: &[u8; 4]| child(stbl, kind).map(|b| (be32(b, 4) as usize, b));
    let mut sizes = Vec::new();
    if let Some(stsz) = child(stbl, b"stsz") {
        let (fixed, count) = (be32(stsz, 4), be32(stsz, 8) as usize);
        for i in 0..count {
            sizes.push(if fixed != 0 {
                fixed
            } else {
                be32(stsz, 12 + i * 4)
            });
        }
    }
    let mut chunks: Vec<u64> = Vec::new();
    if let Some((count, stco)) = full(b"stco") {
        chunks = (0..count)
            .map(|i| u64::from(be32(stco, 8 + i * 4)))
            .collect();
    } else if let Some((count, co64)) = full(b"co64") {
        chunks = (0..count)
            .map(|i| (u64::from(be32(co64, 8 + i * 8)) << 32) | u64::from(be32(co64, 12 + i * 8)))
            .collect();
    }
    let mut per_chunk = vec![1u32; chunks.len()];
    if let Some((count, stsc)) = full(b"stsc") {
        for e in 0..count {
            let first = be32(stsc, 8 + e * 12) as usize;
            let samples = be32(stsc, 12 + e * 12);
            let next = if e + 1 < count {
                be32(stsc, 8 + (e + 1) * 12) as usize
            } else {
                chunks.len() + 1
            };
            for chunk in first.max(1)..next.min(chunks.len() + 1) {
                per_chunk[chunk - 1] = samples;
            }
        }
    }
    let mut times = Vec::new();
    if let Some((count, stts)) = full(b"stts") {
        let mut t = 0u64;
        for e in 0..count {
            let (n, delta) = (be32(stts, 8 + e * 8), u64::from(be32(stts, 12 + e * 8)));
            for _ in 0..n {
                times.push((t, delta));
                t += delta;
            }
        }
    }
    let mut out = Vec::new();
    let mut sample = 0usize;
    for (chunk, offset) in chunks.iter().enumerate() {
        let mut at = *offset;
        for _ in 0..per_chunk[chunk] {
            let (Some(size), Some((start, duration))) = (sizes.get(sample), times.get(sample))
            else {
                return out;
            };
            out.push((at, *size, *start, *duration));
            at += u64::from(*size);
            sample += 1;
        }
    }
    out
}
