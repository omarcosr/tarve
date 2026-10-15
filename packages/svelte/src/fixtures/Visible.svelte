<script lang="ts">
  import { onMount } from "svelte";
  let seen = $state<string[]>([]);
  let pane: HTMLDivElement;
  onMount(() => {
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) seen.push(`${entry.target.id}:${entry.isIntersecting ? Math.round(entry.intersectionRatio * 100) : "out"}`);
    }, { threshold: [0, 0.5, 1] });
    for (const item of pane.querySelectorAll(".item")) observer.observe(item);
    return () => observer.disconnect();
  });
</script>

<div id="pane" bind:this={pane} style="overflow: auto; height: 100px">
  <div id="a" class="item">a</div>
  <div id="b" class="item">b</div>
</div>
<p id="seen">{seen.join(" ")}</p>
