<script lang="ts">
  import CodeBlock from "../lib/CodeBlock.svelte";
  import CopyCommand from "../lib/CopyCommand.svelte";
  import DemoWindow from "../lib/DemoWindow.svelte";
  import Renderers from "../lib/Renderers.svelte";
  import StartTabs from "../lib/StartTabs.svelte";
  import { componentCount, features, pipeline, snippets, stats } from "../lib/content";
  import { catalog } from "../lib/docs/catalog";

  let { version = "0.4.0" }: { version?: string } = $props();
  const repo = "https://github.com/omarcosr/tarve";
  const rows = [catalog.slice(0, 3), catalog.slice(3, 6), catalog.slice(6)];
</script>

<main>
  <section class="hero">
    <div class="hero-copy">
      <a class="pill" href="https://www.npmjs.com/package/@tarve/core">
        <span class="pill-dot"></span> @tarve/core v{version} · Windows x64 &amp; Linux x64
      </a>
      <h1>Native interfaces,<br />written in <span class="grad">TSX</span>.</h1>
      <p class="lead">
        Tarve turns a TSX tree into a retained native interface. No browser, no DOM, no React runtime — just
        <strong>Bun</strong>, a <strong>Rust</strong> runtime and pixels.
      </p>
      <div class="cta">
        <CopyCommand command="bun add @tarve/core" />
        <a class="btn btn-primary" href="/docs">Read the docs <span aria-hidden="true">→</span></a>
      </div>
      <ul class="stack" aria-label="Technologies">
        <li>Bun 1.4+</li><li>Rust</li><li>Taffy</li><li>Parley</li><li>Vello</li><li>AccessKit</li>
      </ul>
    </div>
    <div class="hero-visual">
      <DemoWindow />
    </div>
  </section>

  <section class="stats" aria-label="Numbers">
    {#each stats as stat}
      <div class="stat reveal">
        <strong class="grad">{stat.value}</strong>
        <span>{stat.label}</span>
      </div>
    {/each}
  </section>

  <section class="section contrast">
    <div class="section-head reveal">
      <span class="eyebrow">The idea</span>
      <h2>Your interface. <span class="muted">Not an entire browser.</span></h2>
    </div>
    <div class="versus">
      <div class="versus-card versus-off reveal">
        <h3>What stays out</h3>
        <ul>
          <li>A bundled Chromium</li>
          <li>The DOM and a CSS engine</li>
          <li>The React runtime</li>
          <li>A render loop spinning while idle</li>
        </ul>
      </div>
      <div class="versus-card versus-on reveal">
        <h3>What you get</h3>
        <ul>
          <li>TSX with its own JSX runtime</li>
          <li>Native layout, text and painting in Rust</li>
          <li>GPU or CPU rendering, your choice</li>
          <li>A single executable to ship</li>
        </ul>
      </div>
    </div>
  </section>

  <section class="section" id="pipeline">
    <div class="section-head reveal">
      <span class="eyebrow">Pipeline</span>
      <h2>From TSX to pixels, <span class="muted">in six steps.</span></h2>
      <p>Every layer is specialised. Together they deliver a window that only works when something actually changes.</p>
    </div>
    <ol class="pipeline">
      {#each pipeline as step, index}
        <li class="pipe reveal" style:--i={index}>
          <span class="pipe-tag">{step.tag}</span>
          <h3>{step.title}</h3>
          <p>{step.body}</p>
        </li>
      {/each}
    </ol>
  </section>

  <section class="section" id="features">
    <div class="section-head reveal">
      <span class="eyebrow">Features</span>
      <h2>Everything a desktop app needs. <span class="muted">Native.</span></h2>
    </div>
    <div class="features">
      {#each features as feature}
        <article class="feature reveal">
          <span class="feature-icon">
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <path d={feature.icon} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </span>
          <h3>{feature.title}</h3>
          <p>{feature.body}</p>
        </article>
      {/each}
    </div>
  </section>

  <section class="section split" id="renderers">
    <div class="section-head reveal">
      <span class="eyebrow">Renderers</span>
      <h2>GPU when it can. <span class="muted">CPU when it must.</span></h2>
      <p>
        <code>createApp</code> accepts <code>renderer: "auto" | "gpu" | "cpu"</code>. Windows uses native D3D11/DXGI with a
        Vello/WGPU fallback; Linux uses Vello/WGPU. Both ship a low-memory CPU path.
      </p>
    </div>
    <div class="reveal"><Renderers /></div>
  </section>

  <section class="section split split-reverse">
    <div class="section-head reveal">
      <span class="eyebrow">Styling</span>
      <h2>Write it like CSS. <span class="muted">Paint it natively.</span></h2>
      <p>
        Linear, radial and conic gradients, <code>boxShadow</code>, <code>textShadow</code>, <code>transform</code> and
        transitions animated natively on hover, focus and updates — identical on D3D11, Vello and the CPU renderer.
      </p>
      <div class="style-demo" aria-hidden="true"><span>hover me</span></div>
    </div>
    <div class="reveal"><CodeBlock code={snippets.style} file="card.tsx" /></div>
  </section>

  <section class="section" id="components">
    <div class="section-head reveal">
      <span class="eyebrow">Components</span>
      <h2>{componentCount} components, <span class="muted">inspired by shadcn.</span></h2>
      <p>
        Native primitives and high-level controls, all exported from <code>@tarve/core</code> with light and dark theme tokens.
        Every one has its own <a class="inline-link" href="/docs">documentation page</a>.
      </p>
    </div>
    <div class="marquees">
      {#each rows as row, index}
        <div class="marquee" class:marquee-reverse={index % 2 === 1}>
          <div class="marquee-track">
            {#each [0, 1] as copy}
              {#each row as group}
                <span class="marquee-group" aria-hidden={copy === 1}>
                  <b>{group.title}</b>
                  {#each group.items as item}
                    <a href="/docs/components/{item.name}" tabindex={copy === 1 ? -1 : undefined}><code>&lt;{item.name} /&gt;</code></a>
                  {/each}
                </span>
              {/each}
            {/each}
          </div>
        </div>
      {/each}
    </div>
  </section>

  <section class="section" id="start">
    <div class="section-head center reveal">
      <span class="eyebrow">Get started</span>
      <h2>From install to window <span class="muted">in four steps.</span></h2>
    </div>
    <div class="reveal"><StartTabs /></div>
  </section>

  <section class="section split">
    <div class="section-head reveal">
      <span class="eyebrow">Distribution</span>
      <h2>One command. <span class="muted">One executable.</span></h2>
      <p>
        The <code>tarve build</code> CLI compiles your app into a standalone executable with the native runtime embedded. The
        published package already carries the Windows x64 and Linux x64 runtimes — cross-compile without a Rust toolchain.
      </p>
    </div>
    <div class="reveal"><CodeBlock code={snippets.build} lang="sh" file="terminal" /></div>
  </section>

  <section class="final reveal">
    <h2>Build your next <span class="grad">native</span> window.</h2>
    <p>Bun + TSX on the outside. Rust, Taffy, Parley and Vello on the inside.</p>
    <div class="cta center">
      <CopyCommand command="bun add @tarve/core" />
      <a class="btn btn-primary" href="/docs">Read the docs</a>
      <a class="btn btn-ghost" href={repo}>View on GitHub</a>
    </div>
  </section>
</main>
