use super::super::{
    MAX_QUEUED, RECORD_HEADER, close, com_object, poll, post, slot_of, take_dropped, test_turn,
};
use super::*;

/// (id, args, segments as (arg, tag, data)) of the tagged records of `id` left in the queue.
type Call = ([u64; ARGS], Vec<(u8, u8, Vec<u8>)>);

fn calls_of(id: u32) -> Vec<Call> {
    let mut out = vec![0u8; 4 << 20];
    let written = poll(&mut out).unwrap();
    let bytes = &out[..written];
    let mut calls = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let word = |start: usize| u32::from_le_bytes(bytes[start..start + 4].try_into().unwrap());
        let (record_id, length) = (word(at), word(at + 4));
        let len = (length & !TAGGED) as usize;
        let mut args = [0u64; ARGS];
        for (index, arg) in args.iter_mut().enumerate() {
            let start = at + 8 + index * 8;
            *arg = u64::from_le_bytes(bytes[start..start + 8].try_into().unwrap());
        }
        if record_id == id {
            assert_ne!(length & TAGGED, 0, "a marshalled call's record is tagged");
            let mut segments = Vec::new();
            let (mut cursor, end) = (at + RECORD_HEADER, at + RECORD_HEADER + len);
            while cursor < end {
                let size = word(cursor + 4) as usize;
                let data = bytes[cursor + 8..cursor + 8 + size].to_vec();
                segments.push((bytes[cursor], bytes[cursor + 1], data));
                cursor += 8 + size;
            }
            calls.push((args, segments));
        }
        at += RECORD_HEADER + len;
    }
    calls
}

type Four = extern "C" fn(u64, u64, u64, u64) -> u64;

fn entry(address: u64) -> Four {
    // SAFETY: the address is one of ENTRIES.
    unsafe { std::mem::transmute::<usize, Four>(address as usize) }
}

/// A COM object from [`com_object`] holding one reference.
fn object() -> u64 {
    com_object(vec![], &[1]).unwrap()
}

fn refs(object: u64) -> u32 {
    // SAFETY: a live object; AddRef then Release leaves the count as it was.
    unsafe { vtable_call(object, 1) };
    release_object(object).unwrap()
}

#[test]
fn keeps_interfaces_and_copies_bytes_per_argument() {
    let _turn = test_turn();
    let address = create(7101, 5, &[(RAW, 0), (COM, 0), (BYTES, 3), (COM, 0)]).unwrap();
    let sender = object();
    let data = [4u8, 5, 6, 7];
    let pointer = data.as_ptr() as usize as u64;
    let function = entry(address);
    let result = std::thread::spawn(move || function(9, sender, pointer, 0))
        .join()
        .unwrap();
    assert_eq!(result, 5);
    assert_eq!(refs(sender), 2, "the call holds a reference");
    assert!(close(address));
    let calls = calls_of(7101);
    assert_eq!(calls.len(), 1);
    assert_eq!((calls[0].0[0], calls[0].0[1]), (9, sender));
    assert_eq!(
        calls[0].1,
        vec![
            (1, OBJECT, sender.to_le_bytes().to_vec()),
            (2, DATA, vec![4, 5, 6]),
            (3, NULL, vec![]),
        ]
    );
    assert_eq!(release_object(sender).unwrap(), 1);
    assert_eq!(release_object(sender).unwrap(), 0);
    assert!(release_object(0).is_err());
}

#[test]
fn a_full_queue_drops_the_call_and_its_references() {
    let _turn = test_turn();
    let plain = super::super::create(7102, 0, NO_COPY, 0).unwrap();
    let address = create(7103, 0, &[(COM, 0)]).unwrap();
    let sender = object();
    let _ = take_dropped();
    for _ in 0..MAX_QUEUED {
        post(slot_of(plain).unwrap(), [0; ARGS], &[]);
    }
    entry(address)(sender, 0, 0, 0);
    assert_eq!(refs(sender), 1, "the dropped call released what it kept");
    assert!(take_dropped() >= 1);
    close(plain);
    close(address);
    calls_of(0);
    assert_eq!(release_object(sender).unwrap(), 0);
}

#[test]
fn refuses_unknown_kinds_lengths_and_too_many_arguments() {
    let _turn = test_turn();
    assert!(create(1, 0, &[(9, 0)]).unwrap_err().contains("kind"));
    assert!(create(1, 0, &[(BYTES, 0)]).is_err());
    assert!(create(1, 0, &[(BYTES, MAX_COPY + 1)]).is_err());
    assert!(create(1, 0, &[(RAW, 0); ARGS + 1]).is_err());
    let windows = create(1, 0, &[(BSTR, 0)]);
    assert_eq!(windows.is_ok(), cfg!(target_os = "windows"));
    if let Ok(address) = windows {
        close(address);
    } else {
        assert!(windows.unwrap_err().contains("only available on Windows"));
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use super::*;

    /// A BSTR: its byte length, then UTF-16 units and a terminator. The pointer is past the length.
    fn bstr(text: &str) -> Vec<u16> {
        let units: Vec<u16> = text.encode_utf16().collect();
        let bytes = (units.len() * 2) as u32;
        let mut buffer = vec![bytes as u16, (bytes >> 16) as u16];
        buffer.extend(units);
        buffer.push(0);
        buffer
    }

    fn at(buffer: &[u16]) -> u64 {
        buffer[2..].as_ptr() as usize as u64
    }

    fn variant(vt: u16, value: u64) -> [u8; 24] {
        let mut bytes = [0u8; 24];
        bytes[..2].copy_from_slice(&vt.to_le_bytes());
        bytes[8..16].copy_from_slice(&value.to_le_bytes());
        bytes
    }

    #[test]
    fn copies_bstrs_and_variants_during_the_call() {
        let _turn = test_turn();
        let address = create(7104, 0, &[(BSTR, 0), (VARIANT, 0)]).unwrap();
        let name = bstr("Barra é 😀");
        let text = bstr("valor");
        let unknown = object();
        let date = variant(7, 2.5f64.to_bits());
        let cases: Vec<([u8; 24], u8, Vec<u8>)> = vec![
            (
                variant(3, (-5i32) as u32 as u64),
                NUMBER,
                (-5f64).to_le_bytes().to_vec(),
            ),
            (variant(2, 0xfffe), NUMBER, (-2f64).to_le_bytes().to_vec()),
            (
                variant(19, 0xffff_ffff),
                NUMBER,
                4294967295f64.to_le_bytes().to_vec(),
            ),
            (
                variant(5, 2.5f64.to_bits()),
                NUMBER,
                2.5f64.to_le_bytes().to_vec(),
            ),
            (variant(11, 0xffff), BOOLEAN, vec![1]),
            (variant(11, 0), BOOLEAN, vec![0]),
            (variant(0, 0), NULL, vec![]),
            (variant(8, at(&text)), TEXT, b"valor".to_vec()),
            (variant(8, 0), TEXT, vec![]),
            (variant(13, unknown), OBJECT, unknown.to_le_bytes().to_vec()),
            (variant(9, 0), NULL, vec![]),
            (date, RAW_VARIANT, date.to_vec()),
        ];
        for (value, _, _) in &cases {
            entry(address)(at(&name), value.as_ptr() as usize as u64, 0, 0);
        }
        entry(address)(0, 0, 0, 0);
        assert!(close(address));
        assert_eq!(refs(unknown), 2, "VT_UNKNOWN is kept like a COM argument");
        let calls = calls_of(7104);
        assert_eq!(calls.len(), cases.len() + 1);
        for ((_, segments), (_, tag, data)) in calls.iter().zip(&cases) {
            assert_eq!(segments[0], (0, TEXT, "Barra é 😀".as_bytes().to_vec()));
            assert_eq!(segments[1], (1, *tag, data.clone()));
        }
        assert_eq!(
            calls[cases.len()].1,
            vec![(0, NULL, vec![]), (1, NULL, vec![])]
        );
        assert_eq!(release_object(unknown).unwrap(), 1);
        assert_eq!(release_object(unknown).unwrap(), 0);
    }
}
