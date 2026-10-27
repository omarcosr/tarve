<script lang="ts">
  import CodeBlock from "../../lib/CodeBlock.svelte";
  import DocsShell from "../../lib/DocsShell.svelte";

  let { version }: { version: string } = $props();

  const keygen = `bunx tarve keygen
# private key: ./tarve-update.key (keep it secret and out of git)
# public key:  wVZvRojxPspr35X0YYJ0QRePrwDLUEWhY9pS1Ou7iVQ=`;

  const build = `# the version is baked into the executable; checkForUpdate compares against it
bunx tarve build app.tsx --version 1.2.0 --outfile dist/win/App.exe
bunx tarve build app.tsx --version 1.2.0 --target linux-x64 --outfile dist/linux/App`;

  const release = `bunx tarve release --version 1.2.0 \\
  --artifact win32-x64=dist/win/App.exe \\
  --artifact linux-x64=dist/linux/App \\
  --public-key wVZvRojxPspr35X0YYJ0QRePrwDLUEWhY9pS1Ou7iVQ= \\
  --notes "Faster startup" \\
  --out dist/updates
# dist/updates/latest.json
# dist/updates/App-1.2.0-win32-x64.exe
# dist/updates/App-1.2.0-linux-x64`;

  const sign = `# signtool (Windows SDK), any certificate in the store or a .pfx
bunx tarve release --version 1.2.0 --artifact win32-x64=dist/win/App.exe \\
  --sign "signtool sign /fd sha256 /tr http://timestamp.digicert.com /td sha256 /a {file}"

# osslsigncode from Linux or CI
export TARVE_SIGN_COMMAND='osslsigncode sign -pkcs12 cert.pfx -pass "$PFX_PASS" -h sha256 -t http://timestamp.digicert.com -in {file} -out {file}.signed && mv {file}.signed {file}'
bunx tarve release --version 1.2.0 --artifact win32-x64=dist/win/App.exe`;

  const manifest = `{
  "payload": "{\\"name\\":\\"App\\",\\"version\\":\\"1.2.0\\",\\"pubDate\\":\\"2026-10-15T12:00:00.000Z\\",\\"platforms\\":{\\"win32-x64\\":{\\"url\\":\\"App-1.2.0-win32-x64.exe\\",\\"sha256\\":\\"9f2c…\\",\\"size\\":118712320}}}",
  "signature": "Base64 Ed25519 signature of payload"
}`;

  const app = `import { canInstallUpdate, checkForUpdate, downloadUpdate, installUpdate } from "@tarve/core";

const UPDATES = {
  url: "https://example.com/my-app/latest.json",
  publicKey: "wVZvRojxPspr35X0YYJ0QRePrwDLUEWhY9pS1Ou7iVQ=",
};

export async function updateIfAvailable(onProgress: (percent: number) => void) {
  const update = await checkForUpdate(UPDATES);
  if (!update) return; // up to date, or no build for this platform
  if (!canInstallUpdate()) {
    // installed by a package manager or in a read-only folder: point the user to a download instead
    return;
  }
  const file = await downloadUpdate(update, {
    onProgress: (received, total) => onProgress(Math.round((received / total) * 100)),
  });
  installUpdate(file); // swaps the executable, starts the new version and exits
}`;

  const packs = `# once: an executable that also runs app packs (keeps the private key out of it: only a derived key goes in)
bunx tarve build app.tsx --version 1.2.0 --packs --outfile dist/win/App.exe

# each release: the app's code and files, signed and encrypted (a few hundred KB)
bunx tarve pack app.tsx --version 1.2.1
bunx tarve release --version 1.2.1 \\
  --pack dist/App-1.2.1-win32-x64-bun.tarve \\
  --artifact win32-x64=dist/win/App.exe
# executables built with --packs download the pack; older ones, and any that cannot run it, get the executable`;

  const api = [
    ["checkForUpdate(options)", "Fetches latest.json, checks its signature and fields, and resolves the newer Update for this platform or null. update.kind is \"pack\" when this executable can run the release's app pack, else \"executable\". Options: url, publicKey, currentVersion, platform, name, allowInsecure, fetch, signal."],
    ["downloadUpdate(update, options?)", "Streams the artifact next to the executable and checks its size, SHA-256 and executable format. Options: onProgress, path, allowInsecure, fetch, signal."],
    ["installUpdate(file, options?)", "Replaces the executable (or installs the app pack in its per-user folder) and, by default, starts the new version with the same arguments and exits. Options: executable, restart, args."],
    ["canInstallUpdate(update?)", "Whether this process can install the update: an app pack whenever the executable runs packs, an executable when it is a built app in a writable folder."],
    ["cleanupUpdate(executable?)", "Removes the previous executable left behind on Windows; checkForUpdate already calls it."],
    ["compareVersions(a, b)", "Semver ordering: 1.10.0 > 1.2.0, 1.0.0 > 1.0.0-rc.1, build metadata ignored."],
    ["verifyUpdateManifest(signed, publicKey)", "The signature and field checks of checkForUpdate, for custom transports."],
  ];

  const flags = [
    ["--version 1.2.0", "Required. The release version; it must be newer than the installed one."],
    ["--artifact platform=path", "Repeatable. platform is os-arch as in process.platform/process.arch: win32-x64, linux-x64."],
    ["--key path | base64", "Private key. Defaults to TARVE_UPDATE_PRIVATE_KEY, then ./tarve-update.key."],
    ["--public-key base64", "The key your app ships with. The release fails when the private key does not belong to it."],
    ["--pack path", "Repeatable. An app pack from tarve pack; it is listed under the platform and runtime it was built for."],
    ["--sign command", "Authenticode command run on each Windows artifact before hashing; {file} is the quoted path. Defaults to TARVE_SIGN_COMMAND."],
    ["--base-url https://…/", "Absolute prefix for artifact URLs, for a CDN. Without it, URLs are relative to latest.json."],
    ["--name App", "Recorded in the manifest; apps built under another name reject it."],
    ["--notes text", "Release notes, returned as update.notes."],
    ["--out dist/updates", "Output folder for latest.json and the renamed artifacts."],
  ];

  const checks = [
    ["Manifest", "Ed25519 signature over the exact payload; version, date, platform names, URLs, 64-hex SHA-256 and positive integer sizes; at most 1 MiB."],
    ["Transport", "HTTPS only, for both latest.json and the artifacts. Plain HTTP is accepted for localhost, or everywhere with allowInsecure."],
    ["Identity", "A manifest whose name differs from the app's name is rejected, so one key can sign several apps safely."],
    ["Version", "Only strictly newer versions are offered: no downgrades, no reinstalling the same build."],
    ["Download", "Content-Length and byte count must equal the signed size, the SHA-256 must match, and the file must start like a Windows (MZ) or Linux (ELF) executable. A failed download is deleted."],
    ["App pack", "On every launch: the Ed25519 signature over its header, the SHA-256 of each file it reads, AES-256-GCM, its name, version (newer than the embedded app), runtime, platform, Tarve native ABI, plugin libraries and native features. A pack that fails is skipped; one that throws or crashes while starting is marked bad and the previous pack, or the embedded app, runs instead."],
    ["Install", "Refuses to overwrite bun, node or txiki themselves, missing or non-executable files, and executables in read-only folders. On Windows the old executable is restored if the swap fails."],
    ["Release", "Version format, platform names, duplicate platforms, missing, empty or wrong-format artifacts, HTTP base URLs, a key that does not match --public-key, and a --sign command that fails, leaves the file unchanged or corrupts it."],
  ];
</script>

<DocsShell name="Updates">
<article class="doc">
  <nav class="doc-crumbs" aria-label="Breadcrumb">
    <a href="/docs">Docs</a><span>/</span><span>Auto-updates</span>
  </nav>

  <header class="doc-head">
    <span class="eyebrow">Guide · v{version}</span>
    <h1>Auto-updates</h1>
    <p class="doc-lead">
      Publish signed releases from any static host and let a built app download and install them itself: one key pair,
      one <code>tarve release</code> command and three calls in your app.
    </p>
  </header>

  <section class="doc-section">
    <h2 id="how-it-works">How it works</h2>
    <div class="doc-prose">
      <p>
        <code>tarve release</code> copies your built executables to an output folder and writes <code>latest.json</code>: the
        version, notes and, for each platform, the file URL, size and SHA-256, signed with your Ed25519 private key. Upload the
        folder anywhere that serves files over HTTPS: GitHub Releases, S3 or R2, a CDN or your own server.
      </p>
      <p>
        The app embeds the public key. <code>checkForUpdate</code> downloads <code>latest.json</code>, rejects it unless the
        signature matches, and compares the version with the one baked in by <code>tarve build</code>. The download is checked
        against the signed size and hash, so a compromised host or CDN cannot ship a different binary.
      </p>
    </div>
  </section>

  <section class="doc-section">
    <h2 id="setup">Set up</h2>
    <ol class="doc-steps">
      <li>
        <h3>Create a signing key</h3>
        <p>
          Once per app. Store the private key in your CI secrets (as <code>TARVE_UPDATE_PRIVATE_KEY</code>) and never commit it.
          If you lose it, installed copies can no longer be updated.
        </p>
        <CodeBlock code={keygen} lang="sh" file="terminal" />
      </li>
      <li>
        <h3>Build with a version</h3>
        <p>
          <code>--version</code>, or the <code>version</code> of a <code>package.json</code> with a <code>"tarve"</code> field.
        </p>
        <CodeBlock code={build} lang="sh" file="terminal" />
      </li>
      <li>
        <h3>Release</h3>
        <CodeBlock code={release} lang="sh" file="terminal" />
      </li>
      <li>
        <h3>Upload</h3>
        <p>
          Upload the contents of <code>dist/updates</code> and keep <code>latest.json</code> at a stable URL. Upload the
          executables first and <code>latest.json</code> last, so no client sees a manifest whose files are not there yet.
        </p>
      </li>
      <li>
        <h3>Check from the app</h3>
        <CodeBlock code={app} file="updates.ts" />
      </li>
    </ol>
  </section>

  <section class="doc-section">
    <h2 id="packs">App packs: updates without the runtime</h2>
    <div class="doc-prose">
      <p>
        A built executable is mostly runtime: Bun, Node.js or txiki.js and the native library, about 100 MB. Between two
        releases only your code and files change. An executable built with <code>--packs</code> also runs
        <strong>app packs</strong>: <code>.tarve</code> files, like Electron's <code>app.asar</code>, holding the app's bundled
        code and files. A release then downloads a few hundred kilobytes instead of the whole executable.
      </p>
      <p>
        Unlike asar, a pack is signed with your update key (Ed25519 over a header that lists the SHA-256 of every file),
        compressed and encrypted (AES-256-GCM, with a key derived from your private key). The executable verifies it on every
        launch and decrypts the code in memory: it never reaches the disk in clear. Encryption keeps the code out of reach of
        anyone who downloads the pack; the key is inside the executable, so it slows down, but cannot stop, someone who takes
        that apart.
      </p>
      <p>
        A pack runs only in executables of the same Tarve version, runtime and platform that provide its native features and
        plugin libraries. When a release changes any of those, ship the executable as well: <code>checkForUpdate</code> picks
        the executable for clients that cannot run the pack. Build the pack with the same name, app id and icon as the
        executable (the <code>"tarve"</code> field of <code>package.json</code> keeps them in one place).
      </p>
    </div>
    <CodeBlock code={packs} lang="sh" file="terminal" />
  </section>

  <section class="doc-section">
    <h2 id="authenticode">Windows code signing</h2>
    <div class="doc-prose">
      <p>
        The update signature only protects the updater. Windows has its own trust: without an Authenticode signature,
        SmartScreen warns on first launch and antivirus software is more suspicious. <code>--sign</code> runs your signing tool
        on each Windows executable before it is hashed, so <code>latest.json</code> describes the signed file. The executable
        in your build folder is not modified. Linux artifacts are skipped.
      </p>
      <p>
        Any tool works: <code>signtool</code>, Azure Trusted Signing, <code>osslsigncode</code>. Tarve fails the release if
        the command exits with an error, leaves the file unchanged or turns it into something that is no longer an
        executable. Certificates come from a certificate authority (OV or EV) or from Azure Trusted Signing. SmartScreen
        reputation builds up over downloads, even with EV.
      </p>
    </div>
    <CodeBlock code={sign} lang="sh" file="terminal" />
  </section>

  <section class="doc-section">
    <h2 id="manifest">latest.json</h2>
    <p class="doc-muted">The payload is signed as it is, byte for byte. Never edit it by hand: run <code>tarve release</code> again.</p>
    <CodeBlock code={manifest} file="latest.json" />
  </section>

  <section class="doc-section">
    <h2 id="checks">What is validated</h2>
    <div class="props-wrap">
      <table class="props">
        <thead><tr><th>Stage</th><th>Checks</th></tr></thead>
        <tbody>
          {#each checks as [stage, text] (stage)}
            <tr><td><code class="prop-name">{stage}</code></td><td>{text}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>

  <section class="doc-section">
    <h2 id="where">Where self-updating works</h2>
    <div class="doc-prose">
      <p>
        An app can only replace itself when it may write to its own folder: a per-user location such as
        <code>%LOCALAPPDATA%\Programs</code> or <code>~/.local/bin</code>, or a portable folder. Under <code>Program Files</code>,
        <code>/usr/bin</code> or a package manager, <code>canInstallUpdate()</code> returns false and the update should go through
        that installer instead. <code>tarve run</code> and <code>tarve dev</code> never self-update: there the executable is Bun
        or Node itself.
      </p>
      <p>
        On Windows the running executable is renamed to <code>App.exe.old</code>, the new one takes its place and the next
        update check deletes the old file. App packs install in a per-user folder, so they work under <code>Program Files</code> too.
      </p>
    </div>
  </section>

  <section class="doc-section">
    <h2 id="cli">tarve release options</h2>
    <div class="props-wrap">
      <table class="props">
        <thead><tr><th>Option</th><th>Meaning</th></tr></thead>
        <tbody>
          {#each flags as [flag, text] (flag)}
            <tr><td><code class="prop-name">{flag}</code></td><td>{text}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>

  <section class="doc-section">
    <h2 id="api">API</h2>
    <p class="doc-muted">Exported by <code>@tarve/core</code>.</p>
    <div class="props-wrap">
      <table class="props">
        <thead><tr><th>Function</th><th>Description</th></tr></thead>
        <tbody>
          {#each api as [fn, text] (fn)}
            <tr><td><code class="prop-name">{fn}</code></td><td>{text}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>
</article>
</DocsShell>
