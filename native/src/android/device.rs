//! Device services on Android (crate::device): the share chooser (`dev.tarve.TarveShare`, files
//! through `TarveFileProvider`), location (`TarveLocation`, the framework LocationManager) and
//! the biometric check (`TarveBiometric`, android.hardware.biometrics.BiometricPrompt) and
//! dictation (`TarveSpeech`, android.speech.SpeechRecognizer). Java in
//! packages/core/android/java; answers go straight into the bridge's event queue.

use super::permissions::{load_class, strings};
use super::{LOG_WARN, log, with_env};
use crate::device::{authenticate_event, location_event, position_json, speech_event};
use crate::protocol::requests::{Authenticate, Location, Share, Speech};
use jni::JNIEnv;
use jni::objects::{JByteArray, JClass, JDoubleArray, JObject, JString, JValue};
use jni::sys::{jboolean, jdouble};

fn optional_string(env: &mut JNIEnv, value: &JString) -> Option<String> {
    (!value.is_null())
        .then(|| env.get_string(value).map(String::from).ok())
        .flatten()
}

fn java_string<'local>(
    env: &mut JNIEnv<'local>,
    value: &Option<String>,
) -> jni::errors::Result<JObject<'local>> {
    Ok(match value {
        Some(value) => JObject::from(env.new_string(value)?),
        None => JObject::null(),
    })
}

/// Opens the chooser; the request answers at once (`supported: true`).
pub(crate) fn share(request: &Share) -> Result<(), String> {
    with_env(|env, activity| {
        let class = load_class(env, activity, "dev.tarve.TarveShare")?;

        let title = java_string(env, &request.title)?;
        let body = java_string(env, &request.text)?;
        let url = java_string(env, &request.url)?;
        let files = strings(env, &request.files)?;
        let error = env
            .call_static_method(
                &class,
                "share",
                "(Landroid/app/Activity;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;)Ljava/lang/String;",
                &[
                    JValue::Object(activity),
                    JValue::Object(&title),
                    JValue::Object(&body),
                    JValue::Object(&url),
                    JValue::Object(&files),
                ],
            )?
            .l()?;
        Ok(optional_string(env, &JString::from(error)))
    })
    .map_err(|error| {
        log(LOG_WARN, &format!("tarve: share: {error}"));
        format!("Could not open the share sheet: {error}")
    })?
    .map_or(Ok(()), Err)
}

extern "system" fn native_location(
    mut env: JNIEnv,
    _: JClass,
    id: JString,
    watch: jboolean,
    fix: JDoubleArray,
    code: JString,
    message: JString,
) {
    let Ok(id) = env.get_string(&id).map(String::from) else {
        return;
    };
    let position = (!fix.is_null())
        .then(|| {
            let mut values = [f64::NAN; 8];
            env.get_double_array_region(&fix, 0, &mut values).ok()?;
            Some(position_json(&values))
        })
        .flatten();
    let code = optional_string(&mut env, &code);
    let message = optional_string(&mut env, &message);
    crate::bridge::entry_points::emit(location_event(
        &id,
        watch != 0,
        position,
        code.as_deref(),
        message.as_deref(),
    ));
}

/// `get`, `watch` or `clear` through `TarveLocation`; Err when it cannot start.
pub(crate) fn location(request: &Location) -> Result<(), String> {
    with_env(|env, activity| {
        let class = load_class(env, activity, "dev.tarve.TarveLocation")?;
        env.register_native_methods(
            &class,
            &[jni::NativeMethod {
                name: "nativeLocation".into(),
                sig: "(Ljava/lang/String;Z[DLjava/lang/String;Ljava/lang/String;)V".into(),
                fn_ptr: native_location as *mut std::ffi::c_void,
            }],
        )?;
        let id = env.new_string(&request.request_id)?;
        let high = JValue::Bool(request.high_accuracy.into());
        let millis = |value: Option<f64>, default: f64| {
            JValue::Long(value.unwrap_or(default).clamp(0.0, 3_600_000.0) as i64)
        };
        match request.action.as_str() {
            "clear" => {
                env.call_static_method(
                    &class,
                    "clear",
                    "(Ljava/lang/String;)V",
                    &[JValue::Object(&id)],
                )?;
            }
            "watch" => {
                env.call_static_method(
                    &class,
                    "watch",
                    "(Landroid/content/Context;Ljava/lang/String;Z)V",
                    &[JValue::Object(activity), JValue::Object(&id), high],
                )?;
            }
            _ => {
                env.call_static_method(
                    &class,
                    "get",
                    "(Landroid/content/Context;Ljava/lang/String;ZJJ)V",
                    &[
                        JValue::Object(activity),
                        JValue::Object(&id),
                        high,
                        millis(request.timeout_ms, 30_000.0),
                        millis(request.maximum_age_ms, 0.0),
                    ],
                )?;
            }
        }
        Ok(())
    })
    .map_err(|error| {
        log(LOG_WARN, &format!("tarve: location: {error}"));
        format!("Could not read the location: {error}")
    })
}

extern "system" fn native_authenticated(
    mut env: JNIEnv,
    _: JClass,
    id: JString,
    success: jboolean,
    code: JString,
    message: JString,
) {
    let Ok(id) = env.get_string(&id).map(String::from) else {
        return;
    };
    let code = optional_string(&mut env, &code);
    let message = optional_string(&mut env, &message);
    crate::bridge::entry_points::emit(authenticate_event(
        &id,
        success != 0,
        code.as_deref(),
        message.as_deref(),
    ));
}

/// Shows BiometricPrompt (`TarveBiometric`); Err when it cannot start.
pub(crate) fn authenticate(request: &Authenticate) -> Result<(), String> {
    with_env(|env, activity| {
        let class = load_class(env, activity, "dev.tarve.TarveBiometric")?;
        env.register_native_methods(
            &class,
            &[jni::NativeMethod {
                name: "nativeResult".into(),
                sig: "(Ljava/lang/String;ZLjava/lang/String;Ljava/lang/String;)V".into(),
                fn_ptr: native_authenticated as *mut std::ffi::c_void,
            }],
        )?;
        let id = env.new_string(&request.request_id)?;
        let reason = env.new_string(&request.reason)?;
        env.call_static_method(
            &class,
            "authenticate",
            "(Landroid/app/Activity;Ljava/lang/String;Ljava/lang/String;)V",
            &[
                JValue::Object(activity),
                JValue::Object(&id),
                JValue::Object(&reason),
            ],
        )?;
        Ok(())
    })
    .map_err(|error| {
        log(LOG_WARN, &format!("tarve: authenticate: {error}"));
        format!("Could not show the biometric prompt: {error}")
    })
}

/// Starts, refreshes or (`active` false) ends `dev.tarve.TarveKeepAlive`, the foreground service
/// that keeps the process running in the background. The app declares
/// FOREGROUND_SERVICE_SPECIAL_USE (and POST_NOTIFICATIONS to show the notification).
pub(crate) fn keep_alive(active: bool, title: &str, text: &str) -> Result<(), String> {
    with_env(|env, activity| {
        let class = load_class(env, activity, "dev.tarve.TarveKeepAlive")?;
        let title = env.new_string(title)?;
        let text = env.new_string(text)?;
        env.call_static_method(
            &class,
            "update",
            "(Landroid/content/Context;ZLjava/lang/String;Ljava/lang/String;)V",
            &[
                JValue::Object(activity),
                JValue::Bool(active.into()),
                JValue::Object(&title),
                JValue::Object(&text),
            ],
        )?;
        Ok(())
    })
    .map_err(|error| {
        log(LOG_WARN, &format!("tarve: keepAlive: {error}"));
        format!("Could not keep the app running: {error}")
    })
}

const KEYSTORE: &str = "AndroidKeyStore";

fn keystore<'local>(env: &mut JNIEnv<'local>) -> jni::errors::Result<JObject<'local>> {
    let provider = env.new_string(KEYSTORE)?;
    let store = env
        .call_static_method(
            "java/security/KeyStore",
            "getInstance",
            "(Ljava/lang/String;)Ljava/security/KeyStore;",
            &[JValue::Object(&provider)],
        )?
        .l()?;
    env.call_method(
        &store,
        "load",
        "(Ljava/security/KeyStore$LoadStoreParameter;)V",
        &[JValue::Object(&JObject::null())],
    )?;
    Ok(store)
}

/// The AES key `alias` in the Android Keystore, made on first use (`create`). It never leaves
/// the secure hardware: the app can only ask it to encrypt and decrypt.
fn keystore_key<'local>(
    env: &mut JNIEnv<'local>,
    alias: &str,
    create: bool,
) -> jni::errors::Result<Option<JObject<'local>>> {
    let store = keystore(env)?;
    let name = env.new_string(alias)?;
    if env
        .call_method(&store, "containsAlias", "(Ljava/lang/String;)Z", &[JValue::Object(&name)])?
        .z()?
    {
        let key = env
            .call_method(
                &store,
                "getKey",
                "(Ljava/lang/String;[C)Ljava/security/Key;",
                &[JValue::Object(&name), JValue::Object(&JObject::null())],
            )?
            .l()?;
        return Ok(Some(key));
    }
    if !create {
        return Ok(None);
    }
    let provider = env.new_string(KEYSTORE)?;
    let algorithm = env.new_string("AES")?;
    let generator = env
        .call_static_method(
            "javax/crypto/KeyGenerator",
            "getInstance",
            "(Ljava/lang/String;Ljava/lang/String;)Ljavax/crypto/KeyGenerator;",
            &[JValue::Object(&algorithm), JValue::Object(&provider)],
        )?
        .l()?;
    // PURPOSE_ENCRYPT | PURPOSE_DECRYPT
    let builder = env.new_object(
        "android/security/keystore/KeyGenParameterSpec$Builder",
        "(Ljava/lang/String;I)V",
        &[JValue::Object(&name), JValue::Int(3)],
    )?;
    let gcm = env.new_string("GCM")?;
    let modes = env.new_object_array(1, "java/lang/String", &gcm)?;
    env.call_method(
        &builder,
        "setBlockModes",
        "([Ljava/lang/String;)Landroid/security/keystore/KeyGenParameterSpec$Builder;",
        &[JValue::Object(&modes)],
    )?;
    let none = env.new_string("NoPadding")?;
    let paddings = env.new_object_array(1, "java/lang/String", &none)?;
    env.call_method(
        &builder,
        "setEncryptionPaddings",
        "([Ljava/lang/String;)Landroid/security/keystore/KeyGenParameterSpec$Builder;",
        &[JValue::Object(&paddings)],
    )?;
    let spec = env
        .call_method(&builder, "build", "()Landroid/security/keystore/KeyGenParameterSpec;", &[])?
        .l()?;
    env.call_method(
        &generator,
        "init",
        "(Ljava/security/spec/AlgorithmParameterSpec;)V",
        &[JValue::Object(&spec)],
    )?;
    Ok(Some(env.call_method(&generator, "generateKey", "()Ljavax/crypto/SecretKey;", &[])?.l()?))
}

fn gcm_cipher<'local>(env: &mut JNIEnv<'local>) -> jni::errors::Result<JObject<'local>> {
    let name = env.new_string("AES/GCM/NoPadding")?;
    env.call_static_method(
        "javax/crypto/Cipher",
        "getInstance",
        "(Ljava/lang/String;)Ljavax/crypto/Cipher;",
        &[JValue::Object(&name)],
    )?
    .l()
}

/// Encrypts `plain` with the Keystore key `alias`: the 12-byte nonce, then ciphertext and tag.
pub(crate) fn seal(alias: &str, plain: &[u8]) -> Result<Vec<u8>, String> {
    with_env(|env, _| {
        let key = keystore_key(env, alias, true)?.expect("created");
        let cipher = gcm_cipher(env)?;
        env.call_method(&cipher, "init", "(ILjava/security/Key;)V", &[JValue::Int(1), JValue::Object(&key)])?;
        let iv = JByteArray::from(env.call_method(&cipher, "getIV", "()[B", &[])?.l()?);
        let input = env.byte_array_from_slice(plain)?;
        let sealed = JByteArray::from(
            env.call_method(&cipher, "doFinal", "([B)[B", &[JValue::Object(&input)])?.l()?,
        );
        let mut out = env.convert_byte_array(&iv)?;
        out.extend(env.convert_byte_array(&sealed)?);
        Ok(out)
    })
    .map_err(|error| format!("Could not seal the data: {error}"))
}

/// Decrypts what `seal` made with the same key.
pub(crate) fn open(alias: &str, sealed: &[u8]) -> Result<Vec<u8>, String> {
    if sealed.len() < 12 + 16 {
        return Err("the sealed data is too short".into());
    }
    with_env(|env, _| {
        let Some(key) = keystore_key(env, alias, false)? else {
            return Ok(None);
        };
        let cipher = gcm_cipher(env)?;
        let iv = env.byte_array_from_slice(&sealed[..12])?;
        let spec = env.new_object(
            "javax/crypto/spec/GCMParameterSpec",
            "(I[B)V",
            &[JValue::Int(128), JValue::Object(&iv)],
        )?;
        env.call_method(
            &cipher,
            "init",
            "(ILjava/security/Key;Ljava/security/spec/AlgorithmParameterSpec;)V",
            &[JValue::Int(2), JValue::Object(&key), JValue::Object(&spec)],
        )?;
        let input = env.byte_array_from_slice(&sealed[12..])?;
        let plain = JByteArray::from(
            env.call_method(&cipher, "doFinal", "([B)[B", &[JValue::Object(&input)])?.l()?,
        );
        Ok(Some(env.convert_byte_array(&plain)?))
    })
    .map_err(|error| format!("Could not open the sealed data: {error}"))?
    .ok_or_else(|| "the key that sealed this data is gone (the app was reinstalled or its data cleared)".into())
}

/// Deletes the Keystore key `alias`: what it sealed can never be opened again.
pub(crate) fn forget(alias: &str) -> Result<(), String> {
    with_env(|env, _| {
        let store = keystore(env)?;
        let name = env.new_string(alias)?;
        env.call_method(&store, "deleteEntry", "(Ljava/lang/String;)V", &[JValue::Object(&name)])?;
        Ok(())
    })
    .map_err(|error| format!("Could not delete the key: {error}"))
}

#[allow(clippy::too_many_arguments)]
extern "system" fn native_speech(
    mut env: JNIEnv,
    _: JClass,
    session: JString,
    phase: JString,
    text: JString,
    level: jdouble,
    code: JString,
    message: JString,
) {
    let (Some(session), Some(phase)) = (
        optional_string(&mut env, &session),
        optional_string(&mut env, &phase),
    ) else {
        return;
    };
    let text = optional_string(&mut env, &text);
    let code = optional_string(&mut env, &code);
    let message = optional_string(&mut env, &message);
    crate::bridge::entry_points::emit(speech_event(
        &session,
        &phase,
        text.as_deref(),
        (phase == "level").then_some(level),
        code.as_deref(),
        message.as_deref(),
    ));
}

/// `start`, `stop` or `cancel` a dictation session through `TarveSpeech`; Err when it cannot.
pub(crate) fn speech(request: &Speech) -> Result<(), String> {
    with_env(|env, activity| {
        let class = load_class(env, activity, "dev.tarve.TarveSpeech")?;
        env.register_native_methods(
            &class,
            &[jni::NativeMethod {
                name: "nativeSpeech".into(),
                sig: "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;DLjava/lang/String;Ljava/lang/String;)V".into(),
                fn_ptr: native_speech as *mut std::ffi::c_void,
            }],
        )?;
        let session = env.new_string(&request.session_id)?;
        match request.action.as_str() {
            "start" => {
                let language = java_string(env, &request.language)?;
                env.call_static_method(
                    &class,
                    "start",
                    "(Landroid/app/Activity;Ljava/lang/String;Ljava/lang/String;Z)V",
                    &[
                        JValue::Object(activity),
                        JValue::Object(&session),
                        JValue::Object(&language),
                        JValue::Bool(request.partial_results.into()),
                    ],
                )?;
            }
            action => {
                env.call_static_method(
                    &class,
                    action,
                    "(Landroid/app/Activity;Ljava/lang/String;)V",
                    &[JValue::Object(activity), JValue::Object(&session)],
                )?;
            }
        }
        Ok(())
    })
    .map_err(|error| {
        log(LOG_WARN, &format!("tarve: speech: {error}"));
        format!("Could not use speech recognition: {error}")
    })
}
