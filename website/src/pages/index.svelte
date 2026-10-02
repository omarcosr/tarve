<script lang="ts">
  import CodeBlock from "../lib/CodeBlock.svelte";
  import CopyCommand from "../lib/CopyCommand.svelte";
  import LiveWindow from "../lib/LiveWindow.svelte";
  import PixelWord from "../lib/PixelWord.svelte";
  import Renderers from "../lib/Renderers.svelte";
  import { componentCount, features, pipeline, snippets, spec } from "../lib/content";
  import { catalog } from "../lib/docs/catalog";

  let { version = "0.4.0" }: { version?: string } = $props();
</script>

<main class="home">
  <section class="hero">
    <p class="kicker"><span>@tarve/core {version}</span><span>Windows x64 · Linux x64</span><span>Apache-2.0</span></p>
    <div class="headline">
      <h1>
        <span class="hl-row" style:--n="1"><span class="hl-tsx"><i aria-hidden="true">&lt;</i>TSX<i aria-hidden="true">/&gt;</i></span> in.</span>
        <span class="hl-row" style:--n="2"><PixelWord word="Pixels" /> out.</span>
        <span class="hl-row" style:--n="3"><em>No</em> <s>browser</s></span>
        <span class="hl-row" style:--n="4">between.</span>
      </h1>
      <ol class="hl-notes" aria-hidden="true">
        <li style:--n="1"><b>01</b> Components in TSX, run by Bun. Tarve's own JSX runtime, no React.</li>
        <li style:--n="2"><b>02</b> Laid out by Taffy, shaped by Parley, painted by D3D11, Vello or the CPU.</li>
        <li style:--n="3"><b>03</b> No Chromium, no DOM, no web view. One executable per target.</li>
      </ol>
    </div>
    <div class="hero-foot">
      <p class="lead">
        Tarve is a desktop UI toolkit for Bun. You write components in TSX; a Rust runtime lays them out, shapes the text and
        paints the window. There is no web view underneath.
      </p>
      <div class="cta">
        <CopyCommand command="bun add @tarve/core" />
        <a class="btn btn-primary" href="/docs">Documentation</a>
      </div>
    </div>
  </section>

  <section class="specimen" aria-label="A Tarve program and its output">
    <div class="specimen-code"><CodeBlock code={snippets.counter} file="app.tsx" /></div>
    <LiveWindow />
  </section>

  <section class="sheet" id="spec">
    <header class="sheet-head">
      <span class="sec">01</span>
      <h2>Specification</h2>
    </header>
    <dl class="spec">
      {#each spec as row (row.label)}
        <div>
          <dt>{row.label}</dt>
          <dd><strong>{row.value}</strong>{#if row.note}<span>{row.note}</span>{/if}</dd>
        </div>
      {/each}
    </dl>
  </section>

  <section class="sheet" id="pipeline">
    <header class="sheet-head">
      <span class="sec">02</span>
      <h2>What happens on a click</h2>
      <p>Six stages between an event handler and the screen. Each one does nothing until the one before it hands over work.</p>
    </header>
    <ol class="stages">
      {#each pipeline as step (step.tag)}
        <li>
          <span class="stage-n">{step.tag}</span>
          <h3>{step.title}</h3>
          <code>{step.where}</code>
          <p>{step.body}</p>
        </li>
      {/each}
    </ol>
  </section>

  <section class="sheet" id="features">
    <header class="sheet-head">
      <span class="sec">03</span>
      <h2>In the box</h2>
    </header>
    <dl class="notes">
      {#each features as feature (feature.title)}
        <div>
          <dt>{feature.title}</dt>
          <dd>{feature.body}</dd>
        </div>
      {/each}
    </dl>
  </section>

  <section class="sheet sheet-split" id="renderers">
    <header class="sheet-head">
      <span class="sec">04</span>
      <h2>Renderers</h2>
      <p>
        <code>createApp</code> takes <code>renderer: "auto" | "gpu" | "cpu"</code>. Windows uses D3D11/DXGI with a Vello/WGPU
        fallback, Linux uses Vello/WGPU, and both have a low-memory CPU path. Pick a combination to see the order Tarve tries them in.
      </p>
    </header>
    <Renderers />
  </section>

  <section class="sheet sheet-split">
    <header class="sheet-head">
      <span class="sec">05</span>
      <h2>Styling</h2>
      <p>
        Style objects read like CSS: gradients, <code>boxShadow</code>, <code>textShadow</code>, <code>transform</code> and
        transitions on hover, focus and updates. They are interpreted natively and look the same on D3D11, Vello and the CPU
        renderer.
      </p>
    </header>
    <CodeBlock code={snippets.style} file="card.tsx" />
  </section>

  <section class="sheet" id="components">
    <header class="sheet-head">
      <span class="sec">06</span>
      <h2>Index of components</h2>
      <p>{componentCount} components, all exported from <code>@tarve/core</code>. Each name opens its reference page with a live example.</p>
    </header>
    <div class="index">
      {#each catalog as group (group.id)}
        <div class="index-group">
          <h3>{group.title}<span>{group.items.length}</span></h3>
          <ul>
            {#each group.items as item (item.name)}
              <li><a href="/docs/components/{item.name}">{item.name}</a></li>
            {/each}
          </ul>
        </div>
      {/each}
    </div>
  </section>

  <section class="sheet sheet-split" id="ship">
    <header class="sheet-head">
      <span class="sec">07</span>
      <h2>Shipping</h2>
      <p>
        <code>tarve build</code> compiles the app into one executable with the native runtime embedded. The npm package already
        carries the Windows and Linux runtimes, so either target builds from either machine without a Rust toolchain.
      </p>
    </header>
    <CodeBlock code={snippets.build} lang="sh" file="terminal" />
  </section>
</main>
