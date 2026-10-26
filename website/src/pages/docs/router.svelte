<script lang="ts">
  import CodeBlock from "../../lib/CodeBlock.svelte";
  import DocsShell from "../../lib/DocsShell.svelte";

  let { version }: { version: string } = $props();

  const c0 = "bun add @tarve/router\nnpm install @tarve/router";
  const c1 = "import { Button, Text, Window, createApp } from \"@tarve/core\";\nimport { Link, RouterView, createStackRouter, route } from \"@tarve/router\";\n\nconst router = createStackRouter({\n  transition: \"slide\", // \"none\" (default) | \"fade\" | \"slide\" | { push, pop?, transition? }\n  routes: {\n    home: route(\"/\", () => <Link to=\"/users/42\">User 42</Link>),\n    user: route(\"/users/:id\", ({ params, router }) => ( // params: { id: string }\n      <Button onClick={() => router.pop()}>Back from {params.id}</Button>\n    )),\n    notFound: route(\"*\", () => <Text>Not found</Text>),\n  },\n});\n\nconst app = createApp(() => (\n  <Window title=\"App\" onCloseRequest={router.onCloseRequest}>\n    <RouterView router={router} />\n  </Window>\n), { pointerEvents: true });\nrouter.attach(app);";
  const t2: string[][] = [["<code>push(name, params?, opts?)</code> / <code>replace(...)</code>","Opens a screen; <code>opts</code> takes <code>state</code> and <code>query</code>."],["<code>pop(count = 1)</code>, <code>popToRoot()</code>, <code>back()</code>, <code>canGoBack()</code>","Walks back."],["<code>reset(path?)</code>","Starts over at a path."],["<code>navigate(\"/users/42?tab=posts\", { replace? })</code>","Picks the most specific route: static, then <code>:param</code>, then <code>:param?</code>, <code>*</code> last. Returns <code>undefined</code> when nothing matches; navigating to the screen on top changes nothing."],["<code>route</code>, <code>stack</code>, <code>lastChange</code>","The top route (a union discriminated by <code>name</code>), the whole stack and the last change."],["<code>href(name, params)</code>, <code>match(path)</code>, <code>title(route?)</code>, <code>subscribe(listener)</code>","Helpers."]];
  const c3 = "const tabs = createTabRouter({\n  tabs: {\n    feed: { title: \"Feed\", icon: \"home\", routes: { list: route(\"/\", Feed), post: route(\"/posts/:id\", Post) } },\n    settings: { title: \"Settings\", routes: { main: route(\"/settings\", Settings) } },\n  },\n});\n\n<TabRouterView router={tabs} placement=\"bottom\" />\n// or <RouterView router={tabs} /> with your own <TabBar router={tabs} />";
  const t4: string[][] = [["Escape","<code>RouterView</code> (<code>backOnEscape</code>, on by default) while the router can go back; popups keep their own Escape."],["Alt+Left","<code>router.attach(app)</code> (the <code>hotkeys</code> option)."],["Mouse back button","<code>router.attach(app)</code> with <code>createApp(view, { pointerEvents: true })</code>."],["Android back key","<code>&lt;Window onCloseRequest={router.onCloseRequest}></code>: the native runtime turns it into a close request."]];
</script>

<DocsShell name="Router">
<article class="doc">
  <nav class="doc-crumbs" aria-label="Breadcrumb">
    <a href="/docs">Docs</a><span>/</span><span>Navigation</span>
  </nav>

  <header class="doc-head">
    <span class="eyebrow">Guide · v{version}</span>
    <h1>Navigation</h1>
    <p class="doc-lead"><code>@tarve/router</code> gives stack and tab navigation with typed path params, transitions and the platform back gestures.</p>
  </header>

  <section class="doc-section">
    <h2 id="install">Install</h2>
    <CodeBlock code={c0} lang="sh" file="terminal" />
    <CodeBlock code={c1} file="app.tsx" />
  </section>

  <section class="doc-section">
    <h2 id="stack">Stack router</h2>
    <div class="doc-prose"><p><code>createStackRouter(&#123; routes, initial?, transition?, backOnCloseRequest?, onChange?, id? &#125;)</code>. Params are typed from the path: <code>:id</code> is required, <code>:tab?</code> optional and <code>*</code> a trailing splat.</p></div>
    <div class="props-wrap">
      <table class="props">
        <thead><tr><th>Member</th><th>Does</th></tr></thead>
        <tbody>
          {#each t2 as row, i (i)}
            <tr>{#each row as cell, j (j)}<td>{@html cell}</td>{/each}</tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>

  <section class="doc-section">
    <h2 id="tabs">Tab router</h2>
    <div class="doc-prose"><p><code>createTabRouter(&#123; tabs, initialTab?, backBehavior?, reselectToRoot?, transition? &#125;)</code> keeps one stack per tab. <code>select(tab)</code> switches tabs, and selecting the active one pops it to its root. <code>navigate(path)</code> finds the tab that owns the path, the active tab first. <code>back()</code> pops the active stack, then returns to the initial tab; <code>backBehavior: "history"</code> walks the visited tabs and <code>"none"</code> stops.</p></div>
    <CodeBlock code={c3} file="tabs.tsx" />
  </section>

  <section class="doc-section">
    <h2 id="reading">Reading the route</h2>
    <div class="doc-prose"><p>Screens receive <code>route</code>, <code>params</code> and <code>router</code>. Components deeper in the tree call <code>useRoute()</code>, <code>useParams()</code>, <code>useRouter()</code> or <code>useStack()</code> while rendering. Tarve has no component context: <code>RouterView</code> brackets each screen with marker components, so these hooks read the screen being rendered.</p></div>
    <div class="doc-prose"><p>Navigation inside an event handler renders like any state change. For navigation from a timer or a fetch, <code>router.attach(app)</code> makes the router call <code>app.update()</code>.</p></div>
  </section>

  <section class="doc-section">
    <h2 id="back">Back</h2>
    <div class="props-wrap">
      <table class="props">
        <thead><tr><th>Input</th><th>How</th></tr></thead>
        <tbody>
          {#each t4 as row, i (i)}
            <tr>{#each row as cell, j (j)}<td>{@html cell}</td>{/each}</tr>
          {/each}
        </tbody>
      </table>
    </div>
    <div class="doc-prose"><p>On Node.js, run router apps with <code>tarve run --runtime node</code>, which bundles the sources.</p></div>
  </section>
</article>
</DocsShell>
