# Performance measurements

Run `bun run build:exe` followed by `bun run bench` on Windows x64. The benchmark uses the Rust release library, opens a real GPU-backed window, and writes `work/benchmark.json`.

## Current measurement

Windows x64, Bun 1.4.1, AMD Ryzen 7 9800X3D. The workload contains 2,000 rows / 6,005 native nodes; 67 nodes are visible. Each row contains text and an interactive button. The benchmark discards five warm-up samples and collects 60 samples for each operation.

| Operation | Original full-tree update | Current property patch |
| --- | ---: | ---: |
| State update, median | 35.92 ms | 11.96 ms |
| State update, p95 | 42.41 ms | 14.51 ms |
| Scroll, median | 1.13 ms | 0.92 ms |
| Scroll, p95 | 1.97 ms | 1.09 ms |
| New frames while idle | 0 | 0 |

These are input/update dispatch to native frame-notification times, including Bun/FFI and presentation scheduling. They are not photon latency, universal FPS guarantees, or results from other hardware. Recent update runs on the same machine have ranged from 11.79 to 15.37 ms median, so the current value is one run rather than a fixed performance promise. In that run, TSX tree construction took 5.78 ms median and diffing took 1.54 ms median. The first window took 562 ms. The earlier patch implementation once measured 8.57 ms median; repeatability across machines remains unverified.

The fixed-height `VirtualList` example has 50,000 records and kept at most 97 native layout nodes during initial view, mid-list scroll and bottom-list interaction in the real-window smoke test. Native scroll events trigger updates for virtual lists; ordinary `Scroll` elements paint directly without rebuilding the TSX tree. A virtual list waits for the updated visible rows before scheduling its next frame.

## Memory

Windows x64 measurements after 1.8 s idle, using the standalone release executables and Vulkan:

| Example | Working set | Private bytes |
| --- | ---: | ---: |
| Counter | ~203 MB | ~537 MB |
| Basic | ~207–215 MB | ~597 MB |

Before requesting wgpu's memory-oriented allocation strategy and limiting Vello shader initialization to one thread, the Counter executable measured about 266 MB working set / 842 MB private bytes. The Bun event Worker itself adds roughly 16 MB working set and 40 MB private bytes in an isolated process test; removing it would require a different native event-delivery mechanism rather than polling.

## Implemented

- Stable IDs retain Taffy nodes and layout caches across updates and resizes.
- The native tree stores each node once, with child IDs instead of recursively duplicated subtrees.
- Property-only updates send only changed nodes across the bridge. Structural changes use a full replacement while preserving IDs/state.
- Layout, text and paint invalidation remain separate; hover and scrolling do not recalculate layout.
- Paint and hit testing discard subtrees outside the current clipping region.
- Local asset extraction is cached per process. No filesystem reads are required for those assets during subsequent tree updates.
- Decoded image cache entries are released when the corresponding image nodes leave the retained tree.
- The Windows renderer requests wgpu's memory-oriented allocation strategy and uses one Vello shader-initialization thread.
- The event loop sleeps when idle. The event Worker waits on a native condition variable.

## Remaining work

Timed scrolling/transitions, complex input/overlays, sustained virtual-list interaction latency and multiple Windows/GPU configurations need their own measurements and regression gates before the overall production-readiness objective is complete.
