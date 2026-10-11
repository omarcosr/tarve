import { Column, Input, Path, Pressable, Row, Scroll, Slider, Svg, Text, View, Window, type MediaController } from "@tarve/core";
import type { Track } from "./player-tracks";

export const AUDIO_ID = "player-audio";
type Repeat = "off" | "all" | "one";

export const state = {
  tracks: [] as Track[],
  current: 0,
  /** Load the current track playing; false until the user starts something. */
  autoPlay: false,
  playing: false,
  time: 0,
  volume: 0.8,
  muted: false,
  shuffle: false,
  repeat: "off" as Repeat,
  liked: new Set<string>(),
  query: "",
  view: "all" as "all" | "liked",
  history: [] as number[],
  media: (): MediaController | undefined => undefined,
  addFiles: () => { },
};

const green = "#1ed760";
const surface = "#121212";
const muted = "#b3b3b3";

function clock(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "-:--";
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Player actions; each mirrors what a browser app would do with HTMLMediaElement.
export function playIndex(index: number): void {
  if (index === state.current && state.autoPlay) {
    if (state.playing) state.media()?.pause(); else state.media()?.play();
    return;
  }
  state.history.push(state.current);
  state.current = index;
  state.time = 0;
  state.autoPlay = true;
}
function nextIndex(fromEnd: boolean): number | null {
  const count = state.tracks.length;
  if (!count) return null;
  if (state.shuffle && count > 1) {
    let pick = state.current;
    while (pick === state.current) pick = Math.floor(Math.random() * count);
    return pick;
  }
  if (state.current + 1 < count) return state.current + 1;
  return fromEnd && state.repeat === "off" ? null : 0;
}
export function next(fromEnd = false): void {
  const index = nextIndex(fromEnd);
  if (index === null) { state.playing = false; return; }
  if (index === state.current) { state.media()?.seek(0); state.media()?.play(); return; }
  playIndex(index);
}
export function previous(): void {
  // Like every music app: restart the song unless it just began.
  if (state.time > 3 || !state.history.length) { state.media()?.seek(0); state.time = 0; return; }
  state.current = state.history.pop()!;
  state.time = 0;
  state.autoPlay = true;
}

function Glyph({ d, size = 16, color = "#fff", fill = true }: { d: string; size?: number; color?: string; fill?: boolean }) {
  return (
    <Svg size={size} viewBox="0 0 24 24" color={color} fill={fill ? color : "none"} stroke={fill ? "none" : color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d={d} />
    </Svg>
  );
}
const icons = {
  play: "M7 4.5v15a1 1 0 0 0 1.5.86l12.4-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z",
  pause: "M6 4h4v16H6zM14 4h4v16h-4z",
  next: "M5 5v14l10-7zM17 5h2.5v14H17z",
  prev: "M19 5v14L9 12zM4.5 5H7v14H4.5z",
  shuffle: "M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5",
  repeat: "M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3",
  heart: "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z",
  volume: "M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14",
  mute: "M11 5 6 9H2v6h4l5 4zM22 9l-6 6M16 9l6 6",
  home: "M3 10.8 12 3l9 7.8V21h-6v-7H9v7H3z",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  library: "M4 3v18M9 3v18M14 4l5 16",
  plus: "M12 5v14M5 12h14",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
};

function IconButton({ id, d, label, onClick, active = false, size = 16, fill = true }: { id: string; d: string; label: string; onClick: () => void; active?: boolean; size?: number; fill?: boolean }) {
  return (
    <Pressable id={id} onClick={onClick} control={{ role: "button", label }}
      style={{ width: size + 16, height: size + 16, align: "center", justify: "center", radius: 999, cursor: "pointer", hover: { transform: "scale(1.08)" } }}>
      <Glyph d={d} size={size} color={active ? green : muted} fill={fill} />
    </Pressable>
  );
}

function Cover({ track, size, radius = 4 }: { track: Track | undefined; size: number; radius?: number }) {
  const [a, b] = track?.colors ?? ["#333", "#555"];
  return (
    <View style={{ width: size, height: size, shrink: 0, radius, align: "center", justify: "center",
      background: `linear-gradient(135deg, ${a}, ${b})`, boxShadow: size > 100 ? { y: 8, blur: 24, color: "#00000080" } : undefined }}>
      <Text size={size * 0.42} weight={800} color="#ffffffd0">{track?.title.slice(0, 1) ?? "♪"}</Text>
    </View>
  );
}

function Sidebar() {
  const nav = (id: string, d: string, label: string, active: boolean, onClick: () => void) => (
    <Pressable id={id} onClick={onClick} style={{ cursor: "pointer" }}>
      <Row gap={16} align="center" style={{ height: 40, padding: { left: 12 } }}>
        <Glyph d={d} size={22} color={active ? "#fff" : muted} fill={false} />
        <Text size={15} weight={700} color={active ? "#fff" : muted}>{label}</Text>
      </Row>
    </Pressable>
  );
  const playlist = (id: string, title: string, subtitle: string, colors: [string, string], active: boolean, onClick: () => void) => (
    <Pressable id={id} onClick={onClick} style={{ radius: 6, cursor: "pointer", background: active ? "#ffffff1a" : "transparent", hover: { background: "#ffffff12" } }}>
      <Row gap={12} align="center" style={{ padding: 8 }}>
        <View style={{ width: 48, height: 48, radius: 4, shrink: 0, background: `linear-gradient(135deg, ${colors[0]}, ${colors[1]})` }} />
        <Column gap={4} style={{ minWidth: 0 }}>
          <Text size={15} color={active ? green : "#fff"} style={{ whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>{title}</Text>
          <Text size={13} color={muted}>{subtitle}</Text>
        </Column>
      </Row>
    </Pressable>
  );
  return (
    <Column gap={8} style={{ width: 280, shrink: 0 }}>
      <Column style={{ background: surface, radius: 8, padding: { top: 8, bottom: 8, left: 12, right: 12 } }}>
        {nav("nav-home", icons.home, "Home", state.view === "all" && !state.query, () => { state.view = "all"; state.query = ""; })}
        {nav("nav-search", icons.search, "Search", !!state.query, () => { state.view = "all"; })}
      </Column>
      <Column flex={1} gap={8} style={{ background: surface, radius: 8, padding: 12, minHeight: 0 }}>
        <Row align="center" justify="between" style={{ padding: { left: 4, right: 4 } }}>
          <Row gap={12} align="center">
            <Glyph d={icons.library} size={22} color={muted} fill={false} />
            <Text size={15} weight={700} color={muted}>Your Library</Text>
          </Row>
          <IconButton id="add-files" d={icons.plus} label="Add files" fill={false} onClick={() => state.addFiles()} />
        </Row>
        {playlist("list-all", "Tarve Mix", `Playlist • ${state.tracks.length} songs`, ["#4c1d95", "#1ed760"], state.view === "all", () => { state.view = "all"; })}
        {playlist("list-liked", "Liked Songs", `Playlist • ${state.liked.size} songs`, ["#450af5", "#c4efd9"], state.view === "liked", () => { state.view = "liked"; })}
      </Column>
    </Column>
  );
}

function TrackRow({ track, index, position }: { track: Track; index: number; position: number }) {
  const current = index === state.current && state.autoPlay;
  const liked = state.liked.has(track.id);
  return (
    <Pressable id={`track-${index}`} onClick={() => playIndex(index)} control={{ role: "button", label: `Play ${track.title}` }}
      style={{ radius: 4, cursor: "pointer", background: current ? "#ffffff1a" : "transparent", hover: { background: "#ffffff12" } }}>
      <Row gap={16} align="center" style={{ height: 56, padding: { left: 16, right: 16 } }}>
        <View style={{ width: 20, shrink: 0, align: "center" }}>
          {current && state.playing
            ? <Glyph d={"M5 20V10M10 20V4M15 20v-7M20 20V8"} size={14} color={green} fill={false} />
            : <Text size={15} color={current ? green : muted}>{String(position + 1)}</Text>}
        </View>
        <Cover track={track} size={40} />
        <Column gap={4} flex={1} style={{ minWidth: 0 }}>
          <Text size={15} color={current ? green : "#fff"} style={{ whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>{track.title}</Text>
          <Text size={13} color={muted}>{track.artist}</Text>
        </Column>
        <Text size={13} color={muted} style={{ width: 180, shrink: 0, whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>{track.album}</Text>
        <IconButton id={`like-${index}`} d={icons.heart} label={liked ? "Remove from Liked Songs" : "Save to Liked Songs"} active={liked} fill={liked}
          onClick={() => { if (liked) state.liked.delete(track.id); else state.liked.add(track.id); }} />
        <Text size={13} color={muted} style={{ width: 48, shrink: 0, textAlign: "end" }}>{clock(track.duration)}</Text>
      </Row>
    </Pressable>
  );
}

function Main() {
  const query = state.query.trim().toLowerCase();
  const rows = state.tracks
    .map((track, index) => ({ track, index }))
    .filter(({ track }) => state.view === "all" || state.liked.has(track.id))
    .filter(({ track }) => !query || `${track.title} ${track.artist} ${track.album}`.toLowerCase().includes(query));
  const total = rows.reduce((sum, { track }) => sum + (track.duration ?? 0), 0);
  const hero = state.tracks[state.current];
  const [top] = state.view === "liked" ? ["#450af5"] : hero?.colors ?? ["#333"];
  const title = state.view === "liked" ? "Liked Songs" : "Tarve Mix";
  const playingHere = state.playing && rows.some(row => row.index === state.current);
  return (
    <Column flex={1} style={{ radius: 8, minWidth: 0, minHeight: 0, background: `linear-gradient(180deg, ${top} 0%, ${surface} 55%)` }}>
      <Scroll id="main-scroll" flex={1}>
        <Column gap={24} style={{ padding: 24 }}>
          <Row gap={24} align="end">
            <View style={{ width: 200, height: 200, shrink: 0, radius: 6, align: "center", justify: "center", boxShadow: { y: 8, blur: 40, color: "#00000080" },
              background: state.view === "liked" ? "linear-gradient(135deg, #450af5, #c4efd9)" : `linear-gradient(135deg, ${hero?.colors[0] ?? "#333"}, #121212)` }}>
              <Glyph d={state.view === "liked" ? icons.heart : "M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z"} size={72} color="#fff" fill={state.view === "liked"} />
            </View>
            <Column gap={8} style={{ minWidth: 0 }}>
              <Text size={13} weight={600}>Playlist</Text>
              <Text size={72} weight={900} style={{ letterSpacing: -2, lineHeight: 1.1 }}>{title}</Text>
              <Row gap={4} align="center">
                <Text size={14} weight={700}>Tarve</Text>
                <Text size={14} color="#ffffffb3">• {rows.length} songs, {clock(total)}</Text>
              </Row>
            </Column>
          </Row>
          <Row gap={24} align="center">
            <Pressable id="hero-play" control={{ role: "button", label: playingHere ? "Pause" : "Play" }}
              onClick={() => { if (playingHere) state.media()?.pause(); else if (rows.some(row => row.index === state.current) && state.autoPlay) state.media()?.play(); else if (rows[0]) playIndex(rows[0].index); }}
              style={{ width: 56, height: 56, radius: 999, background: green, align: "center", justify: "center", cursor: "pointer", hover: { transform: "scale(1.04)", background: "#3be477" } }}>
              <Glyph d={playingHere ? icons.pause : icons.play} size={24} color="#000" />
            </Pressable>
            <IconButton id="hero-shuffle" d={icons.shuffle} label="Shuffle" size={28} fill={false} active={state.shuffle} onClick={() => { state.shuffle = !state.shuffle; }} />
            <View flex={1} />
            <Input id="search" type="search" placeholder="What do you want to play?" value={state.query} onChange={value => { state.query = value; }}
              style={{ width: 260, height: 36, radius: 999, background: "#ffffff1a", borderColor: "transparent", foreground: "#fff", padding: { left: 16, right: 16 } }} />
          </Row>
          <Column>
            <Row gap={16} align="center" style={{ height: 36, padding: { left: 16, right: 16 } }}>
              <Text size={13} color={muted} style={{ width: 20, shrink: 0, textAlign: "center" }}>#</Text>
              <Text size={13} color={muted} style={{ flex: 1 }}>Title</Text>
              <Text size={13} color={muted} style={{ width: 180, shrink: 0 }}>Album</Text>
              <View style={{ width: 32, shrink: 0 }} />
              <View style={{ width: 48, shrink: 0, align: "end" }}><Glyph d={icons.clock} size={16} color={muted} fill={false} /></View>
            </Row>
            <View style={{ height: 1, background: "#ffffff1a", margin: { bottom: 8 } }} />
            {rows.length
              ? rows.map(({ track, index }, position) => <TrackRow key={track.id} track={track} index={index} position={position} />)
              : <Text color={muted} style={{ padding: 16 }}>{state.view === "liked" ? "Songs you like will appear here. Tap the heart on any song." : "No songs match your search."}</Text>}
          </Column>
        </Column>
      </Scroll>
    </Column>
  );
}

function NowPlaying() {
  const track = state.tracks[state.current];
  const duration = track?.duration ?? 0;
  const liked = !!track && state.liked.has(track.id);
  const volume = state.muted ? 0 : state.volume;
  return (
    <Row align="center" style={{ height: 80, padding: { left: 8, right: 16 }, gap: 16 }}>
      <Row gap={14} align="center" style={{ width: "30%", minWidth: 180 }}>
        {state.autoPlay && track ? <>
          <Cover track={track} size={56} />
          <Column gap={4} style={{ minWidth: 0 }}>
            <Text id="now-title" size={14} style={{ whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>{track.title}</Text>
            <Text size={12} color={muted}>{track.artist}</Text>
          </Column>
          <IconButton id="now-like" d={icons.heart} label="Save to Liked Songs" active={liked} fill={liked}
            onClick={() => { if (liked) state.liked.delete(track.id); else state.liked.add(track.id); }} />
        </> : <Text size={13} color={muted}>Pick a song to start listening</Text>}
      </Row>
      <Column flex={1} gap={6} align="center" style={{ maxWidth: 720 }}>
        <Row gap={16} align="center">
          <IconButton id="shuffle" d={icons.shuffle} label="Shuffle" fill={false} active={state.shuffle} onClick={() => { state.shuffle = !state.shuffle; }} />
          <IconButton id="previous" d={icons.prev} label="Previous" onClick={previous} />
          <Pressable id="play" control={{ role: "button", label: state.playing ? "Pause" : "Play" }}
            onClick={() => { if (!state.autoPlay) playIndex(state.current); else if (state.playing) state.media()?.pause(); else state.media()?.play(); }}
            style={{ width: 32, height: 32, radius: 999, background: "#fff", align: "center", justify: "center", cursor: "pointer", hover: { transform: "scale(1.06)" } }}>
            <Glyph d={state.playing ? icons.pause : icons.play} size={16} color="#000" />
          </Pressable>
          <IconButton id="next" d={icons.next} label="Next" onClick={() => next()} />
          <IconButton id="repeat" d={icons.repeat} label={`Repeat: ${state.repeat}`} fill={false} active={state.repeat !== "off"}
            onClick={() => { state.repeat = state.repeat === "off" ? "all" : state.repeat === "all" ? "one" : "off"; }} />
          {state.repeat === "one" ? <Text size={10} weight={700} color={green} style={{ margin: { left: -14 } }}>1</Text> : null}
        </Row>
        <Row gap={8} align="center" style={{ width: "100%" }}>
          <Text id="time" size={12} color={muted} style={{ width: 40, textAlign: "end", shrink: 0 }}>{clock(state.autoPlay ? state.time : null)}</Text>
          <Slider id="progress" label="Position" value={Math.min(state.time, duration)} min={0} max={Math.max(duration, 0.001)} step={0.1}
            disabled={!state.autoPlay} onValueChange={value => { state.time = value; state.media()?.seek(value); }}
            style={{ flex: 1, minWidth: 0, width: "auto", foreground: "#fff", hover: { foreground: green } }} />
          <Text size={12} color={muted} style={{ width: 40, shrink: 0 }}>{clock(state.autoPlay ? duration : null)}</Text>
        </Row>
      </Column>
      <Row gap={8} align="center" justify="end" style={{ width: "30%", minWidth: 180 }}>
        <IconButton id="mute" d={volume === 0 ? icons.mute : icons.volume} label={state.muted ? "Unmute" : "Mute"} fill={false} onClick={() => { state.muted = !state.muted; }} />
        <Slider id="volume" label="Volume" value={Math.round(volume * 100)} min={0} max={100} step={1}
          onValueChange={value => { state.volume = value / 100; state.muted = value === 0; }}
          style={{ width: 120, foreground: "#fff", hover: { foreground: green } }} />
      </Row>
    </Row>
  );
}

export function PlayerView() {
  const track = state.tracks[state.current];
  return (
    <Window title={state.playing && track ? `${track.title} • ${track.artist}` : "Tarve Music"} width={1180} height={760} minWidth={820} minHeight={560}
      position="center" style={{ background: "#000", foreground: "#fff", fontFamily: "Inter" }}>
      <audio id={AUDIO_ID} src={track?.path} autoPlay={state.autoPlay} volume={state.volume} muted={state.muted} loop={state.repeat === "one"}
        onPlay={() => { state.playing = true; }}
        onPause={() => { state.playing = false; }}
        onTimeUpdate={info => { state.time = info.currentTime; }}
        onSeeked={info => { state.time = info.currentTime; }}
        onLoadedMetadata={info => { if (track && info.duration !== null) track.duration = info.duration; }}
        onEnded={() => { state.playing = false; next(true); }}
        onError={message => { console.error(`[player] ${track?.path}: ${message}`); next(true); }} />
      <Column flex={1} style={{ padding: 8, minHeight: 0 }}>
        <Row flex={1} gap={8} align="stretch" style={{ minHeight: 0 }}>
          <Sidebar />
          <Main />
        </Row>
        <NowPlaying />
      </Column>
    </Window>
  );
}
