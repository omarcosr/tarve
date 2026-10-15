<script lang="ts">
  let { text, done = $bindable(false), onremove }: { text: string; done?: boolean; onremove: () => void } = $props();
  let hovered = $state(false);
</script>

<div class="item" role="listitem" onmouseenter={() => (hovered = true)} onmouseleave={() => (hovered = false)}>
  <input type="checkbox" bind:checked={done} aria-label={text} />
  <span class:done>{text}</span>
  {#if hovered}
    <button class="remove" onclick={onremove}>Remove</button>
  {/if}
</div>

<style>
  .item { flex-direction: row; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 6px; }
  .item:hover { background-color: #f3f4f6; }
  .done { color: #9ca3af; text-decoration: line-through; }
  .remove { margin-left: auto; }
</style>
