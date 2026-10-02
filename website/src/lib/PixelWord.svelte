<script lang="ts">
  import { onMount } from "svelte";

  /**
   * A word set in the page's display face, then rasterised onto a coarse grid and redrawn as
   * square pixels, row by row: the headline's "pixels out" shown literally. The live text stays
   * underneath (transparent) for selection, search and screen readers.
   */
  let { word }: { word: string } = $props();
  let host: HTMLSpanElement | undefined = $state();
  let probe: HTMLSpanElement | undefined = $state();
  let grid = $state<{ cols: number; rows: number; cell: number; cells: [number, number][] } | undefined>();

  const CELLS_PER_EM = 18;

  function rasterise() {
    if (!host || !probe) return;
    const text = host.querySelector<HTMLElement>(".pw-text")!;
    const style = getComputedStyle(text);
    const box = text.getBoundingClientRect();
    const fontPx = parseFloat(style.fontSize);
    const cell = fontPx / CELLS_PER_EM;
    const cols = Math.ceil(box.width / cell);
    const rows = Math.ceil(box.height / cell);
    const baseline = (probe.getBoundingClientRect().bottom - box.top) / cell;
    // Draw at SUPER× the grid, then keep a cell when enough of it is covered: strokes keep their weight.
    const SUPER = 4;
    const canvas = document.createElement("canvas");
    canvas.width = cols * SUPER;
    canvas.height = rows * SUPER;
    const g = canvas.getContext("2d", { willReadFrequently: true });
    if (!g) return;
    const unit = cell / SUPER;
    g.font = `${style.fontWeight} ${fontPx / unit}px ${style.fontFamily}`;
    // After `font`, which resets it. Unsupported browsers keep the normal width and get squeezed below.
    if ("fontStretch" in g) (g as CanvasRenderingContext2D & { fontStretch: string }).fontStretch = "extra-condensed";
    g.textBaseline = "alphabetic";
    const shown = word.toUpperCase();
    const measured = g.measureText(shown).width;
    g.setTransform(box.width / unit / measured, 0, 0, 1, 0, 0);
    g.fillText(shown, 0, baseline * SUPER);
    const alpha = g.getImageData(0, 0, canvas.width, canvas.height).data;
    const cells: [number, number][] = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        let covered = 0;
        for (let sy = 0; sy < SUPER; sy++) {
          for (let sx = 0; sx < SUPER; sx++) covered += alpha[((y * SUPER + sy) * canvas.width + x * SUPER + sx) * 4 + 3]!;
        }
        if (covered / (255 * SUPER * SUPER) > 0.42) cells.push([x, y]);
      }
    }
    grid = { cols, rows, cell, cells };
  }

  onMount(() => {
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(rasterise);
    };
    void document.fonts.ready.then(schedule);
    const observer = new ResizeObserver(schedule);
    if (host) observer.observe(host);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  });
</script>

<span class="pw" class:pw-ready={grid} bind:this={host}>
  <span class="pw-text">{word}<span class="pw-probe" bind:this={probe}></span></span>
  {#if grid}
    <svg
      class="pw-grid"
      viewBox="0 0 {grid.cols} {grid.rows}"
      width={grid.cols * grid.cell}
      height={grid.rows * grid.cell}
      aria-hidden="true"
    >
      {#each grid.cells as [x, y] (x + "," + y)}
        <rect {x} {y} width="0.88" height="0.88" style:--row={y} />
      {/each}
    </svg>
  {/if}
</span>
