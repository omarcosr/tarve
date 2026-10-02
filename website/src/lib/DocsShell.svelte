<script lang="ts">
  import { onMount, tick, type Snippet } from "svelte";
  import { catalog } from "./docs/catalog";

  let { children, name }: { children: Snippet; name?: string } = $props();
  let query = $state("");
  let open = $state(false);
  let search: HTMLInputElement | undefined = $state();
  let nav: HTMLElement | undefined = $state();
  const needle = $derived(query.trim().toLowerCase());
  const groups = $derived(
    catalog
      .map((category) => ({
        ...category,
        items: category.items.filter(
          (item) => !needle || item.name.toLowerCase().includes(needle) || category.title.toLowerCase().includes(needle),
        ),
      }))
      .filter((category) => category.items.length > 0),
  );
  const firstMatch = $derived(groups[0]?.items[0]?.name);

  function centerActive() {
    const active = nav?.querySelector<HTMLElement>("a.active");
    if (nav && active && nav.clientHeight > 0) {
      nav.scrollTop = active.offsetTop - nav.clientHeight / 2 + active.offsetHeight / 2;
    }
  }

  onMount(centerActive);

  $effect(() => {
    if (open) tick().then(centerActive);
  });

  function onWindowKey(event: KeyboardEvent) {
    const target = event.target;
    const typing = target instanceof Element && target.closest("input, textarea, select, [contenteditable='true']");
    if (event.key === "/" && !typing && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      open = true;
      search?.focus();
    }
  }

  function onSearchKey(event: KeyboardEvent) {
    if (event.key === "Escape") {
      query = "";
      search?.blur();
    } else if (event.key === "Enter" && needle && firstMatch) {
      window.location.href = `/docs/components/${firstMatch}`;
    }
  }
</script>

<svelte:window onkeydown={onWindowKey} />

<div class="docs">
  <aside class="docs-sidebar" class:open={open || !!needle}>
    <div class="docs-search-wrap">
      <input
        bind:this={search}
        bind:value={query}
        class="docs-search"
        type="search"
        placeholder="Search components…"
        aria-label="Search components"
        onkeydown={onSearchKey}
      />
      <kbd class="docs-search-key" aria-hidden="true">/</kbd>
    </div>
    <button class="docs-toggle" type="button" aria-expanded={open} onclick={() => (open = !open)}>
      {open ? "Hide navigation" : "Browse all components"}
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
    </button>
    <nav class="docs-nav" aria-label="Documentation" bind:this={nav}>
      {#if !needle}
        <p class="docs-group">Guides</p>
        <a href="/docs" class:active={!name}>Overview</a>
        <a href="/docs#getting-started">Getting started</a>
        <a href="/docs#rendering">How rendering works</a>
        <a href="/docs#common-props">Common props</a>
      {/if}
      {#each groups as group (group.id)}
        <p class="docs-group">{group.title}</p>
        {#each group.items as item (item.name)}
          <a href="/docs/components/{item.name}" class:active={item.name === name} aria-current={item.name === name ? "page" : undefined}>
            {item.name}
          </a>
        {/each}
      {:else}
        <p class="docs-empty">No component matches “{query}”.</p>
      {/each}
    </nav>
  </aside>
  <main class="docs-main">
    {@render children()}
  </main>
</div>
