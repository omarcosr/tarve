<script lang="ts">
  import CodeBlock from "../../lib/CodeBlock.svelte";
  import DocsShell from "../../lib/DocsShell.svelte";

  let { version }: { version: string } = $props();

  const c0 = "import { Window, createApp } from \"@tarve/core\";\n\nlet size = \"\";\n\nconst app = createApp(() => (\n  <Window title=\"Player\" width={1100} height={720}>\n    <video id=\"film\" src=\"https://example.com/film.mp4\" autoPlay muted loop controls fit=\"cover\"\n      style={{ width: \"100%\", height: \"100%\", radius: 18, background: \"#000\" }}\n      onLoadedMetadata={info => { size = `${info.videoWidth}×${info.videoHeight}`; }} />\n  </Window>\n));";
  const t1: string[][] = [["Windows, D3D11","Media Foundation decodes on the GPU into textures the renderer samples directly: no conversion pass, no copy. In a visible window the video gets its own composition layer, so new pictures repaint no UI."],["Windows, CPU / wgpu","Media Foundation's Media Engine scales and converts each picture on the GPU at the size it is shown."],["Linux","GStreamer (<code>playbin</code>, loaded at run time; install the codecs you need)."],["Android","The platform MediaPlayer with hardware decoders."],["macOS","Not yet: a <code>&lt;video></code> reports an <code>error</code> event and lays out as an empty box."]];
  const c2 = "<audio id=\"song\" src={track.url} autoPlay volume={0.8} muted={muted} loop={repeat}\n  onPlay={() => { playing = true; }}\n  onPause={() => { playing = false; }}\n  onTimeUpdate={info => { time = info.currentTime; }}\n  onEnded={next}\n  onError={message => showError(message)} />";
  const c3 = "// embedded in the executable by tarve build, extracted once on first launch\nimport film from \"./film.mp4\" with { type: \"file\" };\n\n<video src={film} controls />";
  const t4: string[][] = [["<code>src</code>","The file or stream. Changing it loads the new one."],["<code>autoPlay</code>, <code>loop</code>, <code>muted</code>","As in HTML."],["<code>volume</code>","0–1."],["<code>controls</code>","Renders the default control bar."],["<code>fit</code>","<code>&lt;video></code> only: <code>contain</code>, <code>cover</code>, <code>fill</code>, <code>none</code>."],["<code>onLoadedMetadata</code>, <code>onPlay</code>, <code>onPause</code>, <code>onTimeUpdate</code>, <code>onSeeked</code>, <code>onEnded</code>","Receive <code>{ currentTime, duration, paused, videoWidth, videoHeight }</code>. <code>timeupdate</code> fires every 250 ms while playing."],["<code>playbackRate</code>","0.0625–16 (1 by default): faster or slower at the same pitch. A new <code>src</code> starts at the prop's rate."],["<code>onError(message, { code })</code>","The file could not open, decode or keep streaming. <code>code</code> is <code>network</code> (HTTP status, host, timeout), <code>format</code> (a format or codec the system does not play), <code>decode</code> or <code>aborted</code>: skip to another source at once on <code>network</code>/<code>format</code>."],["<code>onWaiting</code>, <code>onCanPlay</code>, <code>onProgress</code>","Buffering: playback stopped for want of data, can play again, the download moved on. The default controls show their spinner while waiting."],["<code>onAudioTracksChange</code>, <code>onTextTracksChange</code>, <code>onCueChange</code>","The file's audio streams, its subtitle streams, and the embedded subtitle shown now."],["<code>subtitles</code>, <code>subtitle</code>, <code>subtitleStyle</code>","<code>&lt;video></code> only: external WebVTT/SRT files and the index shown (<code>null</code>: none), drawn over the picture."]];
  const t7: string[][] = [["<code>currentTime</code>, <code>duration</code>, <code>paused</code>","Seconds; <code>duration</code> is <code>null</code> until known."],["<code>videoWidth</code>, <code>videoHeight</code>","The picture's own size."],["<code>buffered</code>","End (s) of the downloaded range holding the current time: a buffer bar's end."],["<code>waiting</code>","Out of data while playing (between <code>onWaiting</code> and <code>onCanPlay</code>)."],["<code>filename</code>","The served file's name after redirects (as mpv's), from <code>loadedmetadata</code>."],["<code>audioTracks</code>, <code>textTracks</code>","<code>{ id, label, language, enabled }[]</code>: the streams inside the file."],["<code>cueText</code>","The embedded subtitle shown now; empty when none."]];
  const c8 = "let audio: MediaAudioTrack[] = [], texts: MediaTextTrack[] = [];\n\n<video id=\"film\" src={episode.url} controls playbackRate={speed}\n  subtitles={[{ src: \"pt-BR.vtt\", label: \"Português\" }]} subtitle={showExternal ? 0 : null}\n  onAudioTracksChange={info => { audio = info.audioTracks; app.update(); }}\n  onTextTracksChange={info => { texts = info.textTracks; app.update(); }}\n  onError={(message, { code }) => { if (code === \"network\" || code === \"format\") nextSource(); }} />\n\n// a menu item\napp.media(\"film\").setAudioTrack(audio[1].id);\napp.media(\"film\").setTextTrack(texts[0].id);   // null: none\napp.media(\"film\").setPlaybackRate(1.5);";
  const c5 = "const player = app.media(\"song\");\nplayer.play();\nplayer.pause();\nplayer.seek(42);        // seconds\nplayer.setVolume(0.5);\nplayer.setMuted(true);\nplayer.setPlaybackRate(1.25); // same pitch\nplayer.setAudioTrack(id);    // from info.audioTracks\nplayer.setTextTrack(id);     // from info.textTracks; null hides";
  const c6 = "app.systemMedia({\n  title: song.title, artist: song.artist, album: song.album, artwork: song.cover,\n  playing, duration, position: time, canSeek: true, canNext: true, canPrevious: true,\n  onAction: (action, time) => {\n    if (action === \"play\") app.media(\"song\").play();\n    else if (action === \"pause\") app.media(\"song\").pause();\n    else if (action === \"next\") next();\n    else if (action === \"previous\") previous();\n    else if (time !== undefined) app.media(\"song\").seek(time);\n  },\n});";
</script>

<DocsShell name="Media">
<article class="doc">
  <nav class="doc-crumbs" aria-label="Breadcrumb">
    <a href="/docs">Docs</a><span>/</span><span>Audio and video</span>
  </nav>

  <header class="doc-head">
    <span class="eyebrow">Guide · v{version}</span>
    <h1>Audio and video</h1>
    <p class="doc-lead"><code>&lt;audio></code> and <code>&lt;video></code> behave like HTMLMediaElements, but the native runtime plays them: the platform decoder for pictures, a native mixer for sound, no browser underneath.</p>
  </header>

  <section class="doc-section">
    <h2 id="video">Video</h2>
    <CodeBlock code={c0} file="player.tsx" />
    <div class="doc-prose"><p>The picture fills the element's box like an image; <code>fit</code> is CSS <code>object-fit</code> (<code>contain</code> by default, <code>cover</code>, <code>fill</code>, <code>none</code>). UI placed over the video with <code>position: "absolute"</code> is drawn on top of it. With <code>controls</code> the element renders a default control bar (play/pause, time, seek bar, mute); without it, an <code>&lt;audio></code> renders nothing, as in a browser.</p></div>
    <div class="props-wrap">
      <table class="props">
        <thead><tr><th>Platform</th><th>Decoder</th></tr></thead>
        <tbody>
          {#each t1 as row, i (i)}
            <tr>{#each row as cell, j (j)}<td>{@html cell}</td>{/each}</tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>

  <section class="doc-section">
    <h2 id="audio">Audio</h2>
    <div class="doc-prose"><p><code>&lt;audio></code> (and the sound of a <code>&lt;video></code> on the D3D11 path) is decoded by Symphonia and mixed into the default output (WASAPI on Windows, ALSA on Linux). When the output device goes away or the default changes, playback continues from the same sample on the new device. Seeks never block the window.</p></div>
    <CodeBlock code={c2} file="music.tsx" />
  </section>

  <section class="doc-section">
    <h2 id="sources">Sources</h2>
    <div class="doc-prose"><p><code>src</code> takes a relative or absolute path, a <code>file://</code> URL, a <code>data:</code> URL or an <code>http(s)://</code> URL. Remote files stream like a browser's: playback starts with the first chunk and the rest downloads behind it with HTTP range requests (one connection, 4 MB ranges, retries with backoff on 403, 429, 5xx and network errors). A stream whose network stalls for 30 s reports an error instead of ending as if it were over, so the app can reload it.</p></div>
    <CodeBlock code={c3} file="app.tsx" />
    <div class="doc-prose"><p><code>tarve build</code> only compiles the media subsystem when the app uses <code>&lt;audio></code> or <code>&lt;video></code>.</p></div>
  </section>

  <section class="doc-section">
    <h2 id="api">Props, events and control</h2>
    <div class="props-wrap">
      <table class="props">
        <thead><tr><th>Prop</th><th>Meaning</th></tr></thead>
        <tbody>
          {#each t4 as row, i (i)}
            <tr>{#each row as cell, j (j)}<td>{@html cell}</td>{/each}</tr>
          {/each}
        </tbody>
      </table>
    </div>
    <div class="doc-prose"><p>Every event handler receives a <code>MediaEventInfo</code>:</p></div>
    <div class="props-wrap">
      <table class="props">
        <thead><tr><th>Field</th><th>Meaning</th></tr></thead>
        <tbody>
          {#each t7 as row, i (i)}
            <tr>{#each row as cell, j (j)}<td>{@html cell}</td>{/each}</tr>
          {/each}
        </tbody>
      </table>
    </div>
    <div class="doc-prose"><p>Give the element an <code>id</code> and drive it imperatively with <code>app.media(id)</code>:</p></div>
    <CodeBlock code={c5} file="app.tsx" />
  </section>

  <section class="doc-section">
    <h2 id="tracks">Speed, tracks and subtitles</h2>
    <CodeBlock code={c8} file="player.tsx" />
    <div class="doc-prose">
      <p><strong>Playback rate</strong> keeps the pitch everywhere: a WSOLA time stretch for <code>&lt;audio></code> and the D3D11 video path, the Media Engine's rate on the other Windows path, a rate seek on GStreamer (scaletempo) and <code>PlaybackParams</code> on Android.</p>
      <p><strong>Audio tracks</strong> are the file's audio streams (MKV, MP4). Switching keeps the position. Labels and languages come from the file; on Linux an unnamed stream is "Audio 1", "Audio 2"…</p>
      <p><strong>Subtitles</strong> come two ways. <code>subtitles</code> loads external WebVTT or SubRip files (path or URL); the cue under the current time is drawn over the picture, on time between <code>timeupdate</code>s. Text streams inside the file are listed in <code>textTracks</code>: on Windows they are read from the container (Matroska <code>S_TEXT</code> SRT/ASS/WebVTT for local files, MP4 <code>tx3g</code>/<code>wvtt</code> local or remote), on Android from MediaPlayer's timed text, and their cues reach <code>cueText</code> and the overlay; GStreamer draws the chosen stream into the picture itself. Picture subtitles (PGS, VobSub) are not shown.</p>
      <p><strong>Plain <code>http://</code> on Android</strong> is blocked unless the app sets <code>tarve.android.cleartextTraffic: true</code> in package.json (see <a href="/docs/platform#permissions">Platform</a>); <code>https://</code> always works.</p>
      <p><strong>Buffering</strong>: a stalled download reports <code>waiting</code> and then <code>canplay</code>. An <code>&lt;audio></code> plays silence meanwhile instead of blocking the mix, and its clock stops. <code>buffered</code> follows the app's own download for remote files, GStreamer's buffering query and MediaPlayer's buffering percentage.</p>
    </div>
  </section>

  <section class="doc-section">
    <h2 id="system">Media keys and background playback</h2>
    <div class="doc-prose"><p><code>app.systemMedia</code> shows the current track in the system media controls and forwards play, pause, next, previous and seek, hardware media keys included. Pass <code>null</code> to clear it. <code>appIdentity: &#123; id, name, icon? &#125;</code> in <code>createApp</code> names the app there instead of the host executable.</p></div>
    <CodeBlock code={c6} file="music.tsx" />
    <div class="doc-prose"><p>Windows shows it in the media flyout and on the lock screen. On Android, while media plays the app keeps running in the background as a foreground service with a media notification, lock-screen and headset controls; <code>systemMedia</code> adds the title, artwork and next/previous. The repository's <code>examples/video</code>, <code>examples/player</code> and <code>examples/youtube-music</code> are complete players.</p></div>
  </section>
</article>
</DocsShell>
