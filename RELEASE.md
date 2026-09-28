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
2. **JSON protocol version** — a monotonically increasing integer used by serialized TS/Rust messages. It is currently **v45** and is independent from package SemVer.
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

1. Update the product version with `bun run version:set -- <semver>`.
2. Commit the version change and run `bun run release:check`.
3. Create an annotated or lightweight tag exactly matching `v<semver>`, for example `v0.2.0`.
4. Push the commit and tag.
5. `.github/workflows/release.yml` verifies that the tag points to a commit reachable from the default branch, reruns the full release gate, packs the universal npm tarball, verifies that it contains exactly the staged Windows and Linux runtimes, emits SHA-256 hashes in `dist/release-manifest.json`, uploads the artifacts and creates the GitHub release.

Prerelease SemVer tags such as `v0.2.0-beta.1` are published as GitHub prereleases.

## npm publishing

The `npm-publish` job in `.github/workflows/release.yml` runs only after the Windows release job succeeds. It publishes `@tarve/core` from the exact `dist/tarve-core-<version>.tgz` produced and verified by `release:build` (it never repacks), with npm provenance attestation:

- stable versions go to the `latest` dist-tag; prerelease versions (`0.2.0-beta.1`) go to `next`;
- the job is fail-closed: it refuses to run without the `NPM_TOKEN` secret, verifies the tarball name matches the tag, and skips nothing silently;
- publishing requires the `npm` GitHub environment, so a required reviewer can gate the registry step.

One-time setup:

1. The package is published under the `tarve` npm organization (the unscoped name `tarve` is rejected by npm as too similar to `tar`). Owners need 2FA enabled.
2. Create a granular **automation** access token with read-and-write access to the `@tarve` scope (organization `tarve`) and store it as the `NPM_TOKEN` secret of the `npm` GitHub environment.
3. Optionally add required reviewers to the `npm` environment.

To inspect what would be published locally, stage both native runtimes, then:

```powershell
bun run package
bun run pack
npm publish --dry-run (Get-ChildItem dist/tarve-core-*.tgz).FullName
```

For a local release rehearsal (both runtimes staged):

```powershell
bun run release:build -- --tag v0.1.0
```
