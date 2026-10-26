<script lang="ts">
  let count = $state(0);
</script>

<svelte:head><title>__APP_TITLE__</title></svelte:head>
<div class="flex flex-1 flex-col items-center justify-center gap-4 p-6">
  <span class="text-sm font-semibold text-muted-foreground">__APP_TITLE__</span>
  <span class="text-5xl font-bold">{count}</span>
  <div class="flex flex-row gap-2">
    <button class="px-4 py-2 rounded-md border border-border" onclick={() => count--}>Decrease</button>
    <button class="px-4 py-2 rounded-md bg-primary text-primary-foreground" onclick={() => count++}>Increase</button>
  </div>
</div>
