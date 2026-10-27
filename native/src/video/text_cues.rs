//! Subtitle cues every video backend shares: the text of a sample in the formats
//! containers carry (SRT, SSA/ASS, WebVTT, TTML) and the cue showing at a time.
#![cfg_attr(
    not(any(target_os = "windows", target_os = "android")),
    allow(dead_code)
)]

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Cue {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// A text subtitle stream of the file, as `HTMLMediaElement.textTracks` lists it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct TextTrack {
    pub index: u32,
    pub label: String,
    pub language: String,
    pub enabled: bool,
}

impl TextTrack {
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub(crate) fn json(tracks: &[TextTrack]) -> serde_json::Value {
        serde_json::Value::Array(
            tracks
                .iter()
                .map(|track| {
                    serde_json::json!({"id": track.index, "label": track.label, "language": track.language, "enabled": track.enabled})
                })
                .collect(),
        )
    }
}

/// Drops markup: `<i>`, `</font>`, ASS override blocks `{\an8}`; `\N` is a line break.
pub(crate) fn clean(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut tag: Option<char> = None;
    for c in text
        .replace("\\N", "\n")
        .replace("\\n", "\n")
        .replace("\\h", " ")
        .chars()
    {
        match (tag, c) {
            (None, '<') => tag = Some('>'),
            (None, '{') => tag = Some('}'),
            (Some(end), c) if c == end => tag = None,
            (Some(_), _) => {}
            (None, c) => out.push(c),
        }
    }
    out.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// The text of one subtitle sample: `ssa` (a Matroska ASS line: fields before the text,
/// or a whole `Dialogue:` line), `webvtt` (MP4 `vttc` boxes or plain cue text), `xml`
/// (TTML), anything else plain text (SRT, tx3g with its length prefix).
pub(crate) fn sample_text(bytes: &[u8], format: &str) -> String {
    match format {
        "ssa" => {
            let line = String::from_utf8_lossy(bytes);
            let (line, fields) = match line.strip_prefix("Dialogue:") {
                Some(rest) => (rest.to_string(), 9),
                None => (line.to_string(), 8),
            };
            clean(line.splitn(fields + 1, ',').nth(fields).unwrap_or_default())
        }
        "webvtt" => {
            let boxes = mp4_boxes(bytes, b"payl");
            if boxes.is_empty() && bytes.len() >= 8 && &bytes[4..8] == b"vtte" {
                return String::new();
            }
            let text = if boxes.is_empty() {
                String::from_utf8_lossy(bytes).into_owned()
            } else {
                boxes.join("\n")
            };
            clean(&text)
        }
        "xml" => clean(
            &String::from_utf8_lossy(bytes)
                .replace("<br/>", "\n")
                .replace("<br />", "\n"),
        ),
        _ => {
            // tx3g: a 16-bit length, the text, then style boxes.
            if bytes.len() >= 2 {
                let length = usize::from(u16::from_be_bytes([bytes[0], bytes[1]]));
                if length + 2 <= bytes.len() && !bytes[..2].iter().all(u8::is_ascii_graphic) {
                    return clean(&String::from_utf8_lossy(&bytes[2..2 + length]));
                }
            }
            clean(&String::from_utf8_lossy(bytes))
        }
    }
}

/// The payloads of every `kind` box found walking `bytes` (one level of nesting).
fn mp4_boxes(bytes: &[u8], kind: &[u8; 4]) -> Vec<String> {
    let mut out = Vec::new();
    let mut at = 0;
    while at + 8 <= bytes.len() {
        let size =
            u32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]) as usize;
        if size < 8 || at + size > bytes.len() {
            break;
        }
        let name = &bytes[at + 4..at + 8];
        if name == kind {
            out.push(String::from_utf8_lossy(&bytes[at + 8..at + size]).into_owned());
        } else if name == b"vttc" {
            out.extend(mp4_boxes(&bytes[at + 8..at + size], kind));
        }
        at += size;
    }
    out
}

/// The text of the cues showing at `time` (sorted by start).
pub(crate) fn cue_text_at(cues: &[Cue], time: f64) -> String {
    let end = cues.partition_point(|cue| cue.start <= time);
    let mut shown: Vec<&str> = cues[..end]
        .iter()
        .rev()
        .take(8)
        .filter(|cue| cue.end > time)
        .map(|cue| cue.text.as_str())
        .collect();
    shown.reverse();
    shown.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn container_subtitle_samples_become_plain_text() {
        assert_eq!(
            sample_text(b"<i>Ol\xc3\xa1</i>\r\nmundo", "text"),
            "Olá\nmundo"
        );
        assert_eq!(
            sample_text(b"12,0,Default,,0,0,0,,{\\an8}Hello\\Nworld, again", "ssa"),
            "Hello\nworld, again"
        );
        assert_eq!(
            sample_text(
                b"Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hi",
                "ssa"
            ),
            "Hi"
        );
        let mut vttc = Vec::new();
        vttc.extend_from_slice(&19u32.to_be_bytes());
        vttc.extend_from_slice(b"vttc");
        vttc.extend_from_slice(&11u32.to_be_bytes());
        vttc.extend_from_slice(b"payl");
        vttc.extend_from_slice(b"Bom");
        assert_eq!(sample_text(&vttc, "webvtt"), "Bom");
        assert_eq!(sample_text(b"\x00\x05Hello", "text"), "Hello");
        assert_eq!(sample_text(b"<p>a<br/>b</p>", "xml"), "a\nb");
        let cues = vec![
            Cue {
                start: 1.0,
                end: 2.0,
                text: "a".into(),
            },
            Cue {
                start: 1.5,
                end: 3.0,
                text: "b".into(),
            },
        ];
        assert_eq!(cue_text_at(&cues, 1.7), "a\nb");
        assert_eq!(cue_text_at(&cues, 2.5), "b");
        assert_eq!(cue_text_at(&cues, 0.5), "");
    }
}
