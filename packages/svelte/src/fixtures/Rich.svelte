<script lang="ts">
  import { onMount } from "svelte";
  let html = $state("plain <b>bold</b> end");
  let width = $state(-1);
  let box: HTMLDivElement;
  let inputs = $state<string[]>([]);
  onMount(() => { width = box.offsetWidth; });
  export function grow() { box.style.setProperty("padding-left", "10px"); return box.offsetWidth; }
  export function format(command: string) { return document.execCommand(command); }
  export function active(command: string) { return document.queryCommandState(command); }
  export function selected() { return window.getSelection()?.toString(); }
</script>

<div id="measured" bind:this={box}>box</div>
<p id="width">{width}</p>
<div id="rich" contenteditable="true" bind:innerHTML={html} oninput={e => inputs.push((e as InputEvent).inputType)}></div>
<p id="html">{html}</p>
<p id="inputs">{inputs.join(" ")}</p>
