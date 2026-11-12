<script lang="ts">
  const repo = "https://github.com/omarcosr/tarve";
  const tree = `${repo}/tree/main/examples`;

  type Shot = { src: string; alt: string };
  type App = {
    name: string;
    kind: string;
    body: string;
    tags: string[];
    shots: Shot[];
    links: { label: string; href: string }[];
    run?: string;
  };

  // Every picture is a frame Tarve rendered itself (app.capture), not a mock-up.
  const apps: App[] = [
    {
      name: "Termio",
      kind: "SSH terminal",
      body:
        "An SSH client for slow and distant links: hosts and jump hosts, split panes, SFTP, port forwarding, an encrypted keychain and sync. Ships for Windows, Linux and Android from one TSX code base.",
      tags: ["Terminal grid", "Split panes", "Secure storage", "Android"],
      shots: [
        { src: "/showcase/termio.webp", alt: "Termio host list with a sidebar of hosts, snippets, keychain and forwarding" },
        { src: "/showcase/termio-split.webp", alt: "Termio with two PowerShell sessions side by side" },
      ],
      links: [{ label: "Source", href: "https://github.com/omarcosr/Termio" }],
    },
    {
      name: "YouTube Music",
      kind: "Music player",
      body:
        "Home feed, search, albums, playlists, a play queue, synced lyrics and Google sign-in. Streams audio with <audio>, answers the media keys and keeps playing from the tray. Also written in Go against the same runtime.",
      tags: ["<audio>", "Media keys", "Tray", "Go port"],
      shots: [{ src: "/showcase/youtube-music.webp", alt: "YouTube Music client showing Quick picks and an Autumn shelf of album covers" }],
      links: [
        { label: "Download", href: `${repo}/releases/latest` },
        { label: "TSX source", href: `${tree}/youtube-music` },
        { label: "Go source", href: `${repo}/tree/main/go/examples/youtube-music` },
      ],
      run: "bun run youtube-music",
    },
  ];
</script>

<main class="home showcase">
  <section class="hero showcase-hero">
    <span class="eyebrow">Showcase</span>
    <h1>Built with Tarve</h1>
    <p class="lead">
      Apps people actually use, not component demos. Every screenshot below is a frame Tarve painted itself: no browser,
      no web view, one executable per target.
    </p>
  </section>

  {#each apps as app, i (app.name)}
    <section class="sheet showcase-app" class:wide={app.shots.length > 1}>
      <header class="sheet-head">
        <span class="sec">{String(i + 1).padStart(2, "0")}</span>
        <div>
          <span class="eyebrow">{app.kind}</span>
          <h2>{app.name}</h2>
        </div>
        <p>{app.body}</p>
        <ul class="showcase-tags" aria-label="Uses">
          {#each app.tags as tag (tag)}<li>{tag}</li>{/each}
        </ul>
        <div class="cta showcase-links">
          {#each app.links as link, j (link.href)}
            <a class={j === 0 ? "btn btn-primary" : "btn btn-ghost"} href={link.href}>{link.label}</a>
          {/each}
          {#if app.run}<code class="showcase-run">{app.run}</code>{/if}
        </div>
      </header>
      <div class="showcase-shots">
        {#each app.shots as shot (shot.src)}
          <figure>
            <img src={shot.src} alt={shot.alt} loading={i === 0 ? "eager" : "lazy"} decoding="async" />
          </figure>
        {/each}
      </div>
    </section>
  {/each}

  <section class="sheet showcase-submit">
    <header class="sheet-head">
      <span class="sec">+</span>
      <h2>Yours next</h2>
      <p>
        Built something useful with Tarve? Open an issue with a link and a screenshot and it can go on this page.
      </p>
      <div class="cta showcase-links">
        <a class="btn btn-primary" href="{repo}/issues/new?title=Showcase:%20">Submit an app</a>
      </div>
    </header>
  </section>
</main>
