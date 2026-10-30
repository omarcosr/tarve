//! `tarve dev --target android`: a dev APK (packed with an `assets/tarve/dev` marker) runs
//! the bundle the CLI pushes to `<external files>/dev/app.js` (the app reads its own
//! external directory without permissions; `adb push` writes it) instead of
//! `assets/tarve/app.js`, and finds files the edited app imports in `dev/files/`.

use super::*;

/// The directory of the pushed bundle, for a dev APK that has one.
pub(super) fn dev_directory(app: &AndroidApp) -> Option<PathBuf> {
    let dev_build = read_asset(app, "tarve/dev").is_some();
    select_dev_directory(dev_build, app.external_data_path().as_deref())
}

/// `<external>/dev` when this is a dev build and the CLI pushed `app.js` there.
pub(super) fn select_dev_directory(dev_build: bool, external: Option<&Path>) -> Option<PathBuf> {
    let directory = external?.join("dev");
    (dev_build && directory.join("app.js").is_file()).then_some(directory)
}

/// Files a pushed bundle imports that the APK does not carry: `dev/files/<name>`.
pub(super) fn add_dev_assets(directory: &Path, assets: &mut Vec<(String, String)>) {
    let Ok(entries) = std::fs::read_dir(directory.join("files")) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !assets.iter().any(|(known, _)| *known == name) {
            assets.push((name, entry.path().to_string_lossy().into_owned()));
        }
    }
}
