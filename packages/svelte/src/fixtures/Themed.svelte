<script lang="ts">
  let dark = $state(false);
  let items = $state(["a", "b", "c"]);
  export function toggle() { dark = !dark; }
  export function prepend() { items.unshift("z"); }
</script>

<div class="theme" class:dark>
  <p id="label" class="label">Label</p>
  <ul>
    {#each items as item (item)}
      <li id={`item-${item}`}>{item}</li>
    {/each}
  </ul>
</div>

<style>
  .theme .label { color: #111111; }
  .theme.dark .label { color: #eeeeee; }
  li:first-child { font-weight: 700; }
</style>
