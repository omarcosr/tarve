<script lang="ts">
  let { section = "home" }: { section?: string } = $props();
  const repo = "https://github.com/omarcosr/tarve";
</script>

<header class="nav">
  <a class="brand" href="/" aria-label="Tarve home">
    <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
      <defs>
        <linearGradient id="logo-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#7c5cff" />
          <stop offset=".55" stop-color="#22d3ee" />
          <stop offset="1" stop-color="#f472b6" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="9" fill="url(#logo-g)" />
      <path d="M9 10.5h14M16 10.5V23" stroke="#07070b" stroke-width="3.4" stroke-linecap="round" />
    </svg>
    <span>tarve</span>
  </a>
  <nav class="nav-links">
    <a href="/#pipeline">Pipeline</a>
    <a href="/#features">Features</a>
    <a href="/#renderers">Renderers</a>
    <a href="/#components">Components</a>
    <a href="/docs" class:active={section === "docs"}>Docs</a>
  </nav>
  <div class="nav-actions">
    <a class="nav-docs" href="/docs" class:active={section === "docs"}>Docs</a>
    <a class="btn btn-ghost" href={repo}>
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.1c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.9 1.3 1.9 1.3 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 4.7 18.3 5 18.3 5c.7 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.7-5.5 6 .4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .5Z"/></svg>
      GitHub
    </a>
  </div>
</header>
