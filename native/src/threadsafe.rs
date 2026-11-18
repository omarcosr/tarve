//! Threadsafe callbacks for JavaScript FFI (`threadsafeCallback` in @tarve/core): C function
//! pointers that any thread may call (a COM or WinRT event, a thread pool wait, an audio thread).
//! A call never runs JavaScript on the calling thread: it records the arguments (and, when asked,
//! a copy of the bytes one of them points to), queues them, wakes the JavaScript thread through a
//! pipe and returns a fixed value at once. JavaScript then takes the queue
//! (`tarve_threadsafe_poll`) and runs the callbacks on its own thread, in call order. The same
//! model as bun:ffi's `JSCallback({ threadsafe: true })`, for Bun, Node.js and txiki.js alike.
//!
//! Each callback is one of a fixed set of entry points (no code is generated at run time). An
//! entry takes up to [`ARGS`] integer or pointer arguments; floating-point arguments are not
//! captured. [`com_object`] builds a COM object whose IUnknown runs natively (QueryInterface must
//! answer synchronously) and whose other methods are such callbacks. [`marshal`] keeps or copies
//! what an argument names (an interface pointer, a BSTR, a VARIANT) per argument.
use crate::bridge::WakePipe;
use std::{
    collections::VecDeque,
    ffi::c_void,
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicU32, AtomicU64, Ordering},
    },
};

mod marshal;

/// Callbacks that can be open at once.
pub(crate) const SLOTS: usize = 128;
/// Integer or pointer arguments an entry records.
pub(crate) const ARGS: usize = 6;
/// Calls kept while JavaScript does not take them; later ones are dropped (and counted).
const MAX_QUEUED: usize = 16 * 1024;
/// The most bytes one call copies from the memory an argument points to.
pub(crate) const MAX_COPY: u32 = 64 * 1024;
/// A record: id (u32), copied length (u32), the arguments (u64 each), the copied bytes.
pub(crate) const RECORD_HEADER: usize = 8 + ARGS * 8;

const FREE: u32 = 0;
const ACTIVE: u32 = 1;
const RESERVED: u32 = 2;
const NO_COPY: u32 = u32::MAX;

struct Slot {
    state: AtomicU32,
    id: AtomicU32,
    returns: AtomicU64,
    copy_arg: AtomicU32,
    copy_len: AtomicU32,
    /// [`marshal`] kinds, 4 bits per argument; 0 for none (the plain path).
    kinds: AtomicU32,
    lens: [AtomicU32; ARGS],
    /// Marshalled calls in flight: [`close`] waits for them, so none queues after it.
    busy: AtomicU32,
}

#[allow(clippy::declare_interior_mutable_const)]
const EMPTY: Slot = Slot {
    state: AtomicU32::new(FREE),
    id: AtomicU32::new(0),
    returns: AtomicU64::new(0),
    copy_arg: AtomicU32::new(NO_COPY),
    copy_len: AtomicU32::new(0),
    kinds: AtomicU32::new(0),
    lens: [const { AtomicU32::new(0) }; ARGS],
    busy: AtomicU32::new(0),
};
static TABLE: [Slot; SLOTS] = [EMPTY; SLOTS];

struct Calls {
    queue: Mutex<VecDeque<Vec<u8>>>,
    wake: Mutex<Option<WakePipe>>,
    dropped: AtomicU64,
}

fn calls() -> &'static Calls {
    static CALLS: OnceLock<Calls> = OnceLock::new();
    CALLS.get_or_init(|| Calls {
        queue: Mutex::new(VecDeque::new()),
        wake: Mutex::new(None),
        dropped: AtomicU64::new(0),
    })
}

type Entry = extern "C" fn(u64, u64, u64, u64, u64, u64) -> u64;

/// One entry per slot. Declared with every argument an entry records: a caller passing fewer
/// leaves the rest as whatever its registers or stack slots hold, which JavaScript ignores (on
/// Windows x64 the extra ones are read from the caller's own frame, always mapped).
extern "C" fn entry<const K: usize>(a0: u64, a1: u64, a2: u64, a3: u64, a4: u64, a5: u64) -> u64 {
    dispatch(K, [a0, a1, a2, a3, a4, a5])
}

macro_rules! entries {
    ($($k:literal)*) => { [$(entry::<$k> as Entry),*] };
}
static ENTRIES: [Entry; SLOTS] = entries!(
    0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31
    32 33 34 35 36 37 38 39 40 41 42 43 44 45 46 47 48 49 50 51 52 53 54 55 56 57 58 59 60 61 62 63
    64 65 66 67 68 69 70 71 72 73 74 75 76 77 78 79 80 81 82 83 84 85 86 87 88 89 90 91 92 93 94 95
    96 97 98 99 100 101 102 103 104 105 106 107 108 109 110 111 112 113 114 115 116 117 118 119
    120 121 122 123 124 125 126 127
);

fn dispatch(index: usize, args: [u64; ARGS]) -> u64 {
    let slot = &TABLE[index];
    if slot.kinds.load(Ordering::Acquire) != 0 {
        return marshal::dispatch(slot, args);
    }
    dispatch_plain(slot, args)
}

fn dispatch_plain(slot: &Slot, args: [u64; ARGS]) -> u64 {
    let returns = slot.returns.load(Ordering::Acquire);
    let id = slot.id.load(Ordering::Acquire);
    // A slot closed (or closed and opened again) during the call records nothing for its old id.
    if slot.state.load(Ordering::Acquire) != ACTIVE || slot.id.load(Ordering::Acquire) != id {
        return returns;
    }
    let (copy_arg, copy_len) = (
        slot.copy_arg.load(Ordering::Acquire),
        slot.copy_len.load(Ordering::Acquire),
    );
    let copied: &[u8] = match args.get(copy_arg as usize) {
        Some(&address) if address != 0 && copy_len > 0 => {
            // SAFETY: the callback's creator promised `copy_len` readable bytes at this argument
            // for the length of the call (the point of copying them now).
            unsafe { std::slice::from_raw_parts(address as usize as *const u8, copy_len as usize) }
        }
        _ => &[],
    };
    push(record(id, args, copied, 0));
    returns
}

/// `flag` is ORed into the copied length ([`marshal::TAGGED`] for a marshalled call's segments).
fn record(id: u32, args: [u64; ARGS], copied: &[u8], flag: u32) -> Vec<u8> {
    let mut record = Vec::with_capacity(RECORD_HEADER + copied.len());
    record.extend_from_slice(&id.to_le_bytes());
    record.extend_from_slice(&(copied.len() as u32 | flag).to_le_bytes());
    for value in args {
        record.extend_from_slice(&value.to_le_bytes());
    }
    record.extend_from_slice(copied);
    record
}

/// The slot of the callback whose entry is at `address`, for [`post`].
pub(crate) fn slot_of(address: u64) -> Option<usize> {
    ENTRIES
        .iter()
        .position(|entry| *entry as usize as u64 == address)
}

/// Queues a call of callback slot `index` from Rust (a native producer such as
/// native/src/message_window.rs) with `bytes` as its copied data, of any length up to
/// [`MAX_COPY`] (longer is cut): the same record, queue, order and wake-up as a call through its
/// entry. False when the slot is not open.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn post(index: usize, args: [u64; ARGS], bytes: &[u8]) -> bool {
    let Some(slot) = TABLE.get(index) else {
        return false;
    };
    let id = slot.id.load(Ordering::Acquire);
    if slot.state.load(Ordering::Acquire) != ACTIVE {
        return false;
    }
    push(record(
        id,
        args,
        &bytes[..bytes.len().min(MAX_COPY as usize)],
        0,
    ));
    true
}

/// Queues a record: false when the queue was full and it was dropped (and counted).
fn push(record: Vec<u8>) -> bool {
    let calls = calls();
    let was_empty = {
        let mut queue = calls.queue.lock().unwrap_or_else(|p| p.into_inner());
        if queue.len() >= MAX_QUEUED {
            calls.dropped.fetch_add(1, Ordering::Relaxed);
            return false;
        }
        let was_empty = queue.is_empty();
        queue.push_back(record);
        was_empty
    };
    if was_empty
        && let Some(wake) = calls
            .wake
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_mut()
    {
        wake.signal();
    }
    true
}

/// A new wake pipe (the previous one closes): JavaScript connects to its name and drains the
/// queue whenever a byte arrives, and once right after connecting.
pub(crate) fn pipe_name() -> Result<String, String> {
    let pipe = WakePipe::new()?;
    let name = pipe.name().to_owned();
    *calls().wake.lock().unwrap_or_else(|p| p.into_inner()) = Some(pipe);
    Ok(name)
}

/// Opens a slot for callback `id`: the entry's address. `copy_arg` is the argument whose
/// pointed-to `copy_len` bytes each call copies (`u32::MAX` for none).
pub(crate) fn create(id: u32, returns: u64, copy_arg: u32, copy_len: u32) -> Result<u64, String> {
    if copy_arg != NO_COPY && copy_arg as usize >= ARGS {
        return Err(format!(
            "A threadsafe callback copies from one of its first {ARGS} arguments"
        ));
    }
    if copy_len > MAX_COPY {
        return Err(format!(
            "A threadsafe callback copies at most {MAX_COPY} bytes per call"
        ));
    }
    open_slot(id, returns, copy_arg, copy_len, 0, [0; ARGS])
}

fn open_slot(
    id: u32,
    returns: u64,
    copy_arg: u32,
    copy_len: u32,
    kinds: u32,
    lens: [u32; ARGS],
) -> Result<u64, String> {
    for (index, slot) in TABLE.iter().enumerate() {
        if slot
            .state
            .compare_exchange(FREE, RESERVED, Ordering::AcqRel, Ordering::Relaxed)
            .is_ok()
        {
            slot.id.store(id, Ordering::Release);
            slot.returns.store(returns, Ordering::Release);
            slot.copy_arg.store(copy_arg, Ordering::Release);
            slot.copy_len.store(
                if copy_arg == NO_COPY { 0 } else { copy_len },
                Ordering::Release,
            );
            for (len, value) in slot.lens.iter().zip(lens) {
                len.store(value, Ordering::Release);
            }
            slot.kinds.store(kinds, Ordering::Release);
            slot.state.store(ACTIVE, Ordering::Release);
            return Ok(ENTRIES[index] as usize as u64);
        }
    }
    Err(format!(
        "All {SLOTS} threadsafe callbacks are open: close() the ones no longer needed"
    ))
}

/// Closes the slot whose entry is at `address`. Later calls to it return its fixed value and
/// record nothing, so a native caller that still holds the address stays safe. A marshalled call
/// already past its check finishes first, so every record of the slot is queued once this returns.
pub(crate) fn close(address: u64) -> bool {
    let Some(index) = slot_of(address) else {
        return false;
    };
    let slot = &TABLE[index];
    if slot
        .state
        .compare_exchange(ACTIVE, RESERVED, Ordering::SeqCst, Ordering::Relaxed)
        .is_err()
    {
        return false;
    }
    while slot.busy.load(Ordering::SeqCst) != 0 {
        std::thread::yield_now();
    }
    slot.state.store(FREE, Ordering::Release);
    true
}

/// Moves queued calls into `out` (whole records, in order) while they fit. Ok(bytes written,
/// 0 when none); Err(bytes the first record needs) when not even that one fits.
pub(crate) fn poll(out: &mut [u8]) -> Result<usize, usize> {
    let mut queue = calls().queue.lock().unwrap_or_else(|p| p.into_inner());
    let mut written = 0;
    while let Some(record) = queue.front() {
        if written + record.len() > out.len() {
            if written == 0 {
                return Err(record.len());
            }
            break;
        }
        out[written..written + record.len()].copy_from_slice(record);
        written += record.len();
        queue.pop_front();
    }
    Ok(written)
}

/// Calls dropped because the queue was full, since the last ask.
pub(crate) fn take_dropped() -> u64 {
    calls().dropped.swap(0, Ordering::Relaxed)
}

/// A COM object: IUnknown answered natively (any thread, synchronously), the other methods are
/// the given function pointers (threadsafe callbacks, usually). One reference belongs to the
/// creator, released with [`com_release`].
#[repr(C)]
struct ComObject {
    vtable: *const usize,
    refs: AtomicU32,
    iids: Vec<[u8; 16]>,
    table: Vec<usize>,
}

/// {00000000-0000-0000-C000-000000000046}
const IID_IUNKNOWN: [u8; 16] = [0, 0, 0, 0, 0, 0, 0, 0, 0xC0, 0, 0, 0, 0, 0, 0, 0x46];
/// {94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90}: callable from any thread, so WinRT does not marshal.
const IID_IAGILE_OBJECT: [u8; 16] = [
    0x94, 0x2B, 0xEA, 0x94, 0xCC, 0xE9, 0xE0, 0x49, 0xC0, 0xFF, 0xEE, 0x64, 0xCA, 0x8F, 0x5B, 0x90,
];
const S_OK: i32 = 0;
const E_NOINTERFACE: i32 = 0x8000_4002_u32 as i32;
const E_POINTER: i32 = 0x8000_4003_u32 as i32;

extern "system" fn query_interface(
    this: *mut ComObject,
    iid: *const [u8; 16],
    out: *mut *mut c_void,
) -> i32 {
    if out.is_null() {
        return E_POINTER;
    }
    // SAFETY: COM hands the object it got and a GUID; `out` was checked.
    unsafe {
        *out = std::ptr::null_mut();
        if iid.is_null() {
            return E_POINTER;
        }
        let iid = &*iid;
        let object = &*this;
        if *iid == IID_IUNKNOWN || *iid == IID_IAGILE_OBJECT || object.iids.contains(iid) {
            object.refs.fetch_add(1, Ordering::AcqRel);
            *out = this.cast();
            return S_OK;
        }
    }
    E_NOINTERFACE
}

extern "system" fn add_ref(this: *mut ComObject) -> u32 {
    // SAFETY: a live object (its caller holds a reference).
    unsafe { (*this).refs.fetch_add(1, Ordering::AcqRel) + 1 }
}

extern "system" fn release(this: *mut ComObject) -> u32 {
    // SAFETY: a live object; the last reference frees it.
    let left = unsafe { (*this).refs.fetch_sub(1, Ordering::AcqRel) - 1 };
    if left == 0 {
        drop(unsafe { Box::from_raw(this) });
    }
    left
}

/// Builds the object: `iids` are the interfaces it answers to besides IUnknown and IAgileObject,
/// `methods` the vtable entries after IUnknown's three, in order.
pub(crate) fn com_object(iids: Vec<[u8; 16]>, methods: &[u64]) -> Result<u64, String> {
    if methods.contains(&0) {
        return Err("A COM object method is a null pointer".into());
    }
    type QueryInterface =
        extern "system" fn(*mut ComObject, *const [u8; 16], *mut *mut c_void) -> i32;
    type Count = extern "system" fn(*mut ComObject) -> u32;
    let mut table = vec![
        query_interface as QueryInterface as usize,
        add_ref as Count as usize,
        release as Count as usize,
    ];
    table.extend(methods.iter().map(|method| *method as usize));
    let mut object = Box::new(ComObject {
        vtable: std::ptr::null(),
        refs: AtomicU32::new(1),
        iids,
        table,
    });
    object.vtable = object.table.as_ptr();
    Ok(Box::into_raw(object) as usize as u64)
}

/// Releases a reference to an object [`com_object`] made: the count left.
pub(crate) fn com_release(object: u64) -> Result<u32, String> {
    if object == 0 {
        return Err("Null COM object".into());
    }
    Ok(release(object as usize as *mut ComObject))
}

/// The queue and the slots are process-wide: tests that poll it take turns.
#[cfg(test)]
pub(crate) fn test_turn() -> std::sync::MutexGuard<'static, ()> {
    static SERIAL: Mutex<()> = Mutex::new(());
    SERIAL.lock().unwrap_or_else(|p| p.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn serial() -> std::sync::MutexGuard<'static, ()> {
        test_turn()
    }

    fn records(bytes: &[u8]) -> Vec<(u32, [u64; ARGS], Vec<u8>)> {
        let mut out = Vec::new();
        let mut at = 0;
        while at < bytes.len() {
            let id = u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
            let len = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().unwrap()) as usize;
            let mut args = [0u64; ARGS];
            for (index, arg) in args.iter_mut().enumerate() {
                let start = at + 8 + index * 8;
                *arg = u64::from_le_bytes(bytes[start..start + 8].try_into().unwrap());
            }
            let data = bytes[at + RECORD_HEADER..at + RECORD_HEADER + len].to_vec();
            out.push((id, args, data));
            at += RECORD_HEADER + len;
        }
        out
    }

    #[test]
    fn calls_from_other_threads_queue_in_order_and_return_the_fixed_value() {
        let _turn = serial();
        let address = create(7001, 0x8000_4005, 1, 4).unwrap();
        // SAFETY: the address is one of ENTRIES.
        let function: extern "C" fn(u64, u64) -> u64 =
            unsafe { std::mem::transmute(address as usize) };
        let data = [1u8, 2, 3, 4];
        let pointer = data.as_ptr() as usize as u64;
        let result = std::thread::spawn(move || function(42, pointer))
            .join()
            .unwrap();
        assert_eq!(result, 0x8000_4005);
        assert_eq!(function(43, 0), 0x8000_4005);
        assert!(close(address));
        assert_eq!(
            function(44, 0),
            0x8000_4005,
            "a closed callback still returns"
        );
        let mut out = vec![0u8; 4096];
        let written = poll(&mut out).unwrap();
        let mine: Vec<_> = records(&out[..written])
            .into_iter()
            .filter(|record| record.0 == 7001)
            .collect();
        assert_eq!(mine.len(), 2);
        assert_eq!((mine[0].1[0], mine[0].2.clone()), (42, vec![1, 2, 3, 4]));
        assert_eq!(
            (mine[1].1[0], mine[1].2.len()),
            (43, 0),
            "a null pointer copies nothing"
        );
        assert!(!close(address), "closing twice is a no-op");
    }

    #[test]
    fn poll_asks_for_room_for_a_record_that_does_not_fit() {
        let _turn = serial();
        let address = create(7002, 0, NO_COPY, 0).unwrap();
        let function: extern "C" fn() -> u64 = unsafe { std::mem::transmute(address as usize) };
        function();
        let mut small = [0u8; 4];
        assert_eq!(poll(&mut small), Err(RECORD_HEADER));
        let mut out = vec![0u8; 4096];
        let written = poll(&mut out).unwrap();
        assert!(
            records(&out[..written])
                .iter()
                .any(|record| record.0 == 7002)
        );
        close(address);
    }

    #[test]
    fn com_objects_answer_iunknown_natively_and_free_on_the_last_release() {
        let _turn = serial();
        let method = create(7003, 0, NO_COPY, 0).unwrap();
        let iid = [9u8; 16];
        let object = com_object(vec![iid], &[method]).unwrap() as usize as *mut ComObject;
        let mut out: *mut c_void = std::ptr::null_mut();
        assert_eq!(query_interface(object, &iid, &mut out), S_OK);
        assert_eq!(out, object.cast());
        assert_eq!(query_interface(object, &IID_IAGILE_OBJECT, &mut out), S_OK);
        assert_eq!(query_interface(object, &[1u8; 16], &mut out), E_NOINTERFACE);
        assert!(out.is_null());
        // SAFETY: the vtable's fourth entry is the method.
        assert_eq!(unsafe { *(*object).vtable.add(3) }, method as usize);
        assert_eq!(add_ref(object), 4);
        for left in (0..4).rev() {
            assert_eq!(com_release(object as usize as u64).unwrap(), left);
        }
        close(method);
    }

    #[test]
    fn native_posts_carry_any_copy_length_and_stop_once_closed() {
        let _turn = serial();
        let address = create(7005, 0, NO_COPY, 0).unwrap();
        let index = slot_of(address).unwrap();
        let long = vec![5u8; MAX_COPY as usize + 10];
        assert!(post(index, [1, 2, 3, 4, 5, 6], b"abc"));
        assert!(post(index, [7, 0, 0, 0, 0, 0], &long));
        assert!(close(address));
        assert!(
            !post(index, [8, 0, 0, 0, 0, 0], &[]),
            "a closed slot takes no posts"
        );
        assert!(!post(SLOTS, [0; ARGS], &[]));
        let mut out = vec![0u8; 2 * (RECORD_HEADER + MAX_COPY as usize) + 4096];
        let written = poll(&mut out).unwrap();
        let mine: Vec<_> = records(&out[..written])
            .into_iter()
            .filter(|record| record.0 == 7005)
            .collect();
        assert_eq!(mine.len(), 2);
        assert_eq!(
            (mine[0].1, mine[0].2.clone()),
            ([1, 2, 3, 4, 5, 6], b"abc".to_vec())
        );
        assert_eq!(
            (mine[1].1[0], mine[1].2.len()),
            (7, MAX_COPY as usize),
            "cut to MAX_COPY"
        );
    }

    #[test]
    fn refuses_bad_copies_and_runs_out_of_slots_cleanly() {
        let _turn = serial();
        assert!(create(1, 0, ARGS as u32, 4).is_err());
        assert!(create(1, 0, 0, MAX_COPY + 1).is_err());
        let open: Vec<u64> = std::iter::from_fn(|| create(7004, 0, NO_COPY, 0).ok()).collect();
        assert!(open.len() <= SLOTS);
        assert!(create(7004, 0, NO_COPY, 0).unwrap_err().contains("close()"));
        for address in open {
            close(address);
        }
    }
}
