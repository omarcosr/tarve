<script lang="ts">
  import { TitleBar } from "@tarve/svelte";
  let unread = $state(2);
  export function read() { unread--; }
</script>

<svelte:head><title>Mail ({unread})</title></svelte:head>
<TitleBar height={36} showMaximize={false}>
  <span id="bar-content">{unread} unread</span>
</TitleBar>
<p>body</p>
