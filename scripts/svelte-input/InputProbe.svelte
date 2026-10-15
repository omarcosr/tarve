<script lang="ts">
  let clicks = $state(0);
  let text = $state("");
  let html = $state("Hello <b>bold</b>");
  let wheel = $state(0);
  let scrolled = $state(0);
  let keys = $state<string[]>([]);
  let richKeys = $state<string[]>([]);
  export function snapshot() {
    return { clicks, text, html, wheel, scrolled, keys: keys.join(" "), richKeys: richKeys.join(" ") };
  }
</script>

<svelte:head><title>Svelte input</title></svelte:head>
<column style="padding: 16px; gap: 12px">
  <button id="button" onclick={() => clicks++}>Clicked {clicks}</button>
  <input id="field" bind:value={text} onkeydown={e => keys.push(e.key)} placeholder="type here" />
  <div id="rich" contenteditable="true" bind:innerHTML={html} onkeydown={e => richKeys.push(`${e.ctrlKey ? "^" : ""}${e.shiftKey ? "+" : ""}${e.key}[${window.getSelection()?.toString()}]`)} style="height: 60px; border: 1px solid #ccc; padding: 4px"></div>
  <div id="pane" style="overflow: auto; height: 80px; border: 1px solid #ccc" onwheel={e => (wheel += e.deltaY)} onscroll={e => (scrolled = (e.currentTarget as HTMLElement).scrollTop)}>
    {#each Array.from({ length: 30 }, (_, i) => i) as row (row)}<p style="margin: 0">Row {row}</p>{/each}
  </div>
</column>
