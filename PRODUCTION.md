# Production readiness

Objective: publishable npm GUI package for Bun, using the native Taffy / Parley / Vello backend, with a responsive component kit and runnable examples. Windows x64 is the initial supported distribution target.

## Required work and evidence

- [x] Package boundary: examples contain UI/state and normal app startup only; reusable tooling builds any app entrypoint. Verified by compiling the source example and the external consumer through the same build API.
- [x] npm artifact: exports, JSX runtime, types, CLI, native release binary, install/run/build from a clean external consumer with no repository paths. `bun run smoke:package` passed using a fresh installation in the Windows temporary directory, with TypeScript checking enabled.
- [x] Standalone Windows EXE: generic build, embedded runtime/assets, no development dependencies, real window and input verification. The installed CLI builds an external consumer on a different drive; its EXE passes window, callback, image and idle checks with an empty cache and no Bun/Rust on PATH.
- [ ] Components: common form controls, navigation, overlays, feedback, layout primitives, and large-list support; keyboard behavior and disabled/focus states.
- [ ] Input and lifecycle: robust editing, focus, IME, error handling, resource cleanup and window/device recovery.
- [ ] Performance: measure idle work, frame latency, scrolling and updates on realistic large trees; optimize based on those measurements.
- [ ] Smooth interaction: native scrolling/transitions on demand, clipping and correct pointer/keyboard interactions under load.
- [ ] Examples: minimal app, component gallery, forms, overlays, and large data/list example.
- [ ] Release documentation and gates: API, support limits, build/distribution, reproducible checks, packaging and native integration tests.

Completion requires verification of the shipped artifact and examples, not only unit tests. Registry publication is a separate action; this work prepares and validates the npm artifact locally.

## Measured progress

Retained Taffy nodes, a shallow native tree, clipping-aware scene generation and property patches are implemented. Eight Rust tests and five TypeScript tests cover layout/input invariants and the new update path. The existing real-window interaction smoke test passes. With 6,005 nodes, release update latency fell from a 35.92 ms median to 8.57 ms; idle frames remain zero. See `PERFORMANCE.md` for methodology and limits.

## Next implementation work

Complete the common application kit: Pressable/Icon, Checkbox, Switch, RadioGroup, Slider, Select, TextArea, Card, Badge, Separator, Progress, Tabs, Accordion, Dialog, Popover/Menu, Tooltip/Toast and VirtualList. Build the native interaction/focus/overlay foundations needed for these controls, rather than adding visual-only placeholders. Then add forms, component and large-list examples and their keyboard/pointer integration checks. Scrolling/transitions must schedule frames only while active.
