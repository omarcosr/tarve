<script lang="ts">
  import CodeBlock from "../../lib/CodeBlock.svelte";
  import DocsShell from "../../lib/DocsShell.svelte";

  let { version }: { version: string } = $props();

  const build = "bunx tarve build app.tsx --target android                    # dist/App.apk (arm64-v8a + x86_64)\nbunx tarve build app.tsx --target android-arm64              # one ABI\nbunx tarve build app.tsx --target android --runtime bun      # Bun on the device\nbunx tarve build app.tsx --target android --format aab --keystore upload.jks   # Google Play\nbunx tarve build go/examples/counter --target android        # a Go main package\nadb install dist/App.apk\nadb logcat -s tarve                                           # console.log goes to logcat";
  const config = '{\n  "tarve": {\n    "android": {\n      "permissions": ["CAMERA", "RECORD_AUDIO", "ACCESS_FINE_LOCATION"],\n      "cleartextTraffic": true\n    }\n  }\n}';
  const perms = 'const states = await app.requestPermissions(["CAMERA", "RECORD_AUDIO"]); // { CAMERA: "granted", RECORD_AUDIO: "denied" }\nconst now = await app.checkPermissions(["CAMERA"]);                     // no prompt: "granted" | "prompt" | "denied"';
  const status: string[][] = [
    ["Components, layout, text, styles, motion", "Same as on the desktop: the same native runtime lays out and paints them."],
    ["Input", "Touch is the pointer (tap clicks, hold and drag, swipe scrolls, <code>onLongPress</code>, <code>onPinch</code>); the soft keyboard follows input focus and reopens on a tap into the focused field; Back sends <code>onCloseRequest</code> (the router goes back)."],
    ["Audio and video", "<code>&lt;audio></code> on the app's own decoder, <code>&lt;video></code> on MediaPlayer (hardware decoders); playback continues in the background with a media notification, lock-screen and headset controls. See <a href=\"/docs/media\">Audio and video</a>."],
    ["Device APIs", "Permissions, location, biometrics, share, notifications (also at a time or a place with the app closed), speech recognition, deep links and file associations, <code>webSignIn</code>. Several of these exist <em>only</em> on Android; see <a href=\"/docs/platform\">Platform APIs</a>."],
    ["Files", "<code>node:fs</code> works in the app's private storage (<code>os.homedir()</code>, <code>os.tmpdir()</code>); the file dialogs open the system document picker and copy the chosen document into the cache. Folders are not supported."],
    ["Not available", "Tray (a no-op that reports <code>supported: false</code>), desktop widgets, native menus, several windows, window position and size."],
  ];
  const differences: string[][] = [
    ["Where you develop", "On Windows or Linux with <code>tarve dev</code>, or on the device: <code>tarve dev app.tsx --target android</code> installs a dev APK once, then on every save rebundles only the JS, pushes it with adb and restarts the app (about 0.7 s on an emulator, no reinstall). The app's console and crashes print in the terminal; a bundling error leaves the last good app running. <code>--device &lt;serial&gt;</code> or <code>ANDROID_SERIAL</code> picks the device."],
    ["JavaScript engine", "QuickJS-ng inside the runtime (a few MB): timers, <code>fetch</code>, <code>TextEncoder</code>, <code>URL</code>, <code>crypto</code>, <code>Intl</code>, <code>Buffer</code>, <code>node:fs</code>/<code>path</code>/<code>os</code>/<code>crypto</code>, no child processes or sockets. <code>--runtime bun</code> ships Bun instead (its full API, about 45 MB more per ABI). Node.js has no Android build."],
    ["Plugins", "A plugin's native library loads through <code>tjs:ffi</code> on QuickJS-ng; it needs an <code>android-arm64</code> / <code>android-x64</code> build in <code>tarve.native</code>."],
    ["Renderer", "Vello on the GPU (wgpu), with the CPU renderer as fallback; D3D11 is Windows only."],
    ["Target SDK", "API 35, edge-to-edge: the window background paints behind the status and navigation bars, and the UI is laid out inside them, the display cutout and the keyboard. Check Google Play's current requirement before uploading."],
    ["How it is tested", "Every change to the runtime runs an APK on an Android 14 emulator in CI (<code>scripts/smoke-android-ci.tsx</code>): rendering, layout, a click and a long press, timers and storage, <code>&lt;video></code> (metadata, playback, seek) and <code>&lt;audio></code> from files bundled in the APK, the Back key reaching <code>onCloseRequest</code>, and the device APIs that answer without a person (<code>checkPermissions</code>, <code>notify</code> posting to the shade, <code>recognizeSpeech</code> answering). The release workflow builds and ships both ABIs. Pinch, the share sheet, location, biometrics, real dictation and playback on hardware decoders are still checked by hand on a phone (Galaxy S23, Android 15)."],
  ];
</script>

<DocsShell name="Android">
<article class="doc">
  <nav class="doc-crumbs" aria-label="Breadcrumb">
    <a href="/docs">Docs</a><span>/</span><span>Android</span>
  </nav>

  <header class="doc-head">
    <span class="eyebrow">Guide · v{version}</span>
    <h1>Android</h1>
    <p class="doc-lead">The same TSX (or Go) app builds into an APK or an App Bundle. The npm package ships the Android runtimes, so <code>tarve build --target android</code> works from Windows or Linux without Rust or the NDK. You develop on the desktop and build for the phone.</p>
  </header>

  <section class="doc-section">
    <h2 id="build">Build and install</h2>
    <CodeBlock code={build} lang="sh" file="terminal" />
    <div class="doc-prose"><p>You need the Android SDK (build-tools and a platform, from <code>ANDROID_HOME</code>) and a JDK; Go apps also need the NDK. APKs are signed with the debug keystore unless <code>--keystore</code> or <code>TARVE_ANDROID_KEYSTORE</code> names one; Google Play rejects the debug key. Without a phone, <code>bun run android:emulator</code> in the repository starts a headless Android 15 emulator in Docker. Signing, App Bundles and the other build options are in <a href="/docs/shipping#android">Build and package</a>.</p></div>
  </section>

  <section class="doc-section">
    <h2 id="support">What works</h2>
    <div class="props-wrap">
      <table class="props">
        <thead><tr><th>Area</th><th>On Android</th></tr></thead>
        <tbody>
          {#each status as row, i (i)}
            <tr>{#each row as cell, j (j)}<td>{@html cell}</td>{/each}</tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>

  <section class="doc-section">
    <h2 id="permissions">Permissions and network</h2>
    <div class="doc-prose"><p>Every APK declares <code>INTERNET</code>, the media playback foreground service, <code>POST_NOTIFICATIONS</code> and <code>WAKE_LOCK</code>. Add your own in <code>package.json</code> (a name without a dot is an <code>android.permission.</code> one) or with <code>--permission</code>. Android blocks plain <code>http://</code>, media included; <code>cleartextTraffic</code> allows it (a media server on the LAN).</p></div>
    <CodeBlock code={config} file="package.json" />
    <div class="doc-prose"><p>Dangerous permissions also need consent at run time. On Windows and Linux both calls answer <code>"granted"</code>, so the same code runs everywhere.</p></div>
    <CodeBlock code={perms} file="app.tsx" />
  </section>

  <section class="doc-section">
    <h2 id="differences">Differences from the desktop</h2>
    <div class="props-wrap">
      <table class="props">
        <thead><tr><th>Topic</th><th>Details</th></tr></thead>
        <tbody>
          {#each differences as row, i (i)}
            <tr>{#each row as cell, j (j)}<td>{@html cell}</td>{/each}</tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>
</article>
</DocsShell>
