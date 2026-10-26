<script lang="ts">
  import CodeBlock from "../../lib/CodeBlock.svelte";
  import DocsShell from "../../lib/DocsShell.svelte";

  let { version }: { version: string } = $props();

  const c0 = "import { createTestRenderer } from \"@tarve/core\";\n\nconst test = await createTestRenderer(App, { renderer: \"cpu\", headless: true });\n\nawait test.getByRole(\"button\", { name: \"Save\" }).click();\nawait test.getById(\"project-name\").fill(\"Tarve demo\");\nawait test.waitFor(snapshot => snapshot.nodes.some(node => node.text === \"Saved\"));\n\nawait test.advanceMotion(50); // deterministic motion time from now on\nconst midpoint = await test.inspect();\n\nawait test.capture(\"dist/saved.png\");\ntest.close();";
  const c1 = "import { createHeadlessTestRenderer, matchImageSnapshot, renderToRgba } from \"@tarve/headless\";\n\nconst test = await createHeadlessTestRenderer(App); // the TestRenderer API\nawait matchImageSnapshot(await renderToRgba(App, { scale: 2 }), \"__snapshots__/app.png\");";
  const c2 = "const app = createApp(App, {\n  onError(event) {\n    console.error(event.source, event.event, event.targetId, event.error);\n  },\n});";
</script>

<DocsShell name="Automation">
<article class="doc">
  <nav class="doc-crumbs" aria-label="Breadcrumb">
    <a href="/docs">Docs</a><span>/</span><span>Automation and errors</span>
  </nav>

  <header class="doc-head">
    <span class="eyebrow">Guide · v{version}</span>
    <h1>Automation and errors</h1>
    <p class="doc-lead">Drive an app from code on the real native renderer, or without any window through WebAssembly, and catch every recoverable failure in one handler.</p>
  </header>

  <section class="doc-section">
    <h2 id="test-renderer">TestRenderer</h2>
    <div class="doc-prose"><p><code>createTestRenderer</code> runs the app on the same native renderer as in production, with locators, pointer and keyboard actions, waits and capture. <code>headless: true</code> keeps the window hidden for CI machines that still have a renderer surface.</p></div>
    <CodeBlock code={c0} file="e2e.ts" />
    <div class="doc-prose"><p><code>waitForIdle()</code> waits for pending updates and <code>activeMotions === 0</code>. <code>launchTestProcess</code> isolates CPU/GPU runs in child processes; <code>readPngRgba</code>, <code>comparePngCaptures</code> and <code>assertPngMatches</code> are the pixel-regression helpers Tarve's own visual tests use.</p></div>
  </section>

  <section class="doc-section">
    <h2 id="headless">Without a window</h2>
    <div class="doc-prose"><p><code>@tarve/headless</code> runs the same tree, layout, text, input and CPU painter compiled to WebAssembly: no window, GPU or native library. Fonts are bundled and time only moves with <code>advanceMotion</code>, so captures are byte-identical across platforms. For Testing Library–style queries on top of it, use <a href="/docs/testing">@tarve/test</a>.</p></div>
    <CodeBlock code={c1} file="app.test.tsx" />
  </section>

  <section class="doc-section">
    <h2 id="errors">Error handling</h2>
    <CodeBlock code={c2} file="app.tsx" />
    <div class="doc-prose"><p>Recoverable failures from callbacks, listeners, hotkeys, the bridge, requests, dialogs and updates arrive here with their <code>source</code>. A failed native update keeps the last confirmed tree. In development mode, render and handler errors also show an in-window overlay (see <a href="/docs/tooling#dev">Project and dev tools</a>).</p></div>
  </section>
</article>
</DocsShell>
