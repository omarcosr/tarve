<script lang="ts">
  import CodeBlock from "../../lib/CodeBlock.svelte";
  import DocsShell from "../../lib/DocsShell.svelte";

  let { version }: { version: string } = $props();

  const c0 = "bun create tarve my-app\nnpm create tarve@latest my-app\n\n# no prompts\nbun create tarve my-app --template tailwind --runtime bun --yes\nnpm create tarve@latest my-app -- --template svelte --runtime node --yes";
  const t1: string[][] = [["<code>basic</code>","A counter with <code>Window</code>, <code>Column</code>, <code>Text</code> and <code>Button</code>."],["<code>tailwind</code>","The counter styled with Tailwind CSS 4 classes and a light/dark switch."],["<code>svelte</code>","A Svelte 5 counter through <code>@tarve/svelte</code> (<code>app.ts</code> + <code>App.svelte</code>)."],["<code>tray</code>","A system tray app with a menu, notifications and hide-on-close."]];
  const t2: string[][] = [["<code>-t, --template &lt;name></code>","<code>basic</code>, <code>tailwind</code>, <code>svelte</code> or <code>tray</code>."],["<code>-r, --runtime bun|node</code>","Scripts, <code>@types/*</code> and <code>engines</code> for Bun 1.4+ or Node.js 26.10+. Defaults to the runtime running create-tarve."],["<code>--title &lt;title></code>","Display name; defaults to one derived from the directory."],["<code>-y, --yes</code>","Never prompt."],["<code>-f, --force</code>","Write into a non-empty directory, overwriting files with the same names."]];
  const c3 = "bunx tarve dev app.tsx      # Bun\nnpx tarve dev app.tsx       # Node.js 26.10+\nbunx tarve run app.tsx      # no hot reload";
  const c4 = "const app = createApp(App, { frameOverlay: true }); // or TARVE_FRAME_OVERLAY=1\napp.setFrameOverlay(false);";
  const c5 = "bunx tarve dev app.tsx --inspect   # also: tarve run --inspect, npx tarve dev --inspect\nTARVE_INSPECTOR=1 bun app.tsx";
  const c6 = "const app = createApp(App, { dev: { inspector: true } });";
  const t7: string[][] = [["Tree","Components and the native nodes they returned, fragments grouped. <code>×N</code> is how often a component rendered; a reused <code>memo()</code> does not count."],["Details","Props of the selected node, its resolved style, its fields and the layout box computed by the native tree."],["Pick node","Highlights the node under the pointer in the app window; clicking selects it in the tree. Honors paint order, portals, <code>zIndex</code> and scroll clipping."],["Expand all / Collapse","Opens or folds the whole tree."],["Event log","Native events as the app receives them."]];
</script>

<DocsShell name="Tooling">
<article class="doc">
  <nav class="doc-crumbs" aria-label="Breadcrumb">
    <a href="/docs">Docs</a><span>/</span><span>Project and dev tools</span>
  </nav>

  <header class="doc-head">
    <span class="eyebrow">Guide · v{version}</span>
    <h1>Project and dev tools</h1>
    <p class="doc-lead">Scaffold a project with <code>create-tarve</code>, iterate with <code>tarve dev</code>, and look inside a running app with the visual inspector.</p>
  </header>

  <section class="doc-section">
    <h2 id="create">Create a project</h2>
    <div class="doc-prose"><p><code>create-tarve</code> writes a ready-to-run project: <code>package.json</code> with <code>@tarve/core</code> and the <code>dev</code>, <code>start</code>, <code>build</code> and <code>typecheck</code> scripts, the <code>tsconfig.json</code>, a <code>.gitignore</code> and a README. It has no dependencies and runs on Bun and Node.js 26.10+.</p></div>
    <CodeBlock code={c0} lang="sh" file="terminal" />
    <div class="props-wrap">
      <table class="props">
        <thead><tr><th>Template</th><th>What you get</th></tr></thead>
        <tbody>
          {#each t1 as row, i (i)}
            <tr>{#each row as cell, j (j)}<td>{@html cell}</td>{/each}</tr>
          {/each}
        </tbody>
      </table>
    </div>
    <div class="props-wrap">
      <table class="props">
        <thead><tr><th>Option</th><th>Meaning</th></tr></thead>
        <tbody>
          {#each t2 as row, i (i)}
            <tr>{#each row as cell, j (j)}<td>{@html cell}</td>{/each}</tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>

  <section class="doc-section">
    <h2 id="dev">Development mode</h2>
    <div class="doc-prose"><p><code>tarve dev</code> runs the entry with hot reload: a saved change remounts the new view into the window that is already open. Under Bun, <code>TARVE_DEV=1 bun --hot app.tsx</code> does the same. Render, handler, listener and hotkey errors replace the view with an in-window overlay showing the source, message and stack; saving a fix remounts the app.</p></div>
    <CodeBlock code={c3} lang="sh" file="terminal" />
    <div class="doc-prose"><p>The native frame-time overlay draws the CPU cost of the last 120 frames against a 16.7 ms budget. It schedules no frames of its own, so an idle window still presents nothing.</p></div>
    <CodeBlock code={c4} file="app.tsx" />
  </section>

  <section class="doc-section">
    <h2 id="inspector">Visual inspector</h2>
    <div class="doc-prose"><p>The inspector opens a second window beside your app with the live tree of components and native nodes. Turn it on from the CLI, in code or with an environment variable:</p></div>
    <CodeBlock code={c5} lang="sh" file="terminal" />
    <CodeBlock code={c6} file="app.tsx" />
    <div class="props-wrap">
      <table class="props">
        <thead><tr><th>Panel</th><th>Shows</th></tr></thead>
        <tbody>
          {#each t7 as row, i (i)}
            <tr>{#each row as cell, j (j)}<td>{@html cell}</td>{/each}</tr>
          {/each}
        </tbody>
      </table>
    </div>
    <div class="doc-prose"><p>The inspector is TypeScript only and uses existing protocol requests; windows opened with <code>app.openWindow</code> never get one of their own. <code>TARVE_INSPECT=&lt;file></code> is a different switch: automation that writes the tree to a file and exits.</p></div>
  </section>
</article>
</DocsShell>
