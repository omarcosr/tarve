//! Calls a C function whose signature is only known at run time (a plugin's
//! `ctx.loadLibrary` declaration), without libffi.
//!
//! On the two Android ABIs (AAPCS64 on arm64, System V on x86_64) integer/pointer
//! arguments and floating-point arguments are assigned to two independent register
//! files, each in declaration order. So any signature whose arguments fit in registers is
//! called correctly through one fixed prototype that takes every integer register and
//! every vector register: the declared integers fill the first integer slots, the declared
//! floats the first vector slots, and the callee never reads the unused ones. Signatures
//! that would spill onto the stack are refused when the library is opened, not guessed.
//! An `f32` travels in the low 32 bits of its vector register, as both ABIs pass it.

/// An FFI type name, as `ctx.loadLibrary` (bun:ffi, tjs:ffi) spells it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Void,
    Bool,
    I8,
    U8,
    I16,
    U16,
    I32,
    U32,
    I64,
    U64,
    F32,
    F64,
    Ptr,
    Buffer,
}

impl Kind {
    pub(crate) fn parse(name: &str) -> Option<Kind> {
        Some(match name {
            "void" => Kind::Void,
            "bool" => Kind::Bool,
            "i8" | "int8_t" | "char" => Kind::I8,
            "u8" | "uint8_t" => Kind::U8,
            "i16" | "int16_t" => Kind::I16,
            "u16" | "uint16_t" => Kind::U16,
            "i32" | "int32_t" | "int" => Kind::I32,
            "u32" | "uint32_t" => Kind::U32,
            "i64" | "int64_t" => Kind::I64,
            "u64" | "uint64_t" => Kind::U64,
            "f32" | "float" => Kind::F32,
            "f64" | "double" => Kind::F64,
            "ptr" | "pointer" => Kind::Ptr,
            "buffer" => Kind::Buffer,
            _ => return None,
        })
    }

    pub(crate) fn is_float(self) -> bool {
        matches!(self, Kind::F32 | Kind::F64)
    }
}

/// Integer/pointer argument registers: x0–x7 (AAPCS64), rdi, rsi, rdx, rcx, r8, r9 (System V).
#[cfg(target_arch = "aarch64")]
pub(crate) const INTEGER_REGISTERS: usize = 8;
#[cfg(target_arch = "x86_64")]
pub(crate) const INTEGER_REGISTERS: usize = 6;
/// Floating-point argument registers: v0–v7 (AAPCS64), xmm0–xmm7 (System V).
pub(crate) const FLOAT_REGISTERS: usize = 8;

#[derive(Clone, Debug)]
pub(crate) struct Signature {
    pub(crate) args: Vec<Kind>,
    pub(crate) returns: Kind,
}

impl Signature {
    pub(crate) fn new(args: Vec<Kind>, returns: Kind) -> Result<Self, String> {
        if args.contains(&Kind::Void) {
            return Err("void is not an argument type".into());
        }
        if returns == Kind::Buffer {
            return Err("buffer is not a return type (return ptr)".into());
        }
        let floats = args.iter().filter(|kind| kind.is_float()).count();
        let integers = args.len() - floats;
        if integers > INTEGER_REGISTERS || floats > FLOAT_REGISTERS {
            return Err(format!(
                "{integers} integer/pointer and {floats} floating-point arguments: Android passes at most {INTEGER_REGISTERS} and {FLOAT_REGISTERS} to a native plugin function"
            ));
        }
        Ok(Signature { args, returns })
    }
}

/// An integer argument as its 64-bit register value, sign- or zero-extended from its type.
pub(crate) fn integer(kind: Kind, value: i64) -> u64 {
    match kind {
        Kind::Bool => (value != 0) as u64,
        Kind::I8 => value as i8 as i64 as u64,
        Kind::U8 => value as u8 as u64,
        Kind::I16 => value as i16 as i64 as u64,
        Kind::U16 => value as u16 as u64,
        Kind::I32 => value as i32 as i64 as u64,
        Kind::U32 => value as u32 as u64,
        _ => value as u64,
    }
}

/// A floating-point argument as the bits of its vector register.
pub(crate) fn float(kind: Kind, value: f64) -> u64 {
    match kind {
        Kind::F32 => (value as f32).to_bits() as u64,
        _ => value.to_bits(),
    }
}

/// A returned register value, read as its declared type.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Returned {
    Void,
    Bool(bool),
    Number(f64),
    Signed(i64),
    Unsigned(u64),
}

pub(crate) fn returned(kind: Kind, raw: u64) -> Returned {
    match kind {
        Kind::Void => Returned::Void,
        Kind::Bool => Returned::Bool(raw as u8 != 0),
        Kind::I8 => Returned::Number(raw as i8 as f64),
        Kind::U8 => Returned::Number(raw as u8 as f64),
        Kind::I16 => Returned::Number(raw as i16 as f64),
        Kind::U16 => Returned::Number(raw as u16 as f64),
        Kind::I32 => Returned::Number(raw as i32 as f64),
        Kind::U32 => Returned::Number(raw as u32 as f64),
        Kind::F32 => Returned::Number(f32::from_bits(raw as u32) as f64),
        Kind::F64 => Returned::Number(f64::from_bits(raw)),
        Kind::I64 => Returned::Signed(raw as i64),
        Kind::U64 | Kind::Ptr | Kind::Buffer => Returned::Unsigned(raw),
    }
}

type IntegerReturn = unsafe extern "C" fn(
    u64,
    u64,
    u64,
    u64,
    u64,
    u64,
    u64,
    u64,
    f64,
    f64,
    f64,
    f64,
    f64,
    f64,
    f64,
    f64,
) -> u64;
type FloatReturn = unsafe extern "C" fn(
    u64,
    u64,
    u64,
    u64,
    u64,
    u64,
    u64,
    u64,
    f64,
    f64,
    f64,
    f64,
    f64,
    f64,
    f64,
    f64,
) -> f64;

/// Calls `address` with `raw` (one register value per declared argument, from `integer`
/// and `float`) and returns the raw return register (`returned` reads it).
///
/// # Safety
/// `address` must be a C function whose prototype `signature` describes, and every
/// pointer among the arguments must be valid for what that function does with it.
pub(crate) unsafe fn call(address: usize, signature: &Signature, raw: &[u64]) -> u64 {
    assert_eq!(
        raw.len(),
        signature.args.len(),
        "one value per declared argument"
    );
    let mut ints = [0_u64; 8];
    let mut floats = [0_f64; 8];
    let (mut i, mut f) = (0, 0);
    for (kind, &value) in signature.args.iter().zip(raw) {
        if kind.is_float() {
            floats[f] = f64::from_bits(value);
            f += 1;
        } else {
            ints[i] = value;
            i += 1;
        }
    }
    let [a0, a1, a2, a3, a4, a5, a6, a7] = ints;
    let [f0, f1, f2, f3, f4, f5, f6, f7] = floats;
    // SAFETY: the caller guarantees the prototype; Signature::new kept every declared
    // argument in a register, and the extra ones are never read by the callee.
    unsafe {
        if signature.returns.is_float() {
            let function = std::mem::transmute::<usize, FloatReturn>(address);
            function(
                a0, a1, a2, a3, a4, a5, a6, a7, f0, f1, f2, f3, f4, f5, f6, f7,
            )
            .to_bits()
        } else {
            let function = std::mem::transmute::<usize, IntegerReturn>(address);
            function(
                a0, a1, a2, a3, a4, a5, a6, a7, f0, f1, f2, f3, f4, f5, f6, f7,
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    extern "C" fn add_i32(a: i32, b: i32) -> i32 {
        a.wrapping_add(b)
    }
    extern "C" fn negate_i8(value: i8) -> i8 {
        value.wrapping_neg()
    }
    extern "C" fn not(value: bool) -> bool {
        !value
    }
    extern "C" fn half(value: f32) -> f32 {
        value / 2.0
    }
    extern "C" fn mixed(a: i32, x: f64, b: i64, y: f32, bytes: *const u8, c: u16) -> f64 {
        // SAFETY: the test passes a live byte.
        a as f64 + x + b as f64 + y as f64 + unsafe { *bytes } as f64 + c as f64
    }
    extern "C" fn sum_registers(a: u64, b: u64, c: u64, d: u64, e: u64, f: u64) -> u64 {
        a + b * 10 + c * 100 + d * 1_000 + e * 10_000 + f * 100_000
    }
    #[allow(clippy::too_many_arguments)]
    extern "C" fn sum_floats(
        a: f64,
        b: f64,
        c: f64,
        d: f64,
        e: f64,
        f: f64,
        g: f64,
        h: f32,
    ) -> f64 {
        a + b * 2.0 + c * 3.0 + d * 4.0 + e * 5.0 + f * 6.0 + g * 7.0 + h as f64 * 8.0
    }
    extern "C" fn fill(buffer: *mut u8, length: u64, value: u8) -> u64 {
        // SAFETY: the test passes a buffer of `length` bytes.
        unsafe { std::slice::from_raw_parts_mut(buffer, length as usize) }.fill(value);
        buffer as u64
    }
    extern "C" fn widest(value: u64) -> u64 {
        value
    }

    fn run(address: usize, args: &[Kind], returns: Kind, raw: &[u64]) -> Returned {
        let signature = Signature::new(args.to_vec(), returns).unwrap();
        returned(returns, unsafe { call(address, &signature, raw) })
    }

    #[test]
    fn integers_are_extended_and_returns_truncated() {
        use Kind::*;
        assert_eq!(
            run(
                add_i32 as *const () as usize,
                &[I32, I32],
                I32,
                &[integer(I32, -7), integer(I32, 3)]
            ),
            Returned::Number(-4.0)
        );
        assert_eq!(
            run(
                add_i32 as *const () as usize,
                &[I32, I32],
                I32,
                &[integer(I32, i32::MAX as i64), integer(I32, 1)]
            ),
            Returned::Number(i32::MIN as f64)
        );
        assert_eq!(
            run(
                negate_i8 as *const () as usize,
                &[I8],
                I8,
                &[integer(I8, 5)]
            ),
            Returned::Number(-5.0)
        );
        assert_eq!(
            run(
                not as *const () as usize,
                &[Bool],
                Bool,
                &[integer(Bool, 0)]
            ),
            Returned::Bool(true)
        );
        assert_eq!(
            run(
                widest as *const () as usize,
                &[U64],
                U64,
                &[integer(U64, -1)]
            ),
            Returned::Unsigned(u64::MAX)
        );
        assert_eq!(
            run(
                widest as *const () as usize,
                &[I64],
                I64,
                &[integer(I64, i64::MIN)]
            ),
            Returned::Signed(i64::MIN)
        );
    }

    #[test]
    fn floats_and_integers_interleave_in_declaration_order() {
        use Kind::*;
        assert_eq!(
            run(half as *const () as usize, &[F32], F32, &[float(F32, 3.0)]),
            Returned::Number(1.5)
        );
        let byte = 9_u8;
        let raw = [
            integer(I32, 1),
            float(F64, 0.5),
            integer(I64, 100),
            float(F32, 0.25),
            &byte as *const u8 as u64,
            integer(U16, 1000),
        ];
        assert_eq!(
            run(
                mixed as *const () as usize,
                &[I32, F64, I64, F32, Ptr, U16],
                F64,
                &raw
            ),
            Returned::Number(1110.75)
        );
    }

    #[test]
    fn every_register_is_used() {
        use Kind::*;
        let raw: Vec<u64> = (1..=6).map(|n| integer(U64, n)).collect();
        assert_eq!(
            run(sum_registers as *const () as usize, &[U64; 6], U64, &raw),
            Returned::Unsigned(654_321)
        );
        let mut kinds = vec![F64; 7];
        kinds.push(F32);
        let raw: Vec<u64> = kinds.iter().map(|&kind| float(kind, 1.0)).collect();
        assert_eq!(
            run(sum_floats as *const () as usize, &kinds, F64, &raw),
            Returned::Number(36.0)
        );
    }

    #[test]
    fn buffers_pass_their_address() {
        use Kind::*;
        let mut bytes = [0_u8; 4];
        let address = bytes.as_mut_ptr() as u64;
        assert_eq!(
            run(
                fill as *const () as usize,
                &[Buffer, U64, U8],
                Ptr,
                &[address, 4, integer(U8, 0x1ff)]
            ),
            Returned::Unsigned(address)
        );
        assert_eq!(bytes, [0xff; 4]);
    }

    #[test]
    fn stack_arguments_are_refused() {
        assert!(Signature::new(vec![Kind::Ptr; INTEGER_REGISTERS], Kind::Void).is_ok());
        assert!(Signature::new(vec![Kind::Ptr; INTEGER_REGISTERS + 1], Kind::Void).is_err());
        assert!(Signature::new(vec![Kind::F32; FLOAT_REGISTERS + 1], Kind::Void).is_err());
        assert!(Signature::new(vec![Kind::Void], Kind::Void).is_err());
        assert!(Signature::new(vec![], Kind::Buffer).is_err());
        assert_eq!(Kind::parse("double"), Some(Kind::F64));
        assert_eq!(Kind::parse("string"), None);
    }
}
