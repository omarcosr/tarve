//! Per-argument marshalling for threadsafe callbacks (native ABI 9): what a call does with an
//! argument before it returns, because its caller frees or releases what it names afterwards.
//! [`COM`] AddRefs an interface pointer (JavaScript releases it: `releaseCom`, or
//! `tarve_unknown_release`); [`BYTES`] copies a fixed length (the `copy` option, per argument). On
//! Windows, [`BSTR`] copies a BSTR as UTF-8 and [`VARIANT`] a VARIANT as a typed value. A VARIANT
//! passed by value arrives as a pointer too: it is 24 bytes, and the x64 and arm64 Windows calling
//! conventions pass any struct over 8 (x64) or 16 (arm64) bytes as a pointer to a caller's copy.
//!
//! A marshalled call's record sets [`TAGGED`] in its copied length. Its copied bytes are segments,
//! one per marshalled argument, in order: argument index (u8), tag (u8), 2 zero bytes, data length
//! (u32 LE), data. Segments describe themselves, so JavaScript can release the references of a
//! record no callback takes, and [`dispatch`] releases them itself when the queue is full.
use super::{ACTIVE, ARGS, MAX_COPY, NO_COPY, Slot, open_slot, push, record};
use std::sync::atomic::Ordering;

/// Argument kinds (4 bits each in a slot's `kinds`).
pub(crate) const RAW: u32 = 0;
pub(crate) const BYTES: u32 = 1;
pub(crate) const COM: u32 = 2;
pub(crate) const BSTR: u32 = 3;
pub(crate) const VARIANT: u32 = 4;
/// Set in a record's copied length when its copied bytes are segments.
pub(crate) const TAGGED: u32 = 0x8000_0000;

/// Segment tags (TEXT and on only come from Windows' BSTR and VARIANT).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
mod tag {
    pub(super) const NULL: u8 = 0;
    pub(super) const DATA: u8 = 1;
    pub(super) const OBJECT: u8 = 2;
    pub(super) const TEXT: u8 = 3;
    pub(super) const NUMBER: u8 = 4;
    pub(super) const BOOLEAN: u8 = 5;
    pub(super) const RAW_VARIANT: u8 = 6;
}
use tag::*;

/// A VARIANT on 64-bit Windows: vt (u16), 3 reserved u16, a 16-byte union.
#[cfg(target_os = "windows")]
const VARIANT_SIZE: usize = 24;
/// The most bytes of one BSTR copied (longer ones are cut).
#[cfg(target_os = "windows")]
const MAX_STRING: usize = 1 << 20;

fn kind(kinds: u32, arg: usize) -> u32 {
    (kinds >> (arg * 4)) & 0xf
}

/// Opens a callback whose arguments are marshalled per `specs` (kind, byte length for [`BYTES`]).
pub(crate) fn create(id: u32, returns: u64, specs: &[(u32, u32)]) -> Result<u64, String> {
    if specs.len() > ARGS {
        return Err(format!(
            "A threadsafe callback takes at most {ARGS} arguments"
        ));
    }
    let mut kinds = 0;
    let mut lens = [0; ARGS];
    for (arg, &(kind, len)) in specs.iter().enumerate() {
        match kind {
            RAW | COM => {}
            BYTES if (1..=MAX_COPY).contains(&len) => lens[arg] = len,
            BYTES => {
                return Err(format!(
                    "A threadsafe callback copies 1 to {MAX_COPY} bytes per argument"
                ));
            }
            BSTR | VARIANT if cfg!(target_os = "windows") => {}
            BSTR | VARIANT => {
                return Err(
                    "Threadsafe BSTR and VARIANT arguments are only available on Windows".into(),
                );
            }
            _ => return Err(format!("Unknown threadsafe argument kind {kind}")),
        }
        kinds |= kind << (arg * 4);
    }
    open_slot(id, returns, NO_COPY, 0, kinds, lens)
}

/// A call of a slot with marshalled arguments (or one reopened as plain since the caller looked).
pub(super) fn dispatch(slot: &Slot, args: [u64; ARGS]) -> u64 {
    let mut returns = slot.returns.load(Ordering::Acquire);
    // Paired with close(): either this call sees the slot closing, or close() waits for it.
    slot.busy.fetch_add(1, Ordering::SeqCst);
    let open = slot.state.load(Ordering::SeqCst) == ACTIVE;
    let kinds = slot.kinds.load(Ordering::Acquire);
    if open && kinds != 0 {
        returns = slot.returns.load(Ordering::Acquire);
        let id = slot.id.load(Ordering::Acquire);
        let mut payload = Vec::new();
        let mut held = Vec::new();
        for (arg, &value) in args.iter().enumerate() {
            let kind = kind(kinds, arg);
            if kind != RAW {
                let len = slot.lens[arg].load(Ordering::Acquire);
                // SAFETY: the callback's creator declared what this argument holds during the call.
                unsafe { encode(&mut payload, &mut held, arg, kind, len, value) };
            }
        }
        if !push(record(id, args, &payload, TAGGED)) {
            for object in held {
                // SAFETY: the reference this call took.
                unsafe { vtable_call(object, 2) };
            }
        }
    }
    slot.busy.fetch_sub(1, Ordering::SeqCst);
    if open && kinds == 0 {
        return super::dispatch_plain(slot, args);
    }
    returns
}

fn segment(out: &mut Vec<u8>, arg: usize, tag: u8, data: &[u8]) {
    out.extend_from_slice(&[arg as u8, tag, 0, 0]);
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(data);
}

/// # Safety
/// `value` is what `kind` says: `len` readable bytes, a live interface pointer, a BSTR, a VARIANT.
unsafe fn encode(
    out: &mut Vec<u8>,
    held: &mut Vec<u64>,
    arg: usize,
    kind: u32,
    len: u32,
    value: u64,
) {
    if value == 0 {
        return segment(out, arg, NULL, &[]);
    }
    let address = value as usize;
    match kind {
        BYTES => segment(out, arg, DATA, unsafe {
            std::slice::from_raw_parts(address as *const u8, len as usize)
        }),
        COM => {
            unsafe { vtable_call(value, 1) };
            held.push(value);
            segment(out, arg, OBJECT, &value.to_le_bytes());
        }
        #[cfg(target_os = "windows")]
        BSTR => segment(out, arg, TEXT, unsafe { bstr(address) }.as_bytes()),
        #[cfg(target_os = "windows")]
        VARIANT => unsafe { variant(out, held, arg, address) },
        _ => segment(out, arg, NULL, &[]),
    }
}

/// A BSTR's text (its length prefix, as SysStringLen reads it), unpaired surrogates replaced.
#[cfg(target_os = "windows")]
unsafe fn bstr(address: usize) -> String {
    let bytes = unsafe { (address as *const u32).sub(1).read_unaligned() } as usize;
    let units =
        unsafe { std::slice::from_raw_parts(address as *const u16, bytes.min(MAX_STRING) / 2) };
    String::from_utf16_lossy(units)
}

#[cfg(target_os = "windows")]
unsafe fn variant(out: &mut Vec<u8>, held: &mut Vec<u64>, arg: usize, address: usize) {
    let vt = unsafe { (address as *const u16).read_unaligned() };
    let data = address + 8;
    // SAFETY (all reads): a VARIANT is VARIANT_SIZE readable bytes; vt says what its union holds.
    let number = unsafe {
        match vt {
            2 => Some((data as *const i16).read_unaligned() as f64),
            3 | 22 => Some((data as *const i32).read_unaligned() as f64),
            4 => Some((data as *const f32).read_unaligned() as f64),
            5 => Some((data as *const f64).read_unaligned()),
            16 => Some((data as *const i8).read_unaligned() as f64),
            17 => Some((data as *const u8).read_unaligned() as f64),
            18 => Some((data as *const u16).read_unaligned() as f64),
            19 | 23 => Some((data as *const u32).read_unaligned() as f64),
            _ => None,
        }
    };
    if let Some(number) = number {
        return segment(out, arg, NUMBER, &number.to_le_bytes());
    }
    match vt {
        // VT_EMPTY, VT_NULL
        0 | 1 => segment(out, arg, NULL, &[]),
        // VT_BOOL: VARIANT_TRUE is -1
        11 => {
            let value = unsafe { (data as *const i16).read_unaligned() };
            segment(out, arg, BOOLEAN, &[u8::from(value != 0)]);
        }
        // VT_BSTR: a null BSTR is the empty string
        8 => {
            let text = match unsafe { (data as *const usize).read_unaligned() } {
                0 => String::new(),
                pointer => unsafe { bstr(pointer) },
            };
            segment(out, arg, TEXT, text.as_bytes());
        }
        // VT_DISPATCH, VT_UNKNOWN
        9 | 13 => match unsafe { (data as *const u64).read_unaligned() } {
            0 => segment(out, arg, NULL, &[]),
            object => {
                unsafe { vtable_call(object, 1) };
                held.push(object);
                segment(out, arg, OBJECT, &object.to_le_bytes());
            }
        },
        _ => segment(out, arg, RAW_VARIANT, unsafe {
            std::slice::from_raw_parts(address as *const u8, VARIANT_SIZE)
        }),
    }
}

/// IUnknown::AddRef (`index` 1) or Release (2) of an interface pointer: the count it returns.
///
/// # Safety
/// `object` is a live COM interface pointer.
unsafe fn vtable_call(object: u64, index: usize) -> u32 {
    type Count = extern "system" fn(u64) -> u32;
    let method: Count = unsafe {
        let vtable = *(object as usize as *const *const usize);
        std::mem::transmute::<usize, Count>(*vtable.add(index))
    };
    method(object)
}

/// Releases a reference a marshalled call took (or any interface pointer): the count left.
pub(crate) fn release_object(object: u64) -> Result<u32, String> {
    if object == 0 {
        return Err("Null COM pointer".into());
    }
    // SAFETY: the caller hands a reference it owns.
    Ok(unsafe { vtable_call(object, 2) })
}

/// Opens a threadsafe callback whose arguments are marshalled: `specs` holds `count` (at most 6)
/// pairs of u32 LE, kind (0 raw, 1 bytes, 2 COM, 3 BSTR, 4 VARIANT) and byte length (for bytes).
/// Records of its calls set the high bit of their copied length; see native/src/threadsafe/marshal.rs.
/// The entry's address, or 0 (tarve_last_error says why).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tarve_threadsafe_callback_args(
    id: u32,
    returns: u64,
    specs: *const u8,
    count: u32,
) -> u64 {
    let opened = (|| {
        if count as usize > ARGS {
            return Err(format!(
                "A threadsafe callback takes at most {ARGS} arguments"
            ));
        }
        if specs.is_null() && count > 0 {
            return Err("Null threadsafe argument specs".to_string());
        }
        let bytes: &[u8] = if count == 0 {
            &[]
        } else {
            // SAFETY: the caller passes `count` pairs of u32.
            unsafe { std::slice::from_raw_parts(specs, count as usize * 8) }
        };
        let specs: Vec<(u32, u32)> = bytes
            .as_chunks::<8>()
            .0
            .iter()
            .map(|pair| {
                let [k0, k1, k2, k3, l0, l1, l2, l3] = *pair;
                (
                    u32::from_le_bytes([k0, k1, k2, k3]),
                    u32::from_le_bytes([l0, l1, l2, l3]),
                )
            })
            .collect();
        create(id, returns, &specs)
    })();
    opened.unwrap_or_else(|message| {
        crate::bridge::entry_points::set_last_error(message);
        0
    })
}

/// IUnknown::Release on `object` (a reference a marshalled call kept): the count left, or -1.
#[unsafe(no_mangle)]
pub extern "C" fn tarve_unknown_release(object: u64) -> i32 {
    match release_object(object) {
        Ok(left) => left as i32,
        Err(message) => {
            crate::bridge::entry_points::set_last_error(message);
            -1
        }
    }
}

#[cfg(test)]
#[path = "marshal_tests.rs"]
mod tests;
