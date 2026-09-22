# Production readiness

Objective: ship Tarve as a publishable native GUI toolkit for Bun/TypeScript with a Rust Taffy + Parley + Vello backend. The supported production target is currently **Windows x64**.

## Current verified baseline

- TypeScript package checking: `bun run check` passes.
- Rust lint gate: `cargo clippy --manifest-path native/Cargo.toml --all-targets -- -D warnings` passes.
- Core/UI suite: **82 Bun tests / 434 assertions** pass.
- Native suite: **43 Rust tests** pass.
- Protocol is currently **v26** on both TypeScript and Rust sides and is checked by the FFI bridge before startup.
- npm packaging includes JS, JSX runtime, declarations and the Windows x64 native library.
- External-consumer and standalone-EXE smoke tests are part of `bun run verify`.
- Real GPU visual regression exists in `bun run test:visual`; it is still a separate gate rather than part of `verify`.
- Latest full validation on this tree: `bun run verify` **PASS** and `bun run test:visual` **PASS** with the freshly packed/installed v26 artifact.

## Production foundations already implemented

- [x] Retained Taffy layout tree, property patches, stable IDs and separated layout/text/paint invalidation.
- [x] Parley text shaping, Unicode editing, pointer selection, clipboard operations and grapheme-aware deletion.
- [x] `Input` types (`text`, `password`, `email`, `number`, `search`, `tel`, `url`), including native password masking and numeric-edit filtering.
- [x] Native vertical scrolling with clipping, draggable scrollbar, configurable `Scroll.speed` and focus-to-visible behavior.
- [x] Fixed-height `VirtualList` with bounded native layout-node count.
- [x] Modal portals, focus trap, outside dismissal, Escape handling and focus restoration.
- [x] Popup triggers preserve existing interactive `Button`/`Pressable`/native controls rather than nesting a competing interactive wrapper.
- [x] `DropdownMenu`, `ContextMenu`, `Combobox`, `Command` and `CommandPalette` use native roving keyboard focus; disabled entries are skipped and Enter/Space activates focused pressable items.
- [x] `Window.onCloseRequest` can cancel an OS/custom-titlebar close request with `event.preventDefault()`; `app.close()` remains unconditional.
- [x] Global app hotkeys through `app.registerHotkey("Ctrl+S", handler)` with canonical modifier/key normalization.
- [x] Native Windows file dialogs through `openFileDialog`, `openFilesDialog`, `openFolderDialog` and `saveFileDialog`, including title/directory/file-name/filter options and cancellation results.
- [x] `TreeView` with controlled expansion/selection, vertical roving focus and keyboard expand/collapse.
- [x] `DataGrid` distinct from `DataTable`, with fixed-row virtualization, local/manual filtering, local/manual sorting, controlled single/multiple selection and keyboard row navigation/activation.
- [x] npm tarball consumer tests validate the installed declarations rather than only workspace types.
- [x] Standalone Windows executable build embeds the Bun app/runtime and native DLL and runs with no development repository on PATH.
- [x] Idle event loop performs no continuous frame polling.

## Remaining blockers before a general production claim

### 1. OS accessibility bridge

Tarve has internal semantic roles and keyboard focus behavior, but those roles are not yet projected into Windows UI Automation/AccessKit. Narrator/NVDA therefore cannot consume a complete native accessibility tree. This is a blocker for a general-purpose public desktop toolkit.

Required work: add AccessKit/UIA integration, names/roles/states/actions, focus notifications, value/range semantics, modal scopes and label/description/error relationships. Add automated accessibility-tree tests where possible.

### 2. IME/composition completeness

IME commit works for `Input`, but preedit text is not rendered, the candidate rectangle is not positioned from the shaped caret, and `TextArea` is not currently included in the IME enablement path. CJK/composition-heavy editing therefore remains incomplete.

Required work: visual preedit ranges, shaped-caret candidate positioning, `TextArea` IME, composition selection/replacement rules and dedicated Windows IME regression tests.

### 3. JavaScript exception containment

Native errors are surfaced through `onError`, but exceptions thrown by render functions, component callbacks or event listeners can still escape the dispatcher.

Required work: one application-level error boundary that contains render/update, callbacks, listeners and bridge sends, reports through `onError`, and leaves the native window in a deterministic state.

### 4. GPU/surface/device recovery

Vello/wgpu rendering handles normal resize and tries Vulkan then DX12 on Windows, but transient surface states and device loss do not yet have a full recovery state machine. An Outdated/Timeout/Occluded presentation can require another redraw, while fatal device/surface failures currently terminate the app rather than recreating graphics state.

Required work: preserve/redirty frames on transient presentation failures, recreate surface/device/renderer when recoverable, and add forced-failure/recovery tests.

## Release and operational hardening

- [ ] Add CI on a Windows x64 runner for `check`, Clippy, Bun/Rust tests, package smoke and standalone EXE smoke.
- [ ] Decide whether `test:visual` becomes a mandatory release gate and maintain approved captures.
- [ ] Clean generated package/type output before packaging so removed files cannot survive from a previous build.
- [ ] Synchronize root/core/protocol/Cargo package versions automatically; protocol schema versioning remains separate from package SemVer.
- [ ] Separate the C ABI version from the JSON protocol version and test both mismatch paths independently.
- [ ] Bound/coalesce the native event `VecDeque` for high-rate events such as hover/scroll/frame notifications.
- [ ] Add structured diagnostics: selected GPU/backend/adapter, startup failures, renderer/device failures and optional persistent crash/startup logs.
- [ ] Test sustained interaction and startup/presentation latency on multiple Windows releases and multiple NVIDIA/AMD/Intel GPUs.
- [ ] Add Authenticode signing to the public EXE release path if binaries will be distributed to third parties.
- [ ] Replace `UNLICENSED` only if Tarve is intended to be distributed under a public/open license; keep it intentionally if the project remains proprietary.

## Known scope limits / important follow-up components

- One native app/window lifetime per process remains the documented bootstrap model; multi-window is not implemented.
- Scroll is vertical only; horizontal/bidirectional `ScrollArea` remains.
- `Button` still accepts text/number content rather than arbitrary icon+text child composition.
- `Label`/`Field` do not yet expose full native labelled-by/described-by/error associations; this should land together with accessibility work.
- `Calendar`/`DatePicker`, `Menubar` and `HoverCard` still need deeper desktop keyboard/focus semantics.
- `DataTable` remains the lightweight static table API; use the new `DataGrid` when sorting/filtering/selection/virtualization are required.
- `Toast`/`Toaster` are render-driven and do not yet provide an owned timed queue/live-region implementation.
- Number spin buttons, MultiSelect/TagInput, DateRangePicker/TimePicker, ColorPicker, dropzone, Toolbar/SplitButton and StatusBar remain optional toolkit expansion work rather than runtime blockers.

## Release completion criteria

For a Windows x64 beta/internal production release, the shipped npm tarball and standalone EXE must pass `bun run verify`, and native/protocol changes should also pass `bun run test:visual` before release.

For a broad public **production-ready / 1.0** claim, complete the four blockers above (accessibility, IME, JS exception containment and GPU recovery), automate the release gates, and document the intentionally supported platform/lifecycle limits.
