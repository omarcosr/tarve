# Tarve

Native desktop UI for **Bun + TypeScript/TSX**.

Tarve turns a TSX tree into a retained native interface. It does not use a browser, DOM, or React runtime. Layout is handled by **Taffy**, text shaping and editing by **Parley**, and rendering is selectable between a native Windows GPU path and a low-memory CPU path.

> **Current supported target:** Windows x64
>
> **Runtime:** Bun 1.4+
>
> **Package:** `tarve`
>
> **License:** Apache-2.0

## Highlights

- Native TSX UI with a dedicated `tarve` JSX runtime.
- Retained Taffy Flexbox/Grid layout with incremental property and structural updates.
- Parley text shaping, selection, clipboard, caret handling, IME composition, and Unicode-aware editing.
- Native Windows D3D11/DXGI renderer by default, with Vello/WGPU fallback and a `vello_cpu + softbuffer` CPU renderer.
- shadcn-inspired components and semantic light/dark theme tokens.
- Native Markdown, syntax-highlighted Code, and Diff leaves designed for large documents.
- Fixed-height, measured variable-height, and externally windowed `VirtualList` modes.
- Windows UI Automation accessibility through AccessKit.
- Global hotkeys, native file dialogs, custom title bars, window positioning, and standalone `.exe` builds.
- Event-driven Bun/native bridge with no continuous idle polling.

## Installation

For a published package:

```powershell
bun add tarve
bun add -d typescript @types/bun
```

To consume the package directly from this repository before registry publication:

```powershell
bun run pack
bun add ./dist/tarve-0.1.0.tgz
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
    "jsxImportSource": "tarve",
    "types": ["bun", "tarve/assets"]
  }
}
```

## Quick start

```tsx
import { Button, Column, Text, Window, createApp } from "tarve";

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

The package CLI compiles a Tarve application into a standalone Windows x64 executable and embeds the native runtime.

```powershell
bun run tarve build app.tsx --outfile dist/App.exe
```

The build API is also exported:

```ts
import { build } from "tarve/build";

await build({
  entrypoint: "app.tsx",
  outfile: "dist/App.exe",
  name: "My App"
});
```

## Renderers

`createApp` accepts `renderer: "auto" | "gpu" | "cpu"`.

| Mode | Windows behavior |
| --- | --- |
| `auto` | Default. Uses GPU unless `TARVE_RENDERER` overrides it for development or CI. |
| `gpu` | Uses the native D3D11/DXGI renderer. Tarve can fall back to the Vello/WGPU GPU path if native GPU initialization or recovery fails. |
| `cpu` | Uses `vello_cpu + softbuffer`; useful for low-memory or software-rendered workloads. |

```tsx
const app = createApp(App, {
  renderer: "cpu"
});
```

An explicit renderer in `createApp` takes precedence over `TARVE_RENDERER`. `WGPU_BACKEND` is a development/diagnostic escape hatch on Windows that selects the legacy Vello/WGPU path instead of the normal D3D11 renderer.

## Components

Tarve exports native primitives and higher-level controls from the main `tarve` entry point.

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
import { Button, Window, darkTheme, theme } from "tarve";

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

Create derived themes with `createTheme` or `Theme.create`. Theme tokens cover surfaces, foregrounds, borders, focus outlines, selection, caret, scrollbars, modal overlays, rich-content colors, and control states.

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

## Native input and accessibility

`Input` and `TextArea` use native text editing over Parley, including caret placement, selection, clipboard operations, grapheme-aware deletion, IME composition, wrapping, and scrolling. Password input remains masked in rendering and accessibility output.

On Windows, Tarve projects the native tree through AccessKit/UI Automation with roles, names, values, states, actions, focus, text ranges, selection, scroll ranges, live regions, and field relationships.

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

Tarve keeps native dragging, resize hit testing, minimize/maximize/close behavior, Windows 11 corner handling, and maximized/fullscreen border behavior.

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

## Examples

The `examples/` directory is an independent Bun consumer project using only public Tarve APIs.

```powershell
bun run pack
bun run setup:examples
cd examples
bun run check
bun run counter
bun run components
bun run forms
bun run intrinsics
bun run large-list
bun run rich-content
bun run diff
```

All example UI copy and example documentation is written in English.

## Developing Tarve

Building the native library requires:

- Windows x64
- Bun 1.4+
- Rust stable with the `x86_64-pc-windows-msvc` target
- Visual Studio Build Tools with C++ tooling and the Windows SDK

```powershell
bun install
bun run build:native
bun run check
bun run test
```

Run the full package, executable, accessibility, and visual release gate with:

```powershell
bun run verify
```

Additional project documentation:

- [Production readiness](PRODUCTION.md)
- [Performance measurements](PERFORMANCE.md)
- [Release process](RELEASE.md)

## Current scope

Tarve is pre-1.0 and currently targets **Windows x64**. The current application bootstrap model uses one native app/window lifetime per process; multi-window support is not yet part of the public runtime model.

## License

Tarve is licensed under the [Apache License 2.0](LICENSE).
