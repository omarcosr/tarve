<script lang="ts">
  import CodeBlock from "../../lib/CodeBlock.svelte";
  import DocsShell from "../../lib/DocsShell.svelte";

  let { version }: { version: string } = $props();

  const c0 = "bun add -d @tarve/test @tarve/headless";
  const c1 = "import { afterEach, expect, test } from \"bun:test\";\nimport { cleanup, fireEvent, render } from \"@tarve/test\";\nimport { App } from \"./app\";\n\nafterEach(cleanup);\n\ntest(\"counts clicks\", async () => {\n  const view = await render(<App />);\n  await fireEvent.click(view.getByRole(\"button\", { name: \"Increment\" }));\n  expect(view.getByTestId(\"count\").text).toBe(\"Count: 1\");\n});";
  const t2: string[][] = [["<code>ByText(text)</code>","What a Text, Button, Markdown or Code shows."],["<code>ByRole(role, opts)</code>","<code>control.role</code> or the implicit role (<code>button</code>, <code>textbox</code>, <code>searchbox</code>, <code>slider</code>, <code>img</code>, <code>window</code>); filter by <code>name</code>, <code>checked</code>, <code>selected</code>, <code>expanded</code>, <code>disabled</code>."],["<code>ByLabel(text)</code>","A control named by <code>&lt;label htmlFor></code>, a <code>Field</code> label or its own <code>control.label</code>."],["<code>ByPlaceholder(text)</code>","An Input or TextArea placeholder."],["<code>ByDisplayValue(text)</code>","The current value of an Input or TextArea."],["<code>ByTestId(id)</code>","The node <code>id</code>; Tarve has no <code>data-testid</code>."]];
  const t3: string[][] = [["<code>fireEvent.click(el, { via? })</code>","Pointer move, down and up at the element's centre. A disabled or covered element gets nothing; <code>via: \"event\"</code> delivers a native <code>click</code> instead."],["<code>fireEvent.type(el, text, { clear? })</code>","Focuses and types; <code>{Enter}</code>, <code>{Tab}</code>, <code>{Backspace}</code>, <code>{ArrowLeft}</code>… press keys."],["<code>fireEvent.clear(el)</code>","Selects all and deletes."],["<code>fireEvent.key(key, el?)</code>","Presses a key, focusing <code>el</code> first when given."],["<code>fireEvent.scroll(el, deltaY)</code>","Mouse wheel over the element."],["<code>fireEvent.hover(el)</code>","Moves the pointer over it."],["<code>fireEvent.native(event)</code>","Any native event, dispatched like the native tree's."]];
  const c4 = "import { tarveMatchers, toMatchImageSnapshot } from \"@tarve/test\";\n\nawait toMatchImageSnapshot(view, `${import.meta.dirname}/__snapshots__/app.png`, { threshold: 8, maxDifferenceRatio: 0.001 });\n\n// or as a matcher (Bun, Jest, Vitest)\nexpect.extend(tarveMatchers);\nawait expect(view).toMatchImageSnapshot(\"__snapshots__/app.png\");";
  const t5: string[][] = [["Bun 1.4+","<code>bun test</code>"],["Node.js 26.10+","<code>tarve run --runtime node app.test.tsx</code> bundles the TSX and the WebAssembly and font files, then runs the <code>node:test</code> tests."],["txiki.js","<code>tarve build --runtime txiki app.test.tsx</code> and run the executable; there is no runner or <code>node:assert</code>, so call tests from a script and throw on failure."]];
</script>

<DocsShell name="Testing">
<article class="doc">
  <nav class="doc-crumbs" aria-label="Breadcrumb">
    <a href="/docs">Docs</a><span>/</span><span>Testing</span>
  </nav>

  <header class="doc-head">
    <span class="eyebrow">Guide · v{version}</span>
    <h1>Testing</h1>
    <p class="doc-lead"><code>@tarve/test</code> gives Testing Library–style tests over <code>@tarve/headless</code>, Tarve's native tree compiled to WebAssembly: no window, GPU or native library, so tests run on any CI machine.</p>
  </header>

  <section class="doc-section">
    <h2 id="start">First test</h2>
    <CodeBlock code={c0} lang="sh" file="terminal" />
    <CodeBlock code={c1} file="app.test.tsx" />
    <div class="doc-prose"><p><code>render</code> is async: it loads the WebAssembly runtime once per process. A view that is not a <code>Window</code> is wrapped in a 640×480 one unless <code>width</code>/<code>height</code> say otherwise. Queries read the compiled scene tree; input goes through native hit testing, focus and the app's own event dispatch, as in a window.</p></div>
  </section>

  <section class="doc-section">
    <h2 id="queries">Queries</h2>
    <div class="doc-prose"><p>Every query comes as <code>getBy*</code>, <code>getAllBy*</code>, <code>queryBy*</code>, <code>queryAllBy*</code>, <code>findBy*</code> and <code>findAllBy*</code>. The matcher is an exact string after collapsing whitespace, <code>&#123; exact: false &#125;</code> for a case-insensitive substring, a RegExp, or a function. A failed query prints the tree; <code>within(element)</code> scopes queries and <code>view.debug()</code> returns the printed tree.</p></div>
    <div class="props-wrap">
      <table class="props">
        <thead><tr><th>Query</th><th>Matches</th></tr></thead>
        <tbody>
          {#each t2 as row, i (i)}
            <tr>{#each row as cell, j (j)}<td>{@html cell}</td>{/each}</tr>
          {/each}
        </tbody>
      </table>
    </div>
    <div class="doc-prose"><p>Elements are live: one object per node id whose <code>text</code>, <code>value</code>, <code>name</code>, <code>role</code>, <code>checked</code>, <code>disabled</code>, <code>parent</code>, <code>children</code> and <code>node</code> always read the current tree; <code>isConnected</code> turns false once the node is gone.</p></div>
  </section>

  <section class="doc-section">
    <h2 id="events">Events</h2>
    <div class="doc-prose"><p>Every call waits until the app has handled it and re-rendered.</p></div>
    <div class="props-wrap">
      <table class="props">
        <thead><tr><th>Call</th><th>Does</th></tr></thead>
        <tbody>
          {#each t3 as row, i (i)}
            <tr>{#each row as cell, j (j)}<td>{@html cell}</td>{/each}</tr>
          {/each}
        </tbody>
      </table>
    </div>
    <div class="doc-prose"><p><code>rerender(ui?)</code>, <code>unmount()</code>, <code>cleanup()</code>, <code>waitFor(callback, &#123; timeout, interval &#125;)</code>, <code>waitForElementToBeRemoved</code>, <code>box(el)</code> for the laid-out box, <code>settle()</code> and <code>advance(ms)</code> for the motion clock complete the render.</p></div>
  </section>

  <section class="doc-section">
    <h2 id="snapshots">Image snapshots</h2>
    <div class="doc-prose"><p><code>view.snapshot()</code> returns the frame as PNG bytes and <code>view.pixels()</code> as RGBA. Captures are deterministic (bundled fonts, frozen clock), so thresholds default to 0. A missing snapshot is written, except on CI; a mismatch writes <code>app.actual.png</code> beside it and throws. <code>TARVE_UPDATE_SNAPSHOTS=1</code> rewrites stored images.</p></div>
    <CodeBlock code={c4} file="app.test.tsx" />
  </section>

  <section class="doc-section">
    <h2 id="runtimes">Runners and runtimes</h2>
    <div class="doc-prose"><p>The package depends on no test runner: queries and events throw plain errors and <code>waitFor</code> retries on its own timer. <code>node:test</code> files run unchanged under <code>bun test</code> and Node.js.</p></div>
    <div class="props-wrap">
      <table class="props">
        <thead><tr><th>Runtime</th><th>Run</th></tr></thead>
        <tbody>
          {#each t5 as row, i (i)}
            <tr>{#each row as cell, j (j)}<td>{@html cell}</td>{/each}</tr>
          {/each}
        </tbody>
      </table>
    </div>
    <div class="doc-prose"><p>Limits: dialogs, clipboard, tray, notifications and the OS accessibility tree need a real window, and roles come from Tarve's <code>control</code> metadata rather than a platform accessibility API. For tests against the real renderer, use <code>TestRenderer</code>.</p></div>
  </section>
</article>
</DocsShell>
