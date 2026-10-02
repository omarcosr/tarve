<script lang="ts">
  import { onDestroy } from "svelte";
  import { copyText } from "./clipboard";

  let { command }: { command: string } = $props();
  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function copy() {
    copied = await copyText(command);
    clearTimeout(timer);
    timer = setTimeout(() => (copied = false), 1600);
  }

  onDestroy(() => clearTimeout(timer));
</script>

<button class="copy" type="button" onclick={copy} aria-label="Copy command: {command}">
  <span class="copy-prompt" aria-hidden="true">$</span>
  <code>{command}</code>
  <span class="copy-state" aria-live="polite">{copied ? "copied ✓" : "copy"}</span>
</button>
