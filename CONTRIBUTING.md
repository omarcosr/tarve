# Contributing to Tarve

Building the native library requires Bun 1.4+ and Rust stable.

On Windows x64, install Visual Studio Build Tools with C++ tooling and the Windows SDK and use the `x86_64-pc-windows-msvc` Rust target.

On Debian/Ubuntu Linux x64, install the native build dependencies first:

```bash
sudo apt install build-essential pkg-config libx11-dev libxkbcommon-dev \
  libxkbcommon-x11-0 libwayland-dev libegl1-mesa-dev libfontconfig1-dev
```

```powershell
bun install
bun run build:native
bun run check
bun run test
```

To try an unreleased build in another project, stage both native runtimes, then `bun run package`, `bun run pack` and `bun add <path>/dist/tarve-core-<version>.tgz`.

## Native runtimes and packaging

The release/package pipeline builds each native runtime on its native OS and assembles both into the same npm package. Stage one runtime with `bun run package:native`; `bun run package` intentionally refuses to create an incomplete single-platform package.

Each staged native runtime carries compatibility metadata containing its target, native ABI, JSON protocol version, source fingerprint, and binary hash. Cross-compilation validates that metadata before embedding the runtime, so a stale Linux `.so` cannot be combined with newer JavaScript (or vice versa). After native/protocol changes, rebuild the affected runtime on that OS with `bun run package:native` before cross-compiling from the other OS.

To build the Linux runtime on Ubuntu or WSL, install the native toolchain once:

```bash
apt-get update
apt-get install -y build-essential pkg-config libx11-dev libxkbcommon-dev libxkbcommon-x11-0 libwayland-dev libegl1-mesa-dev libfontconfig1-dev curl ca-certificates
curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
source "$HOME/.cargo/env"
cargo --version
bun run package:native
```

Rustup installs Cargo per user. If you switch between a normal WSL user and `root`, install/activate Rust for the user that actually runs `bun run package:native`, or run the build from the same user where Rustup was installed.

`bun run package:local` stages JS, declarations, and the native runtime for the current host for local development. `bun run package` is the publishable universal package gate and requires both Windows x64 and Linux x64 runtimes. The release pipeline documented in `RELEASE.md` assembles both runtimes into the same npm artifact. Tarve does not sign binaries; sign the executables you build with `tarve build` using your own certificate.

Run the full release gate (typecheck, clippy, unit tests, real-window smoke tests, package, executable, accessibility, and visual regression) with:

```powershell
bun run verify
```

Useful switches for the gate and the smoke tests:

| Variable | Effect |
| --- | --- |
| `TARVE_VERIFY_SKIP=pack,smoke:package` | Skips the named `verify` steps (unknown names fail). CI packages in a separate job. |
| `TARVE_SMOKE_FORCED_WGPU=0` | Skips forced-WGPU renderer modes (`gpu-vello-dx12`), which need a real GPU adapter. |
| `TARVE_SMOKE_OS_INPUT=1` | Windows only: `smoke:editor` injects real keystrokes and a file paste through the OS. Needs an idle desktop. |

CI (`.github/workflows/ci.yml`) runs the gate on Windows x64 and Linux x64 (virtual X display). Pushing a `v<semver>` tag runs `.github/workflows/release.yml`, which creates the GitHub release and publishes `@tarve/core` to npm with provenance.

See also [PRODUCTION.md](PRODUCTION.md), [PERFORMANCE.md](PERFORMANCE.md) and [RELEASE.md](RELEASE.md).
