// The phone layout of the youtube-music example (a phone, or any window narrower than 640 px):
// a bottom navigation bar instead of the sidebar, and a two-row player without the desktop's
// volume and queue.
import { Column, Pressable, Row, Slider, Text, viewport } from "@tarve/core";
import { Art, c, clock, ellipsis, Glyph, IconButton, icons, state, togglePlaying } from "./youtube-music-view";

/** Android: sign-in in the system WebView, no tray. */
export const phone = typeof process !== "undefined" && (process.platform as string) === "android";

/** A phone-sized window (narrow, or a phone on its side): the bottom navigation replaces the sidebar. Reading it re-renders on resize. */
export function compact(): boolean {
  const { width, height, pointer } = viewport();
  return width < 640 || (pointer === "coarse" && height < 640);
}

function Tab({ id, d, label, active, onClick }: { id: string; d: string; label: string; active: boolean; onClick: () => void }) {
  return (
    <Pressable id={id} onClick={onClick} control={{ role: "tab", label, selected: active }}
      style={{ flex: 1, height: "100%", direction: "column", align: "center", justify: "center", gap: 4 }}>
      <Glyph d={d} size={20} color={active ? c.text : c.muted} />
      <Text size={11} weight={active ? 600 : 400} color={active ? c.text : c.muted}>{label}</Text>
    </Pressable>
  );
}

export function MobileNav() {
  const kind = state.page.kind;
  return (
    <Row style={{ height: 60, shrink: 0, background: c.panel }}>
      <Tab id="tab-home" d={icons.home} label="Home" active={kind === "home"} onClick={() => state.open({ kind: "home" })} />
      <Tab id="tab-search" d={icons.search} label="Search" active={kind === "search"} onClick={() => state.open({ kind: "search", query: state.query })} />
      <Tab id="tab-library" d={icons.library} label="Library" active={kind === "library"} onClick={() => state.open({ kind: "library" })} />
    </Row>
  );
}

export function MobilePlayerBar() {
  const song = state.queue[state.index];
  if (!song) return null;
  const duration = state.duration || song.duration || 0;
  const ready = !!state.path && state.loading === null;
  const status = state.playError ?? (state.loading !== null || (state.path && !state.playing && state.time === 0) ? "Loading…" : null);
  return (
    <Pressable id="player-bar" onClick={togglePlaying} control={{ role: "button", label: state.page.kind === "playing" ? "Close now playing" : "Open now playing" }}
      style={{ direction: "column", shrink: 0, padding: { left: 12, right: 8, top: 8 }, gap: 2, background: state.page.kind === "playing" ? c.raised : c.panel, borderColor: c.border, borderWidth: { top: 1, bottom: 1 } }}>
      <Row gap={12} align="center">
        <Art url={song.thumbnail} size={44} radius={6} />
        <Column gap={2} style={{ flex: 1, minWidth: 0 }}>
          <Text id="now-title" size={14} weight={600} style={ellipsis}>{song.title}</Text>
          <Text id="now-status" size={12} color={state.playError ? "#ff8a8a" : c.muted} style={ellipsis}>{status ?? song.artist}</Text>
        </Column>
        <IconButton id="previous" d={icons.prev} label="Previous" size={20} fill box={40} onClick={state.previous} />
        <IconButton id="play" d={state.playing ? icons.pause : icons.play} label={state.playing ? "Pause" : "Play"} size={22} fill box={44} disabled={!ready}
          onClick={() => { if (state.playing) state.media()?.pause(); else state.media()?.play(); }} />
        <IconButton id="next" d={icons.next} label="Next" size={20} fill box={40} onClick={state.next} />
      </Row>
      <Row gap={8} align="center">
        <Text id="time" size={11} color={c.muted} style={{ width: 44, shrink: 0, whiteSpace: "nowrap" }}>{clock(state.time)}</Text>
        <Slider id="progress" label="Position" value={Math.min(state.time, duration)} min={0} max={Math.max(duration, 0.001)} step={0.1}
          disabled={!ready} onValueChange={value => { state.time = value; state.media()?.seek(value); }}
          style={{ flex: 1, minWidth: 0, width: "auto", foreground: c.accent }} />
        <Text size={11} color={c.muted} style={{ width: 44, shrink: 0, textAlign: "end", whiteSpace: "nowrap" }}>{clock(duration)}</Text>
      </Row>
    </Pressable>
  );
}
