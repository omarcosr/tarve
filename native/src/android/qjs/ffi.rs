//! `__tarveHost.dlopen(path, definitions)`: the FFI plugins' native libraries get on
//! Android (`ctx.loadLibrary`, packages/core/src/plugins/ffi.ts), with bun:ffi's shape:
//! `{ symbols: { name(...args) }, close() }` from `{ name: { args, returns } }`.
//! The library is opened with the app's linker namespace, so a bare `libplugin.so`
//! resolves to the copy `tarve build` packed in the APK's lib/<abi>/.

use super::foreign_call::{self, Kind, Returned, Signature};
use rquickjs::function::Rest;
use rquickjs::{ArrayBuffer, BigInt, Ctx, Exception, Function, Object, Value};
use std::cell::Cell;
use std::ffi::{CStr, CString, c_char, c_void};
use std::rc::Rc;

unsafe extern "C" {
    fn dlopen(name: *const c_char, flags: i32) -> *mut c_void;
    fn dlsym(handle: *mut c_void, name: *const c_char) -> *mut c_void;
    fn dlclose(handle: *mut c_void) -> i32;
    fn dlerror() -> *const c_char;
}

const RTLD_NOW: i32 = 2;

struct Library {
    handle: Cell<*mut c_void>,
}

impl Library {
    fn close(&self) {
        let handle = self.handle.replace(std::ptr::null_mut());
        if !handle.is_null() {
            // SAFETY: a handle dlopen returned, closed once.
            unsafe { dlclose(handle) };
        }
    }
}

fn dl_error() -> String {
    // SAFETY: dlerror returns null or a NUL-terminated message owned by the linker.
    let message = unsafe { dlerror() };
    if message.is_null() {
        "unknown error".into()
    } else {
        unsafe { CStr::from_ptr(message) }
            .to_string_lossy()
            .into_owned()
    }
}

pub(super) fn install<'js>(ctx: &Ctx<'js>, host: &Object<'js>) -> rquickjs::Result<()> {
    host.set("dlopen", Function::new(ctx.clone(), open)?)
}

fn open<'js>(
    ctx: Ctx<'js>,
    path: String,
    definitions: Object<'js>,
) -> rquickjs::Result<Object<'js>> {
    let name = CString::new(path.as_str())
        .map_err(|_| Exception::throw_type(&ctx, "dlopen: the library path contains a NUL byte"))?;
    // SAFETY: a NUL-terminated name; failure is a null handle.
    let handle = unsafe { dlopen(name.as_ptr(), RTLD_NOW) };
    if handle.is_null() {
        return Err(Exception::throw_message(
            &ctx,
            &format!("dlopen({path}): {}", dl_error()),
        ));
    }
    let library = Rc::new(Library {
        handle: Cell::new(handle),
    });
    let symbols = Object::new(ctx.clone())?;
    let bound = (|| {
        for entry in definitions.props::<String, Object<'js>>() {
            let (symbol, definition) = entry?;
            let signature = signature(&ctx, &symbol, &definition)?;
            let c_symbol = CString::new(symbol.as_str()).map_err(|_| {
                Exception::throw_type(&ctx, "dlopen: a symbol name contains a NUL byte")
            })?;
            // SAFETY: an open handle and a NUL-terminated name; a missing symbol is null.
            let address = unsafe { dlsym(handle, c_symbol.as_ptr()) };
            if address.is_null() {
                return Err(Exception::throw_message(
                    &ctx,
                    &format!("{path}: symbol {symbol} not found: {}", dl_error()),
                ));
            }
            symbols.set(
                symbol.as_str(),
                bind(&ctx, &library, address as usize, signature, symbol.clone())?,
            )?;
        }
        Ok(())
    })();
    if let Err(error) = bound {
        library.close();
        return Err(error);
    }
    let opened = Object::new(ctx.clone())?;
    opened.set("symbols", symbols)?;
    let owner = library.clone();
    opened.set("close", Function::new(ctx.clone(), move || owner.close())?)?;
    Ok(opened)
}

fn signature<'js>(
    ctx: &Ctx<'js>,
    symbol: &str,
    definition: &Object<'js>,
) -> rquickjs::Result<Signature> {
    let kind = |name: &str| {
        Kind::parse(name).ok_or_else(|| {
            Exception::throw_type(ctx, &format!("{symbol}: unsupported FFI type {name}"))
        })
    };
    let args = definition
        .get::<_, Option<Vec<String>>>("args")?
        .unwrap_or_default()
        .iter()
        .map(|name| kind(name))
        .collect::<rquickjs::Result<Vec<_>>>()?;
    let returns = match definition.get::<_, Option<String>>("returns")? {
        Some(name) => kind(&name)?,
        None => Kind::Void,
    };
    Signature::new(args, returns)
        .map_err(|message| Exception::throw_type(ctx, &format!("{symbol}: {message}")))
}

fn bind<'js>(
    ctx: &Ctx<'js>,
    library: &Rc<Library>,
    address: usize,
    signature: Signature,
    symbol: String,
) -> rquickjs::Result<Function<'js>> {
    let library = library.clone();
    Function::new(
        ctx.clone(),
        move |ctx: Ctx<'js>, Rest(values): Rest<Value<'js>>| {
            if library.handle.get().is_null() {
                return Err(Exception::throw_message(
                    &ctx,
                    &format!("{symbol}: the library was closed"),
                ));
            }
            let mut raw = Vec::with_capacity(signature.args.len());
            for (index, &kind) in signature.args.iter().enumerate() {
                let value = values
                    .get(index)
                    .cloned()
                    .unwrap_or_else(|| Value::new_undefined(ctx.clone()));
                raw.push(argument(kind, &value).ok_or_else(|| {
                    Exception::throw_type(
                        &ctx,
                        &format!("{symbol}: argument {index} is not a valid {kind:?}"),
                    )
                })?);
            }
            // SAFETY: the plugin declared this prototype for the symbol (as with bun:ffi), and
            // buffer arguments point into ArrayBuffers that live through the call.
            let result = unsafe { foreign_call::call(address, &signature, &raw) };
            Ok(match foreign_call::returned(signature.returns, result) {
                Returned::Void => Value::new_undefined(ctx),
                Returned::Bool(value) => Value::new_bool(ctx, value),
                Returned::Number(value) => Value::new_number(ctx, value),
                Returned::Signed(value) if value.unsigned_abs() <= MAX_SAFE => {
                    Value::new_number(ctx, value as f64)
                }
                Returned::Signed(value) => Value::new_big_int(ctx, value),
                Returned::Unsigned(value) if value <= MAX_SAFE => {
                    Value::new_number(ctx, value as f64)
                }
                Returned::Unsigned(value) => BigInt::from_u64(ctx, value)?.into_value(),
            })
        },
    )
}

/// 2^53 - 1: larger 64-bit results come back as BigInt.
const MAX_SAFE: u64 = (1 << 53) - 1;

fn argument(kind: Kind, value: &Value) -> Option<u64> {
    let empty = value.is_null() || value.is_undefined();
    match kind {
        Kind::Buffer if empty => Some(0),
        Kind::Buffer => buffer_address(value),
        Kind::Ptr if empty => Some(0),
        Kind::F32 | Kind::F64 => Some(foreign_call::float(kind, value.as_number()?)),
        Kind::Bool => {
            let truthy = value
                .as_bool()
                .or_else(|| value.as_number().map(|n| n != 0.0))?;
            Some(foreign_call::integer(kind, truthy as i64))
        }
        _ => Some(foreign_call::integer(kind, integer(value)?)),
    }
}

fn integer(value: &Value) -> Option<i64> {
    if let Some(big) = value.as_big_int() {
        return big.clone().to_i64().ok();
    }
    let number = value.as_number().filter(|n| n.is_finite())?.trunc();
    Some(if number >= 0.0 {
        number as u64 as i64
    } else {
        number as i64
    })
}

/// The address of an ArrayBuffer's bytes, or of a TypedArray's or DataView's first byte.
fn buffer_address(value: &Value) -> Option<u64> {
    let object = value.as_object()?;
    if let Some(buffer) = ArrayBuffer::from_object(object.clone()) {
        return Some(buffer.as_raw()?.ptr.as_ptr() as u64);
    }
    let buffer: ArrayBuffer = object.get("buffer").ok()?;
    let offset: f64 = object.get("byteOffset").ok()?;
    let raw = buffer.as_raw()?;
    (offset as usize <= raw.len).then(|| raw.ptr.as_ptr() as u64 + offset as u64)
}
