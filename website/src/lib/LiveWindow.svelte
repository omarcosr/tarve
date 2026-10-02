<script lang="ts">
  import { onMount } from "svelte";
  import type { VNode } from "@tarve/core";
  import { currentTheme, onThemeChange } from "./theme";

  type Stats = { frames: number; lastMs: number };
  let canvas: HTMLCanvasElement | undefined = $state();
  let phase = $state<"loading" | "live" | "error">("loading");
  let frames = $state(0);
  let lastMs = $state(0);
  let painting = $state(false);

  onMount(() => {
    let dispose: (() => void) | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let stopped = false;
    let mount: (() => Promise<void>) | undefined;
    const stopTheme = onThemeChange(() => void mount?.());
    void (async () => {
      try {
        const [{ mountExample }, counter] = await Promise.all([
          import("./playground/mount"),
          import("./playground/hero/Counter.tsx?playground"),
        ]);
        // The program is shown as written; only the window's theme follows the page.
        mount = async () => {
          if (stopped || !canvas) return;
          dispose?.();
          dispose = await mountExample(canvas, counter.preview, true, currentTheme());
        };
        await mount();
        if (stopped || !canvas) return;
        phase = "live";
        // The bridge counts the frames it paints; reading the number does not cause any.
        const read = () => (canvas as HTMLCanvasElement & { tarveStats: Stats }).tarveStats;
        let quiet = 0;
        let seen = read();
        timer = setInterval(() => {
          const stats = read();
          if (stats !== seen) {
            seen = stats;
            frames = 0;
          }
          if (stats.frames !== frames) {
            frames = stats.frames;
            lastMs = stats.lastMs;
            painting = true;
            quiet = 0;
          } else if (++quiet >= 4) painting = false;
        }, 120);
      } catch (error) {
        console.error(error);
        phase = "error";
      }
    })();
    return () => {
      stopped = true;
      stopTheme();
      clearInterval(timer);
      dispose?.();
    };
  });
</script>

<figure class="live" data-phase={phase}>
  <figcaption class="live-head">
    <span>Fig. 1</span>
    <span>The program on the left, running in this page</span>
  </figcaption>
  <div class="live-stage">
    <canvas bind:this={canvas} class="live-canvas" tabindex="0" aria-label="Counter window rendered by Tarve"></canvas>
    {#if phase !== "live"}
      <p class="live-note">
        {phase === "error" ? "The WebAssembly runtime could not start in this browser." : "Loading Tarve's runtime (WebAssembly)…"}
      </p>
    {/if}
  </div>
  <div class="live-meter" aria-live="off">
    <span><b>{frames}</b> frames painted</span>
    <span>{frames ? `last ${lastMs.toFixed(1)} ms` : "—"}</span>
    <span class="live-state" class:on={painting}>{painting ? "painting" : "idle, 0 fps"}</span>
  </div>
  <p class="live-caption">
    Not a screenshot and not HTML. This is Tarve's native layout, text and paint code compiled to WebAssembly, drawing into a
    canvas. It paints only when you click.
  </p>
</figure>
