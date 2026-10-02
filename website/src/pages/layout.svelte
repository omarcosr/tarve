<script lang="ts">
  import type { Snippet } from "svelte";
  import SiteNav from "../lib/SiteNav.svelte";

  let { children, section = "home" }: { children: Snippet; section?: string } = $props();
  const repo = "https://github.com/omarcosr/tarve";
</script>

<div class="aurora" class:aurora-dim={section === "docs"} aria-hidden="true"><span></span><span></span><span></span></div>
<div class="grid-bg" aria-hidden="true"></div>

<SiteNav {section} />

{@render children()}

<footer class="footer">
  <span>Tarve · Apache-2.0</span>
  <span>
    <a href="/docs">Docs</a> · <a href={repo}>GitHub</a> · <a href="https://www.npmjs.com/package/@tarve/core">npm</a> ·
    <a href="{repo}/blob/main/CHANGELOG.md">Changelog</a>
  </span>
</footer>
