<script lang="ts">
  import CodeBlock from "../../lib/CodeBlock.svelte";
  import DocsShell from "../../lib/DocsShell.svelte";

  let { version }: { version: string } = $props();

  const c0 = "bunx tarve build app.tsx --outfile dist/App.exe                      # Bun\nnpx tarve build app.tsx --outfile dist/App.exe                       # Node.js\nbunx tarve build app.tsx --target linux-x64 --outfile dist/App\nbunx tarve build app.tsx --runtime txiki --outfile dist/App.exe      # a few MB";
  const c1 = "bunx tarve package dist/App --format deb,tar --version 1.2.0 --categories \"Utility;Office\"\nbunx tarve package app.tsx --format zip,msix --version 1.2.0 --publisher \"Acme Inc.\" --out dist/packages";
  const t2: string[][] = [["<code>deb</code>","<code>&lt;app>_&lt;version>_amd64.deb</code> with <code>/opt/&lt;app>/&lt;exe></code>, a <code>/usr/bin/&lt;app></code> symlink, a <code>.desktop</code> entry and a hicolor icon."],["<code>tar</code>","<code>&lt;app>-&lt;version>-linux-x64.tar.gz</code> with the executable, <code>.desktop</code>, icon and an <code>install.sh</code> for a per-user install into <code>~/.local</code>."],["<code>zip</code>","<code>&lt;App>-&lt;version>-windows-x64.zip</code>, a portable folder."],["<code>msix</code>","An MSIX folder with <code>AppxManifest.xml</code> and logos, packed into an unsigned <code>.msix</code> when <code>makeappx</code> is found (<code>TARVE_MAKEAPPX</code>). Sign it with <code>signtool</code> using a certificate whose subject is <code>CN=&lt;publisher></code>."],["<code>app-zip</code>","A zipped macOS <code>.app</code> bundle (preview, see below)."]];
  const c3 = "tarve build app.tsx --target android                                   # dist/App.apk\ntarve build app.tsx --target android --runtime bun                     # Bun on the device\ntarve build app.tsx --target android --format aab --keystore upload.jks # Google Play\ntarve build go/examples/counter --target android                       # a Go main package\nadb install dist/App.apk";
  const t4: string[][] = [["Signing","The debug keystore unless <code>--keystore</code> or <code>TARVE_ANDROID_KEYSTORE</code> (with <code>TARVE_ANDROID_KEYSTORE_PASSWORD</code>, <code>TARVE_ANDROID_KEY_ALIAS</code>). Google Play rejects bundles signed with the debug key."],["App Bundles","<code>--format aab</code> runs bundletool from <code>--bundletool</code>, <code>TARVE_BUNDLETOOL</code> or a pinned release downloaded once into the Tarve cache. Tarve targets API 34."],["Permissions","<code>INTERNET</code>, <code>FOREGROUND_SERVICE</code>, media playback, <code>POST_NOTIFICATIONS</code>, <code>WAKE_LOCK</code> and <code>USE_BIOMETRIC</code> by default; add more in <code>tarve.android.permissions</code> or with <code>--permission</code>. Ask at run time with <code>app.requestPermissions</code>."],["Requirements","The Android SDK (build-tools and a platform, from <code>ANDROID_HOME</code>) and a JDK; Go apps also need the NDK. <code>bun run android:emulator</code> starts a headless emulator in Docker in the repository."],["Not available","The tray, desktop widgets, native menus and several windows."]];
</script>

<DocsShell name="Shipping">
<article class="doc">
  <nav class="doc-crumbs" aria-label="Breadcrumb">
    <a href="/docs">Docs</a><span>/</span><span>Build and package</span>
  </nav>

  <header class="doc-head">
    <span class="eyebrow">Guide · v{version}</span>
    <h1>Build and package</h1>
    <p class="doc-lead"><code>tarve build</code> compiles an app into one executable with the native runtime inside; <code>tarve package</code> turns it into installers and archives; <code>--target android</code> writes an APK or App Bundle.</p>
  </header>

  <section class="doc-section">
    <h2 id="build">Executables</h2>
    <div class="doc-prose"><p>The npm package carries the Windows x64 and Linux x64 runtimes, so either target builds from either machine without a Rust toolchain. Bun and Node.js builds produce GUI executables named and versioned after the app (<code>--name</code>, <code>--version</code>).</p></div>
    <CodeBlock code={c0} lang="sh" file="terminal" />
  </section>

  <section class="doc-section">
    <h2 id="package">Installers and archives</h2>
    <div class="doc-prose"><p><code>tarve package</code> takes a built executable, or <code>app.tsx</code> which it builds first, and writes the packages in pure TypeScript with no external tools. Name, version, icon, description and publisher come from the <code>tarve</code> field of <code>package.json</code>; flags override them.</p></div>
    <CodeBlock code={c1} lang="sh" file="terminal" />
    <div class="props-wrap">
      <table class="props">
        <thead><tr><th>Format</th><th>Output</th></tr></thead>
        <tbody>
          {#each t2 as row, i (i)}
            <tr>{#each row as cell, j (j)}<td>{@html cell}</td>{/each}</tr>
          {/each}
        </tbody>
      </table>
    </div>
    <div class="doc-prose"><p>Packages declare the app's URL protocols and file types too (<code>--protocol</code>, <code>--file-type ext=Name</code>, or <code>tarve.protocols</code> / <code>tarve.fileTypes</code>); see <a href="/docs/platform">Platform APIs</a>. AppImage is not produced. The API is <code>packageApp(&#123; executable, format &#125;)</code> from <code>@tarve/core/package</code>. For self-updating builds, see <a href="/docs/updates">Auto-updates</a>.</p></div>
  </section>

  <section class="doc-section">
    <h2 id="android">Android</h2>
    <div class="doc-prose"><p><code>tarve build --target android</code> writes a signed APK (arm64-v8a and x86_64; <code>android-arm64</code> or <code>android-x64</code> for one ABI) from Bun or Node.js, for TSX and Go apps. A TSX app runs on QuickJS-ng embedded in the runtime, a few MB; <code>--runtime bun</code> ships Bun itself, with its full API, at about 45 MB more per ABI.</p></div>
    <CodeBlock code={c3} lang="sh" file="terminal" />
    <div class="props-wrap">
      <table class="props">
        <thead><tr><th>Topic</th><th>Details</th></tr></thead>
        <tbody>
          {#each t4 as row, i (i)}
            <tr>{#each row as cell, j (j)}<td>{@html cell}</td>{/each}</tr>
          {/each}
        </tbody>
      </table>
    </div>
    <div class="doc-prose"><p>On the device, touch acts as the pointer, the soft keyboard follows input focus, Back requests a close, and <code>&lt;audio></code>/<code>&lt;video></code> keep playing in the background with a media notification and lock-screen controls.</p></div>
  </section>

  <section class="doc-section">
    <h2 id="macos">macOS (preview)</h2>
    <div class="doc-prose"><p>macOS is not a supported target yet. The TypeScript side is in place: <code>darwin-arm64</code> and <code>darwin-x64</code> targets, <code>.app</code> bundles with an <code>.icns</code> icon, <code>tarve package --format app-zip</code>, and <code>tarve release</code> with <code>--sign "Developer ID Application: …"</code> and <code>--notarize</code>. None of it has been run or signed on a real Mac, and the npm package does not ship a macOS runtime, so building needs <code>native/darwin-&lt;arch>/libtarve_native.dylib</code> built on a Mac.</p></div>
  </section>
</article>
</DocsShell>
