<script lang="ts">
  let { size = 1000 }: { size?: number } = $props();
  let rows = $state(Array.from({ length: size }, (_, index) => ({ id: index, label: `row ${index}`, done: false })));
  let next = size;
  export function update(index: number) { rows[index].label += "!"; }
  export function updateAll() { for (const row of rows) row.label += "."; }
  export function append() { rows.push({ id: next, label: `row ${next++}`, done: false }); }
  export function removeFirst() { rows.shift(); }
  export function swap() { const a = rows[1]; rows[1] = rows[rows.length - 2]; rows[rows.length - 2] = a; }
</script>

<div class="list">
  {#each rows as row (row.id)}
    <div class="row">
      <span class="id">{row.id}</span>
      <span class="label">{row.label}</span>
      <button onclick={() => (row.done = !row.done)}>{row.done ? "Undo" : "Done"}</button>
    </div>
  {/each}
</div>

<style>
  .list { gap: 2px; }
  .row { flex-direction: row; gap: 8px; padding: 4px; }
  .id { width: 40px; }
</style>
