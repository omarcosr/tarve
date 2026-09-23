# Tarve release policy

Tarve currently ships for **Windows x64**. The release process is intentionally fail-closed: a release tag must match the product version, the complete verification gate must pass, and official Windows binaries must carry a valid timestamped Authenticode signature.

## License and distribution

- Tarve is licensed under the **Apache License 2.0**. The canonical license text is in `LICENSE`, and package manifests use the SPDX identifier `Apache-2.0`.
- `@tarve/core` and `@tarve/protocol` are private workspace packages for repository organization, but inherit the same Apache-2.0 license.
- The native Rust crate declares `license = "Apache-2.0"` and remains `publish = false`; it is distributed as part of Tarve rather than as an independent crates.io package.
- The automated release-policy gate rejects license drift between the root package, workspace packages, native crate, and the canonical `LICENSE` file.
- The signed release workflow publishes GitHub release artifacts. Publishing the npm package to a registry remains a separate operational step until registry ownership/access is configured.

## Version policy

There are three independent version domains:

1. **Product SemVer** — one version shared by the root npm package, `@tarve/core`, `@tarve/protocol`, their workspace entries in `bun.lock`, `native/Cargo.toml` and the `tarve_native` entry in `Cargo.lock`.
2. **JSON protocol version** — a monotonically increasing integer used by serialized TS/Rust messages. It is currently **v29** and is independent from package SemVer.
3. **Native C ABI version** — a monotonically increasing integer for exported FFI function compatibility. It is currently **v1** and is independent from both product SemVer and the JSON protocol.

Use the version tool rather than editing manifests independently:

```powershell
bun run version:check
bun run version:set -- 0.2.0
```

`bun run release:policy` rejects product-version drift, license-policy drift, protocol mismatches and ABI mismatches.

## Authenticode policy

Official Windows release artifacts require SHA-256 Authenticode signatures with an RFC 3161 timestamp. The signed path covers:

- `dist/Tarve.exe`;
- `native/win32-x64/tarve_native.dll`;
- the same native DLL after extraction from the final npm `.tgz`.

For the standalone executable, the release builder signs the release DLL **before** embedding it and signs the final EXE afterward, so the DLL materialized at runtime retains its own Authenticode signature.

The release runner accepts exactly one certificate source:

- `TARVE_AUTHENTICODE_PFX_BASE64` — base64-encoded PFX, intended for CI secrets; or
- `TARVE_AUTHENTICODE_PFX_PATH` — local PFX path.

`TARVE_AUTHENTICODE_PFX_PASSWORD` is required. `TARVE_AUTHENTICODE_TIMESTAMP_URL` is optional and defaults to `http://timestamp.digicert.com`.

GitHub Actions should store the PFX and password as repository/environment secrets:

- `TARVE_AUTHENTICODE_PFX_BASE64`
- `TARVE_AUTHENTICODE_PFX_PASSWORD`

The PFX is materialized only into a temporary file during signing and is deleted in a `finally` path. Password/certificate data is never written into release artifacts or the release manifest. Build/package subprocesses run with the Authenticode secret variables removed; only the dedicated signing subprocess receives them.

## Release procedure

1. Update the product version with `bun run version:set -- <semver>`.
2. Commit the version change and run `bun run release:check`.
3. Create an annotated or lightweight tag exactly matching `v<semver>`, for example `v0.2.0`.
4. Push the commit and tag.
5. `.github/workflows/release.yml` verifies that the tag points to a commit reachable from the default branch, reruns the full release gate, builds/signs the Windows artifacts, verifies the signatures/timestamps, emits SHA-256 hashes in `dist/release-manifest.json`, uploads the signed artifacts and creates the GitHub release.

Prerelease SemVer tags such as `v0.2.0-beta.1` are published as GitHub prereleases.

For a local signing rehearsal with an actual certificate:

```powershell
$env:TARVE_RELEASE_TAG = "v0.1.0"
$env:TARVE_AUTHENTICODE_SIGN = "1"
$env:TARVE_AUTHENTICODE_PFX_PATH = "C:\secure\tarve-signing.pfx"
$env:TARVE_AUTHENTICODE_PFX_PASSWORD = "<secret>"
bun run release:build
```

Do not commit a PFX, its password, or its base64 representation.
