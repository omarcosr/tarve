<script lang="ts">
  let { start = 0 }: { start?: number } = $props();
  let count = $state(start);
  let doubled = $derived(count * 2);
</script>

<svelte:head><title>Count {count}</title></svelte:head>

<div class="counter">
  <button id="increment" onclick={() => count++}>Clicked {count}</button>
  <p id="doubled">Doubled: {doubled}</p>
  {#if count > 1}
    <span id="many">many</span>
  {/if}
</div>

<style>
  .counter { padding: 12px; gap: 8px; }
  button:hover { background-color: #eeeeee; }
</style>
