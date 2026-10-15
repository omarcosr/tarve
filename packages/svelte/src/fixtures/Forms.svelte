<script lang="ts">
  let choice = $state("b");
  let objects = [{ id: 1, name: "one" }, { id: 2, name: "two" }];
  let picked = $state(objects[1]);
  let many = $state<string[]>(["x"]);
  let flavours = $state<string[]>(["mint"]);
  let size = $state("m");
  export function setChoice(value: string) { choice = value; }
</script>

<select id="sel" bind:value={choice}>
  <option value="a">A</option>
  <option value="b">B</option>
  <option value="c" disabled>C</option>
</select>
<p id="choice">{choice}</p>

<select id="objects" bind:value={picked}>
  {#each objects as object (object.id)}
    <option value={object}>{object.name}</option>
  {/each}
</select>
<p id="picked">{picked?.name}</p>

<label><input id="mint" type="checkbox" bind:group={flavours} value="mint" />Mint</label>
<label><input id="choc" type="checkbox" bind:group={flavours} value="choc" />Choc</label>
<p id="flavours">{flavours.join(",")}</p>

<input id="size-s" type="radio" bind:group={size} value="s" />
<input id="size-m" type="radio" bind:group={size} value="m" />
<p id="size">{size}</p>
<p id="many">{many.join(",")}</p>
