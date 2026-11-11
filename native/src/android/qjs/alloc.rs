//! QuickJS's heap on mimalloc instead of bionic's malloc (Scudo). Scudo is a hardened allocator:
//! each malloc/free costs more than mimalloc's, and its `malloc_usable_size` reports exactly the
//! size asked for, so QuickJS never finds room to append to a string in place and `s += x` copies
//! the whole string every time (100,000 appends: 930 ms on a Galaxy S23, 10 ms with mimalloc).
use rquickjs::Runtime;
use rquickjs::allocator::Allocator;

unsafe extern "C" {
    fn mi_malloc(size: usize) -> *mut u8;
    fn mi_calloc(count: usize, size: usize) -> *mut u8;
    fn mi_realloc(ptr: *mut u8, size: usize) -> *mut u8;
    fn mi_free(ptr: *mut u8);
    fn mi_usable_size(ptr: *const u8) -> usize;
}

struct MiAlloc;

// SAFETY: mimalloc returns null or blocks aligned to at least 16 bytes, of at least the size asked
// for; `usable_size` answers for blocks it allocated, and every pointer QuickJS hands back came from it.
unsafe impl Allocator for MiAlloc {
    fn alloc(&mut self, size: usize) -> *mut u8 {
        unsafe { mi_malloc(size) }
    }

    fn calloc(&mut self, count: usize, size: usize) -> *mut u8 {
        unsafe { mi_calloc(count, size) }
    }

    unsafe fn dealloc(&mut self, ptr: *mut u8) {
        unsafe { mi_free(ptr) }
    }

    unsafe fn realloc(&mut self, ptr: *mut u8, new_size: usize) -> *mut u8 {
        unsafe { mi_realloc(ptr, new_size) }
    }

    unsafe fn usable_size(ptr: *mut u8) -> usize {
        unsafe { mi_usable_size(ptr) }
    }
}

pub(super) fn runtime() -> rquickjs::Result<Runtime> {
    Runtime::new_with_alloc(MiAlloc)
}
