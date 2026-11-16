//! Calls a C function whose signature is only known at run time, without libffi and without
//! generating code: plugin libraries' `ctx.loadLibrary` symbols on Android
//! (android/qjs/ffi.rs) and `pointerFunction` on every runtime (bridge::entry_points::tarve_ffi_call).
//!
//! Every call goes through a prototype fixed at compile time, picked by the signature:
//!
//! - AAPCS64 (arm64 on Android, Linux, macOS and Windows) and System V (x86-64 Linux, macOS and
//!   Android) assign integer/pointer arguments and floating-point arguments to two independent
//!   register files, each in declaration order. One prototype that takes every integer register
//!   and every vector register calls any signature whose arguments fit in registers: the declared
//!   integers fill the first integer slots, the declared floats the first vector slots, and the
//!   callee never reads the unused ones. Signatures that would spill onto the stack are refused
//!   by `Signature::new`, not guessed.
//! - Windows x64 gives each argument position one slot: RCX/RDX/R8/R9 or XMM0–XMM3 for the first
//!   four, by type, then an 8-byte stack slot each, which the caller allocates and frees. One
//!   prototype per integer/float pattern of the first four positions (16) and per return register
//!   (2) calls any signature of up to `MAX_ARGUMENTS` arguments; the callee never reads the
//!   trailing slots it did not declare.
//!
//! An `f32` travels in the low 32 bits of its register or slot, as all three ABIs pass it.
//! Variadic functions and structs passed by value are not supported.

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
    /// A type name of a `__tarveHost.dlopen` declaration (android/qjs/ffi.rs).
    #[cfg(any(test, target_os = "android"))]
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

    /// The kind a `tarve_ffi_call` frame code stands for: its position in this list, which
    /// packages/core/src/plugins/pointer.ts (`KIND_CODES`) mirrors.
    pub(crate) fn from_code(code: u8) -> Option<Kind> {
        use Kind::*;
        const KINDS: [Kind; 14] = [
            Void, Bool, I8, U8, I16, U16, I32, U32, I64, U64, F32, F64, Ptr, Buffer,
        ];
        KINDS.get(code as usize).copied()
    }

    pub(crate) fn is_float(self) -> bool {
        matches!(self, Kind::F32 | Kind::F64)
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Signature {
    pub(crate) args: Vec<Kind>,
    pub(crate) returns: Kind,
}

/// Why `Signature::new` refused a signature.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SignatureError {
    /// Not a C signature at all (a void argument, a buffer return).
    Invalid(String),
    /// A C signature this platform's calling convention cannot take here (stack arguments).
    Unsupported(String),
}

impl std::fmt::Display for SignatureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SignatureError::Invalid(message) | SignatureError::Unsupported(message) => {
                f.write_str(message)
            }
        }
    }
}

impl Signature {
    pub(crate) fn new(args: Vec<Kind>, returns: Kind) -> Result<Self, SignatureError> {
        if args.contains(&Kind::Void) {
            return Err(SignatureError::Invalid(
                "void is not an argument type".into(),
            ));
        }
        if returns == Kind::Buffer {
            return Err(SignatureError::Invalid(
                "buffer is not a return type (return ptr)".into(),
            ));
        }
        abi::fits(&args).map_err(SignatureError::Unsupported)?;
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
    // SAFETY: the caller guarantees the prototype; Signature::new kept it within what
    // abi::call passes.
    unsafe { abi::call(address, signature, raw) }
}

/// Two register files (AAPCS64, System V): arguments must fit in registers.
#[cfg(any(
    target_arch = "aarch64",
    all(target_arch = "x86_64", not(target_os = "windows"))
))]
mod abi {
    use super::{Kind, Signature};

    /// Integer/pointer argument registers: x0–x7 (AAPCS64), rdi, rsi, rdx, rcx, r8, r9 (System V).
    #[cfg(target_arch = "aarch64")]
    pub(crate) const INTEGER_REGISTERS: usize = 8;
    #[cfg(target_arch = "x86_64")]
    pub(crate) const INTEGER_REGISTERS: usize = 6;
    /// Floating-point argument registers: v0–v7 (AAPCS64), xmm0–xmm7 (System V).
    pub(crate) const FLOAT_REGISTERS: usize = 8;

    pub(super) fn fits(args: &[Kind]) -> Result<(), String> {
        let floats = args.iter().filter(|kind| kind.is_float()).count();
        let integers = args.len() - floats;
        if integers > INTEGER_REGISTERS || floats > FLOAT_REGISTERS {
            return Err(format!(
                "{integers} integer/pointer and {floats} floating-point arguments: this platform passes at most {INTEGER_REGISTERS} and {FLOAT_REGISTERS} in registers, and stack arguments are not supported"
            ));
        }
        Ok(())
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

    pub(super) unsafe fn call(address: usize, signature: &Signature, raw: &[u64]) -> u64 {
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
        // SAFETY: the caller guarantees the prototype; `fits` kept every declared argument in
        // a register, and the extra ones are never read by the callee.
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
}

/// Windows x64: one slot per argument position, the first four in registers by type.
#[cfg(all(target_arch = "x86_64", target_os = "windows"))]
mod abi {
    use super::{Kind, Signature};

    /// Arguments a pointer function may declare (4 in registers, the rest on the stack).
    pub(crate) const MAX_ARGUMENTS: usize = 16;

    pub(super) fn fits(args: &[Kind]) -> Result<(), String> {
        if args.len() > MAX_ARGUMENTS {
            return Err(format!(
                "{} arguments: at most {MAX_ARGUMENTS} are supported",
                args.len()
            ));
        }
        Ok(())
    }

    type Slots = [u64; MAX_ARGUMENTS];

    /// What a register position holds: an integer register (u64) or a vector register (f64).
    trait Register: Copy {
        fn from_bits(bits: u64) -> Self;
        fn into_bits(self) -> u64;
    }
    impl Register for u64 {
        fn from_bits(bits: u64) -> Self {
            bits
        }
        fn into_bits(self) -> u64 {
            self
        }
    }
    impl Register for f64 {
        fn from_bits(bits: u64) -> Self {
            f64::from_bits(bits)
        }
        fn into_bits(self) -> u64 {
            self.to_bits()
        }
    }

    type Prototype<A, B, C, D, R> = unsafe extern "C" fn(
        A,
        B,
        C,
        D,
        u64,
        u64,
        u64,
        u64,
        u64,
        u64,
        u64,
        u64,
        u64,
        u64,
        u64,
        u64,
    ) -> R;

    unsafe fn invoke<A: Register, B: Register, C: Register, D: Register, R: Register>(
        address: usize,
        slots: &Slots,
    ) -> u64 {
        // SAFETY: a function pointer is an address; the caller guarantees the prototype, whose
        // first four positions A–D and return register R the dispatch below picked.
        let function =
            unsafe { std::mem::transmute_copy::<usize, Prototype<A, B, C, D, R>>(&address) };
        let [a, b, c, d, s4, s5, s6, s7, s8, s9, s10, s11, s12, s13, s14, s15] = *slots;
        // SAFETY: as above; trailing stack slots the callee did not declare are never read, and
        // the caller frees them (Windows x64 is caller-cleanup).
        unsafe {
            function(
                A::from_bits(a),
                B::from_bits(b),
                C::from_bits(c),
                D::from_bits(d),
                s4,
                s5,
                s6,
                s7,
                s8,
                s9,
                s10,
                s11,
                s12,
                s13,
                s14,
                s15,
            )
        }
        .into_bits()
    }

    unsafe fn fourth<A: Register, B: Register, C: Register, R: Register>(
        address: usize,
        floats: [bool; 4],
        slots: &Slots,
    ) -> u64 {
        // SAFETY: forwarded from `call`.
        unsafe {
            if floats[3] {
                invoke::<A, B, C, f64, R>(address, slots)
            } else {
                invoke::<A, B, C, u64, R>(address, slots)
            }
        }
    }

    unsafe fn third<A: Register, B: Register, R: Register>(
        address: usize,
        floats: [bool; 4],
        slots: &Slots,
    ) -> u64 {
        // SAFETY: forwarded from `call`.
        unsafe {
            if floats[2] {
                fourth::<A, B, f64, R>(address, floats, slots)
            } else {
                fourth::<A, B, u64, R>(address, floats, slots)
            }
        }
    }

    unsafe fn second<A: Register, R: Register>(
        address: usize,
        floats: [bool; 4],
        slots: &Slots,
    ) -> u64 {
        // SAFETY: forwarded from `call`.
        unsafe {
            if floats[1] {
                third::<A, f64, R>(address, floats, slots)
            } else {
                third::<A, u64, R>(address, floats, slots)
            }
        }
    }

    unsafe fn first<R: Register>(address: usize, floats: [bool; 4], slots: &Slots) -> u64 {
        // SAFETY: forwarded from `call`.
        unsafe {
            if floats[0] {
                second::<f64, R>(address, floats, slots)
            } else {
                second::<u64, R>(address, floats, slots)
            }
        }
    }

    pub(super) unsafe fn call(address: usize, signature: &Signature, raw: &[u64]) -> u64 {
        let mut slots = [0_u64; MAX_ARGUMENTS];
        slots[..raw.len()].copy_from_slice(raw);
        let mut floats = [false; 4];
        for (float, kind) in floats.iter_mut().zip(&signature.args) {
            *float = kind.is_float();
        }
        // SAFETY: the caller guarantees the prototype; `fits` kept it within MAX_ARGUMENTS.
        unsafe {
            if signature.returns.is_float() {
                first::<f64>(address, floats, &slots)
            } else {
                first::<u64>(address, floats, &slots)
            }
        }
    }
}

/// Any other architecture: no calling convention implemented, every signature refused.
#[cfg(not(any(target_arch = "aarch64", target_arch = "x86_64")))]
mod abi {
    use super::{Kind, Signature};

    pub(super) fn fits(_: &[Kind]) -> Result<(), String> {
        Err("calling a function by its signature is not supported on this architecture".into())
    }

    pub(super) unsafe fn call(_: usize, _: &Signature, _: &[u64]) -> u64 {
        unreachable!("Signature::new refuses every signature on this architecture")
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
    fn kinds_have_stable_frame_codes() {
        assert_eq!(Kind::from_code(0), Some(Kind::Void));
        assert_eq!(Kind::from_code(10), Some(Kind::F32));
        assert_eq!(Kind::from_code(13), Some(Kind::Buffer));
        assert_eq!(Kind::from_code(14), None);
        assert_eq!(Kind::parse("double"), Some(Kind::F64));
        assert_eq!(Kind::parse("string"), None);
    }

    #[test]
    fn invalid_signatures_are_refused() {
        assert!(matches!(
            Signature::new(vec![Kind::Void], Kind::Void),
            Err(SignatureError::Invalid(_))
        ));
        assert!(matches!(
            Signature::new(vec![], Kind::Buffer),
            Err(SignatureError::Invalid(_))
        ));
    }

    #[cfg(any(
        target_arch = "aarch64",
        all(target_arch = "x86_64", not(target_os = "windows"))
    ))]
    #[test]
    fn stack_arguments_are_refused() {
        use abi::{FLOAT_REGISTERS, INTEGER_REGISTERS};
        assert!(Signature::new(vec![Kind::Ptr; INTEGER_REGISTERS], Kind::Void).is_ok());
        assert!(matches!(
            Signature::new(vec![Kind::Ptr; INTEGER_REGISTERS + 1], Kind::Void),
            Err(SignatureError::Unsupported(_))
        ));
        assert!(matches!(
            Signature::new(vec![Kind::F32; FLOAT_REGISTERS + 1], Kind::Void),
            Err(SignatureError::Unsupported(_))
        ));
    }

    #[cfg(all(target_arch = "x86_64", target_os = "windows"))]
    mod win64 {
        use super::*;

        #[allow(clippy::too_many_arguments)]
        extern "C" fn sixteen(
            a: f32,
            b: i64,
            c: f64,
            d: u8,
            e: f64,
            f: i32,
            g: f32,
            h: u64,
            i: f64,
            j: i16,
            k: f32,
            l: u32,
            m: f64,
            n: i8,
            o: f32,
            p: u64,
        ) -> f64 {
            let values = [
                a as f64, b as f64, c, d as f64, e, f as f64, g as f64, h as f64, i, j as f64,
                k as f64, l as f64, m, n as f64, o as f64, p as f64,
            ];
            values
                .iter()
                .enumerate()
                .map(|(index, value)| value * (index as f64 + 1.0).powi(2))
                .sum()
        }

        #[allow(clippy::too_many_arguments)]
        extern "C" fn stacked_f32(a: u64, b: f64, c: u64, d: f32, e: f32, f: u64) -> f32 {
            a as f32 + b as f32 * 2.0 + c as f32 * 4.0 + d * 8.0 + e * 16.0 + f as f32 * 32.0
        }

        #[test]
        fn every_position_pattern_reaches_its_register_or_slot() {
            use Kind::*;
            let kinds = [
                F32, I64, F64, U8, F64, I32, F32, U64, F64, I16, F32, U32, F64, I8, F32, U64,
            ];
            let raw = [
                float(F32, 1.5),
                integer(I64, -2),
                float(F64, 3.25),
                integer(U8, 4),
                float(F64, -5.5),
                integer(I32, -6),
                float(F32, 7.75),
                integer(U64, 8),
                float(F64, 9.5),
                integer(I16, -10),
                float(F32, 11.25),
                integer(U32, 12),
                float(F64, 13.5),
                integer(I8, -14),
                float(F32, 15.75),
                integer(U64, 16),
            ];
            let expected = sixteen(
                1.5, -2, 3.25, 4, -5.5, -6, 7.75, 8, 9.5, -10, 11.25, 12, 13.5, -14, 15.75, 16,
            );
            assert_eq!(
                run(sixteen as *const () as usize, &kinds, F64, &raw),
                Returned::Number(expected)
            );
            let expected = stacked_f32(1, 0.5, 3, 0.25, 0.125, 2);
            assert_eq!(
                run(
                    stacked_f32 as *const () as usize,
                    &[U64, F64, U64, F32, F32, U64],
                    F32,
                    &[
                        integer(U64, 1),
                        float(F64, 0.5),
                        integer(U64, 3),
                        float(F32, 0.25),
                        float(F32, 0.125),
                        integer(U64, 2)
                    ]
                ),
                Returned::Number(expected as f64)
            );
        }

        #[test]
        fn more_than_sixteen_arguments_are_refused() {
            assert!(Signature::new(vec![Kind::F64; abi::MAX_ARGUMENTS], Kind::Void).is_ok());
            assert!(matches!(
                Signature::new(vec![Kind::Ptr; abi::MAX_ARGUMENTS + 1], Kind::Void),
                Err(SignatureError::Unsupported(_))
            ));
        }
    }
}
