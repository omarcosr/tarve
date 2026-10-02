<script lang="ts">
  import { onDestroy } from "svelte";
  import { copyText } from "./clipboard";
  import { highlight } from "./highlight";

  let { code, lang = "tsx", file = "" }: { code: string; lang?: "tsx" | "sh"; file?: string } = $props();
  const html = $derived(highlight(code, lang));
  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function copy() {
    copied = await copyText(code);
    clearTimeout(timer);
    timer = setTimeout(() => (copied = false), 1600);
  }

  onDestroy(() => clearTimeout(timer));
</script>

<figure class="code" class:code-bare={!file}>
  {#if file}
    <figcaption><span class="code-dots" aria-hidden="true"><i></i><i></i><i></i></span>{file}</figcaption>
  {/if}
  <button class="code-copy" class:copied type="button" onclick={copy} aria-label={copied ? "Copied" : "Copy code"}>
    {#if copied}
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M5 12l5 5L20 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
    {:else}
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.8" /><path d="M5 15V6a2 2 0 0 1 2-2h9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
    {/if}
  </button>
  <pre><code>{@html html}</code></pre>
</figure>
