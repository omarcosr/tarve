<script lang="ts">
  import { fade, fly } from "svelte/transition";
  let shown = $state(false);
  export function toggle() { shown = !shown; }
</script>

{#if shown}
  <p id="faded" transition:fade={{ duration: 120 }}>faded</p>
  <p id="flown" in:fly={{ y: 20, duration: 120 }}>flown</p>
{/if}
