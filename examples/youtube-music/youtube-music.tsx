// A YouTube Music client in Tarve: home feed, search, albums, playlists and
// artists, a play queue, and your library after signing in with Google (a
// browser window, or pasted cookies). The YouTube side lives in this example
// (youtube-music-source.ts: a small InnerTube client, plus yt-dlp for audio);
// Tarve itself only renders the UI and plays the downloaded M4A with <audio>.
// Personal-use demo: YouTube's Terms of Service forbid third-party clients.

import { createApp } from "@tarve/core";
import { connect } from "./youtube-music-actions";
import { YouTubeMusicView } from "./youtube-music-view";

const app = createApp(() => <YouTubeMusicView />, {
  closeBehavior: "hide",
  // Names the app in Windows' media controls instead of "Unknown app" / bun.exe.
  appIdentity: { id: "Tarve.Examples.YouTubeMusic", name: "YouTube Music (Tarve)" },
});
connect(app);
await app.ready;
app.tray({
  tooltip: "YouTube Music",
  onDoubleClick: () => app.show(),
  menu: [
    { id: "show", label: "Open", onSelect: () => app.show() },
    { type: "separator" },
    { id: "quit", label: "Quit", onSelect: () => app.close() },
  ],
});
await app.closed;
