<script lang="ts">
  import type { Snippet } from "svelte";
  import SiteNav from "../lib/SiteNav.svelte";

  let { children, section = "home" }: { children: Snippet; section?: string } = $props();
  const repo = "https://github.com/omarcosr/tarve";
</script>

<SiteNav {section} />

{@render children()}

<footer class="footer">
  <p class="colophon">
    Set in Archivo and IBM Plex. Every component figure in the documentation was drawn by Tarve itself, either as a PNG
    from the runtime or live in WebAssembly.
  </p>
  <nav aria-label="Footer">
    <a href="/docs">Docs</a>
    <a href={repo}>GitHub</a>
    <a href="https://www.npmjs.com/package/@tarve/core">npm</a>
    <a href="{repo}/blob/main/CHANGELOG.md">Changelog</a>
  </nav>
  <span>Tarve · Apache-2.0</span>
</footer>
