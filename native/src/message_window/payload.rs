//! The bytes a message window copies out of a message's lParam before its call returns, for the
//! messages whose lParam is data JavaScript cannot read later.
use crate::threadsafe;
use windows_sys::Win32::Foundation::{LPARAM, WPARAM};

pub(crate) const WM_SETTINGCHANGE: u32 = 0x001A;
pub(crate) const WM_COPYDATA: u32 = 0x004A;
const WM_POWERBROADCAST: u32 = 0x0218;
const WM_DEVICECHANGE: u32 = 0x0219;
const PBT_POWERSETTINGCHANGE: usize = 0x8013;

/// COPYDATASTRUCT.
#[repr(C)]
pub(crate) struct CopyData {
    pub data: usize,
    pub length: u32,
    pub bytes: *const u8,
}

/// The bytes a message's lParam points to (empty for other messages).
///
/// # Safety
/// `lparam` must be what Windows documents for `message`, valid during this call.
pub(crate) unsafe fn copied(message: u32, wparam: WPARAM, lparam: LPARAM) -> Vec<u8> {
    let max = threadsafe::MAX_COPY as usize;
    let address = lparam as usize;
    if address == 0 {
        return Vec::new();
    }
    // SAFETY (all arms): the layouts Windows documents for each message's lParam.
    unsafe {
        match message {
            WM_COPYDATA => {
                let copy = &*(address as *const CopyData);
                let length = (copy.length as usize).min(max - 8);
                let mut out = Vec::with_capacity(8 + length);
                out.extend_from_slice(&(copy.data as u64).to_le_bytes());
                if !copy.bytes.is_null() && length > 0 {
                    out.extend_from_slice(std::slice::from_raw_parts(copy.bytes, length));
                }
                out
            }
            WM_SETTINGCHANGE => {
                let text = address as *const u16;
                let mut length = 0;
                while length < max / 2 && *text.add(length) != 0 {
                    length += 1;
                }
                std::slice::from_raw_parts(text as *const u8, length * 2).to_vec()
            }
            WM_POWERBROADCAST if wparam == PBT_POWERSETTINGCHANGE => {
                // POWERBROADCAST_SETTING: GUID, DataLength, Data.
                let length = *((address + 16) as *const u32) as usize;
                std::slice::from_raw_parts(address as *const u8, (20 + length).min(max)).to_vec()
            }
            WM_DEVICECHANGE if wparam & 0x8000 != 0 => {
                // DEV_BROADCAST_HDR: its first u32 is the whole structure's size.
                let length = *(address as *const u32) as usize;
                std::slice::from_raw_parts(address as *const u8, length.clamp(4, max)).to_vec()
            }
            _ => Vec::new(),
        }
    }
}
