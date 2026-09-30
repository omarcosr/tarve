# Performance measurements

Run `bun run build` followed by `bun run bench`. The benchmark uses the host Rust release library, opens a real GPU-backed window, and writes `work/benchmark.json`.

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

> **Por que o D3D11 continua:** é o caminho padrão de `auto`/`gpu` no Windows e evita o custo-base de `wgpu + D3D12` (~90 MB a mais de working set na medição abaixo). Reavaliar a remoção só se a base de memória do Vello/wgpu cair a um nível comparável ou se a manutenção do D3D11 passar a custar mais que esse ganho.

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

Windows x64, Bun 1.4.2, Counter 620x520 executado a partir do pacote local no renderer CPU. O backend pode ser selecionado por `createApp(App, { renderer: "cpu" })`; `TARVE_RENDERER=cpu` continua disponível quando o app usa `renderer: "auto"`. A medição abaixo foi feita na revisão anterior do bridge, ainda com polling FFI não bloqueante de 4 ms, após o app estabilizar em idle; portanto ela é um limite histórico conservador e ainda não foi refeita após o wakeup event-driven:

| Metric | CPU renderer |
| --- | ---: |
| Working set | **46.9 MB** |
| Private bytes | 134.5 MB |
| Threads | 24 |
| CPU idle | **0.39% de um core** (~0.024% do CPU total de 16 threads) |

Esse modo mantém o Bun como runtime principal e continua suportando TypeScript/TSX, APIs Bun e pacotes npm. A redução vem de duas mudanças: o pump de eventos não cria mais um segundo Bun Worker, e o renderer `vello_cpu + softbuffer` evita inicializar `wgpu + Vello GPU`. O backend GPU continua disponível e permanece o padrão. Uma configuração explícita em `createApp` tem prioridade sobre `TARVE_RENDERER`; `"auto"` preserva o override por env para desenvolvimento/CI.

`JSCallback({ threadsafe: true })` foi retestado no Bun 1.4.2 como wake-only, inclusive com lifetime one-shot e FIFO continuando em `tarve_poll_event()`. Probes mínimos com `Bun.sleep()` não reproduziram o problema histórico, mas isso se mostrou um falso negativo: no app empacotado real, medido externamente pelo Windows (`Get-Process`/tempo de CPU do processo), o callback mantém aproximadamente um core inteiro ocupado em idle. O `Counter` ficou em ~98.9% de um core (~6.18% do CPU total de 16 threads) e o showcase `components` em ~103.7% de um core (~6.48% total). Após repackar exatamente os mesmos apps com o wakeup por named pipe, o `Counter` caiu para ~0.39% de um core (~0.024% total) e o showcase ficou em 0% na mesma janela de medição. Por isso o bridge de produção permanece no named pipe: ele só sinaliza a transição da FIFO de vazia para não vazia, enquanto o payload continua sendo drenado via FFI. Não há polling periódico nem Worker dedicado.

Os números abaixo são medições históricas do renderer GPU Vello/WGPU e usam um método diferente (executáveis standalone), portanto não devem ser tratados como comparação A/B direta com a tabela D3D11 atual.

Windows x64 measurements after 1.8 s idle, using the standalone release executables and Vulkan:

| Example | Working set | Private bytes |
| --- | ---: | ---: |
| Counter | ~203 MB | ~537 MB |
| Basic | ~207–215 MB | ~597 MB |

Before requesting wgpu's memory-oriented allocation strategy and limiting Vello shader initialization to one thread, the Counter executable measured about 266 MB working set / 842 MB private bytes. In an isolated Bun process, the old dedicated event Worker added roughly 15–16 MB working set and about 40 MB private bytes. It has since been removed: native events remain in a FIFO queue, a Windows named pipe wakes the Bun event loop only when work arrives, and the main runtime then drains the queue with non-blocking FFI calls.

## Implemented

- Stable IDs retain Taffy nodes and layout caches across updates and resizes.
- The native tree stores each node once, with child IDs instead of recursively duplicated subtrees.
- Property-only updates send only changed nodes across the bridge. Structural changes use a full replacement while preserving IDs/state.
- Layout, text and paint invalidation remain separate; hover and scrolling do not recalculate layout.
- Paint and hit testing discard subtrees outside the current clipping region.
- Local asset extraction is cached per process. No filesystem reads are required for those assets during subsequent tree updates.
- Decoded image cache entries are released when the corresponding image nodes leave the retained tree.
- On Windows, `renderer: "gpu"` uses the native D3D11/DXGI renderer by default: flip-model BGRA swapchain, grow-on-demand geometry buffers, Lyon tessellation, nested stencil clipping, bounded Swash glyph atlases, retained image resources, MSAA and direct DXGI presentation. If D3D11 initialization/recovery fails, Tarve falls back to Vello/WGPU over DX12.
- Renderer fallback order (one list in `native/src/renderer.rs`, `startup_attempts`/`recovery_attempts`, shared by startup and device-loss recovery): Windows `auto`/`gpu` tries D3D11 → Vello/DX12; Linux tries Vello over wgpu's default backends; with `WGPU_BACKEND` set only that Vello backend is tried. When every GPU attempt fails, `auto` (without `TARVE_RENDERER`) falls back to the CPU renderer, and `gpu` does so only when the adapter cannot run Vello. `cpu` never touches the GPU. A lost Vello device retries its own backend before the other one (Vulkan ↔ DX12). The error names every failed attempt in order.
- The legacy Windows Vello/WGPU path still requests wgpu's memory-oriented allocation strategy and uses one Vello shader-initialization thread. Defining `WGPU_BACKEND` explicitly selects this path for development/diagnostics.
- `createApp(App, { renderer: "cpu" })` selects a single-threaded `vello_cpu + softbuffer` path that shares the same tree/text/control paint traversal and supports captures, images, clipping and text. `"gpu"` explicitly selects GPU; `"auto"` keeps the GPU default and honors `TARVE_RENDERER` for development/CI overrides.
- Clean software redraws reuse retained softbuffer pixels when possible, avoiding another full-frame vello_cpu rasterization and RGBA flattening pass when content did not change.
- The native event loop sleeps when idle. Native events are queued FIFO; a Windows named pipe sends one wake signal when the queue transitions from empty to non-empty, then the Bun main runtime drains it with non-blocking FFI calls. There is no periodic bridge poll, dedicated Bun event Worker or cross-thread JS callback.

## Remaining work

Timed scrolling/transitions, complex input/overlays, sustained virtual-list interaction latency and multiple Windows/GPU configurations need their own measurements and regression gates before the overall production-readiness objective is complete.
