//! Calls through every prototype to Rust `extern "C"` functions with known results.
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
extern "C" fn sum_floats(a: f64, b: f64, c: f64, d: f64, e: f64, f: f64, g: f64, h: f32) -> f64 {
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
