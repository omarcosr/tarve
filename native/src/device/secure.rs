//! Keeping the app running in the background (`keepAlive`) and sealing its secrets
//! (`secureStore`).
//!
//! `secureStore` encrypts bytes with a key only this app, on this device, can use: an AES-GCM
//! key in the Android Keystore (`tarve.secure.<alias>`, it never leaves the secure hardware) or
//! DPAPI on Windows (bound to the signed-in user, the alias as entropy). The sealed bytes go back
//! to the caller, which keeps them (packages/core/src/app/device.ts writes them under the app's
//! config directory). macOS (Keychain) and Linux (libsecret) answer `supported: false`.
//!
//! `keepAlive` starts, updates or ends Android's `dev.tarve.TarveKeepAlive` foreground service.
//! Desktops never suspend a running app: there it answers `supported: false` and nothing is
//! needed.
use crate::protocol::requests::{KeepAlive, SecureStore};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};

/// A `keepAlive` answer.
pub(crate) fn keep_alive_event(id: &str, supported: bool, error: Option<&str>) -> Value {
    let mut event = json!({"type":"keepAlive", "requestId":id, "supported":supported});
    if let Some(error) = error {
        event["error"] = json!(error);
    }
    event
}

/// Starts, refreshes (`active` with a new title or text) or ends the background service.
pub(crate) fn keep_alive(request: &KeepAlive) -> Value {
    if super::fake::enabled() {
        return keep_alive_event(&request.request_id, true, None);
    }
    #[cfg(target_os = "android")]
    {
        let result =
            crate::android::device::keep_alive(request.active, &request.title, &request.text);
        keep_alive_event(&request.request_id, true, result.err().as_deref())
    }
    #[cfg(not(target_os = "android"))]
    keep_alive_event(&request.request_id, false, None)
}

#[derive(Debug, PartialEq)]
enum Failure {
    Unsupported,
    Failed(String),
}

/// A name the platforms accept as a key alias and the app as a file name.
pub(crate) fn valid_alias(alias: &str) -> bool {
    !alias.is_empty()
        && alias.len() <= 64
        && alias
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// Answers a `secureStore` request: `data` (base64) for `seal` and `open`, none for `delete`.
pub(crate) fn secure_store(request: &SecureStore) -> Value {
    let mut event =
        json!({"type":"secureStore", "requestId":request.request_id, "supported":true});
    match run(request) {
        Ok(Some(bytes)) => event["data"] = json!(STANDARD.encode(bytes)),
        Ok(None) => {}
        Err(Failure::Unsupported) => {
            event["supported"] = json!(false);
            event["error"] = json!("secure storage is not available on this platform");
        }
        Err(Failure::Failed(message)) => event["error"] = json!(message),
    }
    event
}

fn run(request: &SecureStore) -> Result<Option<Vec<u8>>, Failure> {
    if !valid_alias(&request.alias) {
        return Err(Failure::Failed(
            "secureStore alias must be 1-64 letters, digits, '.', '_' or '-'".into(),
        ));
    }
    let data = match request.action.as_str() {
        "seal" | "open" => STANDARD
            .decode(request.data.as_deref().unwrap_or(""))
            .map_err(|error| Failure::Failed(format!("secureStore data is not base64: {error}")))?,
        "delete" => Vec::new(),
        other => return Err(Failure::Failed(format!("unknown secureStore action {other}"))),
    };
    if super::fake::enabled() {
        return fake(&request.action, &request.alias, &data);
    }
    platform(&request.action, &request.alias, &data)
}

const FAKE_TAG: &[u8] = b"tarve-fake-seal:";

/// `TARVE_DEVICE=fake`: a reversible mask tagged with the alias, so a test sees sealed bytes
/// differ from the input and an `open` under another alias fail. The alias `unsupported`
/// answers as a platform without secure storage.
fn fake(action: &str, alias: &str, data: &[u8]) -> Result<Option<Vec<u8>>, Failure> {
    if alias == "unsupported" {
        return Err(Failure::Unsupported);
    }
    let mask = |bytes: &[u8]| bytes.iter().map(|byte| byte ^ 0x5a).collect::<Vec<u8>>();
    let prefix = [FAKE_TAG, alias.as_bytes(), b":"].concat();
    match action {
        "seal" => Ok(Some([prefix, mask(data)].concat())),
        "open" => match data.strip_prefix(prefix.as_slice()) {
            Some(sealed) => Ok(Some(mask(sealed))),
            None => Err(Failure::Failed(
                "the sealed data was not made with this alias".into(),
            )),
        },
        _ => Ok(None),
    }
}

#[cfg(target_os = "android")]
fn platform(action: &str, alias: &str, data: &[u8]) -> Result<Option<Vec<u8>>, Failure> {
    let key = format!("tarve.secure.{alias}");
    match action {
        "seal" => crate::android::device::seal(&key, data).map(Some),
        "open" => crate::android::device::open(&key, data).map(Some),
        _ => crate::android::device::forget(&key).map(|()| None),
    }
    .map_err(Failure::Failed)
}

#[cfg(target_os = "windows")]
fn platform(action: &str, alias: &str, data: &[u8]) -> Result<Option<Vec<u8>>, Failure> {
    match action {
        "seal" => dpapi::call(alias, data, true).map(Some),
        "open" => dpapi::call(alias, data, false).map(Some),
        // DPAPI keeps no per-alias key: forgetting is the caller dropping the sealed bytes.
        _ => Ok(None),
    }
    .map_err(Failure::Failed)
}

#[cfg(not(any(target_os = "android", target_os = "windows")))]
fn platform(_action: &str, _alias: &str, _data: &[u8]) -> Result<Option<Vec<u8>>, Failure> {
    Err(Failure::Unsupported)
}

/// CryptProtectData / CryptUnprotectData (crypt32), declared here so the `windows` crates need
/// no extra feature.
#[cfg(target_os = "windows")]
mod dpapi {
    use std::ffi::c_void;
    use std::ptr::{null, null_mut};

    #[repr(C)]
    struct Blob {
        len: u32,
        data: *mut u8,
    }

    /// Never show a UI: the app is the only caller.
    const UI_FORBIDDEN: u32 = 0x1;

    #[link(name = "crypt32")]
    unsafe extern "system" {
        fn CryptProtectData(
            input: *const Blob,
            description: *const u16,
            entropy: *const Blob,
            reserved: *const c_void,
            prompt: *const c_void,
            flags: u32,
            output: *mut Blob,
        ) -> i32;
        fn CryptUnprotectData(
            input: *const Blob,
            description: *mut *mut u16,
            entropy: *const Blob,
            reserved: *const c_void,
            prompt: *const c_void,
            flags: u32,
            output: *mut Blob,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
    }

    pub(super) fn call(alias: &str, data: &[u8], protect: bool) -> Result<Vec<u8>, String> {
        let mut entropy = alias.as_bytes().to_vec();
        let input = Blob {
            len: u32::try_from(data.len()).map_err(|_| "the data is too large".to_string())?,
            data: data.as_ptr().cast_mut(),
        };
        let entropy = Blob {
            len: entropy.len() as u32,
            data: entropy.as_mut_ptr(),
        };
        let mut output = Blob {
            len: 0,
            data: null_mut(),
        };
        // SAFETY: the blobs point at live buffers for the call; DPAPI only reads them and
        // allocates `output` with LocalAlloc, freed below.
        let ok = unsafe {
            if protect {
                CryptProtectData(&input, null(), &entropy, null(), null(), UI_FORBIDDEN, &mut output)
            } else {
                CryptUnprotectData(
                    &input,
                    null_mut(),
                    &entropy,
                    null(),
                    null(),
                    UI_FORBIDDEN,
                    &mut output,
                )
            }
        };
        if ok == 0 {
            let name = if protect { "seal" } else { "open" };
            return Err(format!("Could not {name} the data: {}", std::io::Error::last_os_error()));
        }
        if output.data.is_null() {
            return Ok(Vec::new());
        }
        // SAFETY: DPAPI answered `len` bytes at `data`, ours until LocalFree.
        let bytes = unsafe { std::slice::from_raw_parts(output.data, output.len as usize) }.to_vec();
        unsafe { LocalFree(output.data.cast()) };
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::Command;

    fn request(action: &str, alias: &str, data: Option<&[u8]>) -> SecureStore {
        SecureStore {
            request_id: "r".into(),
            action: action.into(),
            alias: alias.into(),
            data: data.map(|data| STANDARD.encode(data)),
        }
    }

    #[test]
    fn keep_alive_and_secure_store_commands_parse() {
        let keep: Command = serde_json::from_value(
            json!({"type":"keepAlive", "requestId":"r", "active":true, "title":"T"}),
        )
        .unwrap();
        assert!(
            matches!(keep, Command::KeepAlive(KeepAlive { active: true, ref title, ref text, .. }) if title == "T" && text.is_empty())
        );
        let store: Command = serde_json::from_value(
            json!({"type":"secureStore", "requestId":"r", "action":"seal", "alias":"a", "data":"AQI="}),
        )
        .unwrap();
        assert!(
            matches!(store, Command::SecureStore(SecureStore { ref action, ref data, .. }) if action == "seal" && data.as_deref() == Some("AQI="))
        );
    }

    #[test]
    fn aliases_are_safe_file_and_key_names() {
        for alias in ["vault", "termio.unlock", "a_b-1"] {
            assert!(valid_alias(alias), "{alias}");
        }
        for alias in ["", "../x", "a/b", "a b", "ç", &"x".repeat(65)] {
            assert!(!valid_alias(alias), "{alias}");
        }
        let event = secure_store(&request("seal", "../x", Some(b"s")));
        assert_eq!(event["supported"], json!(true));
        assert!(event["error"].as_str().unwrap().contains("alias"));
        let event = secure_store(&request("burn", "a", None));
        assert_eq!(event["error"], json!("unknown secureStore action burn"));
    }

    #[test]
    fn the_fake_seals_reversibly_and_per_alias() {
        let sealed = fake("seal", "a", b"secret").unwrap().unwrap();
        assert_ne!(sealed, b"secret");
        assert_eq!(fake("open", "a", &sealed).unwrap().unwrap(), b"secret");
        assert!(matches!(fake("open", "b", &sealed), Err(Failure::Failed(_))));
        assert_eq!(fake("delete", "a", &[]), Ok(None));
        assert_eq!(fake("seal", "unsupported", b"x"), Err(Failure::Unsupported));
    }

    #[test]
    fn answers_have_one_shape() {
        assert_eq!(
            keep_alive_event("r", false, None),
            json!({"type":"keepAlive", "requestId":"r", "supported":false})
        );
        assert_eq!(
            keep_alive_event("r", true, Some("no")),
            json!({"type":"keepAlive", "requestId":"r", "supported":true, "error":"no"})
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn dpapi_seals_for_this_user_and_alias() {
        let sealed = dpapi::call("termio.test", b"secret", true).unwrap();
        assert!(!sealed.windows(6).any(|window| window == b"secret"));
        assert_eq!(dpapi::call("termio.test", &sealed, false).unwrap(), b"secret");
        assert!(dpapi::call("other", &sealed, false).is_err());
        let event = secure_store(&request("open", "termio.test", Some(&sealed)));
        assert_eq!(event["data"], json!(STANDARD.encode(b"secret")));
    }
}
