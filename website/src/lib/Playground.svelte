<script lang="ts">
  import { onMount } from "svelte";
  import type { VNode } from "@tarve/core";
  import type { PreviewImage } from "./docs/types";
  import { currentTheme, onThemeChange } from "./theme";

  let { name, poster }: { name: string; poster?: PreviewImage } = $props();

  type ExampleModule = { preview: () => VNode; fullWindow: boolean };
  const examples = import.meta.env.SSR
    ? {}
    : (import.meta.glob("./docs/examples/*.tsx", { query: "?playground" }) as Record<string, () => Promise<ExampleModule>>);

  let canvas: HTMLCanvasElement | undefined = $state();
  let phase = $state<"idle" | "loading" | "live" | "error">("idle");
  let failure = $state("");
  let generation = $state(0);
  /** What the example's title bar buttons did to its "window". */
  let windowState = $state<"open" | "minimized" | "closed">("open");
  let dispose: (() => void) | undefined;

  /**
   * When the column is wide enough, the canvas gets the exact window the poster was cut from and
   * is offset so the same crop shows: the first live frame is the poster, pixel for pixel. On
   * narrower columns the canvas simply fills the stage.
   */
  function placeCanvas() {
    if (!canvas || !poster) return;
    const stage = canvas.parentElement!;
    const exact = stage.clientWidth >= poster.width - 0.5;
    canvas.style.width = exact ? `${poster.frameWidth}px` : "100%";
    canvas.style.height = exact ? `${poster.frameHeight}px` : "100%";
    canvas.style.left = exact ? `${-poster.left}px` : "0";
    canvas.style.top = exact ? `${-poster.top}px` : "0";
  }

  async function start() {
    const load = examples[`./docs/examples/${name}.tsx`];
    if (!canvas || !load) return;
    placeCanvas();
    const run = ++generation;
    phase = "loading";
    try {
      const [{ mountExample }, example] = await Promise.all([import("./playground/mount"), load()]);
      if (run !== generation) return;
      dispose?.();
      dispose = await mountExample(canvas, example.preview, example.fullWindow, currentTheme());
      if (run === generation) phase = "live";
    } catch (error) {
      console.error(error);
      failure = error instanceof Error ? error.message : String(error);
      phase = "error";
    }
  }

  function reset() {
    dispose?.();
    dispose = undefined;
    windowState = "open";
    void start();
  }

  function onWindowAction(event: Event) {
    const action = (event as CustomEvent<string>).detail;
    if (action === "minimize") windowState = "minimized";
    else if (action === "close") {
      dispose?.();
      dispose = undefined;
      windowState = "closed";
    }
  }

  onMount(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          void start();
        }
      },
      { rootMargin: "300px" },
    );
    if (canvas) observer.observe(canvas);
    canvas?.addEventListener("tarve:windowaction", onWindowAction);
    // A theme switch restarts a running example in the new theme; one not started yet will pick it up.
    const stopTheme = onThemeChange(() => {
      if (phase !== "idle" && windowState !== "closed") void start();
    });
    return () => {
      stopTheme();
      canvas?.removeEventListener("tarve:windowaction", onWindowAction);
      observer.disconnect();
      generation++;
      dispose?.();
    };
  });
</script>

<svelte:window onresize={() => phase === "live" && placeCanvas()} />

<figure class="playground" data-phase={phase}>
  <div class="playground-stage" style:max-width={poster ? `${poster.width + 2}px` : undefined} style:height={poster ? `${poster.height + 2}px` : "320px"}>
    {#if poster}
      <img
        class="playground-poster only-dark"
        src={poster.src}
        width={poster.width}
        height={poster.height}
        style:width="{poster.width}px"
        style:height="{poster.height}px"
        alt="{name} rendered by Tarve"
      />
      <img
        class="playground-poster only-light"
        src={poster.srcLight}
        width={poster.width}
        height={poster.height}
        style:width="{poster.width}px"
        style:height="{poster.height}px"
        alt="{name} rendered by Tarve"
      />
    {/if}
    <canvas bind:this={canvas} class="playground-canvas" tabindex="0" aria-label="Interactive {name} example"></canvas>
    {#if windowState !== "open"}
      <div class="playground-window-state">
        <span>{windowState === "closed" ? "The window was closed." : "The window was minimized."}</span>
        <button type="button" onclick={() => (windowState === "closed" ? reset() : (windowState = "open"))}>
          {windowState === "closed" ? "Reopen" : "Restore"}
        </button>
      </div>
    {/if}
  </div>
  <figcaption>
    <span class="playground-status">
      <i aria-hidden="true"></i>
      {#if phase === "live"}
        Live — this is Tarve's native runtime compiled to WebAssembly. Click, type and scroll.
      {:else if phase === "loading"}
        Loading the Tarve runtime…
      {:else if phase === "error"}
        The live runtime failed to start ({failure}). Showing a native render instead.
      {:else}
        Native render. The live version loads when this comes into view.
      {/if}
    </span>
    {#if phase === "live"}
      <button type="button" class="playground-reset" onclick={reset}>Reset</button>
    {/if}
  </figcaption>
</figure>
