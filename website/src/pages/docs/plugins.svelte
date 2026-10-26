<script lang="ts">
  import CodeBlock from "../../lib/CodeBlock.svelte";
  import DocsShell from "../../lib/DocsShell.svelte";

  let { version }: { version: string } = $props();

  const c0 = "import hello from \"tarve-plugin-hello\";\n\nconst app = createApp(View, { plugins: [hello] });\nawait hello.client(app).add(2, 3);   // typed: Promise<number>\nawait app.invoke(\"hello.add\", 2, 3); // the same command by id";
  const c1 = "import { definePlugin } from \"@tarve/core\";\n\nexport default definePlugin({\n  name: \"tarve-plugin-hello\",\n  version: \"0.1.0\",\n  namespace: \"hello\",\n  tarvePluginApi: 1,\n  root: import.meta.dirname,\n  setup(ctx) {\n    const lib = ctx.loadLibrary({ hello_add: { args: [\"i32\", \"i32\"], returns: \"i32\" } });\n    ctx.onReady(() => { /* the window is up */ });\n    ctx.onClosed(() => { /* release resources; libraries close after this */ });\n    ctx.onOpenUrl(url => { /* the app's protocols, as app.onOpenUrl */ });\n    return { add: (a: number, b: number) => lib.symbols.hello_add(a, b) };\n  },\n});";
  const t2: string[][] = [["<code>ctx.loadLibrary(symbols)</code> / <code>ctx.loadLibrary(pathsByTarget, symbols)</code>","Opens the library with the runtime's FFI: <code>bun:ffi</code>, <code>node:ffi</code> (Node.js 26.10+) or <code>tjs:ffi</code> (txiki.js); elsewhere it throws <code>PluginFfiUnsupportedError</code>. Types: <code>i8</code>…<code>u64</code>, <code>f32</code>, <code>f64</code>, <code>bool</code>, <code>ptr</code>, <code>buffer</code>, <code>void</code>."],["<code>ctx.request(command, { expect, timeoutMs })</code>","Sends a protocol request to the Tarve runtime and checks the answer type."],["<code>ctx.onReady</code>, <code>ctx.onClosed</code>, <code>ctx.onOpenUrl</code>, <code>ctx.onOpenFiles</code>","Lifecycle hooks."],["<code>ctx.registerCommand(name, fn)</code>","Adds a command."]];
  const c3 = "{\n  \"tarve\": {\n    \"tarvePluginApi\": 1,\n    \"plugin\": \"./dist/plugin.js\",\n    \"native\": {\n      \"win32-x64\": \"./native/hello.dll\",\n      \"linux-x64\": \"./native/libhello.so\",\n      \"darwin-arm64\": \"./native/libhello.dylib\",\n      \"android-arm64\": \"./native/android/libhello.so\"\n    }\n  }\n}";
</script>

<DocsShell name="Plugins">
<article class="doc">
  <nav class="doc-crumbs" aria-label="Breadcrumb">
    <a href="/docs">Docs</a><span>/</span><span>Plugins</span>
  </nav>

  <header class="doc-head">
    <span class="eyebrow">Guide · v{version}</span>
    <h1>Plugins</h1>
    <p class="doc-lead">A plugin is an npm package that adds commands to an app, optionally over a native library of its own: Rust, C, Zig or anything with a C ABI.</p>
  </header>

  <section class="doc-section">
    <h2 id="use">Using a plugin</h2>
    <CodeBlock code={c0} file="app.tsx" />
    <div class="doc-prose"><p><code>app.invoke</code> rejects when no installed plugin registered the command.</p></div>
  </section>

  <section class="doc-section">
    <h2 id="write">Writing one</h2>
    <div class="doc-prose"><p><code>definePlugin</code> takes the package name, its semver version and <code>setup(ctx)</code>, which runs once per app before the window opens. The functions <code>setup</code> returns become commands named <code>&lt;namespace>.&lt;name></code>; <code>ctx.registerCommand</code> adds more.</p></div>
    <CodeBlock code={c1} file="plugin.ts" />
    <div class="props-wrap">
      <table class="props">
        <thead><tr><th>Context</th><th>Does</th></tr></thead>
        <tbody>
          {#each t2 as row, i (i)}
            <tr>{#each row as cell, j (j)}<td>{@html cell}</td>{/each}</tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>

  <section class="doc-section">
    <h2 id="manifest">package.json</h2>
    <div class="doc-prose"><p>The <code>tarve</code> field makes a package discoverable (<code>discoverPlugins</code>, <code>loadPlugins</code>) and tells <code>tarve build</code> which library to embed for each target.</p></div>
    <CodeBlock code={c3} file="package.json" />
    <div class="doc-prose"><p><code>tarve build</code> and <code>tarve package</code> (Bun, Node.js and txiki.js builds) embed the target's library of every plugin among the app's <code>dependencies</code> and extract it once on first use; macOS bundles get it in <code>Contents/Frameworks</code>. A declared library missing for the build target fails the build. Android builds do not embed plugin libraries yet.</p></div>
    <div class="doc-prose"><p><code>tarvePluginApi</code> is the major version of the plugin API (currently <code>1</code>). Additions keep the number; Tarve refuses plugins that ask for a newer one. The repository's <code>examples/plugin-hello</code> is a complete plugin with a Rust cdylib, a TypeScript wrapper, a demo and tests.</p></div>
  </section>
</article>
</DocsShell>
