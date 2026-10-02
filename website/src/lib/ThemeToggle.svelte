<script lang="ts">
  import { onMount } from "svelte";
  import { currentTheme, onThemeChange, setTheme, type SiteTheme } from "./theme";

  let theme = $state<SiteTheme | undefined>();
  onMount(() => {
    theme = currentTheme();
    return onThemeChange((next) => (theme = next));
  });
</script>

<button
  class="theme-toggle"
  type="button"
  aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
  title={theme === "dark" ? "Light theme" : "Dark theme"}
  onclick={() => setTheme(currentTheme() === "dark" ? "light" : "dark")}
>
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <rect x="1.5" y="1.5" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" />
    <path d="M1.5 14.5 14.5 1.5V14.5Z" fill="currentColor" />
  </svg>
</button>
