<script lang="ts">
  let { size = 3 }: { size?: number } = $props();
  let items = $state(Array.from({ length: size }, (_, index) => ({ id: index, label: `item ${index}` })));
  let draft = $state("");
  let next = size;
  function add() {
    if (!draft) return;
    items.push({ id: next++, label: draft });
    draft = "";
  }
  export function rename(index: number, label: string) { items[index].label = label; }
  export function removeFirst() { items.shift(); }
</script>

<section>
  <input id="draft" bind:value={draft} placeholder="New item" />
  <button id="add" onclick={add}>Add</button>
  <ul>
    {#each items as item (item.id)}
      <li id={`item-${item.id}`}>{item.label}</li>
    {/each}
  </ul>
  <p id="draft-echo">{draft}</p>
</section>
