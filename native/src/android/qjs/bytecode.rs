use super::*;

/// Files the app imports (`with { type: "file" }`, images, fonts) are paths at run time:
/// `assets/tarve/files/<name>` is copied once to `<files>/tarve-assets/<name>`.
/// Where the bundle's bytecode is cached between launches: the app's cache directory, keyed
/// by the bundle and this runtime's version (an update or a new engine compiles afresh).
pub(super) fn bytecode_cache(files_dir: &Path, bundle: &[u8]) -> Option<PathBuf> {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::hash::DefaultHasher::new();
    bundle.hash(&mut hasher);
    env!("CARGO_PKG_VERSION").hash(&mut hasher);
    let directory = files_dir.parent()?.join("cache");
    Some(directory.join(format!("tarve-app-{:016x}.qbc", hasher.finish())))
}

pub(super) fn checksum(bytes: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::hash::DefaultHasher::new();
    bytes.hash(&mut hasher);
    hasher.finish()
}

/// The cached bytecode, if whole: an 8-byte checksum, then the module. QuickJS reads it in
/// place (JS_READ_OBJ_ROM_DATA), so the bytes live as long as the process.
pub(super) fn cached_bytecode(path: &Path) -> Option<&'static [u8]> {
    let data = std::fs::read(path).ok()?;
    let (head, body) = data.split_at_checked(8)?;
    if u64::from_le_bytes(head.try_into().ok()?) != checksum(body) {
        return None;
    }
    Some(&Box::leak(data.into_boxed_slice())[8..])
}

/// The app's module, declared from cached bytecode when there is some (skipping the parse of
/// the whole bundle on every launch after the first), else from source, then cached.
pub(super) fn declare_bundle<'js>(
    ctx: &Ctx<'js>,
    bundle: Vec<u8>,
    cache: Option<&Path>,
) -> rquickjs::Result<Module<'js, rquickjs::module::Declared>> {
    if let Some(path) = cache
        && let Some(bytes) = cached_bytecode(path)
    {
        // SAFETY: bytecode this runtime wrote for this bundle, checked whole by its checksum.
        match unsafe { Module::load(ctx.clone(), bytes) } {
            Ok(module) => return Ok(module),
            Err(_) => {
                let _ = ctx.catch();
                let _ = std::fs::remove_file(path);
            }
        }
    }
    let module = Module::declare(ctx.clone(), "app.js", bundle)?;
    if let Some(path) = cache
        && let Ok(bytecode) = module.write(rquickjs::module::WriteOptions::default())
    {
        let path = path.to_owned();
        std::thread::spawn(move || write_bytecode(&path, &bytecode));
    }
    Ok(module)
}

/// Writes the cache atomically and drops the caches of earlier bundles.
pub(super) fn write_bytecode(path: &Path, bytecode: &[u8]) {
    let Some(directory) = path.parent() else {
        return;
    };
    if std::fs::create_dir_all(directory).is_err() {
        return;
    }
    if let Ok(entries) = std::fs::read_dir(directory) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name.to_string_lossy().starts_with("tarve-app-") && entry.path() != path {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    let mut data = Vec::with_capacity(bytecode.len() + 8);
    data.extend_from_slice(&checksum(bytecode).to_le_bytes());
    data.extend_from_slice(bytecode);
    let temporary = path.with_extension("tmp");
    if std::fs::write(&temporary, &data).is_ok() && std::fs::rename(&temporary, path).is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
}

pub(super) fn extract_assets(
    app: &AndroidApp,
    files_dir: &Path,
) -> Result<Vec<(String, String)>, String> {
    let Some(index) = read_asset(app, "tarve/files.json") else {
        return Ok(Vec::new());
    };
    let index: Vec<serde_json::Value> =
        serde_json::from_slice(&index).map_err(|e| format!("tarve/files.json: {e}"))?;
    let directory = files_dir.join("tarve-assets");
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for entry in index {
        let Some(name) = entry["name"].as_str() else {
            continue;
        };
        if name.contains('/') || name.contains("..") {
            return Err(format!("invalid asset name {name}"));
        }
        let target = directory.join(name);
        let size = entry["size"].as_u64().unwrap_or(u64::MAX);
        if std::fs::metadata(&target).map(|m| m.len()).ok() != Some(size) {
            let bytes = read_asset(app, &format!("tarve/files/{name}"))
                .ok_or_else(|| format!("asset {name} is missing from the APK"))?;
            let temporary = directory.join(format!("{name}.tmp"));
            std::fs::write(&temporary, &bytes).map_err(|e| e.to_string())?;
            std::fs::rename(&temporary, &target).map_err(|e| e.to_string())?;
        }
        out.push((name.to_owned(), target.to_string_lossy().into_owned()));
    }
    Ok(out)
}

pub(super) fn errno(error: &std::io::Error) -> &'static str {
    match error.raw_os_error() {
        Some(2) => "ENOENT",
        Some(13) => "EACCES",
        Some(1) => "EPERM",
        Some(17) => "EEXIST",
        Some(20) => "ENOTDIR",
        Some(21) => "EISDIR",
        Some(39) => "ENOTEMPTY",
        Some(28) => "ENOSPC",
        Some(30) => "EROFS",
        _ => match error.kind() {
            std::io::ErrorKind::NotFound => "ENOENT",
            std::io::ErrorKind::PermissionDenied => "EACCES",
            std::io::ErrorKind::AlreadyExists => "EEXIST",
            _ => "EIO",
        },
    }
}

/// Node-style error: the shim reads the code before the colon.
pub(super) fn io_error(
    ctx: &Ctx,
    syscall: &str,
    path: &str,
    error: std::io::Error,
) -> rquickjs::Error {
    Exception::throw_message(
        ctx,
        &format!("{}: {error}, {syscall} '{path}'", errno(&error)),
    )
}

pub(super) fn bytes_of<'a>(array: &'a TypedArray<'_, u8>) -> &'a [u8] {
    array.as_bytes().unwrap_or_default()
}
