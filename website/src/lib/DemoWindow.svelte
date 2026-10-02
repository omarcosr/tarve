<script lang="ts">
  import { onDestroy } from "svelte";
  import CodeBlock from "./CodeBlock.svelte";
  import { snippets } from "./content";

  const BARS = 28;
  let count = $state(0);
  let frames = $state(0);
  let bars = $state<number[]>(Array(BARS).fill(0));
  let presenting = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  function increase() {
    count++;
    frames++;
    bars = [...bars, 100].slice(-BARS);
    presenting = true;
    clearTimeout(timer);
    timer = setTimeout(() => {
      presenting = false;
      bars = [...bars, 0].slice(-BARS);
    }, 600);
  }

  onDestroy(() => clearTimeout(timer));
</script>

<div class="demo">
  <div class="demo-code">
    <CodeBlock code={snippets.counter} file="app.tsx" />
  </div>

  <div class="window" role="group" aria-label="Example native window">
    <div class="window-bar">
      <span class="window-title"><span class="window-icon"></span>Counter</span>
      <span class="window-controls" aria-hidden="true"><i>&#x2014;</i><i>&#x25A2;</i><i class="close">&#x2715;</i></span>
    </div>
    <div class="window-body">
      {#key count}
        <span class="counter" class:patched={count > 0}>
          {count}
          {#if count > 0}<span class="patch-tag" aria-hidden="true">patch</span>{/if}
        </span>
      {/key}
      <button class="native-btn" type="button" onclick={increase}>Increase</button>
    </div>
  </div>

  <div class="hud" class:hud-live={presenting}>
    <div class="hud-head">
      <span class="hud-dot"></span>
      <span>{presenting ? "presented 1 frame" : "idle · 0 fps"}</span>
      <span class="hud-count">{frames} {frames === 1 ? "frame" : "frames"}</span>
    </div>
    <div class="hud-graph" aria-hidden="true">
      {#each bars as height, index (index)}
        <i style:height="{Math.max(height, 4)}%" class:on={height > 0}></i>
      {/each}
    </div>
    <p class="hud-log" aria-live="polite">
      {#if count === 0}
        No updates yet. Nothing is drawn while nothing changes.
      {:else}
        <span class="hud-log-label">diff → 1 mutation</span>
        <code>{"{ type: \"patch\", node: <Text> }"}</code>
      {/if}
    </p>
  </div>
</div>
