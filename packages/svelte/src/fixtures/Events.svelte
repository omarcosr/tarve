<script lang="ts">
  let keys = $state<string[]>([]);
  let focused = $state("none");
  let width = $state(0);
  let innerWidth = $state(0);
  let clicks = $state(0);
  let doubles = $state(0);
  let field: HTMLInputElement;
  export function focusField() { field.focus(); }
</script>

<svelte:window onkeydown={event => keys.push((event.ctrlKey ? "Ctrl+" : "") + event.key)} bind:innerWidth />

<input id="field" bind:this={field} onfocus={() => (focused = "field")} onblur={() => (focused = "none")} />
<div id="box" bind:clientWidth={width}>box</div>
<button id="clicker" onclick={() => clicks++} ondblclick={() => doubles++}>click</button>
<p id="keys">{keys.join(" ")}</p>
<p id="focused">{focused}</p>
<p id="width">{width}</p>
<p id="inner">{innerWidth}</p>
<p id="clicks">{clicks}/{doubles}</p>
