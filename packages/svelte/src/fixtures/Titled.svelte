<script lang="ts">
  let unread = $state(0);
  export function receive() { unread++; }
</script>

<svelte:head><title>Inbox ({unread})</title></svelte:head>

<titlebar id="bar" height="36">
  <span id="bar-title">Inbox · {unread}</span>
  <button id="custom-close" window-action="close">×</button>
</titlebar>
<div id="handle" drag-region>drag here</div>
