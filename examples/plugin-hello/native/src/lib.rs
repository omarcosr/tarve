//! Native half of the `tarve-plugin-hello` sample plugin: a plain C ABI that
//! the plugin's TypeScript wrapper opens with `ctx.loadLibrary` (bun:ffi,
//! node:ffi or txiki.js' tjs:ffi). No Tarve crate is linked: a plugin library
//! only depends on the C ABI it exports.

/// Version of this library's own C ABI, checked by the TypeScript wrapper.
pub const HELLO_ABI_VERSION: u32 = 1;

#[no_mangle]
pub extern "C" fn hello_abi_version() -> u32 {
    HELLO_ABI_VERSION
}

/// Wrapping addition: an overflow wraps instead of aborting across the FFI boundary.
#[no_mangle]
pub extern "C" fn hello_add(a: i32, b: i32) -> i32 {
    a.wrapping_add(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_and_wraps() {
        assert_eq!(hello_add(2, 3), 5);
        assert_eq!(hello_add(i32::MAX, 1), i32::MIN);
        assert_eq!(hello_abi_version(), 1);
    }
}
