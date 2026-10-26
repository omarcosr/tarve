//! A Bun app on Android (`tarve build app.tsx --target android --runtime bun`): the app is a
//! Bun executable built with `bun build --compile --target=bun-linux-<arch>-android` and packed
//! as `lib/<abi>/libtarvebun.so`, so the package manager extracts it where an app may execute
//! files. It runs as a child process of the activity: the window, the GPU surface and the JNI
//! services stay in this process, and the child calls the C ABI (`tarve_start`, `tarve_send`,
//! `tarve_poll_event`, …) over a socket pair on its fd 3 (packages/core/src/bridge/remote.ts).
//! Events wake it through the bridge's usual Unix socket (`tarve_event_pipe_name`), which the
//! child connects to as Bun does on Linux.
//!
//! Frame: request `[op u8][len u32 LE][payload]` (for the calls that fill a buffer the payload
//! is the capacity, u32 LE); response `[result i32 LE][len u32 LE][bytes]`.

use super::{LOG_ERROR, LOG_INFO, log, with_env};
use jni::objects::JString;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};

/// The file name `tarve build --runtime bun` gives the app's Bun executable.
const EXECUTABLE: &str = "libtarvebun.so";
/// The child's end of the socket pair.
const BRIDGE_FD: i32 = 3;

const OP_ABI: u8 = 0;
const OP_START: u8 = 1;
const OP_SEND: u8 = 2;
const OP_POLL: u8 = 3;
const OP_PIPE_NAME: u8 = 4;
const OP_LAST_ERROR: u8 = 5;
const OP_OPEN_EXTERNAL: u8 = 6;
const OP_JOIN: u8 = 7;

unsafe extern "C" {
    fn dup2(old: i32, new: i32) -> i32;
    fn prctl(option: i32, arg2: u64, arg3: u64, arg4: u64, arg5: u64) -> i32;
}

/// `<nativeLibraryDir>/libtarvebun.so` when this APK carries a Bun app.
pub(crate) fn executable() -> Option<PathBuf> {
    let directory: String = with_env(|env, activity| {
        let info = env
            .call_method(
                activity,
                "getApplicationInfo",
                "()Landroid/content/pm/ApplicationInfo;",
                &[],
            )?
            .l()?;
        let directory = env
            .get_field(&info, "nativeLibraryDir", "Ljava/lang/String;")?
            .l()?;
        Ok(env.get_string(&JString::from(directory))?.into())
    })
    .ok()?;
    let path = PathBuf::from(directory).join(EXECUTABLE);
    path.is_file().then_some(path)
}

/// Starts the Bun app and answers its bridge calls until it exits.
pub(crate) fn run(executable: PathBuf) -> Result<(), String> {
    let (mut host, child_end) = UnixStream::pair().map_err(|error| error.to_string())?;
    let child_fd = child_end.as_raw_fd();
    let mut command = Command::new(&executable);
    command
        .env("TARVE_ANDROID_BRIDGE_FD", BRIDGE_FD.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    // SAFETY: only async-signal-safe calls between fork and exec. dup2 clears close-on-exec on
    // fd 3; PR_SET_PDEATHSIG (1) ends the app with the activity's process.
    unsafe {
        command.pre_exec(move || {
            if dup2(child_fd, BRIDGE_FD) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            prctl(1, 9, 0, 0, 0);
            Ok(())
        });
    }
    let mut child = command.spawn().map_err(|error| {
        format!(
            "could not start the Bun app {}: {error}",
            executable.display()
        )
    })?;
    drop(child_end);
    crate::stats::trace("bun child");
    log(
        LOG_INFO,
        &format!("tarve: Bun app started (pid {})", child.id()),
    );
    let served = serve(&mut host);
    drop(host);
    let status = child.wait().map_err(|error| error.to_string())?;
    if let Err(error) = served {
        log(LOG_ERROR, &format!("tarve: Bun bridge: {error}"));
    }
    if !status.success() {
        return Err(format!("the Bun app exited with {status}"));
    }
    Ok(())
}

fn serve(stream: &mut UnixStream) -> std::io::Result<()> {
    let mut header = [0_u8; 5];
    let mut payload = Vec::new();
    let mut out = Vec::new();
    loop {
        match stream.read_exact(&mut header) {
            Ok(()) => {}
            // The app exited: its end of the pair closed.
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(error) => return Err(error),
        }
        let length = u32::from_le_bytes([header[1], header[2], header[3], header[4]]) as usize;
        payload.resize(length, 0);
        stream.read_exact(&mut payload)?;
        out.clear();
        let result = call(header[0], &payload, &mut out);
        let mut response = Vec::with_capacity(8 + out.len());
        response.extend_from_slice(&result.to_le_bytes());
        response.extend_from_slice(&(out.len() as u32).to_le_bytes());
        response.extend_from_slice(&out);
        stream.write_all(&response)?;
    }
}

/// One C ABI call; `out` receives the bytes a buffer-filling call wrote.
fn call(op: u8, payload: &[u8], out: &mut Vec<u8>) -> i32 {
    use crate::bridge;
    let fill = |out: &mut Vec<u8>, f: unsafe extern "C" fn(*mut u8, u32) -> i32| -> i32 {
        let capacity = payload
            .get(..4)
            .map_or(0, |bytes| {
                u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
            })
            .clamp(1, 64 << 20);
        out.resize(capacity as usize, 0);
        // SAFETY: `out` holds `capacity` writable bytes.
        let result = unsafe { f(out.as_mut_ptr(), capacity) };
        out.truncate(result.max(0) as usize);
        result
    };
    // SAFETY: each entry point reads `payload.len()` bytes from `payload`.
    match op {
        OP_ABI => bridge::tarve_abi_version() as i32,
        OP_START => unsafe { bridge::tarve_start(payload.as_ptr(), payload.len() as u32) },
        OP_SEND => unsafe { bridge::tarve_send(payload.as_ptr(), payload.len() as u32) },
        OP_POLL => fill(out, bridge::tarve_poll_event),
        OP_PIPE_NAME => fill(out, bridge::tarve_event_pipe_name),
        OP_LAST_ERROR => fill(out, bridge::tarve_last_error),
        OP_OPEN_EXTERNAL => unsafe {
            bridge::tarve_open_external(payload.as_ptr(), payload.len() as u32)
        },
        OP_JOIN => bridge::tarve_join(),
        _ => -1,
    }
}
