// A Spotify-style music player built on <audio>: library, search, liked songs,
// shuffle/repeat, seek and volume. Ships with synthesized demo songs; "+" adds
// your own MP3/WAV/FLAC/Ogg/M4A files.
import { createApp } from "@tarve/core";
import { demoTracks, fileTrack } from "./player-tracks";
import { AUDIO_ID, PlayerView, state } from "./player-view";

state.tracks = demoTracks();
const app = createApp(() => <PlayerView />);
state.media = () => app.media(AUDIO_ID);
state.addFiles = () => {
  void app.openFilesDialog({ filters: [{ name: "Audio", extensions: ["mp3", "wav", "flac", "ogg", "m4a", "mp4"] }] }).then(paths => {
    if (!paths.length) return;
    const start = state.tracks.length;
    state.tracks.push(...paths.map((path, offset) => fileTrack(path, start + offset)));
    app.update();
  });
};
// Space toggles playback, arrows skip, like a desktop music app.
app.registerHotkey("Space", () => { if (!state.autoPlay) return; if (state.playing) app.media(AUDIO_ID).pause(); else app.media(AUDIO_ID).play(); });
await app.closed;
