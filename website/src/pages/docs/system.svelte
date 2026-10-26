<script lang="ts">
  import CodeBlock from "../../lib/CodeBlock.svelte";
  import DocsShell from "../../lib/DocsShell.svelte";

  let { version }: { version: string } = $props();

  const c0 = "const tray = app.tray({\n  tooltip: \"Pulse\",\n  menu: [\n    { id: \"show\", label: \"Show\", onSelect: () => app.activate() },\n    { id: \"pause\", label: \"Pause monitoring\", checked: paused, onSelect: togglePause },\n    { type: \"separator\" },\n    { id: \"quit\", label: \"Quit\", onSelect: () => app.close() },\n  ],\n  onClick: () => app.activate(),\n});\n\ntray.update({ tooltip: \"Pulse — paused\" }); // modified in place";
  const c1 = "const unregister = app.registerHotkey(\"Ctrl+Shift+Space\", () => app.activate());\n// later\nunregister();";
  const c2 = "const file = await app.openFileDialog({ title: \"Open project\", filters: [{ name: \"JSON\", extensions: [\"json\"] }] });\nconst files = await app.openFilesDialog();\nconst folder = await app.openFolderDialog();\nconst target = await app.saveFileDialog({ fileName: \"report.json\", directory: home });";
  const c3 = "<View focusable onPaste={payload => {\n  if (payload.kind === \"files\") attach(payload.files);\n  else if (payload.kind === \"image\") addImage(payload.width, payload.height, payload.rgba);\n}} />";
  const c4 = "<Window title=\"Clock\" desktopWidget={{ columns: 3, rows: 2 }} position=\"top-right\">\n  <Clock />\n</Window>";
  const c5 = "{\n  \"name\": \"pulse\",\n  \"version\": \"1.2.0\",\n  \"tarve\": {\n    \"name\": \"Pulse\",\n    \"description\": \"System monitor\",\n    \"publisher\": \"Example Inc.\",\n    \"copyright\": \"© 2026 Example Inc.\",\n    \"icon\": \"assets/icon.png\",\n    \"appId\": \"Example.Pulse\"\n  }\n}";
  const c6 = "<Window title=\"My app\" width={1000} height={700}>\n  <TitleBar title=\"My app\" />\n  <View flex={1}>{/* application */}</View>\n</Window>";
  const c7 = "import { lucideReactAdapter, phosphorReactAdapter, reactSvgAdapter } from \"@tarve/react-icons\";\nimport { Save } from \"lucide-react\";\n\nconst app = createApp(App, { componentAdapters: [reactSvgAdapter, lucideReactAdapter, phosphorReactAdapter] });\n\n<Save size={16} />";
</script>

<DocsShell name="System">
<article class="doc">
  <nav class="doc-crumbs" aria-label="Breadcrumb">
    <a href="/docs">Docs</a><span>/</span><span>System integration</span>
  </nav>

  <header class="doc-head">
    <span class="eyebrow">Guide · v{version}</span>
    <h1>System integration</h1>
    <p class="doc-lead">Everything an app does with the operating system around its window: tray, hotkeys, dialogs, widgets, its icon and name, and its own title bar.</p>
  </header>

  <section class="doc-section">
    <h2 id="tray">Tray icon</h2>
    <CodeBlock code={c0} file="tray.tsx" />
    <div class="doc-prose"><p>Windows only; a second <code>app.tray()</code> replaces the first. The icon defaults to the app icon. Combine it with <code>&lt;Window onCloseRequest=&#123;e => &#123; e.preventDefault(); app.hide(); &#125;&#125;></code> for hide-on-close apps. <code>app.show()</code>, <code>app.hide()</code>, <code>app.minimize()</code> and <code>app.activate()</code> (show, restore and bring to front) control the window.</p></div>
  </section>

  <section class="doc-section">
    <h2 id="hotkeys">Global hotkeys</h2>
    <CodeBlock code={c1} file="app.tsx" />
    <div class="doc-prose"><p>Shortcuts work while the app is in the background. Handler errors go to <code>onError</code> with <code>source: "hotkey"</code>.</p></div>
  </section>

  <section class="doc-section">
    <h2 id="dialogs">File dialogs</h2>
    <CodeBlock code={c2} file="app.tsx" />
    <div class="doc-prose"><p>Each resolves to a path (or paths), or <code>undefined</code> when cancelled. Linux uses the XDG desktop portal. On Android the system document picker opens: an opened document is copied into the app's cache, a saved one is copied back when the app closes the file, and folders report an error. <code>&lt;input type="file"></code> opens the same dialog.</p></div>
  </section>

  <section class="doc-section">
    <h2 id="clipboard">Clipboard and paste</h2>
    <div class="doc-prose"><p>Text fields handle copy, cut and paste natively. When the clipboard holds no text, <code>Ctrl+V</code> delivers files or a bitmap to the focused element's <code>onPaste</code>:</p></div>
    <CodeBlock code={c3} file="app.tsx" />
  </section>

  <section class="doc-section">
    <h2 id="widget">Desktop widgets</h2>
    <CodeBlock code={c4} file="widget.tsx" />
    <div class="doc-prose"><p>A desktop widget sits under every other window, stays out of the taskbar and snaps into free cells of a grid when dragged across the desktop. <code>level: "alwaysOnBottom"</code> or <code>"alwaysOnTop"</code> set the stacking without the grid. Not available on Android.</p></div>
  </section>

  <section class="doc-section">
    <h2 id="identity">App icon and metadata</h2>
    <div class="doc-prose"><p>Name, icon and publisher live in <code>package.json</code> under <code>"tarve"</code>. <code>tarve build</code>, <code>run</code> and <code>dev</code> read them; <code>--name</code>, <code>--version</code>, <code>--icon</code>, <code>--publisher</code>, <code>--copyright</code>, <code>--description</code> and <code>--app-id</code> override them.</p></div>
    <CodeBlock code={c5} file="package.json" />
    <div class="doc-prose"><p>The icon is a square PNG (256 px or larger) or an <code>.ico</code>. On Windows the build writes a multi-size icon and version info into the <code>.exe</code>; on Linux it writes <code>&lt;App>.desktop</code> and <code>&lt;App>.png</code> beside the binary. The window, taskbar and tray use the same icon, and <code>appId</code> names the app in media controls and notifications. A monorepo sets per-entry values under <code>"tarve": &#123; "apps": &#123; "pulse/pulse.tsx": &#123; … &#125; &#125; &#125;</code>; <code>createApp(view, &#123; icon &#125;)</code> sets the window icon directly.</p></div>
  </section>

  <section class="doc-section">
    <h2 id="titlebar">Custom title bar</h2>
    <CodeBlock code={c6} file="app.tsx" />
    <div class="doc-prose"><p><code>TitleBar</code> opts into Tarve-drawn window chrome while keeping native dragging, resize hit testing and minimize/maximize/close; Windows also gets Windows 11 corners and maximized/fullscreen border handling. A menu bar can sit inside it with <code>&lt;AppMenuBar items></code>; see <a href="/docs/desktop#menu-bar">Desktop integration</a> and <a href="/docs/components/TitleBar">TitleBar</a>.</p></div>
  </section>

  <section class="doc-section">
    <h2 id="icons">Icon libraries</h2>
    <div class="doc-prose"><p><code>Icon</code> and the SVG primitives are native. <code>@tarve/react-icons</code> adapts static SVG icon components from Lucide, Phosphor, Heroicons or Tabler without adding React to Tarve:</p></div>
    <CodeBlock code={c7} file="app.tsx" />
  </section>
</article>
</DocsShell>
