//! The primitives behind `crypto.subtle` on Android (packages/core/android/globals.ts): Ed25519
//! verification and AES-GCM, on `ring` (already in the library for rustls). The update manifest
//! (`checkForUpdate`) and app packs are verified and decrypted through these.
use super::bytes_of;
use ring::aead::{AES_128_GCM, AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey};
use ring::signature::{ED25519, UnparsedPublicKey};
use rquickjs::prelude::Opt;
use rquickjs::{Ctx, Exception, Function, Object, TypedArray};

pub(super) fn install<'js>(ctx: &Ctx<'js>, host: &Object<'js>) -> rquickjs::Result<()> {
    host.set(
        "ed25519Verify",
        Function::new(
            ctx.clone(),
            |key: TypedArray<'js, u8>,
             signature: TypedArray<'js, u8>,
             data: TypedArray<'js, u8>| {
                UnparsedPublicKey::new(&ED25519, bytes_of(&key))
                    .verify(bytes_of(&data), bytes_of(&signature))
                    .is_ok()
            },
        )?,
    )?;
    host.set(
        "aesGcm",
        Function::new(
            ctx.clone(),
            |ctx: Ctx<'js>,
             encrypt: bool,
             key: TypedArray<'js, u8>,
             iv: TypedArray<'js, u8>,
             data: TypedArray<'js, u8>,
             aad: Opt<TypedArray<'js, u8>>| {
                let fail = |message: &str| Exception::throw_message(&ctx, message);
                let key = bytes_of(&key);
                let algorithm = match key.len() {
                    16 => &AES_128_GCM,
                    32 => &AES_256_GCM,
                    _ => return Err(fail("AES-GCM key must be 128 or 256 bits")),
                };
                let key = LessSafeKey::new(
                    UnboundKey::new(algorithm, key).map_err(|_| fail("invalid AES-GCM key"))?,
                );
                let nonce = Nonce::try_assume_unique_for_key(bytes_of(&iv))
                    .map_err(|_| fail("AES-GCM iv must be 12 bytes"))?;
                let aad = Aad::from(aad.0.as_ref().map(bytes_of).unwrap_or_default());
                let mut buffer = bytes_of(&data).to_vec();
                if encrypt {
                    key.seal_in_place_append_tag(nonce, aad, &mut buffer)
                        .map_err(|_| fail("AES-GCM encryption failed"))?;
                } else {
                    let length = key
                        .open_in_place(nonce, aad, &mut buffer)
                        .map_err(|_| fail("The operation failed for an operation-specific reason"))?
                        .len();
                    buffer.truncate(length);
                }
                TypedArray::<u8>::new(ctx.clone(), buffer)
            },
        )?,
    )?;
    Ok(())
}
