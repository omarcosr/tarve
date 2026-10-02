<script lang="ts">
  import CodeBlock from "../../lib/CodeBlock.svelte";
  import DocsShell from "../../lib/DocsShell.svelte";
  import PropsTable from "../../lib/PropsTable.svelte";
  import type { ComponentDoc } from "../../lib/docs/types";

  let { doc }: { doc: ComponentDoc } = $props();
</script>

<DocsShell name={doc.name}>
<article class="doc">
  <nav class="doc-crumbs" aria-label="Breadcrumb">
    <a href="/docs">Docs</a><span>/</span><a href="/docs#{doc.category.id}">{doc.category.title}</a><span>/</span><span>{doc.name}</span>
  </nav>

  <header class="doc-head">
    <h1>{doc.name}</h1>
    <p class="doc-lead">{doc.summary}</p>
    {#if doc.notes}<p class="doc-notes">{doc.notes}</p>{/if}
    <div class="doc-meta">
      {#if doc.propsType}<span class="doc-chip"><code>{doc.propsType}</code></span>{/if}
      {#if doc.generic}<span class="doc-chip">generic</span>{/if}
      <a class="doc-chip doc-source" href={doc.sourceUrl}>{doc.sourceLabel} ↗</a>
    </div>
  </header>

  <section class="doc-section">
    <h2 id="import">Import</h2>
    <CodeBlock code={doc.importLine} />
  </section>

  <section class="doc-section">
    <h2 id="usage">Usage</h2>
    <CodeBlock code={doc.example} file="{doc.name}.tsx" />
  </section>

  <section class="doc-section">
    <h2 id="props">Props</h2>
    {#if doc.props.length}
      <PropsTable props={doc.props} />
    {:else}
      <p class="doc-muted">{doc.name} has no props of its own beyond the inherited and common props below.</p>
    {/if}
  </section>

  {#each doc.inherited as group (group.from)}
    <details class="doc-details">
      <summary>Inherited from <code>{group.from}</code> <span>{group.props.length} props</span></summary>
      <PropsTable props={group.props} />
    </details>
  {/each}

  {#if doc.common.length}
    <section class="doc-section">
      <h2 id="common">Common props</h2>
      <p class="doc-muted">Shared by every component. <a href="/docs#common-props">See descriptions →</a></p>
      <div class="doc-common">
        {#each doc.common as name (name)}<code>{name}</code>{/each}
      </div>
    </section>
  {/if}

  {#if doc.types.length}
    <section class="doc-section">
      <h2 id="types">Types</h2>
      <div class="doc-types">
        {#each doc.types as type (type.name)}
          <CodeBlock code={type.code} file={type.name} />
        {/each}
      </div>
    </section>
  {/if}

  <nav class="doc-pager" aria-label="Pagination">
    {#if doc.prev}
      <a class="doc-pager-link" href="/docs/components/{doc.prev.name}">
        <span>← Previous</span><strong>{doc.prev.name}</strong>
      </a>
    {:else}<span></span>{/if}
    {#if doc.next}
      <a class="doc-pager-link next" href="/docs/components/{doc.next.name}">
        <span>Next →</span><strong>{doc.next.name}</strong>
      </a>
    {/if}
  </nav>
</article>
</DocsShell>
