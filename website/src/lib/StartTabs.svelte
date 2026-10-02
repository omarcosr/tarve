<script lang="ts">
  import CodeBlock from "./CodeBlock.svelte";
  import { snippets } from "./content";

  const tabs = [
    { id: "install", label: "1 · Install", file: "terminal", code: snippets.install, lang: "sh" },
    { id: "tsconfig", label: "2 · Configure", file: "tsconfig.json", code: snippets.tsconfig, lang: "tsx" },
    { id: "app", label: "3 · Write", file: "app.tsx", code: snippets.counter, lang: "tsx" },
    { id: "run", label: "4 · Run", file: "terminal", code: snippets.run, lang: "sh" },
  ] as const;

  let current = $state<(typeof tabs)[number]["id"]>("install");
  const tab = $derived(tabs.find((item) => item.id === current) ?? tabs[0]);
</script>

<div class="start">
  <div class="start-tabs" role="tablist">
    {#each tabs as item (item.id)}
      <button type="button" role="tab" aria-selected={current === item.id} class:active={current === item.id} onclick={() => (current = item.id)}>
        {item.label}
      </button>
    {/each}
  </div>
  {#key tab.id}
    <div class="start-panel">
      <CodeBlock code={tab.code} lang={tab.lang} file={tab.file} />
    </div>
  {/key}
</div>
