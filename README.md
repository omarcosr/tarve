# Tarve

Native desktop UI for **Bun + TypeScript/TSX**.

Tarve turns a TSX tree into a retained native interface. It does not use a browser, DOM, or React runtime. Layout is handled by **Taffy**, text shaping and editing by **Parley**, and rendering is selectable between GPU and low-memory CPU paths.

> **Current supported targets:** Windows x64, Linux x64 and Android (arm64, x86_64)
>
> **Runtimes:** Bun 1.4+, Node.js 26.10+, txiki.js / QuickJS-ng and Go (see [Runtimes](#runtimes))
>
> **Package:** [`@tarve/core`](https://www.npmjs.com/package/@tarve/core) (CLI: `tarve`)
>
> **License:** Apache-2.0

## Highlights

- Native TSX UI with a dedicated `@tarve/core` JSX runtime.
- Retained Taffy Flexbox/Grid layout with incremental property and structural updates.
- Parley text shaping, selection, clipboard (text, files, images), IME composition, native undo/redo, and Unicode-aware editing.
- Native Windows D3D11/DXGI renderer with Vello/WGPU fallback; Linux uses Vello/WGPU. Both platforms provide a `vello_cpu + softbuffer` CPU renderer.
- shadcn-inspired components and semantic light/dark theme tokens.
- Native Markdown, syntax-highlighted Code, and Diff leaves designed for large documents.
- Fixed-height, measured variable-height, and externally windowed `VirtualList` modes.
- Accessibility through AccessKit: UI Automation on Windows, AT-SPI on Linux and TalkBack on Android; the system text size and reduced-motion setting apply natively.
- Global hotkeys, native file dialogs, custom title bars, window positioning, and standalone Windows/Linux builds.
- Event-driven Bun/native bridge with no continuous idle polling: an idle window presents zero frames.
- Development mode with in-window runtime error overlay, same-window remount under `bun --hot`, and a native frame-time graph.

## Installation

For a published package:

```powershell
bun add @tarve/core
bun add -d typescript @types/bun
```

Use this TypeScript configuration:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "jsxImportSource": "@tarve/core",
    "types": ["bun", "@tarve/core/assets"]
  }
}
```

## Quick start

```tsx
import { Button, Column, Text, Window, createApp } from "@tarve/core";

let count = 0;

function App() {
  return (
    <Window title="Counter" width={520} height={360}>
      <Column flex={1} align="center" justify="center" gap={16}>
        <Text size={42} weight={700}>{count}</Text>
        <Button onClick={() => count++}>Increase</Button>
      </Column>
    </Window>
  );
}

const app = createApp(App);
await app.ready;
await app.closed;
```

Run it with the `tarve` CLI, under Bun or Node.js 26.10+ — the same commands work with either:

```powershell
bunx tarve run app.tsx      # Bun
npx tarve run app.tsx       # Node.js
bunx tarve dev app.tsx      # hot reload into the same window (npx tarve dev on Node)
```

`tarve` uses the runtime that launched it: `bunx`/`bun run` pick Bun, `npx`/`npm run` pick Node (Bun, as before, when Node is older than 26.10). `--runtime bun|node` overrides it. With Bun you can still run the source directly with `bun app.tsx`.

## New packages

| Package | What |
| --- | --- |
| `create-tarve` | `bun create tarve my-app` / `npm create tarve my-app` — templates `basic`, `tailwind`, `svelte`, `tray` |
| `@tarve/router` | Stack and tab navigation with typed params (`route("/users/:id", …)`), `<RouterView>`, `<TabBar>`, `<Link to>` |
| `@tarve/test` | Testing Library–style `render`, queries, `fireEvent`, `waitFor` and PNG snapshots over `@tarve/headless` |

App-level additions: `app.onOpenUrl` / `app.onOpenFiles` with `protocols` / `fileTypes` (deep links and file associations), `app.share`, `app.getCurrentPosition` and `app.authenticate` (Android and Windows), `app.recognizeSpeech` (Android dictation with partial results and the microphone level; `{ supported: false }` on desktops for now), and `definePlugin` (see [Plugins](#plugins)). For tests and CI, `TARVE_DEVICE=fake` in the app's environment makes the native library answer the device services deterministically (no share UI, location source or biometric prompt; same on Bun, Node and txiki; details in `packages/core/src/device.ts`).

## Build a standalone executable

The package CLI compiles a Tarve application into a standalone executable and embeds the native runtime. Windows produces a `.exe`; Linux produces an ELF executable with no required extension. The target defaults to the current host. Published Tarve packages contain both Windows x64 and Linux x64 native runtimes, so `--target` can switch between those targets without rebuilding Tarve's Rust runtime.

```powershell
bunx tarve build app.tsx --outfile dist/App.exe   # Bun executable
npx tarve build app.tsx --outfile dist/App.exe    # Node.js executable
```

```bash
bunx tarve build app.tsx --outfile dist/App
```

Cross-compile explicitly from either Windows x64 or Linux x64:

```bash
bunx tarve build app.tsx --target windows-x64 --outfile dist/App.exe
npx tarve build app.tsx --target linux-x64 --outfile dist/App
```

The published package already contains both runtimes, so `tarve build` needs no Rust toolchain. Both runtimes produce a GUI executable (no console window on Windows) named and versioned after the app (`--name`, `--version`).

The build API is also exported:

```ts
import { build } from "@tarve/core/build";

await build({
  entrypoint: "app.tsx",
  target: "linux-x64",
  outfile: "dist/App",
  name: "My App"
});
```

### Installers and portable archives

`tarve package` wraps a built executable (or builds `app.tsx` first, one build per target OS) into distributable packages, written in pure TypeScript with no external tools:

```bash
bunx tarve package dist/App --format deb,tar --version 1.2.0 --categories "Utility;Office"
bunx tarve package app.tsx --format zip,msix --version 1.2.0 --publisher "Acme Inc." --out dist/packages
```

| Format | Output |
| --- | --- |
| `deb` | `<app>_<version>_amd64.deb`: `/opt/<app>/<exe>`, `/usr/bin/<app>` symlink, `.desktop` entry and hicolor icon |
| `tar` | `<app>-<version>-linux-x64.tar.gz`: executable, `.desktop`, icon and `install.sh` (per-user install into `~/.local`) |
| `zip` | `<App>-<version>-windows-x64.zip`: portable folder with the `.exe` |
| `msix` | MSIX folder with `AppxManifest.xml` and logos; packed into an unsigned `.msix` when `makeappx` (Windows SDK, `TARVE_MAKEAPPX`) is found |

Name, version, icon, description and publisher come from the same `package.json` `"tarve"` metadata as `tarve build` (flags override them). Sign `.msix` files with `signtool` using a certificate whose subject matches `CN=<publisher>`. AppImage is not produced (it needs the AppImage runtime and squashfs); use `tar`. The API is `packageApp({ executable, format })` from `@tarve/core/package`.

## Auto-updates

Built apps can update themselves from signed releases hosted on any HTTPS server (GitHub Releases, S3/R2, a CDN). The full guide is at [tarve.dev/docs/updates](https://tarve.dev/docs/updates).

```bash
bunx tarve keygen                                   # once: ./tarve-update.key (secret) + the public key
bunx tarve build app.tsx --version 1.2.0 --outfile dist/App.exe
bunx tarve release --version 1.2.0 --artifact win32-x64=dist/App.exe --out dist/updates \
  --sign "signtool sign /fd sha256 /tr http://timestamp.digicert.com /td sha256 /a {file}"   # optional Authenticode
# upload dist/updates: the executables first, latest.json last
```

```ts
import { canInstallUpdate, checkForUpdate, downloadUpdate, installUpdate } from "@tarve/core";

const update = await checkForUpdate({ url: "https://example.com/app/latest.json", publicKey: "…" });
if (update && canInstallUpdate()) installUpdate(await downloadUpdate(update, { onProgress: (n, total) => {} }));
```

`latest.json` is signed with Ed25519 and lists the size and SHA-256 of each platform's executable; the app checks the signature, only accepts newer versions, HTTPS URLs and a matching app name, and verifies the download before `installUpdate` swaps the executable and restarts. `--sign` (or `TARVE_SIGN_COMMAND`) runs your Authenticode tool on each Windows executable before it is hashed. Self-updating needs a writable install folder (per-user or portable); `canInstallUpdate()` is false under `Program Files` or a package manager. txiki.js builds are not supported yet.

## Runtimes

Tarve supports four runtimes. Each one keeps its own strengths and limits: there is no promise of feature parity between them, and choosing one means accepting what it offers. The native runtime, components and the app API (`AppHandle`, or `App` in Go) are the same underneath.

| Runtime | Windows x64 | Linux x64 | Android | What it gives you |
| --- | --- | --- | --- | --- |
| **Bun** 1.4+ | `run`, `dev`, `build` | `run`, `dev`, `build` | `build --target android --runtime bun`: the app runs as a Bun executable on the device | the fastest dev loop, `bun:ffi`, `bun:sqlite`, single-file executables; on Android the full Bun API at ~45 MB more download per ABI |
| **Node.js** 26.10+ | `run`, `dev`, `build` | `run`, `dev`, `build` | builds the APK/AAB (the app runs on QuickJS-ng or Bun); Node.js itself publishes no Android build | the npm ecosystem, Node single-executable apps (FFI and SEA are experimental in Node 26) |
| **txiki.js / QuickJS-ng** | `build --runtime txiki` | `build --runtime txiki` | the default engine on the device (`tarve build --target android`), inside the runtime | small executables and APKs (a few MB); a subset of Node's APIs through shims (`fs`, `path`, `os`, `crypto` hashes, `fetch`, `zlib`/gzip sync; on the desktop also `child_process` `spawn`/`spawnSync`, `net` pipes, and plugin FFI through `tjs:ffi`; on Android no child processes or sockets) |
| **Go** | `go run`, `go build` | `go run`, `go build` | `tarve build <go package> --target android` | no JS at all; the Go toolchain and its libraries ([go/README.md](go/README.md)) |

On Android a TSX app runs on QuickJS-ng by default, or on Bun with `--runtime bun` (Bun 1.4 ships Android builds: `bun-linux-arm64-android`, `bun-linux-x64-android`). Node.js has no official Android build, so a Node.js project builds its APK with either engine. txiki.js has no `tarve run`/`dev`; develop on Bun or Node.js and build with `--runtime txiki`. macOS is not a supported target yet.

## Node.js runtime

The same TSX components, desktop APIs, renderer modes and native bridge run on Node.js 26.10+ with the same `tarve run|dev|build` commands; a Node-only project needs neither Bun nor Rust:

```powershell
npm install @tarve/core
npx tarve dev app.tsx
npx tarve build app.tsx --outfile dist/App.exe
```

`dev` rebuilds TSX and remounts into the same native window when the entry uses `await render(App)`, as with Bun's hot mode. Node builds compile TSX with esbuild and embed the app and native library in a Node.js single-executable application. Node's FFI and single-executable APIs are experimental in Node 26.

The shared build API also accepts `build({ entrypoint: "app.tsx", runtime: "node" })` from `@tarve/core/build`, and Node-only tooling can call `buildNode` from `@tarve/core/build-node`. Cross-compiling works as with Bun: `npx tarve build app.tsx --target linux-x64 --outfile dist/App`. The first build for a target downloads the official Node.js binary of the same version as the Node running the build from nodejs.org (or `NODEJS_ORG_MIRROR`), checks it against the release `SHASUMS256.txt` and caches it (`TARVE_CACHE_DIR`, by default `%LOCALAPPDATA%\tarve\cache` or `~/.cache/tarve`). Offline or with a custom Node build, pass it with `--target-executable path/to/node`; it must be the same Node.js version. As with Bun, the packaged native runtime for that target must match the current protocol.

## Android

`tarve build --target android` packs an app into a signed APK, or an Android App Bundle for Google Play (arm64-v8a and x86_64; `android-arm64` or `android-x64` for one). It works from Bun and from Node.js, for TSX apps and for Go apps:

```powershell
bun run build:native:android                      # once: native/android/<abi>/libtarve_native.so (cargo-ndk + NDK)
tarve build app.tsx --target android              # dist/App.apk
tarve build go/examples/counter --target android  # a Go main package
adb install dist/App.apk
tarve build app.tsx --target android --format aab --keystore upload.jks   # dist/App.aab for Google Play
```

**Bun on the device.** `--runtime bun` compiles the app with `bun build --compile --target=bun-linux-<arch>-android` (run the build with Bun: `bunx tarve build …`) and packs the executable as `lib/<abi>/libtarvebun.so`, which the package manager extracts (`extractNativeLibs="true"`). The activity starts it as a child process and keeps the window, GPU surface and system services; the app calls the native runtime over a socket pair (`native/src/android/bun_host.rs`, `packages/core/src/bridge/remote.ts`) and wakes on the same event socket as on Linux. The app gets Bun's own APIs (`Bun.file`, `bun:sqlite`, `fetch`, `Worker`, `Bun.spawn` of system binaries such as `/system/bin/toybox`) and `process.platform === "android"`; `Bun.$` fails inside the app sandbox. The cost is size: about 45 MB more per ABI in the download (~100 MB installed) against a few MB for QuickJS-ng. `scripts/android-bun-smoke.tsx` checks it on a device.

```powershell
bunx tarve build app.tsx --target android --runtime bun           # dist/App.apk with Bun inside
```

**App Bundle.** `--format aab` (or an `--outfile` ending in `.aab`) links the manifest and resources in protobuf form, lays the module out for bundletool (`manifest/`, `dex/`, `lib/`, `assets/`, `res/`, `resources.pb`), runs `bundletool build-bundle` (native libraries uncompressed and 16 KB aligned in the APKs Play generates) and signs the bundle with `jarsigner` using the same key options as an APK. bundletool comes from `--bundletool path.jar`, `TARVE_BUNDLETOOL`, or a pinned release downloaded once into the Tarve cache (`TARVE_CACHE_DIR`). Google Play rejects bundles signed with the debug key: pass your upload key with `--keystore`. Play also requires a recent `targetSdkVersion` for new apps and updates; Tarve targets API 34 for now (API 35 forces edge-to-edge, which NativeActivity cannot inset yet), so check Play's current requirement before uploading.

**Permissions.** Every APK declares `INTERNET`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`, `POST_NOTIFICATIONS` and `WAKE_LOCK`. An app adds its own in package.json (per entry under `tarve.apps["<entry>"].android` too) or with `--permission` (repeatable); a name without a dot is an `android.permission.` one:

```json
{ "tarve": { "android": { "permissions": ["CAMERA", "RECORD_AUDIO", "ACCESS_FINE_LOCATION"] } } }
```

Android blocks plain `http://` by default (media players included). An app that must reach an `http://` server, a media server on the LAN for instance, sets `"cleartextTraffic": true` in the same `tarve.android` object.

Dangerous permissions also need the user's consent at run time:

```ts
const states = await app.requestPermissions(["CAMERA", "RECORD_AUDIO"]); // { CAMERA: "granted", RECORD_AUDIO: "denied" }
const now = await app.checkPermissions(["CAMERA"]);                     // no dialog: "granted", "prompt" (never answered) or "denied"
```

`requestPermissions` shows the system prompt for the ones not granted yet and resolves once the user answers; a permission missing from the manifest is denied at once. Go apps call `app.RequestPermissions("CAMERA")` / `app.CheckPermissions(...)`. On Windows and Linux there is no per-app permission prompt, so both resolve every name as `"granted"`.

The runtime runs as a NativeActivity. A TSX app is bundled like a txiki.js build and runs on the QuickJS-ng engine embedded in the runtime (`native/src/android/qjs.rs`). Its prelude provides timers, `fetch` (rustls), `TextEncoder`, `URL`, `crypto`, `Intl`, `Buffer`, and `node:fs`/`path`/`os`/`crypto` over the app's private storage (`os.homedir()` is the files directory, `os.tmpdir()` the cache). A Go app is built as `libtarveapp.so` with the NDK and called through `TarveAndroidMain`. Touch acts as the pointer: tap to click, hold and drag, swipe to scroll. The soft keyboard opens for focused inputs, Back requests a close, and the clipboard and `openExternal` go through the system, and `app.webSignIn({ url, cookieUrl, cookies })` opens a sign-in page (Google, OAuth) in the system WebView inside the app and resolves with the cookies of `cookieUrl` once signed in (the youtube-music example signs in to Google this way). Layout stays inside the system bars and the keyboard. While `<audio>`/`<video>` plays, the runtime keeps the app running in the background (a foreground service with a media notification, lock-screen and headset controls, and a wake lock): play and pause work on their own, and `app.systemMedia(...)` adds the title, artist, artwork and next/previous, which arrive as `systemMedia` events as on Windows.

Without a phone, `bun run android:emulator` starts a headless Android 15 emulator in Docker (google/android-emulator-container-scripts; WSL2 with KVM) at `localhost:5555`. Needs the Android SDK (build-tools and a platform, from `ANDROID_HOME`) and a JDK to sign. Go apps also need the NDK. APKs are signed with the debug keystore unless `--keystore` or `TARVE_ANDROID_KEYSTORE` (`TARVE_ANDROID_KEYSTORE_PASSWORD`, `TARVE_ANDROID_KEY_ALIAS`) names one. Node.js and txiki.js themselves do not run on the device; Bun does with `--runtime bun` (below). `<video>` plays through the platform's MediaPlayer, and the file dialogs open the system document picker (an opened document is copied into the app's cache; folders report an error, since Android hands apps documents, not paths). `app.notify` posts to the notification shade (see [Notifications](#notifications)). The tray is a no-op; desktop widgets, native menus and several windows are not available on Android.

## Renderers

`createApp` accepts `renderer: "auto" | "gpu" | "cpu"`.

| Mode | Windows | Linux |
| --- | --- | --- |
| `auto` | Uses the native D3D11/DXGI GPU renderer by default. | Uses the Vello/WGPU GPU renderer by default. |
| `gpu` | Uses D3D11/DXGI with Vello/WGPU fallback for initialization or recovery failures. If Vello cannot run on the available adapter, falls back to CPU. | Uses Vello/WGPU with the platform graphics backend selected by WGPU. If the adapter lacks Vello's required shader features, falls back to CPU. |
| `cpu` | Uses `vello_cpu + softbuffer`. | Uses `vello_cpu + softbuffer`. |

```tsx
const app = createApp(App, {
  renderer: "cpu"
});
```

An explicit renderer in `createApp` takes precedence over `TARVE_RENDERER`. `WGPU_BACKEND` can select a WGPU backend for development and diagnostics. On Windows, setting it also selects the Vello/WGPU path instead of the normal D3D11 renderer. An explicit `WGPU_BACKEND` keeps GPU failures strict instead of silently falling back to CPU, which makes backend-specific diagnostics reliable.

## Components

Tarve exports native primitives and higher-level controls from the main `@tarve/core` entry point.

| Area | Components |
| --- | --- |
| Window and layout | `Window`, `TitleBar`, `View`, `Row`, `Column`, `Scroll`, `ScrollArea`, `Portal`, `Resizable`, `AspectRatio`, `Direction` |
| Text and media | `Text`, `Typography`, `Image`, `Svg`, `Icon` |
| Inputs | `Input`, `TextArea`, `Checkbox`, `Switch`, `RadioGroup`, `Select`, `NativeSelect`, `Slider`, `InputOTP` |
| Buttons and feedback | `Button`, `ButtonGroup`, `Toggle`, `ToggleGroup`, `Badge`, `Progress`, `Spinner`, `Skeleton`, `Alert` |
| Overlays | `Modal`/`Dialog`, `AlertDialog`, `Popover`, `Tooltip`, `DropdownMenu`, `ContextMenu`, `Sheet`, `Drawer`, `HoverCard`, `CommandPalette` |
| Navigation | `Tabs`, `Accordion`, `Breadcrumb`, `Pagination`, `NavigationMenu`, `Menubar`, `Sidebar`, `Collapsible` |
| Data | `List`, `VirtualList`, `Table`, `DataTable`, `DataGrid`, `TreeView` |
| Rich content | `Markdown`, `Code`, `Diff` |
| App/chat UI | `Card`, `Field`, `Item`, `Empty`, `Questionnaire`, `Attachment`, `Message`, `Bubble`, `MessageScroller` |

The public API also includes lower-level composition primitives such as `Pressable`, declarative SVG elements, reusable `Style` helpers, component adapters, and desktop APIs exposed through `AppHandle`.

## Styling and themes

Tarve uses semantic theme tokens. `lightTheme` is the default; `darkTheme` can be selected per window and themes can be changed at runtime without recreating the native window.

```tsx
import { Button, Window, darkTheme, theme } from "@tarve/core";

function App() {
  return (
    <Window theme={darkTheme}>
      <Button
        style={{
          background: theme.colors.primary,
          hover: { background: theme.colors.primaryHover },
          focus: { outlineWidth: 2 },
          disabled: { foreground: theme.colors.mutedForeground }
        }}
      >
        Continue
      </Button>
    </Window>
  );
}
```

Every colour property (`background`, `foreground`, `borderColor`, `outlineColor`, rich-content and diff colours, state styles and the window background) accepts hex (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`), `rgb()`/`rgba()`, `hsl()`/`hsla()`, common names such as `transparent` or `white`, and theme tokens. Unsupported colour strings throw when the view is compiled instead of rendering black.

`transform` translates, scales, rotates and skews a node and its subtree: `{ x, y, scale, scaleX, scaleY, rotate, skewX, skewY, originX, originY }` (angles in degrees; the origin is a fraction of the box, the centre by default) or CSS syntax such as `"translateY(-2px) scale(1.02)"`. It is paint-only (layout does not move) but hit testing and hover follow the transformed box, and it transitions like other paint properties. `radius` takes a number or per-corner `{ topLeft, topRight, bottomRight, bottomLeft }`; `margin` sides take `"auto"` to centre a box or push it aside, as CSS auto margins do.

Borders accept `borderStyle` with the same values as `outlineStyle` (`dashed`, `dotted`, `double`, `groove`, `ridge`, `inset`, `outset`, `none`); non-solid styles apply when all four border widths are equal. Text, button labels, `Input` and `TextArea` accept `textShadow: { x, y, blur, color }`, an offset copy of the glyphs (`blur` is the CSS blur radius; 0 is a solid copy, larger values blur it identically on every renderer); it also works inside state styles such as `hover`.

`boxShadow` takes `{ x, y, blur, spread, color, inset }` or a list of up to 8 (the first paints on top). `blur` is the CSS blur radius; `spread` grows or shrinks the shadow and its corner radius; `inset` paints inside the padding box. Outer shadows are never drawn under their own box, so translucent backgrounds stay clean. Shadows do not affect layout, work in state styles such as `hover`, and render the same on D3D11, Vello GPU and the CPU renderer.

`background` also takes a gradient, as a CSS string or an object: `"linear-gradient(135deg, #2563eb, #9333ea 80%)"`, `"linear-gradient(to top right, red, blue)"`, `"radial-gradient(circle at 25% 75%, #fff, #000)"`, `"repeating-linear-gradient(45deg, #000 0 6px, #fff 6px 12px)"`, `"conic-gradient(from 90deg at 30% 50%, red, blue 25%, red)"`, or `{ type: "linear", angle: 135, stops: ["#2563eb", { color: "#9333ea", offset: 0.8 }] }`. Angles accept `deg`, `rad`, `turn` and `grad`. Stop positions take `%` or `px` (object offsets: a number is a 0..1 fraction, strings take `px`/`%`); two positions make a hard stop, omitted ones are spread and positions never go back, as in CSS. Radial gradients take `circle`/`ellipse`, a size keyword (`closest-side`, `closest-corner`, `farthest-side`, `farthest-corner`, the default) or explicit radii (`circle 40px`, `ellipse 50% 20px`; object `size: 40` or `["50%", "20px"]`), and an `at` centre in keywords, percentages or `px`, including edge offsets such as `at right 10px bottom 20%`. Conic gradients take `from <angle>` (0 points up, clockwise) and the same `at` positions; their stops are angles (`deg`, `turn`, `rad`, `grad`) or `%` of a turn (object `{ type: "conic", from: 90, at: { x: 0.3, y: 0.5 }, stops }`, with number offsets as fractions of a turn). `repeating-linear-gradient`, `repeating-radial-gradient` and `repeating-conic-gradient` tile the stop pattern; patterns finer than a pixel paint their average colour. Stop colours accept the same colour syntax and theme tokens. With `transition`, gradients with the same kind, stop count, units, size and repeat mode animate stop by stop; anything else, including colour ↔ gradient, switches instantly, as in CSS. `borderColor` and `foreground` take the same gradients: a gradient border fills the ring between the border and padding boxes, and `dashed`, `dotted` and `double` borders paint their strokes with the gradient (CSS `border-image` would ignore `border-style` and paint a solid ring; Tarve keeps the style; `inset`/`outset`/`groove`/`ridge` shade the first stop), and gradient text on `Text` fills the glyphs with the gradient laid over the text box, like CSS `background-clip: text` (it is rasterized once and cached, so it renders identically everywhere; `Button` labels and icons use the first stop). Other length units (`em`, `rem`, `vw`, `vh`, …) and `calc()` are not supported yet; they are planned for the whole style system rather than for gradients alone.

`hover` styles apply to any node under the pointer and to its ancestors, as CSS `:hover` does; the innermost interactive node still receives events. With `transition`, `opacity`, `radius`, `background`, `foreground`, `borderColor`, `boxShadow` and `textShadow` animate natively both on JS updates and on hover/active/focus/disabled changes, starting from the value on screen:

```tsx
<Column style={{
  background: "#ffffff",
  boxShadow: { y: 2, blur: 6, color: "#0f172a22" },
  hover: { background: "#eff6ff", boxShadow: { y: 14, blur: 28, color: "#2563eb44" } },
  transition: { all: { duration: 220, easing: "easeOut" } },
}} />
```

Both shadows also accept CSS syntax: `boxShadow: "inset 0 1px 2px rgba(0,0,0,.2), 0 8px 24px -4px #0003"` and `textShadow: "1px 2px #0006"` (or `"none"`). Lengths are `px` or unitless `0`; colours may be hex, `rgb()`/`rgba()`, `hsl()`/`hsla()`, a few names or theme tokens. Invalid strings throw when the view is compiled. Shadow lists of different lengths interpolate against transparent layers. `motionFrom` and AnimatePresence `enter`/`exit` accept numeric properties only.

Create derived themes with `createTheme` or `Theme.create`. Theme tokens cover surfaces, foregrounds, borders, focus outlines, selection, caret, scrollbars, modal overlays, rich-content colors, and control states.

Besides `hover`, `focus`, `focusVisible`, `active` and `disabled`, a style can carry `groupHover` (applied while an ancestor with `group: true` is hovered), `focusWithin` (while the box or a descendant has focus), `dark` (under a dark window theme), `first`/`last`/`odd`/`even` (by position among the parent's element children) , `sm`/`md`/`lg`/`xl`/`2xl` (window at least 640/768/1024/1280/1536 px wide; the app re-renders when the width crosses a breakpoint), `portrait`/`landscape` (the window's shape), `pointerCoarse`/`pointerFine` (a finger on Android, a mouse elsewhere) and `motionReduce`/`motionSafe` (the system's animation setting). These are folded by the reconciler, so the native tree never sees them. For layout decisions in code, `viewport()` returns `{ width, height, orientation, pointer, fontScale, reducedMotion }`; a view that reads it renders again when any of them changes.

## Tailwind classes

Tailwind CSS utility classes work on every element, with no CSS and no DOM: `class` (or `className`) compiles to the element's native `style` at the JSX call site, and `tw("…")` returns the same `Style` for component `style` props. Later classes win and an inline `style` wins over classes, as in CSS.

```tsx
import { Column, Text, Window, tw } from "@tarve/core";

function Card({ active }: { active: boolean }) {
  return (
    <Window>
      <div class="group flex flex-col gap-2 p-4 rounded-xl bg-card border border-border shadow-md hover:shadow-lg dark:bg-zinc-900 md:flex-row">
        <span class="text-sm font-semibold text-foreground group-hover:text-primary">Title</span>
        <div class={`px-3 py-1.5 rounded-md text-sm transition active:scale-95 ${active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`} onClick={() => {}}>
          Action
        </div>
      </div>
      <Column style={tw("gap-1 p-3 rounded-lg border border-border", active && "bg-primary/10")}>
        <Text style={tw("text-xs text-muted-foreground")}>tw() composes like clsx</Text>
      </Column>
    </Window>
  );
}
```

The vocabulary follows Tailwind CSS 4 and is checked class by class against the real compiler (`packages/core/src/tailwind-parity.test.tsx`): layout (`flex`, `grid`, `items-*`, `self-*`, `content-*`, `justify-*`, `place-*`, `gap-*`, `gap-x/y-*`, `space-x/y-*`, `inset-*`, `start-*`/`end-*`, `z-*`), spacing and sizing (the 4 px scale, fractions, `full`, the container scale on `w-*`/`min-w-*`/`max-w-*`, `mx-auto`, arbitrary `[12px]`/`[50%]`), the full colour palette (Tailwind 4's OKLCH colours mapped into sRGB) with `/opacity` modifiers, theme tokens (`bg-primary`, `text-muted-foreground`, `border-border`, also with `/opacity`), typography (`text-sm/6`, `font-*`, `leading-*`, `tracking-*`, `text-justify`, `truncate`, `line-clamp-*`, decorations), borders and radii per side and corner, `shadow-*` and `inset-shadow-*` with colours, `text-shadow-*`, `ring-*`, `outline-*`, `opacity-*`, `cursor-*`, `select-*`, `pointer-events-*`, `overflow-*`, `object-*`, `aspect-*`, transforms (`scale-*`, `translate-*`, `rotate-*`, `skew-*`, `origin-*`), transitions (`transition`, `duration-*`, `delay-*`, `ease-*`), `animate-spin`, gradients (`bg-linear-to-r`, `bg-linear-45`, `bg-radial`, `bg-conic`, `from-*`/`via-*`/`to-*` with positions), `backdrop-blur-*`/`backdrop-saturate-*` (as the Liquid Glass material) and the variants `hover:`, `focus:`, `focus-visible:`, `focus-within:`, `active:`, `disabled:`, `group-hover:` (with `group`), `dark:`, `first:`/`last:`/`odd:`/`even:`, `sm:`…`2xl:`, `portrait:`/`landscape:`, `pointer-coarse:`/`pointer-fine:` and `motion-reduce:`/`motion-safe:`.

What has no native counterpart is dropped rather than approximated: `inline`/`table`/`float` layouts, `fixed`/`sticky`, min/max-content widths, viewport units, CSS filters (`blur`, `grayscale`, `drop-shadow`), blend modes, lists, columns, pseudo-elements (`before:`, `placeholder:`, `selection:`), `print:`/`motion-*:`/`rtl:`, `peer-*`, `has-[]`, arbitrary properties (`[mask-type:luminance]`) and `calc()` lengths. A few classes map to the closest native notion: `inline-flex` is `flex`, `static` is `relative`, `space-x/y-*` is a flex gap, `ring-*`/`outline-*` are both the outline, `backdrop-*` needs the D3D11 renderer (others paint the tint), and `ease-*`/`delay-*` animate nothing without a duration, as CSS does. The `tailwind` example is a live playground.

## Native motion

Tarve transitions retained native values without a Bun timer or per-frame TSX render. Bun sends the new target once; Rust owns interpolation, layout/paint invalidation, frame scheduling, retargeting, and completion.

The first motion surface supports numeric `width`, `height`, `top`, `right`, `bottom`, `left`, `opacity`, and `radius`. Transitions can use `linear`, `ease`, `easeIn`, `easeOut`, or `easeInOut`, with optional duration and delay in milliseconds.

```tsx
<View
  id="details-panel"
  motionFrom={{ opacity: 0, width: 240 }}
  onTransitionEnd={({ property }) => {
    console.log(`${property} finished`);
  }}
  style={{
    width: expanded ? 420 : 280,
    opacity: expanded ? 1 : 0.72,
    radius: 16,
    transition: {
      width: { duration: 220, easing: "easeOut" },
      opacity: { duration: 160, easing: "linear" },
      radius: { duration: 220, easing: "easeOut" },
    },
  }}
/>
```

Changing a target while it is already moving retargets from the current interpolated value, so the node does not jump back to its previous declarative target. `motionFrom` is mount-only: it provides the initial numeric value when a native node is first created.

Use `AnimatePresence` when a node must stay mounted long enough to finish an exit transition. Keep the presence boundary rendered and toggle `present`; removing the boundary itself cannot retain its child for exit.

```tsx
<AnimatePresence
  id="details-presence"
  present={detailsOpen}
  enter={{ opacity: 0 }}
  exit={{ opacity: 0 }}
  transition={{ opacity: { duration: 180, easing: "easeOut" } }}
>
  <Card id="details-card" style={{ opacity: 1 }}>
    <Text>Project details</Text>
  </Card>
</AnimatePresence>
```

Base numeric style targets participate in native motion. Interactive `hover`, `focus`, `focusVisible`, `active`, and `disabled` overrides are still applied immediately rather than creating state-transition tracks.

## Audio and video

`<audio>` and `<video>` work like HTMLMediaElements, played by the native runtime: `src` (path, `file://`, `data:` or a streamed `http(s)://` URL), `autoPlay`, `loop`, `muted`, `volume`, `controls` (a default control bar) and, on `<video>`, `fit` (`contain`, `cover`, `fill`, `none`). Events: `onLoadedMetadata`, `onPlay`, `onPause`, `onTimeUpdate`, `onSeeked`, `onEnded` (`{ currentTime, duration, paused, videoWidth, videoHeight }`) and `onError(message)`. `app.media(id)` gives `play`, `pause`, `seek`, `setVolume` and `setMuted`.

```tsx
<video id="film" src="https://example.com/film.mp4" autoPlay muted loop controls fit="cover" style={{ width: "100%", height: 400 }} />
<audio id="song" src={track.url} autoPlay onEnded={next} onError={reload} />
```

Video uses the platform decoder: Media Foundation on Windows (GPU textures sampled directly by the D3D11 renderer, on their own composition layer), GStreamer on Linux, MediaPlayer on Android; macOS is not supported yet. Audio is decoded by Symphonia and follows output-device changes. Remote files stream with HTTP range requests and retries. `app.systemMedia({ title, artist, artwork, playing, duration, position, onAction })` connects the system media controls and media keys; on Android playback continues in the background with a media notification.

## Rich content

`Markdown`, `Code`, and `Diff` are native leaf nodes, so large documents do not expand into thousands of TSX children.

```tsx
<Column
  highlight={{ query: search, activeIndex: currentMatch }}
  onHighlight={({ matchCount }) => {
    totalMatches = matchCount;
  }}
>
  <Markdown source={document} />
  <Code
    code={snippet}
    language="tsx"
    showLineNumbers
  />
  <Diff
    source={patch}
    wordDiff
    maxLines={expanded ? undefined : 80}
    onShowMore={() => {
      expanded = true;
    }}
  />
</Column>
```

`Markdown` supports GFM structure including tables, task lists, links, quotes, lists, inline code, and fenced code. Embedded HTML is displayed as literal text.

`Code` supports syntax highlighting through Syntect, optional `language`/`path` detection, selectable text, line numbers, and horizontal scrolling.

`Diff` accepts either a unified/Git patch in `source` or an `oldText`/`newText` pair. It supports word-level changes, per-file sections, collapsible paths, line limits, line-click events, and selection/copy without diff chrome.

`createTextSearchController` and `findRanges` provide search/navigation helpers for `Text`, `Markdown`, `Code`, and `Diff`.

## App icon and metadata

Name, icon and publisher live in the app's `package.json` under `"tarve"`; `tarve build`, `tarve run` and `tarve dev` read them, and CLI flags (`--name`, `--version`, `--icon`, `--publisher`, `--copyright`, `--description`, `--app-id`) override them.

```json
{
  "name": "pulse",
  "version": "1.2.0",
  "tarve": {
    "name": "Pulse",
    "description": "System monitor",
    "publisher": "Example Inc.",
    "copyright": "© 2026 Example Inc.",
    "icon": "assets/icon.png",
    "appId": "Example.Pulse"
  }
}
```

A monorepo of apps sets per-entry values under `"tarve": { "apps": { "pulse/pulse.tsx": { … } } }`. The icon is a square PNG (256 px or larger) or an `.ico`: on Windows the build writes a multi-size icon and the version info into the `.exe`, for Bun and Node builds alike; on Linux it writes `<App>.desktop` and `<App>.png` beside the binary. At run time the window and taskbar use the same icon, and `appId` names the app in media controls and notifications. `createApp(view, { icon })` sets the window icon directly.

## Images

`Image` accepts local paths, `http(s)://` URLs, data URLs, encoded PNG/JPEG/WebP/SVG bytes, and raw RGBA8 pixels. Raw RGBA is sent directly to the native image cache, so live pixel updates do not require a PNG encode/decode round trip.

```tsx
<Image
  src={{
    rgba: previewPixels,
    width: 640,
    height: 360,
    cacheKey: "live-preview",
  }}
  width={640}
  height={360}
  fit="contain"
/>
```

A URL is fetched and decoded natively, off the UI thread, the first time the image is painted, like `loading="lazy"`: covers further down a list or in a closed panel cost nothing until they scroll in. Until then the image shows its `placeholderBackground`; once decoded it lays out again with its intrinsic size. At most six downloads run at once, and responses with `Cache-Control: max-age` are kept in a disk cache (256 MB) so they survive a restart.

```tsx
<Image src="https://example.com/cover.webp" width={152} height={152} fit="cover" />
```

To load bytes yourself (for an `AbortSignal`, a payload limit or to process them), `loadImageSource` fetches into a bounded in-process LRU cache:

```tsx
const controller = new AbortController();
const avatar = await loadImageSource("https://example.com/avatar.webp", {
  signal: controller.signal,
});

render(() => <Image src={avatar} width={96} height={96} fit="cover" />);
```

The native decoded-image cache is bounded and renderer-side image caches retain only images used by the current scene/frame.

## Lists and virtualization

`List` keeps all items mounted and is appropriate for normal collections.

`VirtualList` has three modes:

- **Fixed height:** use `itemHeight` for the smallest and simplest runtime path.
- **Measured variable height:** use `estimatedItemHeight`, a stable `id`, and `keyForItem`. Tarve measures rows natively and preserves a keyed scroll anchor as row heights change or items are prepended/reordered.
- **Externally windowed:** add `itemCount` and `windowStart` when the application owns a larger logical data set and passes only a mounted window.

Fixed-height example:

```tsx
<VirtualList
  items={rows}
  itemHeight={36}
  height={360}
  offset={offset}
  onScroll={(nextOffset) => {
    offset = nextOffset;
  }}
  renderItem={(row) => <Text>{row.label}</Text>}
/>
```

Variable-height example:

```tsx
<VirtualList
  id="messages"
  items={messages}
  estimatedItemHeight={52}
  height={420}
  offset={offset}
  keyForItem={(message) => message.id}
  alignment="bottom"
  followTail
  onScroll={(nextOffset) => {
    offset = nextOffset;
  }}
  renderItem={(message) => (
    <Text>{message.body}</Text>
  )}
/>
```

Variable lists retain measured heights by key and can keep a focused editor row alive while normal windowing moves it outside the visible range.

Native text search and copy operate on the mounted logical window. A retained editor row that is parked only to preserve focus is excluded from search, copy, accessibility, and tab order. For an externally windowed data set, search the full logical data set in the application/provider, call `scrollToItem` for the chosen result, and apply the native highlight after that row mounts.

## Native input and accessibility

`Input` and `TextArea` use native text editing over Parley, including caret placement, selection, clipboard operations, grapheme-aware deletion, IME composition, wrapping, and scrolling. Password input remains masked in rendering and accessibility output.

Editors keep a native per-field undo/redo history (`Ctrl+Z`, `Ctrl+Y` / `Ctrl+Shift+Z`) that coalesces continuous typing or deletion into word-sized steps and resets when a controlled value changes externally. `onSubmit(value)` fires on Enter for `Input`; `TextArea` submits on `Ctrl/Cmd+Enter`, or on Enter with `submitOnEnter` (Shift+Enter then inserts a newline). The caret blinks after activity and settles solid after 10 s idle, so a focused editor schedules no idle frames. When the clipboard holds no text, `Ctrl+V` delivers files or a bitmap to the focused element's `onPaste` as `{ kind: "files", files }` or `{ kind: "image", width, height, rgba }`.

On Windows, Tarve projects the native tree through AccessKit/UI Automation with roles, names, values, states, actions, focus, text ranges, selection, scroll ranges, live regions, and field relationships. On Linux, the same AccessKit tree is exposed over AT-SPI (D-Bus) for screen readers such as Orca; it activates only when an assistive technology connects.

## Desktop APIs

`createApp` returns an `AppHandle` with lifecycle and desktop integration methods.

```tsx
const app = createApp(App);

const unregisterSave = app.registerHotkey("Ctrl+S", () => {
  saveProject();
});

const file = await app.openFileDialog({
  title: "Open project",
  filters: [{ name: "JSON", extensions: ["json"] }]
});

const files = await app.openFilesDialog();
const folder = await app.openFolderDialog();
const target = await app.saveFileDialog({
  fileName: "report.json"
});

unregisterSave();
```

Other `AppHandle` APIs include `update`, `close`, `focus`, `scrollToItem`, event listeners, debug inspection, and deterministic screen capture.

### Notifications

`app.notify` shows a system notification with the same call and behavior on every platform. No tray icon is needed:

```ts
app.notify({ title: "Export finished", body: "report.pdf is ready", onClick: () => openReport() });
```

| Platform | Shown through | Notes |
| --- | --- | --- |
| Windows | a toast (`ToastNotificationManager`) | under `appIdentity` (or package.json `tarve.appId`); without one, Tarve registers `Tarve.<window title>` for the current user so the toast shows the app's name |
| Linux | `org.freedesktop.Notifications` | any notification daemon (GNOME, KDE, dunst, mako…) |
| Android | the notification shade (`dev.tarve.TarveNotifications`) | asks for `POST_NOTIFICATIONS` the first time on Android 13+; notifications sent while the prompt is open show once it is allowed and are dropped if the user denies it |

Clicking a notification brings the window forward and runs that notification's `onClick` (each notification keeps its own). If the user turned the app's notifications off, nothing shows and no error is raised, the same on every platform. On Windows, a toast that cannot be shown falls back to the tray balloon when `app.tray` is active. Go apps call `app.Notify(title, body, onClick)`. On Android the small icon is a white bell; set package.json `tarve.android.notificationIcon` to a white-on-transparent PNG to replace it.

`app.checkPermissions(names)` and `app.requestPermissions(names)` handle runtime permissions (see [Android](#android)); on Windows and Linux they report every name as `"granted"`.

`Window.onCloseRequest` can cancel a user-initiated close with `event.preventDefault()`. `Window.position` accepts centered/edge/corner presets or explicit logical desktop coordinates.

## Plugins

A plugin is an npm package that adds JavaScript commands, optionally over a native library of its own (Rust, C, Zig… anything with a C ABI), like Flutter plugins or React Native Turbo Modules. The app installs it and passes it to `createApp`:

```tsx
import hello from "tarve-plugin-hello";

const app = createApp(View, { plugins: [hello] });
await hello.client(app).add(2, 3);    // typed: Promise<number>
await app.invoke("hello.add", 2, 3);  // the same command by id
```

**Writing one.** `definePlugin` takes the package name, its semver `version` and `setup(ctx)`, which runs once per app before the window opens. The functions `setup` returns become commands (`<namespace>.<name>`); `ctx.registerCommand` adds more.

```ts
import { definePlugin } from "@tarve/core";

export default definePlugin({
  name: "tarve-plugin-hello",
  version: "0.1.0",
  namespace: "hello",
  tarvePluginApi: 1,
  root: import.meta.dirname,
  setup(ctx) {
    const lib = ctx.loadLibrary({ hello_add: { args: ["i32", "i32"], returns: "i32" } });
    ctx.onReady(() => { /* window is up */ });
    ctx.onClosed(() => { /* release resources; loaded libraries close after this */ });
    ctx.onOpenUrl(url => { /* the app's protocols, as app.onOpenUrl */ });
    return { add: (a: number, b: number) => lib.symbols.hello_add(a, b) };
  },
});
```

`ctx.request(command, { expect })` sends a protocol request to the Tarve runtime and checks the answer type (what `app`'s own dialogs and permissions use). `ctx.loadLibrary(symbols)` or `ctx.loadLibrary({ "win32-x64": "…", "linux-x64": "…" }, symbols)` opens the library with the runtime's FFI: `bun:ffi` on Bun, `node:ffi` on Node.js 26.10+, `tjs:ffi` on txiki.js; elsewhere it throws `PluginFfiUnsupportedError`. Symbol types are `i8`…`u64`, `f32`, `f64`, `bool`, `ptr`, `buffer` (arguments) and `void`; the returned `symbols` are typed from the declaration.

**package.json.** The `tarve` field makes a package discoverable (`discoverPlugins`, `loadPlugins`) and tells `tarve build` which library to embed per target:

```json
"tarve": {
  "tarvePluginApi": 1,
  "plugin": "./dist/plugin.js",
  "native": {
    "win32-x64": "./native/hello.dll",
    "linux-x64": "./native/libhello.so",
    "darwin-arm64": "./native/libhello.dylib",
    "android-arm64": "./native/android/libhello.so"
  }
}
```

`tarve build` and `tarve package` (`--runtime bun`, `node` and `txiki` alike) embed the target's library of every plugin among the app's `dependencies` and extract it once on first use, like Tarve's own runtime; macOS bundles get it in `Contents/Frameworks`. Android builds do not embed plugin libraries yet: ship them beside the app and pass paths to `loadLibrary`. A declared library missing for the build target fails the build.

**Versioning.** `tarvePluginApi` is the major version of this plugin API (`PLUGIN_API_VERSION`, currently `1`). Additions keep the number; a breaking change to `definePlugin`, the context or the manifest raises it, and Tarve refuses plugins asking for a newer one. The plugin's own `version` is its semver; declare `@tarve/core` as a peer dependency. The native library's C ABI is the plugin's own contract (export a version function, as the sample does). See [examples/plugin-hello](examples/plugin-hello) for a Rust cdylib plugin with tests and a demo app.

## Automation and visual regression

`TestRenderer` exposes the supported automation surface over the same native renderer used by applications. It provides ID/text/role locators, pointer and keyboard actions, `waitFor`, `waitForIdle`, capture, and an optional hidden-window mode for CI runs that still require a real renderer surface.

```tsx
const test = await createTestRenderer(App, {
  renderer: "cpu",
  headless: true,
});

await test.getByRole("button", { name: "Save" }).click();
await test.getById("project-name").fill("Tarve demo");
await test.waitFor((snapshot) =>
  snapshot.nodes.some((node) => node.text === "Saved") || false
);

// After an interaction or app update starts a transition:
await test.advanceMotion(50);
const midpoint = await test.inspect();

await test.capture("dist/saved.png");
test.close();
```

`advanceMotion(milliseconds)` first flushes any queued declarative update, then advances the native motion clock without sleeping. Once used, that app instance stays on deterministic motion time, which makes intermediate geometry and captures reproducible. `waitForIdle()` also waits for `activeMotions === 0`.

Use `launchTestProcess` to isolate CPU/GPU test runs in child processes. `readPngRgba`, `comparePngCaptures`, and `assertPngMatches` are reusable pixel-regression helpers; Tarve's own visual smoke tests use the same public PNG decoder.

### Without a window: `@tarve/headless`

[`@tarve/headless`](packages/headless) runs the same tree, layout, text, input and CPU painter compiled to WebAssembly, so tests need no window, GPU or native library and run on any CI machine. Text uses bundled fonts and time only moves with `advanceMotion`, so captures are byte-identical across platforms.

```tsx
import { createHeadlessTestRenderer, matchImageSnapshot, renderToRgba } from "@tarve/headless";

const test = await createHeadlessTestRenderer(App); // the TestRenderer API above
await matchImageSnapshot(await renderToRgba(App, { scale: 2 }), "__snapshots__/app.png");
```

## Custom title bar

Render `TitleBar` inside `Window` to opt into Tarve-managed window chrome:

```tsx
<Window title="My app" width={1000} height={700}>
  <TitleBar title="My app" />
  <View flex={1}>
    {/* application */}
  </View>
</Window>
```

Tarve keeps native dragging, resize hit testing, and minimize/maximize/close behavior on supported platforms. Windows additionally applies Windows 11 corner and maximized/fullscreen border handling.

## Icons

Tarve includes native `Icon` and SVG primitives. The optional `@tarve/react-icons` package adapts static SVG icon components from libraries such as Lucide, Phosphor, Heroicons, and Tabler without adding React as a core Tarve dependency.

```ts
import {
  lucideReactAdapter,
  phosphorReactAdapter,
  reactSvgAdapter
} from "@tarve/react-icons";

const app = createApp(App, {
  componentAdapters: [
    reactSvgAdapter,
    lucideReactAdapter,
    phosphorReactAdapter
  ]
});
```

## Error handling

`createApp` accepts a structured application-level error handler:

```tsx
const app = createApp(App, {
  onError(event) {
    console.error(
      event.source,
      event.event,
      event.targetId,
      event.error
    );
  }
});
```

Recoverable callback, listener, hotkey, bridge, request, dialog, and update failures are reported through `onError`. A failed native update keeps the last confirmed tree.

## Development tools

Run an app in development mode with hot reload:

```powershell
$env:TARVE_DEV = "1"; bun --hot app.tsx
```

```bash
TARVE_DEV=1 bun --hot app.tsx
```

With `dev: true` (or `TARVE_DEV=1`):

- **Same-window remount:** when `bun --hot` re-evaluates the entry, `render()` remounts the new view into the already open window instead of opening a new one. `app.remount(view)` does the same explicitly and resets component state.
- **Runtime error overlay:** render, event-handler, listener, and hotkey errors replace the view with an in-window overlay (source, message, scrollable stack). *Dismiss* renders the app again; saving a fix remounts it. Errors during the first render still reject `ready`.

Independently of dev mode, the native frame-time overlay draws the CPU cost of the last 120 presented frames against a 16.7 ms budget line:

```tsx
const app = createApp(App, { frameOverlay: true }); // or TARVE_FRAME_OVERLAY=1
app.setFrameOverlay(false);
```

Neither tool schedules frames on its own, so an idle window still presents zero frames. The graph refreshes on the next repaint.

### Inspector

```bash
bunx tarve dev app.tsx --inspect   # or npx tarve dev / tarve run --inspect
```

`createApp(App, { dev: { inspector: true } })` or `TARVE_INSPECTOR=1` do the same. A second window shows the live tree of components and native nodes (×N = renders), the selected node's props, resolved style and computed layout box, and an event log. **Pick node** highlights the node under the pointer in the app window; **Expand all** / **Collapse** fold the tree. (`TARVE_INSPECT=<file>` is the unrelated automation switch that writes the tree to a file and exits.)


## Examples

The [`examples/`](https://github.com/omarcosr/tarve/tree/main/examples) directory in the repository is an independent Bun consumer project using only public Tarve APIs. From a clone:

```powershell
bun run setup:examples
cd examples
bun run check
bun run basic
bun run counter
bun run components
bun run forms
bun run intrinsics
bun run large-list
bun run rich-content
bun run diff
bun run motion
bun run studio
bun run performance
bun run tailwind
```

From the repository root, `bun run dev --entry examples/<name>/<name>.tsx` runs an example with hot reload and the development tools enabled.

`setup:examples` builds host-local package staging itself; it does not require the universal publishable tarball.

All example UI copy and example documentation is written in English.

## Platform notes

Linux file dialogs use the XDG desktop portal through `rfd`. Opening external links uses `xdg-open` when available and falls back to `gio open`.

On WSLg, Tarve prefers winit's X11 backend when `DISPLAY` is available; native Linux keeps winit's normal Wayland/X11 auto-selection. This avoids WSLg-specific Wayland `Broken pipe` event-loop failures without changing backend selection on ordinary Linux desktops.

## Contributing

Building Tarve from source, the test and smoke-test gates, and the release process are documented in [CONTRIBUTING.md](https://github.com/omarcosr/tarve/blob/main/CONTRIBUTING.md). Project notes: [production readiness](https://github.com/omarcosr/tarve/blob/main/PRODUCTION.md), [performance measurements](https://github.com/omarcosr/tarve/blob/main/PERFORMANCE.md), [release process](https://github.com/omarcosr/tarve/blob/main/RELEASE.md).

## Current scope

Tarve is pre-1.0 and currently targets **Windows x64 and Linux x64**, with Android (arm64, x86_64) APKs and App Bundles from `tarve build --target android`. The current application bootstrap model uses one native app/window lifetime per process; multi-window support is not yet part of the public runtime model.

## License

Tarve is licensed under the [Apache License 2.0](https://github.com/omarcosr/tarve/blob/main/LICENSE).
