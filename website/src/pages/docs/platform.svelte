<script lang="ts">
  import CodeBlock from "../../lib/CodeBlock.svelte";
  import DocsShell from "../../lib/DocsShell.svelte";

  let { version }: { version: string } = $props();

  const c0 = "import { createApp, requestSingleInstance } from \"@tarve/core\";\n\nconst instance = await requestSingleInstance({ schemes: [\"notes\"] });\nif (!instance.primary) process.exit(0);\n\nconst app = createApp(App, {\n  protocols: [\"notes\"],\n  fileTypes: [{ ext: \"note\", name: \"Note\", icon: \"note.png\" }],\n});\n\napp.onOpenUrl((url, event) => openLink(url));        // notes://…\napp.onOpenFiles((files, event) => files.forEach(open)); // absolute paths\n// event: { initial, args, cwd }; both return an unsubscribe function";
  const c1 = "app.notify({ title: \"Export finished\", body: \"report.pdf is ready\", onClick: () => openReport() });";
  const t2: string[][] = [["Windows","A toast under <code>appIdentity</code> (or <code>tarve.appId</code>); without one Tarve registers <code>Tarve.&lt;window title></code> for the current user. Falls back to the tray balloon when a toast cannot show."],["Linux","<code>org.freedesktop.Notifications</code> (GNOME, KDE, dunst, mako…)."],["Android","The notification shade; asks for <code>POST_NOTIFICATIONS</code> first on Android 13+. Set <code>tarve.android.notificationIcon</code> to replace the white bell."]];
  const c3 = "const states = await app.requestPermissions([\"CAMERA\", \"RECORD_AUDIO\"]); // { CAMERA: \"granted\", RECORD_AUDIO: \"denied\" }\nconst now = await app.checkPermissions([\"CAMERA\"]);                     // \"granted\" | \"prompt\" | \"denied\", no dialog";
  const c4 = "await app.share({ title: \"Report\", text: \"Q3 numbers\", url: \"https://example.com\", files: [\"out/report.pdf\"] });\n\nconst fix = await app.getCurrentPosition({ highAccuracy: true, timeoutMs: 10_000 });\nif (fix.position) show(fix.position.latitude, fix.position.longitude);\nelse console.warn(fix.code); // \"unsupported\" | \"denied\" | \"unavailable\" | \"timeout\"\n\nconst stop = app.watchPosition(result => update(result)); // about every second\n\nconst auth = await app.authenticate({ reason: \"Unlock your vault\" });\nif (auth.success) unlock(); // else auth.code: \"not-enrolled\" | \"canceled\" | \"failed\" | \"lockout\" | \"busy\"";
  const t5: string[][] = [["<code>share</code>","System chooser; files go through a private read-only provider.","The Windows share UI.","<code>supported: false</code>"],["<code>getCurrentPosition</code> / <code>watchPosition</code>","<code>LocationManager</code> (no Play Services). Declare <code>ACCESS_FINE_LOCATION</code> / <code>ACCESS_COARSE_LOCATION</code> yourself.","<code>Geolocator</code>.","<code>supported: false</code>"],["<code>authenticate</code>","<code>BiometricPrompt</code>, with the device PIN as fallback (API 28+).","Windows Hello.","<code>supported: false</code>"]];
</script>

<DocsShell name="Platform">
<article class="doc">
  <nav class="doc-crumbs" aria-label="Breadcrumb">
    <a href="/docs">Docs</a><span>/</span><span>Platform APIs</span>
  </nav>

  <header class="doc-head">
    <span class="eyebrow">Guide · v{version}</span>
    <h1>Platform APIs</h1>
    <p class="doc-lead">Deep links, file associations, notifications, permissions, the share sheet, location and biometrics, with one shape on every OS: where a platform has no equivalent the answer is <code>&#123; supported: false &#125;</code>, never an exception.</p>
  </header>

  <section class="doc-section">
    <h2 id="links">Deep links and file types</h2>
    <div class="doc-prose"><p>Declare the URL schemes and file types the app opens, then listen for them. A listener receives the links or files the app was launched with right after it registers, then those of later launches that <code>requestSingleInstance</code> forwards; call it before <code>createApp</code> and no other wiring is needed.</p></div>
    <CodeBlock code={c0} file="app.tsx" />
    <div class="doc-prose"><p>Packages register them for you: put <code>tarve.protocols</code> and <code>tarve.fileTypes</code> in <code>package.json</code> (or pass <code>--protocol</code> and <code>--file-type ext=Name</code>) and <code>tarve package</code> writes HKCU/MSIX entries on Windows, <code>MimeType</code> and shared-mime-info on Linux, and intent filters on Android. At run time, <code>registerProtocol</code> / <code>registerFileType</code> (and their <code>unregister*</code> counterparts) register for the current user without admin rights. On Android a shared <code>content://</code> document is copied into the app's cache and delivered as a path. See also <a href="/docs/desktop#single-instance">Desktop integration</a>.</p></div>
  </section>

  <section class="doc-section">
    <h2 id="notifications">Notifications</h2>
    <div class="doc-prose"><p><code>app.notify</code> needs no tray icon. A click brings the window forward and runs that notification's <code>onClick</code>.</p></div>
    <CodeBlock code={c1} file="app.tsx" />
    <div class="props-wrap">
      <table class="props">
        <thead><tr><th>Platform</th><th>Shown through</th></tr></thead>
        <tbody>
          {#each t2 as row, i (i)}
            <tr>{#each row as cell, j (j)}<td>{@html cell}</td>{/each}</tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>

  <section class="doc-section">
    <h2 id="permissions">Permissions</h2>
    <CodeBlock code={c3} file="app.tsx" />
    <div class="doc-prose"><p>On Android, <code>requestPermissions</code> shows the system prompt and resolves once the user answers; a permission missing from the manifest is denied at once. Desktops have no per-app prompt and report every name as <code>"granted"</code>.</p></div>
  </section>

  <section class="doc-section">
    <h2 id="device">Share, location and biometrics</h2>
    <CodeBlock code={c4} file="app.tsx" />
    <div class="props-wrap">
      <table class="props">
        <thead><tr><th>API</th><th>Android</th><th>Windows</th><th>Linux</th></tr></thead>
        <tbody>
          {#each t5 as row, i (i)}
            <tr>{#each row as cell, j (j)}<td>{@html cell}</td>{/each}</tr>
          {/each}
        </tbody>
      </table>
    </div>
    <div class="doc-prose"><p>Location asks for the permission before the first fix. On Android, <code>app.webSignIn(&#123; url, cookieUrl, cookies &#125;)</code> opens a sign-in page in the system WebView and resolves with the cookies of <code>cookieUrl</code> once the user is signed in. Push notifications (FCM/APNs) are not available yet.</p></div>
  </section>
</article>
</DocsShell>
