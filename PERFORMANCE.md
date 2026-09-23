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

A previous fixed-height `VirtualList` run with 50,000 records kept at most 97 native layout nodes during initial view, mid-list scroll and bottom-list interaction in the real-window smoke test. The current example uses 500 records and taller padded rows. Native scroll events trigger updates for virtual lists; ordinary `Scroll` elements paint directly without rebuilding the TSX tree. A virtual list waits for the updated visible rows before scheduling its next frame.

## Memory

### Low-memory CPU renderer

Windows x64, Bun 1.4.2, Counter 620x520 executado a partir do pacote local atualizado no renderer CPU. O backend pode ser selecionado por `createApp(App, { renderer: "cpu" })`; `TARVE_RENDERER=cpu` continua disponível quando o app usa `renderer: "auto"`. No estado final com polling FFI não bloqueante de 4 ms, após o app estabilizar em idle:

| Metric | CPU renderer |
| --- | ---: |
| Working set | **46.9 MB** |
| Private bytes | 134.5 MB |
| Threads | 24 |
| CPU idle | **0.39% de um core** (~0.024% do CPU total de 16 threads) |

Esse modo mantém o Bun como runtime principal e continua suportando TypeScript/TSX, APIs Bun e pacotes npm. A redução vem de duas mudanças: o pump de eventos não cria mais um segundo Bun Worker, e o renderer `vello_cpu + softbuffer` evita inicializar `wgpu + Vello GPU`. O backend GPU continua disponível e permanece o padrão. Uma configuração explícita em `createApp` tem prioridade sobre `TARVE_RENDERER`; `"auto"` preserva o override por env para desenvolvimento/CI.

Um protótipo anterior tentou usar `JSCallback({ threadsafe: true })` para acordar o runtime principal. No Bun 1.4.2, depois da primeira invocação cross-thread esse callback manteve aproximadamente um core ocupado em idle. O caminho final remove callbacks cross-thread e usa `tarve_poll_event()` a cada 4 ms. Em probes isolados, polls de 4–16 ms ficaram entre ~0.0% e ~0.2% de um core; no app completo o Counter ficou em ~0.39% de um core idle.

Os números abaixo são medições históricas do renderer GPU e usam um método diferente (executáveis standalone), portanto não devem ser tratados como comparação A/B direta com a tabela acima.

Windows x64 measurements after 1.8 s idle, using the standalone release executables and Vulkan:

| Example | Working set | Private bytes |
| --- | ---: | ---: |
| Counter | ~203 MB | ~537 MB |
| Basic | ~207–215 MB | ~597 MB |

Before requesting wgpu's memory-oriented allocation strategy and limiting Vello shader initialization to one thread, the Counter executable measured about 266 MB working set / 842 MB private bytes. In an isolated Bun process, the old dedicated event Worker added roughly 15–16 MB working set and about 40 MB private bytes. It has since been removed: native events remain in a FIFO queue and the main Bun runtime drains them with a non-blocking FFI poll.

## Implemented

- Stable IDs retain Taffy nodes and layout caches across updates and resizes.
- The native tree stores each node once, with child IDs instead of recursively duplicated subtrees.
- Property-only updates send only changed nodes across the bridge. Structural changes use a full replacement while preserving IDs/state.
- Layout, text and paint invalidation remain separate; hover and scrolling do not recalculate layout.
- Paint and hit testing discard subtrees outside the current clipping region.
- Local asset extraction is cached per process. No filesystem reads are required for those assets during subsequent tree updates.
- Decoded image cache entries are released when the corresponding image nodes leave the retained tree.
- The Windows GPU renderer requests wgpu's memory-oriented allocation strategy and uses one Vello shader-initialization thread.
- `createApp(App, { renderer: "cpu" })` selects a single-threaded `vello_cpu + softbuffer` path that shares the same tree/text/control paint traversal and supports captures, images, clipping and text. `"gpu"` forces Vello/WGPU; `"auto"` keeps the GPU default and honors `TARVE_RENDERER` for development/CI overrides.
- Clean software redraws reuse retained softbuffer pixels when possible, avoiding another full-frame vello_cpu rasterization and RGBA flattening pass when content did not change.
- The native event loop sleeps when idle. Native events are queued FIFO and the Bun main runtime checks them with a 4 ms non-blocking FFI poll; no dedicated Bun event Worker or cross-thread JS callback is created.

## Remaining work

Timed scrolling/transitions, complex input/overlays, sustained virtual-list interaction latency and multiple Windows/GPU configurations need their own measurements and regression gates before the overall production-readiness objective is complete.
