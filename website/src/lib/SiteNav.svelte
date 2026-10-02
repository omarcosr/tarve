<script lang="ts">
  let { section = "home" }: { section?: string } = $props();
  import ThemeToggle from "./ThemeToggle.svelte";

  const repo = "https://github.com/omarcosr/tarve";
</script>

<header class="nav">
  <a class="brand" href="/" aria-label="Tarve home">
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <rect x="1" y="1" width="22" height="22" fill="currentColor" />
      <rect x="13" y="13" width="10" height="10" fill="var(--accent)" />
    </svg>
    <span>tarve</span>
  </a>
  {#if section === "home"}
    <nav class="nav-links" aria-label="Sections">
      <a href="/#spec">Spec</a>
      <a href="/#pipeline">Pipeline</a>
      <a href="/#renderers">Renderers</a>
      <a href="/#components">Components</a>
    </nav>
  {/if}
  <div class="nav-actions">
    <a href="/docs" class:active={section === "docs"} aria-current={section === "docs" ? "page" : undefined}>Docs</a>
    <a href={repo}>GitHub</a>
    <a href="https://www.npmjs.com/package/@tarve/core">npm</a>
    <ThemeToggle />
  </div>
</header>
