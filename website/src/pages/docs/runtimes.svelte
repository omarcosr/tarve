<script lang="ts">
  import CodeBlock from "../../lib/CodeBlock.svelte";
  import DocsShell from "../../lib/DocsShell.svelte";

  let { version }: { version: string } = $props();

  const t0: string[][] = [["Bun 1.4+","<code>run</code>, <code>dev</code>, <code>build</code>","<code>build --target android --runtime bun</code>","The fastest dev loop, <code>bun:ffi</code>, <code>bun:sqlite</code>, single-file executables."],["Node.js 26.10+","<code>run</code>, <code>dev</code>, <code>build</code>","Builds the APK; the app runs on QuickJS-ng or Bun","The npm ecosystem and Node single-executable apps. FFI and SEA are experimental in Node 26."],["txiki.js / QuickJS-ng","<code>build --runtime txiki</code>","The default engine on the device","Executables and APKs of a few MB, with a subset of Node APIs through shims."],["Go","<code>go run</code>, <code>go build</code>","<code>tarve build &lt;go package> --target android</code>","No JavaScript at all."]];
  const c1 = "npm install @tarve/core\nnpx tarve dev app.tsx\nnpx tarve build app.tsx --target linux-x64 --outfile dist/App";
</script>

<DocsShell name="Runtimes">
<article class="doc">
  <nav class="doc-crumbs" aria-label="Breadcrumb">
    <a href="/docs">Docs</a><span>/</span><span>Runtimes</span>
  </nav>

  <header class="doc-head">
    <span class="eyebrow">Guide · v{version}</span>
    <h1>Runtimes</h1>
    <p class="doc-lead">The same components, native runtime and app API run on four runtimes. Each keeps its own strengths and limits: there is no promise of feature parity between them.</p>
  </header>

  <section class="doc-section">
    <h2 id="matrix">Which runtime</h2>
    <div class="props-wrap">
      <table class="props">
        <thead><tr><th>Runtime</th><th>Windows / Linux</th><th>Android</th><th>What it gives you</th></tr></thead>
        <tbody>
          {#each t0 as row, i (i)}
            <tr>{#each row as cell, j (j)}<td>{@html cell}</td>{/each}</tr>
          {/each}
        </tbody>
      </table>
    </div>
    <div class="doc-prose"><p><code>tarve</code> uses the runtime that launched it: <code>bunx</code> and <code>bun run</code> pick Bun, <code>npx</code> and <code>npm run</code> pick Node.js. <code>--runtime bun|node|txiki</code> overrides it.</p></div>
  </section>

  <section class="doc-section">
    <h2 id="node">Node.js</h2>
    <div class="doc-prose"><p>A Node-only project needs neither Bun nor Rust. <code>dev</code> rebuilds the TSX with esbuild and remounts into the same window when the entry uses <code>await render(App)</code>. Builds embed the app and the native library in a Node.js single-executable application; the first build for a target downloads the matching official Node.js binary, checks it against <code>SHASUMS256.txt</code> and caches it (<code>TARVE_CACHE_DIR</code>). Offline, pass one with <code>--target-executable</code>.</p></div>
    <CodeBlock code={c1} lang="sh" file="terminal" />
    <div class="doc-prose"><p>From code, <code>build(&#123; entrypoint: "app.tsx", runtime: "node" &#125;)</code> from <code>@tarve/core/build</code>, or <code>buildNode</code> from <code>@tarve/core/build-node</code>.</p></div>
  </section>

  <section class="doc-section">
    <h2 id="txiki">txiki.js</h2>
    <div class="doc-prose"><p>txiki.js has no <code>tarve run</code> or <code>dev</code>: develop on Bun or Node.js and build with <code>--runtime txiki</code>. The shims cover <code>fs</code>, <code>path</code>, <code>os</code>, <code>crypto</code> hashes, <code>fetch</code> and synchronous <code>zlib</code>/gzip; on the desktop also <code>child_process</code> <code>spawn</code>/<code>spawnSync</code>, <code>net</code> pipes and plugin FFI through <code>tjs:ffi</code>. Known limits: <code>server.unref()</code> throws, a <code>fetch</code> cannot be aborted while its TCP connection opens, and auto-updates do not support txiki.js builds yet.</p></div>
  </section>

  <section class="doc-section">
    <h2 id="go">Go</h2>
    <div class="doc-prose"><p>The Go module in <code>go/</code> drives the same native runtime without JavaScript, with the same <code>App</code> methods (<code>app.Notify</code>, <code>app.RequestPermissions</code>, …). See <code>go/README.md</code> in the repository.</p></div>
  </section>
</article>
</DocsShell>
