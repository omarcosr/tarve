# Production readiness

Objective: ship Tarve as a publishable native GUI toolkit for Bun/TypeScript with a Rust Taffy + Parley + Vello backend. The supported production target is currently **Windows x64**.

## Current verified baseline

- TypeScript package checking: `bun run check` passes.
- Rust lint gate: `cargo clippy --manifest-path native/Cargo.toml --all-targets -- -D warnings` passes.
- Core/UI suite: **192 Bun tests** pass.
- Native suite: **204 Rust tests** pass on Windows (183 on Linux, where the AccessKit bridge is not built), including deterministic AccessKit tree/action/TextPattern/scroll-alignment, horizontal/bidirectional scroll, bounded grid-track coverage and independent ABI/protocol mismatch handling.
- JSON protocol is currently **v45** on both TypeScript and Rust sides; the native C ABI is independently versioned at **v5** and checked before startup.
- The npm package `@tarve/core` includes JS, JSX runtime, declarations, the CLI and both the Windows x64 and Linux x64 native runtimes.
- External-consumer and standalone-EXE smoke tests are part of `bun run verify`.
- Real GPU visual regression is a mandatory release gate: `bun run verify` runs `test:visual` after package/EXE smoke validation, and `bun run release:check` is the CI/release entry point for the same gate.
- Latest full validation on this tree: `bun run verify` **PASS**, including release-policy checks, synchronized product-version policy, independent ABI/protocol tests, the integrated `test:visual` gate against the freshly packed/installed artifact, Windows x64 `smoke:accessibility`, package/standalone-EXE smoke and stale-package-output coverage.
- Tarve does not Authenticode-sign its runtimes; applications built with `tarve build` are signed by their authors. The npm tarball carries npm provenance and SHA-256 release metadata.

## Production foundations already implemented

- [x] Retained Taffy layout tree, property patches, stable IDs and separated layout/text/paint invalidation.
- [x] Parley text shaping, Unicode editing, pointer selection, clipboard operations and grapheme-aware deletion.
- [x] `Input` types (`text`, `password`, `email`, `number`, `search`, `tel`, `url`), including native password masking and numeric-edit filtering.
- [x] Native vertical scrolling with clipping, draggable scrollbar, configurable `Scroll.speed` and focus-to-visible behavior.
- [x] Composite `Button` children and native horizontal/bidirectional `ScrollArea`: text-only buttons retain the compact native path, while icon/text/layout composition remains one focusable/clickable semantic button; scroll areas support vertical/horizontal/both axes, 2D wheel/trackpad offsets, axis scrollbars, focus/UIA scroll-into-view and a backward-compatible scalar `onScroll` plus `onScrollPosition`.
- [x] Fixed-height `VirtualList` with bounded native layout-node count.
- [x] Modal portals, focus trap, outside dismissal, Escape handling and focus restoration.
- [x] Popup triggers preserve existing interactive `Button`/`Pressable`/native controls rather than nesting a competing interactive wrapper.
- [x] `DropdownMenu`, `ContextMenu`, `Combobox`, `Command` and `CommandPalette` use native roving keyboard focus; disabled entries are skipped and Enter/Space activates focused pressable items.
- [x] `Window.onCloseRequest` can cancel an OS/custom-titlebar close request with `event.preventDefault()`; `app.close()` remains unconditional.
- [x] Global app hotkeys through `app.registerHotkey("Ctrl+S", handler)` with canonical modifier/key normalization.
- [x] Native Windows file dialogs through `openFileDialog`, `openFilesDialog`, `openFolderDialog` and `saveFileDialog`, including title/directory/file-name/filter options and cancellation results.
- [x] `TreeView` with controlled expansion/selection, vertical roving focus and keyboard expand/collapse.
- [x] `DataGrid` distinct from `DataTable`, with fixed-row virtualization, local/manual filtering, local/manual sorting, controlled single/multiple selection and keyboard row navigation/activation.
- [x] Application-level JavaScript exception containment with structured `onError`, deterministic startup rejection, isolated handlers/listeners/hotkeys, transactional native updates and rollback to the last confirmed tree after recoverable failures.
- [x] GPU/surface/device recovery: `Outdated`, `Timeout`, `Occluded` and `Lost` presentation states recover without terminating the app; wgpu device-loss/uncaptured-error callbacks feed a bounded graphics state machine that can rebuild Device/Queue/Vello/surface state, fail over Vulkan/DX12 on Windows, preserve CPU tree/scene/focus/scroll/image state and keep frame counters monotonic across graphics generations.
- [x] Complete native IME composition for `Input` and `TextArea`: visual preedit/selection, selection replacement and commit/cancel lifecycle, UTF-8 byte cursor handling, candidate positioning from the same Parley-shaped caret used for rendering (including wrapping, scrolling and text alignment), controlled-value reconciliation with stale-event rejection, password masking and final number-input validation.
- [x] Native Windows accessibility bridge through AccessKit/UI Automation: stable semantic IDs, names/roles/states/actions, focus notifications, range values, live regions, modal scopes, UIA TextRange-aligned scroll-into-view and `Field` label/description/error/required/invalid associations. Editable `Input`/`TextArea` nodes expose Value/Text patterns with grapheme-aware multiline/bidirectional text geometry and selection, password values remain masked, selectable controls expose UIA-supported selection/toggle semantics and modal fallback focus uses the same caret/scroll initialization path as normal focus. AccessKit tree projection is lazy: normal input/scroll/update paths do no accessibility layout/tree work until a Windows UIA client activates the provider, and active accessibility sync performs layout/geometry only rather than eagerly rebuilding the Vello scene. The real Windows UIA provider is exercised automatically by `smoke:accessibility`.
- [x] npm tarball consumer tests validate the installed declarations rather than only workspace types.
- [x] Standalone Windows executable build embeds the Bun app/runtime and native DLL and runs with no development repository on PATH.
- [x] Idle event loop performs no continuous frame polling.

## Release and operational hardening

- [x] Windows x64 CI in `.github/workflows/ci.yml` installs locked Bun/Rust dependencies and runs the full `release:check` gate, with visual captures uploaded as artifacts. The workflow is configured for pushes, pull requests and manual dispatch; remote execution still occurs when GitHub runs that workflow.
- [x] `test:visual` is a mandatory release gate inside `bun run verify` / `bun run release:check`, after package and standalone-EXE smoke validation.
- [x] Packaging removes stale `dist/npm`, `dist/types`, `native/win32-x64` and prior `dist/*.tgz` outputs before rebuilding; a focused Bun regression test verifies stale generated files cannot survive while unrelated visual artifacts are preserved.
- [x] Product SemVer is synchronized across root/core/protocol/`bun.lock`/Cargo/Cargo.lock by `version:set`, enforced by `version:check` / `release:policy`, while protocol schema versioning remains independent.
- [x] The native C ABI is versioned independently from the JSON protocol (ABI v1 vs protocol v29), with TS/Rust agreement checks and independent mismatch regressions.
- [ ] Bound/coalesce the native event `VecDeque` for high-rate events such as hover/scroll/frame notifications.
- [ ] Add structured diagnostics: selected GPU/backend/adapter, startup failures, renderer/device failures and optional persistent crash/startup logs.
- [ ] Test sustained interaction and startup/presentation latency on multiple Windows releases and multiple NVIDIA/AMD/Intel GPUs.
- [x] Tagged releases verify that the final npm tarball contains exactly the staged Windows and Linux runtimes, emit SHA-256 release metadata and publish (with npm provenance) only after the full release gate passes.
- [x] License policy is explicit and release-gated: Tarve uses **Apache License 2.0** (`Apache-2.0`) across the root package, private workspace packages and native crate, with the canonical `LICENSE` text included in distribution artifacts; the native crate remains non-publishable independently.

## Known scope limits / important follow-up components

- One native app/window lifetime per process remains the documented bootstrap model; multi-window is not implemented.
- `Calendar`/`DatePicker`, `Menubar` and `HoverCard` still need deeper desktop keyboard/focus semantics.
- `DataTable` remains the lightweight static table API; use the new `DataGrid` when sorting/filtering/selection/virtualization are required.
- `Toast`/`Toaster` are render-driven and do not yet provide an owned timed queue/live-region implementation.
- Number spin buttons, MultiSelect/TagInput, DateRangePicker/TimePicker, ColorPicker, dropzone, Toolbar/SplitButton and StatusBar remain optional toolkit expansion work rather than runtime blockers.

## Release completion criteria

For a release, the shipped npm tarball must pass `bun run release:check` (the same full gate as `bun run verify`), which includes the mandatory real-GPU `test:visual` regression and release-policy/version checks.

Official third-party release artifacts must be produced by the tag workflow in `.github/workflows/release.yml`, with a tag exactly matching `v<product-semver>`. The detailed license/version/release procedure is documented in `RELEASE.md`.

For a broad public **production-ready / 1.0** claim, complete the applicable distribution/diagnostics hardening above, and document/test the intentionally supported platform/lifecycle limits.
