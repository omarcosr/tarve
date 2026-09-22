# Production readiness

Objective: publishable npm GUI package for Bun, using the native Taffy / Parley / Vello backend, with a responsive component kit and runnable examples. Windows x64 is the initial supported distribution target.

## Required work and evidence

- [x] Package boundary: examples contain UI/state and normal app startup only; reusable tooling builds any app entrypoint. Verified by compiling the source example and the external consumer through the same build API.
- [x] npm artifact: exports, JSX runtime, types, CLI, native release binary, install/run/build from a clean external consumer with no repository paths. `bun run smoke:package` passed using a fresh installation in the Windows temporary directory, with TypeScript checking enabled.
- [x] Standalone Windows EXE: generic build, embedded runtime/assets, no development dependencies, real window and input verification. The installed CLI builds an external consumer on a different drive; its EXE passes window, callback, image and idle checks with an empty cache and no Bun/Rust on PATH.
- [ ] Components: common form controls, navigation, overlays, feedback, layout primitives, and large-list support; keyboard behavior and disabled/focus states. Basic controls and fixed-height virtual rows are implemented; selection popovers, multiline editing and feedback overlays remain.
- [ ] Input and lifecycle: robust editing, focus, IME, error handling, resource cleanup and window/device recovery.
- [ ] Performance: measure idle work, frame latency, scrolling and updates on realistic large trees; optimize based on those measurements.
- [ ] Smooth interaction: native scrolling/transitions on demand, clipping and correct pointer/keyboard interactions under load.
- [ ] Examples: minimal app, component gallery, forms, overlays, and large data/list example. Counter, basic gallery, forms and 50,000-row list exist; dedicated overlays and advanced component gallery remain.
- [ ] Release documentation and gates: API, support limits, build/distribution, reproducible checks, packaging and native integration tests.

Completion requires verification of the shipped artifact and examples, not only unit tests. Registry publication is a separate action; this work prepares and validates the npm artifact locally.

## Measured progress

Retained Taffy nodes, a shallow native tree, clipping-aware scene generation and property patches are implemented. Eighteen Rust tests and nineteen TypeScript tests cover layout/input invariants and the update path. Real-window smoke tests pass for the original app, form controls and the 50,000-row virtual list. The npm tarball also passes install, source and standalone EXE checks in an external consumer. The latest release run measured 11.96 ms median for updates and 0.92 ms for ordinary scroll on a 6,005-node tree; idle frames remain zero. See `PERFORMANCE.md` for methodology and limits.

The public kit now includes Pressable, Icon, Checkbox, Switch, RadioGroup, Slider, Card, Badge, Separator, Progress, Tabs, Accordion and VirtualList. The forms example exercises controls with keyboard and pointer input. A 50,000-record example keeps fewer than 100 native layout nodes while scrolling. Focus scrolls offscreen controls into view; grouped radio choices use one Tab stop; leaving the window during slider drag preserves its value.

## Next implementation work

Complete Select, TextArea, Popover/Menu and Tooltip/Toast with native interaction foundations rather than visual-only placeholders. Add dedicated overlays and advanced component examples. Improve IME editing, selection and accessibility. Add timed scrolling/transitions that schedule frames only while active. Characterize sustained interaction and frame presentation latency on multiple GPUs/Windows systems. Re-run packaging and performance gates after each native/protocol change.
