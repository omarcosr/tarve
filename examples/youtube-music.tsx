// A YouTube Music client in Tarve: home feed, search, albums, playlists and
// artists, a play queue, and your library after signing in with Google (a
// browser window, or pasted cookies). The YouTube side lives in this example
// (youtube-music-source.ts: a small InnerTube client, plus yt-dlp for audio);
// Tarve itself only renders the UI and plays the downloaded M4A with <audio>.
// Personal-use demo: YouTube's Terms of Service forbid third-party clients.
import { createApp } from "@tarve/core";
import { connect } from "./youtube-music-actions";
import { YouTubeMusicView } from "./youtube-music-view";

const app = createApp(() => <YouTubeMusicView />);
connect(app);
await app.closed;
