# Tarve

Native desktop UI for **Bun + TypeScript/TSX**.

Tarve turns a TSX tree into a retained native interface. It does not use a browser, DOM, or React runtime. Layout is handled by **Taffy**, text shaping and editing by **Parley**, and rendering is selectable between GPU and low-memory CPU paths.

> **Current supported targets:** Windows x64 and Linux x64
>
> **Runtime:** Bun 1.4+
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
- Accessibility through AccessKit: UI Automation on Windows and AT-SPI on Linux.
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

Run the source directly with Bun:

```powershell
bun app.tsx
```

## Build a standalone executable

The package CLI compiles a Tarve application into a standalone executable and embeds the native runtime. Windows produces a `.exe`; Linux produces an ELF executable with no required extension. The target defaults to the current host. Published Tarve packages contain both Windows x64 and Linux x64 native runtimes, so `--target` can switch between those targets without rebuilding Tarve's Rust runtime.

```powershell
bun run tarve build app.tsx --outfile dist/App.exe
```

```bash
bun run tarve build app.tsx --outfile dist/App
```

Cross-compile explicitly from either Windows x64 or Linux x64:

```bash
bun run tarve build app.tsx --target windows-x64 --outfile dist/App.exe
bun run tarve build app.tsx --target linux-x64 --outfile dist/App
```

The published package already contains both runtimes, so `tarve build` needs no Rust toolchain.

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

Borders accept `borderStyle` with the same values as `outlineStyle` (`dashed`, `dotted`, `double`, `groove`, `ridge`, `inset`, `outset`, `none`); non-solid styles apply when all four border widths are equal. Text and button labels accept `textShadow: { x, y, color }`, a solid offset copy of the glyphs. Blurred text shadows are not supported yet.

Create derived themes with `createTheme` or `Theme.create`. Theme tokens cover surfaces, foregrounds, borders, focus outlines, selection, caret, scrollbars, modal overlays, rich-content colors, and control states.

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

## Images

`Image` accepts local paths, data URLs, encoded PNG/JPEG/WebP/SVG bytes, and raw RGBA8 pixels. Raw RGBA is sent directly to the native image cache, so live pixel updates do not require a PNG encode/decode round trip.

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

HTTP(S) loading is explicit and asynchronous. `loadImageSource` supports `AbortSignal`, payload limits, and a bounded in-process LRU cache:

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

`Window.onCloseRequest` can cancel a user-initiated close with `event.preventDefault()`. `Window.position` accepts centered/edge/corner presets or explicit logical desktop coordinates.

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
```

From the repository root, `bun run dev --entry examples/<name>.tsx` runs an example with hot reload and the development tools enabled.

`setup:examples` builds host-local package staging itself; it does not require the universal publishable tarball.

All example UI copy and example documentation is written in English.

## Platform notes

Linux file dialogs use the XDG desktop portal through `rfd`. Opening external links uses `xdg-open` when available and falls back to `gio open`.

On WSLg, Tarve prefers winit's X11 backend when `DISPLAY` is available; native Linux keeps winit's normal Wayland/X11 auto-selection. This avoids WSLg-specific Wayland `Broken pipe` event-loop failures without changing backend selection on ordinary Linux desktops.

## Contributing

Building Tarve from source, the test and smoke-test gates, and the release process are documented in [CONTRIBUTING.md](https://github.com/omarcosr/tarve/blob/main/CONTRIBUTING.md). Project notes: [production readiness](https://github.com/omarcosr/tarve/blob/main/PRODUCTION.md), [performance measurements](https://github.com/omarcosr/tarve/blob/main/PERFORMANCE.md), [release process](https://github.com/omarcosr/tarve/blob/main/RELEASE.md).

## Current scope

Tarve is pre-1.0 and currently targets **Windows x64 and Linux x64**. The current application bootstrap model uses one native app/window lifetime per process; multi-window support is not yet part of the public runtime model.

## License

Tarve is licensed under the [Apache License 2.0](https://github.com/omarcosr/tarve/blob/main/LICENSE).
