# Changelog

All notable changes to `@tarve/core` and `@tarve/react-icons` are documented here. Versions follow [Semantic Versioning](https://semver.org/); before 1.0, minor versions may contain breaking changes.

## Unreleased

### Added
- `borderStyle` (`dashed`, `dotted`, `double`, `groove`, `ridge`, `inset`, `outset`, `none`) on any node with a uniform border width.
- `textShadow: { x, y, color }` on text, button labels, `Input` and `TextArea`, including state styles such as `hover` (solid offset; no blur). Protocol version is now 46.
- Linux accessibility: the AccessKit bridge now runs on Linux through AT-SPI, so screen readers such as Orca can read and drive Tarve apps.
- Word-wise editing in `Input`/`TextArea`: `Ctrl+←/→` (Option on macOS) moves by word, with `Shift` to select; `Ctrl+Backspace`/`Ctrl+Delete` delete a word.

### Changed
- Faster native runtime: `mimalloc` allocator and `FxHash` maps cut native tree update time by ~40% on a 6,000-node tree.
- Syntax highlight cache uses an O(1) LRU.
- Text highlight search no longer depends on the `regex` crate.

## 0.1.2 — 2026-09-28

### Added
- `@tarve/react-icons` is published alongside `@tarve/core`.

### Changed
- The published `package.json` contains only consumer-facing fields.

## 0.1.1 — 2026-09-28

### Changed
- Package renamed from `tarve` to `@tarve/core`. The CLI command is still `tarve`.

## 0.1.0 — 2026-09-28

Initial release: native Windows x64 and Linux x64 runtime with JSX components, Taffy layout, Parley text, Vello and D3D11 rendering, rich markdown/code/diff, native text editing with undo/redo, motion transitions, Windows accessibility, file dialogs, global hotkeys and standalone executable builds.
