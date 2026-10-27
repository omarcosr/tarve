<script lang="ts">
  import CodeBlock from "../../lib/CodeBlock.svelte";
  import DocsShell from "../../lib/DocsShell.svelte";

  let { version }: { version: string } = $props();

  const backdrop = `import { Column, Text, Window, createApp } from "@tarve/core";

// "transparent" | "blur" | "mica" | "acrylic"; the window background defaults to transparent
createApp(() => (
  <Window title="Glass" width={480} height={320} backdrop="acrylic">
    <Column flex={1} padding={24} style={{ background: "#10101840" }}>
      <Text>The desktop shows through.</Text>
    </Column>
  </Window>
));`;

  const windows = `import { Button, Text, Window, createApp } from "@tarve/core";

let count = 0;
const app = createApp(() => (
  <Window title="Main">
    <Button onClick={openSettings}>Settings…</Button>
  </Window>
));

function openSettings() {
  const settings = app.openWindow(() => (
    <Window title="Settings" width={320} height={200}>
      <Text>{\`Opened \${count} times\`}</Text>
      <Button onClick={() => settings.close()}>Done</Button>
    </Window>
  ), { id: "settings" });
  count++;
  void settings.closed.then(() => app.update());
}`;

  const drop = `<Column
  flex={1}
  onFileDragEnter={(paths) => { hovering = true; app.update(); }}
  onFileDragLeave={() => { hovering = false; app.update(); }}
  onFileDrop={({ paths, x, y }) => { for (const path of paths) open(path); }}
  style={{ background: hovering ? "#3b82f633" : "#00000000" }}
>
  <Text>Drop files here</Text>
</Column>`;

  const instance = `import { createApp, registerUrlScheme, requestSingleInstance } from "@tarve/core";

// Before createApp: a later launch hands its arguments and links to the first one and exits.
const instance = await requestSingleInstance({ schemes: ["myapp"] });
if (!instance.primary) process.exit(0);

const app = createApp(App, { rememberWindow: true });
handle(instance.launch); // { args, cwd, urls }

instance.onSecondInstance((launch) => {
  handle(launch);
  app.activate(); // show, restore and focus the window
});

// Once, for example from a setting: myapp://… links now open this app (current user).
registerUrlScheme("myapp", { name: "My App" });`;

  const menu = `app.menuBar([
  { label: "&File", items: [
    { id: "open", label: "&Open…", accelerator: "Ctrl+O", onSelect: openFile },
    { id: "save", label: "&Save", accelerator: "Ctrl+S", onSelect: save },
    { type: "separator" },
    { label: "&Recent", items: recent.map((path) => ({ id: path, label: path, onSelect: () => open(path) })) },
    { type: "separator" },
    { id: "exit", label: "E&xit", onSelect: () => app.close() },
  ] },
  { label: "&View", items: [
    { id: "wrap", label: "Word &wrap", checked: wrap, onSelect: () => { wrap = !wrap; } },
  ] },
]);

// app.menuBar(items, { native: true }) uses the Win32 menu instead (framed windows only).
// <AppMenuBar items={…} /> places the same bar anywhere, e.g. inside a TitleBar.`;

  const api = [
    ["<Window backdrop>", "\"none\" (default), \"transparent\", \"blur\", \"mica\" or \"acrylic\". Set when the window opens."],
    ["app.inspect().transparencyEffects", "Whether Windows \"Transparency effects\" is on; a transparencyEffects event reports changes. windowAlpha says whether the window composes alpha at all."],
    ["app.openWindow(view, options?)", "Opens another window from its own <Window> view and returns its AppHandle (update, close, closed, ready, onEvent, inspect, layout, dialogs). Options: id, rememberWindow, debug, renderer and the other per-window AppOptions."],
    ["onFileDrop / onFileDragEnter / onFileDragLeave", "On a View, a <div> or the Window: files dragged in from the system. The innermost enabled, visible target under the pointer gets { paths, x, y }; app.onEvent sees a fileDrop without id for files dropped elsewhere."],
    ["requestSingleInstance(options?)", "Resolves { primary, launch, onSecondInstance, release }. Options: id (default package.json tarve.appId, else the app name), schemes (URL schemes picked out of the arguments)."],
    ["registerUrlScheme(scheme, options?)", "Makes scheme://… links open the app for the current user. Options: name, command. unregisterUrlScheme(scheme) undoes it."],
    ["app.activate()", "Shows, restores and focuses the window, for a launch handed over by a second instance."],
    ["app.setFullscreen(on) / app.toggleFullscreen()", "Borderless full screen on the window's monitor, and back to the window it was. A windowState event reports fullscreen. windowAction=\"toggleFullscreen\" makes any element a full-screen button."],
    ["<Window maximized> / app.setMaximized(on)", "Opens maximized (width/height/position are the bounds it restores to; a remembered state wins), or maximizes and restores at run time."],
    ["style.cursor = \"none\"", "Hides the pointer while it is over the box (cursor-none in Tailwind), e.g. a player after a few idle seconds."],
    ["createApp(view, { rememberWindow })", "true or a key: saves size, position and maximized state per user and reopens the window that way. A position off every monitor reopens centred."],
    ["appConfigDirectory(app?)", "Where per-user app data goes: %APPDATA%, ~/Library/Application Support or $XDG_CONFIG_HOME."],
    ["app.menuBar(items | null, options?)", "Puts a menu bar at the top of the window (after a TitleBar), drawn in the theme. A choice runs onSelect and reaches app.onEvent as { type: \"menu\", id }. null removes it."],
    ["<AppMenuBar items onSelect>", "The same bar as a component, to place it yourself."],
  ];

  const support = [
    ["Translucent windows", "transparent, blur, mica, acrylic (D3D11 and CPU renderers; Vello/DX12 is opaque)", "transparent with a compositor; blur on KDE", "transparent, blur"],
    ["Several windows", "Yes", "Yes", "Yes"],
    ["System file drops", "Yes; the target follows the pointer during the drag", "X11; the target follows the pointer", "The drop goes to the target under the last known pointer"],
    ["Single instance", "Named pipe; the first instance takes the foreground", "Unix socket in $XDG_RUNTIME_DIR", "Unix socket"],
    ["URL links", "Per user, in the registry", "Desktop entry made the default with xdg-mime", "Not yet: registerUrlScheme throws"],
    ["Remembered windows", "Yes, across monitor scales", "Yes", "Yes"],
    ["Menu bar", "Themed, or native: true for the Win32 menu", "Themed", "Themed; the global macOS menu is not used yet"],
  ];
</script>

<DocsShell name="Desktop">
<article class="doc">
  <nav class="doc-crumbs" aria-label="Breadcrumb">
    <a href="/docs">Docs</a><span>/</span><span>Desktop integration</span>
  </nav>

  <header class="doc-head">
    <span class="eyebrow">Guide · v{version}</span>
    <h1>Desktop integration</h1>
    <p class="doc-lead">
      What makes an app feel like a desktop app: see-through windows, several windows, files dragged in from the system, one
      instance with links that open it, windows that reopen where they were left and a menu bar.
    </p>
  </header>

  <section class="doc-section">
    <h2 id="backdrop">Translucent windows</h2>
    <div class="doc-prose">
      <p>
        <code>backdrop</code> on <code>&lt;Window&gt;</code> lets the desktop show through. <code>transparent</code> shows
        the windows behind as they are. <code>blur</code> blurs them. <code>mica</code> and <code>acrylic</code> are the
        Windows 11 materials, and fall back to <code>blur</code> elsewhere. The window background becomes transparent: give
        any box an alpha colour to tint it.
      </p>
      <p>
        Like the system's own windows, Mica and Acrylic turn solid while the window is inactive, and all of them are solid
        while Windows "Transparency effects" is off. The material is light or dark after the window background (your theme),
        and the window opens with its final look, without first flashing transparent.
      </p>
    </div>
    <CodeBlock code={backdrop} file="glass.tsx" />
  </section>

  <section class="doc-section">
    <h2 id="windows">Several windows</h2>
    <div class="doc-prose">
      <p>
        <code>app.openWindow</code> opens another window from its own view and returns its own handle. Each window renders,
        diffs and handles events on its own, and they share your app's state: call <code>update()</code> on the windows that
        show what changed. Closing a window closes only that one; closing the first window closes them all. The tray,
        notifications and the media session stay with the first window.
      </p>
    </div>
    <CodeBlock code={windows} file="windows.tsx" />
  </section>

  <section class="doc-section">
    <h2 id="file-drop">Files from the system</h2>
    <div class="doc-prose">
      <p>
        Any of <code>onFileDrop</code>, <code>onFileDragEnter</code> and <code>onFileDragLeave</code> makes a node take
        files dragged in from Explorer, Finder or a file manager. Paths are absolute. This is separate from
        <code>draggable</code>/<code>onDrop</code>, which move things inside the app.
      </p>
    </div>
    <CodeBlock code={drop} file="drop.tsx" />
  </section>

  <section class="doc-section">
    <h2 id="single-instance">One instance and links</h2>
    <div class="doc-prose">
      <p>
        <code>requestSingleInstance</code> makes the first launch the primary instance. A later launch, from opening a file,
        clicking a link or the icon again, sends its arguments, working directory and links to the primary instance over a
        per-user named pipe or Unix socket, then exits. On Windows the first instance may take the foreground, so
        <code>app.activate()</code> brings it to the front.
      </p>
      <p>
        <code>registerUrlScheme</code> makes <code>myapp://…</code> links open the app for the current user, without
        administrator rights. Call it from an installer step or a setting, not on every launch.
      </p>
    </div>
    <CodeBlock code={instance} file="main.tsx" />
  </section>

  <section class="doc-section">
    <h2 id="remember-window">Remembered windows</h2>
    <div class="doc-prose">
      <p>
        <code>rememberWindow: true</code> (or a key, to keep several layouts) saves the window's restored size, position and
        maximized state to <code>&lt;config dir&gt;/&lt;app&gt;/window-state.json</code> and reopens it that way. Positions
        are saved in screen pixels, so a window left on a monitor with another scale reopens in the same place. A window
        whose monitor was unplugged reopens centred. On <code>openWindow</code> the option is keyed by the window id.
      </p>
    </div>
  </section>

  <section class="doc-section">
    <h2 id="menu-bar">Menu bar</h2>
    <div class="doc-prose">
      <p>
        <code>app.menuBar</code> draws the menu bar in your theme, the same on every system and in frameless windows. Menus
        open on click and follow the pointer once one is open. Arrow keys move along the bar and through menus, Enter or
        Space chooses, Escape closes, F10 focuses the bar and Alt plus the access key (<code>&amp;File</code>) opens a menu.
        An <code>accelerator</code> is shown next to its item and works as a window hotkey. While a text field has focus,
        editing shortcuts such as Ctrl+C, V, X, A and Z stay with the field.
      </p>
      <p>
        For a menu inside your own layout, use <a href="/docs/components/AppMenuBar">AppMenuBar</a>. For an in-page menu
        with your own state, use <a href="/docs/components/Menubar">Menubar</a>.
      </p>
    </div>
    <CodeBlock code={menu} file="menu.ts" />
  </section>

  <section class="doc-section">
    <h2 id="support">Platform support</h2>
    <div class="props-wrap">
      <table class="props">
        <thead><tr><th>Feature</th><th>Windows</th><th>Linux</th><th>macOS</th></tr></thead>
        <tbody>
          {#each support as [feature, win, linux, mac] (feature)}
            <tr><td><code class="prop-name">{feature}</code></td><td>{win}</td><td>{linux}</td><td>{mac}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class="doc-muted">
      Every feature is tested end to end on Windows. On Linux it builds and passes the unit tests; file drops, remembered
      windows and the menu bar have not been run on a Linux desktop yet. macOS has not been built or tested.
    </p>
  </section>

  <section class="doc-section">
    <h2 id="api">API</h2>
    <p class="doc-muted">Exported by <code>@tarve/core</code>. The <code>examples/translucent</code>, <code>examples/windows</code> and <code>examples/notes</code> apps in the repository show each feature running.</p>
    <div class="props-wrap">
      <table class="props">
        <thead><tr><th>API</th><th>Description</th></tr></thead>
        <tbody>
          {#each api as [name, text] (name)}
            <tr><td><code class="prop-name">{name}</code></td><td>{text}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>
</article>
</DocsShell>
