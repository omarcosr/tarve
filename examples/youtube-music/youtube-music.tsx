// A YouTube Music client in Tarve: home feed, search, albums, playlists and
// artists, a play queue, and your library after signing in with Google (a
// browser window, or pasted cookies), and synced lyrics on the now-playing page.
// The YouTube side lives in this example (youtube-music-source.ts: a small
// InnerTube client that also finds each song's audio URL; lyrics from LRCLIB
// in youtube-music-lyrics.ts); Tarve renders the UI and streams the URL with <audio>.
// Personal-use demo: YouTube's Terms of Service forbid third-party clients.

import { createApp } from "@tarve/core";
import { connect } from "./youtube-music-actions";
import { YouTubeMusicView } from "./youtube-music-view";

// Name, icon and app id (media controls, taskbar) come from examples/package.json "tarve".
const app = createApp(() => <YouTubeMusicView />, { closeBehavior: "hide", textRendering: "cleartype" });
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
