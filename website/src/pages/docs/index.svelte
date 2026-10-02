<script lang="ts">
  import CodeBlock from "../../lib/CodeBlock.svelte";
  import DocsShell from "../../lib/DocsShell.svelte";
  import PropsTable from "../../lib/PropsTable.svelte";
  import { snippets } from "../../lib/content";
  import type { CatalogCategory } from "../../lib/docs/catalog";
  import type { PropDoc } from "../../lib/docs/types";

  let { categories, commonProps, version }: { categories: CatalogCategory[]; commonProps: PropDoc[]; version: string } = $props();
  const total = $derived(categories.reduce((count, category) => count + category.items.length, 0));
</script>

<DocsShell name={undefined}>
<article class="doc">
  <header class="doc-head">
    <span class="eyebrow">Documentation · v{version}</span>
    <h1>Tarve documentation</h1>
    <p class="doc-lead">
      Everything you need to ship a native Windows and Linux interface from Bun and TSX: setup, the rendering model and a
      reference page for each of the {total} built-in components.
    </p>
  </header>

  <section class="doc-section">
    <h2 id="getting-started">Getting started</h2>
    <ol class="doc-steps">
      <li>
        <h3>Install</h3>
        <p>Tarve needs Bun 1.4+ on Windows x64 or Linux x64.</p>
        <CodeBlock code={snippets.install} lang="sh" file="terminal" />
      </li>
      <li>
        <h3>Configure TypeScript</h3>
        <p>Point the JSX runtime at <code>@tarve/core</code>.</p>
        <CodeBlock code={snippets.tsconfig} file="tsconfig.json" />
      </li>
      <li>
        <h3>Write a window</h3>
        <CodeBlock code={snippets.counter} file="app.tsx" />
      </li>
      <li>
        <h3>Run and ship</h3>
        <CodeBlock code={snippets.run + "\n\n" + snippets.build} lang="sh" file="terminal" />
      </li>
    </ol>
  </section>

  <section class="doc-section">
    <h2 id="rendering">How rendering works</h2>
    <div class="doc-prose">
      <p>
        Your view is a plain function that returns TSX. Tarve compiles it into a retained tree, diffs it against the previous
        one and sends only the changed nodes to the native runtime, where Taffy lays them out and Vello, D3D11 or the CPU
        renderer paints them.
      </p>
      <p>
        State can live in ordinary variables. When a native event handler such as <code>onClick</code> or
        <code>onChange</code> runs, Tarve schedules a re-render automatically. For changes that happen outside an event (timers,
        network responses, file watchers) call <code>app.update()</code> on the handle returned by <code>createApp</code>.
      </p>
      <p>
        Controls are <em>controlled</em>: pass the current value (<code>checked</code>, <code>value</code>, <code>open</code>…)
        and update it in the matching <code>on…Change</code> callback. An idle window presents zero frames.
      </p>
    </div>
  </section>

  <section class="doc-section">
    <h2 id="components">Components</h2>
    {#each categories as category (category.id)}
      <div class="doc-category">
        <h3 id={category.id}>{category.title}</h3>
        <p class="doc-muted">{category.description}</p>
        <div class="doc-cards">
          {#each category.items as item (item.name)}
            <a class="doc-card" href="/docs/components/{item.name}">
              {#if item.preview}
                <span class="doc-card-thumb">
                  <img class="only-dark" src={item.preview.src} width={item.preview.width} height={item.preview.height} alt="" loading="lazy" decoding="async" />
                  <img class="only-light" src={item.preview.srcLight} width={item.preview.width} height={item.preview.height} alt="" loading="lazy" decoding="async" />
                </span>
              {/if}
              <strong>{item.name}</strong>
              <span>{item.summary}</span>
            </a>
          {/each}
        </div>
      </div>
    {/each}
  </section>

  <section class="doc-section">
    <h2 id="common-props">Common props</h2>
    <p class="doc-muted">Every component accepts these props in addition to its own.</p>
    <PropsTable props={commonProps} />
  </section>
</article>
</DocsShell>
