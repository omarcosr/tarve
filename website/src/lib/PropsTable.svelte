<script lang="ts">
  import type { PropDoc } from "./docs/types";

  let { props }: { props: PropDoc[] } = $props();
</script>

<div class="props-wrap">
  <table class="props">
    <thead>
      <tr>
        <th>Prop</th>
        <th>Type</th>
        <th>Default</th>
      </tr>
    </thead>
    <tbody>
      {#each props as prop (prop.name)}
        <tr>
          <td>
            <code class="prop-name">{prop.name}</code>
            {#if !prop.optional}<span class="prop-required">required</span>{/if}
            {#if prop.doc}<p class="prop-doc">{prop.doc}</p>{/if}
          </td>
          <td><code class="prop-type">{prop.type}</code></td>
          <td>
            {#if prop.default}<code class="prop-default">{prop.default}</code>{:else}<span class="prop-none">—</span>{/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>
