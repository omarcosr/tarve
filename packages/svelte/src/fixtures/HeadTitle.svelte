<script lang="ts">
  let count = $state(0);
  export function bump() { count++; }
</script>

<svelte:head><title>Count {count}</title></svelte:head>
<titlebar id="plain-bar" />
<p>body</p>
