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

### Native Windows D3D11 GPU renderer

Windows x64, Bun 1.4.2, Ryzen 7 9800X3D, Counter 620x520, usando o mesmo pacote release local para os três modos. Cada processo estabilizou por 4 s; CPU foi amostrada por mais 3 s. A linha D3D11 é o caminho normal de `renderer: "gpu"`/`"auto"` no Windows sem `WGPU_BACKEND`; a linha DX12 força o renderer legado com `WGPU_BACKEND=dx12`.

| Renderer | Working set | Private bytes | Threads | Handles | CPU idle (um core) |
| --- | ---: | ---: | ---: | ---: | ---: |
| **D3D11/DXGI nativo** | **82.2 MB** | 309.7 MB | 79 | 596 | **0.52%** |
| Vello/WGPU DX12 legado | 172.1 MB | 493.9 MB | 39 | 519 | 1.04% |
| vello_cpu + softbuffer | 48.1 MB | 139.6 MB | 26 | 270 | 0.00% |

Uma execução D3D11 imediatamente anterior mediu 85.4 MB de working set e 0.00% de um core no mesmo Counter, portanto 82.2 MB deve ser tratado como uma amostra e não como promessa fixa. No run comparativo, o processo D3D11 carregou `d3d11.dll` sem `d3d12.dll` nem `vulkan-1.dll`; ao forçar o legado DX12, `d3d12.dll` apareceu e o working set ficou ~90 MB maior.

O backend D3D11 renderiza para um target BGRA associado ao flip-model swapchain, usa buffers de vértices/índices pequenos com crescimento sob demanda, atlas R8 de glifos limitado a quatro páginas de 1024x1024, cache de imagens limitado ao display list retido e MSAA 4x quando suportado (fallback 2x/1x). Não há os grandes buffers intermediários do Vello Classic nem o custo-base do `wgpu + D3D12` no caminho padrão do Windows. O renderer legado permanece disponível como fallback se a criação D3D11 falhar e como escape hatch explícito via `WGPU_BACKEND`.

No mesmo PC, um probe separado do GPUix 0.10.0 ficou em ~94.3 MB de working set vazio e ~95.8–97.6 MB com a UI de teste. Esses números são apenas contexto local: processos, drivers e workloads diferentes não tornam isso uma garantia de que Tarve sempre usará menos memória.

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

Os números abaixo são medições históricas do renderer GPU Vello/WGPU e usam um método diferente (executáveis standalone), portanto não devem ser tratados como comparação A/B direta com a tabela D3D11 atual.

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
- On Windows, `renderer: "gpu"` uses the native D3D11/DXGI renderer by default: flip-model BGRA swapchain, grow-on-demand geometry buffers, Lyon tessellation, nested stencil clipping, bounded Swash glyph atlases, retained image resources, MSAA and direct DXGI presentation. If D3D11 initialization/recovery fails, Tarve falls back to Vello/WGPU over DX12.
- The legacy Windows Vello/WGPU path still requests wgpu's memory-oriented allocation strategy and uses one Vello shader-initialization thread. Defining `WGPU_BACKEND` explicitly selects this path for development/diagnostics.
- `createApp(App, { renderer: "cpu" })` selects a single-threaded `vello_cpu + softbuffer` path that shares the same tree/text/control paint traversal and supports captures, images, clipping and text. `"gpu"` explicitly selects GPU; `"auto"` keeps the GPU default and honors `TARVE_RENDERER` for development/CI overrides.
- Clean software redraws reuse retained softbuffer pixels when possible, avoiding another full-frame vello_cpu rasterization and RGBA flattening pass when content did not change.
- The native event loop sleeps when idle. Native events are queued FIFO and the Bun main runtime checks them with a 4 ms non-blocking FFI poll; no dedicated Bun event Worker or cross-thread JS callback is created.

## Remaining work

Timed scrolling/transitions, complex input/overlays, sustained virtual-list interaction latency and multiple Windows/GPU configurations need their own measurements and regression gates before the overall production-readiness objective is complete.
