# Tarve examples

This directory is a standalone Bun consumer project for the `tarve` npm package. The examples import only public package APIs and local media assets; their `tsconfig.json` does not inherit repository configuration.

From the repository root, build the local package and install its tarball into this consumer project:

```powershell
bun run pack
bun run setup:examples
cd examples
bun run check
```

Run an example with one of the package scripts:

```powershell
bun run counter
bun run basic
bun run components
bun run forms
bun run intrinsics
bun run large-list
bun run motion
bun run rich-content
bun run diff
bun run studio
bun run performance
```

The examples cover:

- `counter`: a minimal native app plus global hotkeys, file/folder dialogs, save dialogs, and cancellable `Window.onCloseRequest`.
- `basic`: core layout, text, buttons, images, scrolling, and common controls.
- `components`: the broader component set, including `TreeView` and `DataGrid`.
- `forms`: input and form controls.
- `intrinsics`: Tarve JSX intrinsics such as `div`, `span`, `p`, `img`, `input`, `textarea`, `button`, `label`, `select`, `progress`, headings, and lowercase SVG elements.
- `large-list`: virtualized list behavior.
- `motion`: native retained transitions with `motionFrom`, numeric size/opacity/radius animation, easing curves, mid-flight retargeting, `onTransitionEnd`, and `AnimatePresence` enter/exit lifetime handling.
- `rich-content`: GFM Markdown, syntax-highlighted TypeScript, native code line numbers, and generated diffs.
- `studio`: the Tarve Studio app from the launch film. A searchable, sortable `DataGrid`, an **Actions** `DropdownMenu` (open a source file into the `Code` tab, a **Build executable…** `Dialog` that compiles the example with `tarve/build`, a runtime dark/light theme switch), a `Sidebar`, a `Resizable` inspector with `Switch`, `Slider` and `Progress`, and `Tabs` holding `Code`, `Markdown` and `Diff`.
- `performance`: the performance sequence from the launch film. A 100,000-row `VirtualList` whose **Fly to row** button animates the controlled offset to any row, and a card grid that reflows live as you resize the window.
- `diff`: an interactive patch review with file sections, search, word-level changes, selectable text, collapsible files, and visible-line limits. **Open .patch / .diff** accepts Git patches and unified diffs up to 8 MB.

Build any example as a standalone Windows executable with the package CLI:

```powershell
bun run tarve build counter.tsx --outfile dist/Counter.exe
bun run tarve build rich-content.tsx --outfile dist/RichContent.exe
```

When consuming a published package instead of the repository tarball:

```powershell
bun add tarve@0.1.0
```
