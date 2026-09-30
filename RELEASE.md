# Tarve release policy

Tarve currently ships for **Windows x64 and Linux x64**. The release process is intentionally fail-closed: a release tag must match the product version, and the complete verification gate must pass. The npm package stages both native runtimes so `tarve build --target windows-x64|linux-x64` can cross-compile application executables.

The npm artifact is universal across those two targets: Linux CI builds `libtarve_native.so`, Windows CI builds `tarve_native.dll`, and packaging only proceeds after both are staged. Each runtime includes compatibility metadata with its target, protocol/ABI versions, source fingerprint, and binary hash. Packaging rejects missing, stale, mismatched, or modified runtimes before publishing.

## License and distribution

- Tarve is licensed under the **Apache License 2.0**. The canonical license text is in `LICENSE`, and package manifests use the SPDX identifier `Apache-2.0`.
- `@tarve/core-internal` and `@tarve/protocol` are private workspace packages for repository organization, but inherit the same Apache-2.0 license.
- The native Rust crate declares `license = "Apache-2.0"` and remains `publish = false`; it is distributed as part of Tarve rather than as an independent crates.io package.
- The automated release-policy gate rejects license drift between the root package, workspace packages, native crate, and the canonical `LICENSE` file.
- The release workflow publishes GitHub release artifacts and then publishes the same verified npm tarball to the npm registry (see *npm publishing* below).

## Version policy

There are three independent version domains:

1. **Product SemVer** — one version shared by the root npm package, `@tarve/core-internal`, `@tarve/protocol`, their workspace entries in `bun.lock`, `native/Cargo.toml` and the `tarve_native` entry in `Cargo.lock`.
2. **JSON protocol version** — a monotonically increasing integer used by serialized TS/Rust messages. It is currently **v48** and is independent from package SemVer.
3. **Native C ABI version** — a monotonically increasing integer for exported FFI function compatibility. It is currently **v5** and is independent from both product SemVer and the JSON protocol.

Use the version tool rather than editing manifests independently:

```powershell
bun run version:check
bun run version:set -- 0.2.0
```

`bun run release:policy` rejects product-version drift, license-policy drift, protocol mismatches and ABI mismatches.

## Code signing

Tarve is a framework, not an end-user application, so the Tarve release does **not** Authenticode-sign its native runtimes. Signing is the responsibility of each application author: sign the executable produced by `tarve build` with your own certificate (for example `signtool sign /fd SHA256 /tr <timestamp-url> /td SHA256 dist/App.exe`). The published npm tarball is instead protected by npm provenance and by the SHA-256 hashes in `dist/release-manifest.json`.

## Release procedure

1. `bun run version:set -- <semver>` and rename the `## Unreleased` section of `CHANGELOG.md` to `## <semver> — <date>` (`release:policy` rejects a version without its own section). Commit and push to `main`; wait for CI to pass.
2. Tag that commit with exactly `v<semver>` and push the tag: `git tag v0.2.0 && git push origin v0.2.0`.
3. `.github/workflows/release.yml` then, without further input:
   - checks that the tag matches the product version and points to a commit on `main`;
   - requires a successful CI run for the tagged commit (CI runs the full gate on both platforms), waiting for it if it is still running;
   - builds the Linux runtime on Linux and the Windows runtime on Windows;
   - packs the universal tarball, verifies it contains exactly the staged runtimes and the tagged version, and writes SHA-256 hashes to `dist/release-manifest.json`;
   - creates the GitHub release with those artifacts;
   - publishes `@tarve/core` and `@tarve/react-icons` to npm from those same tarballs (never repacked), with provenance: stable versions as `latest`, prereleases (`v0.2.0-beta.1`) as `next` and as GitHub prereleases.

A published npm version cannot be reused: if a release fails after publishing, fix forward with a new patch version.
