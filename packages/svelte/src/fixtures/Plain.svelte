<script lang="ts">
  let count = $state(0);
  export function bump() { count++; }
</script>

<svelte:head><title>Plain {count}</title></svelte:head>
<p>body</p>
