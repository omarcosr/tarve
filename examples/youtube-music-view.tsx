import { Column, darkTheme, DropdownMenu, Image, Input, loadImageSource, memo, Path, VirtualList, type Child, Pressable, Row, Scroll, Slider, Svg, Text, Theme, TitleBar, Tooltip, View, Window, type ImageBytesSource, type MediaController } from "@tarve/core";
import type { Collection, Item, Shelf, Song } from "./youtube-music-source";

export const AUDIO_ID = "ytm-audio";
export type Page = { kind: "home" } | { kind: "search"; query: string } | { kind: "library" } | { kind: "collection"; entry: Collection } | { kind: "playing" };
export type Repeat = "off" | "all" | "one";

export const state = {
  page: { kind: "home" } as Page,
  back: [] as Page[],
  shelves: null as Shelf[] | null,
  results: null as Song[] | null,
  /** The open playlist/album/artist: its header as loaded, and its songs. */
  opened: null as { header: Collection; songs: Song[] } | null,
  library: null as Collection[] | null,
  query: "",
  /** Scroll offset of the open song list. */
  listOffset: 0,
  /** Bumped when artwork arrives, so the parts showing it render again. */
  art: 0,
  pageError: null as string | null,
  signedIn: false,
  /** Sign-in dialog: closed, choosing, waiting on the browser window, or pasting cookies. */
  signIn: "closed" as "closed" | "choose" | "browser" | "paste",
  signInError: null as string | null,
  pastedCookies: "",
  queue: [] as Song[],
  index: -1,
  /** Where the queue came from, shown in the queue panel. */
  source: "",
  showQueue: true,
  /** The current song's stream URL; undefined while it resolves. */
  path: undefined as string | undefined,
  loading: null as number | null,
  playError: null as string | null,
  playing: false,
  time: 0,
  duration: 0,
  volume: 0.8,
  muted: false,
  shuffle: false,
  repeat: "off" as Repeat,
  /** The icon button whose tooltip is showing. */
  tip: null as string | null,
  accountOpen: false,
  /** Size of the now-playing area, so the artwork fits it. */
  stage: null as { width: number; height: number } | null,
  media: (): MediaController | undefined => undefined,
  // Wired by youtube-music-actions.ts.
  open: (_page: Page) => { },
  goBack: () => { },
  play: (_queue: Song[], _index: number, _source?: string) => { },
  jump: (_index: number) => { },
  next: () => { },
  previous: () => { },
  toggleShuffle: () => { },
  signInWithBrowser: () => { },
  savePastedCookies: () => { },
  signOut: () => { },
  refresh: () => { },
};

// YouTube Music's palette: near-black surfaces, one red accent.
const c = {
  window: "#030303",
  panel: "#0f0f0f",
  raised: "#212121",
  row: "#181818",
  hover: "#ffffff12",
  border: "#ffffff14",
  text: "#f1f1f1",
  muted: "#aaaaaa",
  accent: "#ff0033",
  accentInk: "#ffffff",
  selected: "#2b2b2b",
  liked: "#7a1426",
};
const ellipsis = { whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" } as const;
// Built-in controls (tooltips, menus, the title bar's buttons, focus rings) follow this palette.
const ytmTheme = Theme.create(darkTheme, {
  colors: {
    background: c.window, card: c.panel, foreground: c.text, muted: c.selected, mutedForeground: c.muted,
    border: "#272727", input: c.raised, placeholder: "#8a8a8a", selection: "#ff00334d",
    ring: "#ffffff59", ringSoft: "#ffffff33", primary: c.accent, primaryForeground: c.accentInk, sliderThumb: c.text,
  },
});

function clock(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "-:--";
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  return `${h ? `${h}:${String(m).padStart(2, "0")}` : m}:${String(s % 60).padStart(2, "0")}`;
}

const icons = {
  play: "M7 4.8v14.4a1 1 0 0 0 1.5.86l11.9-7.2a1 1 0 0 0 0-1.72L8.5 3.94A1 1 0 0 0 7 4.8z",
  pause: "M7 4h3.5v16H7zM13.5 4H17v16h-3.5z",
  next: "M6 5v14l9.5-7zM17 5h2v14h-2z",
  prev: "M18 5v14L8.5 12zM5 5h2v14H5z",
  shuffle: "M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5",
  repeat: "M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3",
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4",
  library: "M5 3v18M10 3v18M15 4l5 16",
  heart: "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z",
  volume: "M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14",
  mute: "M11 5 6 9H2v6h4l5 4zM22 9l-6 6M16 9l6 6",
  queue: "M3 6h13M3 12h13M3 18h9M17 15v6l5-3z",
  back: "M15 18l-6-6 6-6",
  note: "M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  bars: "M5 20V10M10 20V4M15 20v-8M20 20V7",
};

function Glyph({ d, size = 18, color = c.text, fill = false, weight = 2 }: { d: string; size?: number; color?: string; fill?: boolean; weight?: number }) {
  return (
    <Svg size={size} viewBox="0 0 24 24" color={color} fill={fill ? color : "none"} stroke={fill ? "none" : color} strokeWidth={weight} strokeLinecap="round" strokeLinejoin="round">
      <Path d={d} />
    </Svg>
  );
}

/** A hover label for icon-only controls. */
function Tip({ id, label, side = "top", children }: { id: string; label: string; side?: "top" | "bottom"; children: Child }) {
  return (
    <Tooltip id={`${id}-tip`} open={state.tip === id} side={side} label={label} trigger={children}
      onOpenChange={open => { if (open) state.tip = id; else if (state.tip === id) state.tip = null; }}
      content={<Text size={12} color={c.text} style={{ whiteSpace: "nowrap" }}>{label}</Text>}
      contentStyle={{ background: "#333333", borderColor: "#333333", radius: 6 }} />
  );
}

function IconButton({ id, d, label, onClick, size = 18, fill = false, active = false, disabled = false, box = 32, tip = "top" }: { id: string; d: string; label: string; onClick: () => void; size?: number; fill?: boolean; active?: boolean; disabled?: boolean; box?: number; tip?: "top" | "bottom" }) {
  return (
    <Tip id={id} label={label} side={tip}>
      <Pressable id={id} onClick={disabled ? () => { } : onClick} control={{ role: "button", label }}
        style={{ width: box, height: box, align: "center", justify: "center", radius: 8, shrink: 0, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.35 : 1,
          background: active ? c.selected : "transparent", hover: { background: active ? c.selected : c.hover } }}>
        <Glyph d={d} size={size} fill={fill} color={active ? c.accent : c.text} />
      </Pressable>
    </Tip>
  );
}

// Remote artwork, fetched once at 1.5× its on-screen size: sharp at 125–150% scaling,
// and each decoded image costs a quarter of a 2× (let alone the 544 px original) one.
const thumbs = new Map<string, ImageBytesSource | "loading" | "failed">();
// A few downloads at a time: a page of covers must not open hundreds of sockets.
const waiting: string[] = [];
let fetching = 0;
function pump(): void {
  while (fetching < 6 && waiting.length) {
    const src = waiting.shift()!;
    fetching++;
    // no-store: this map is the cache; loadImageSource's own LRU would hold every cover a second time.
    loadImageSource(src, { cache: "no-store" }).then(bytes => { thumbs.set(src, bytes); state.art++; state.refresh(); }, () => thumbs.set(src, "failed"))
      .finally(() => { fetching--; pump(); });
  }
}
const sizedUrls = new Map<string, string>();
function sized(url: string, px: number): string {
  const key = `${px} ${url}`;
  let out = sizedUrls.get(key);
  if (out === undefined) {
    if (sizedUrls.size > 5000) sizedUrls.clear();
    sizedUrls.set(key, out = url.replace(/=w\d+-h\d+/, `=w${px}-h${px}`).replace(/=s\d+/, `=s${px}`));
  }
  return out;
}
/** The artwork for `url` at `size`, once loaded (starting the download if needed). */
function cover(url: string | null | undefined, size: number): ImageBytesSource | undefined {
  const src = url ? sized(url, Math.min(544, Math.ceil(size * 1.5 / 30) * 30)) : null;
  const entry = src ? thumbs.get(src) : undefined;
  if (src && entry === undefined) {
    // Keep the encoded artwork of the last few hundred covers; the oldest go first.
    if (thumbs.size >= 400) thumbs.delete(thumbs.keys().next().value!);
    thumbs.set(src, "loading");
    waiting.push(src);
    pump();
  }
  return typeof entry === "object" ? entry : undefined;
}

function Art({ url, size, radius = 6, round = false }: { url: string | null | undefined; size: number; radius?: number; round?: boolean }) {
  const entry = cover(url, size);
  const shape = { width: size, height: size, shrink: 0, radius: round ? size / 2 : radius, overflow: "hidden" as const, background: c.raised };
  return entry
    ? <Image src={entry} width={size} height={size} fit="cover" style={shape} />
    : <View style={{ ...shape, align: "center", justify: "center" }}><Glyph d={icons.note} size={Math.max(12, size / 3)} color={c.muted} /></View>;
}

function NavItem({ id, d, label, active, onClick }: { id: string; d: string; label: string; active: boolean; onClick: () => void }) {
  return (
    <Pressable id={id} onClick={onClick} control={{ role: "button", label }}
      style={{ height: 32, padding: { left: 10, right: 10 }, gap: 10, direction: "row", align: "center", radius: 8, cursor: "pointer",
        background: active ? c.selected : "transparent", hover: { background: active ? c.selected : c.hover } }}>
      <Glyph d={d} size={16} color={active ? c.accent : c.muted} />
      <Text size={13} color={active ? c.text : "#c3cfd1"} weight={active ? 600 : 400}>{label}</Text>
    </Pressable>
  );
}

function Sidebar() {
  const page = state.page;
  const current = state.queue[state.index];
  return (
    <Column justify="start" style={{ width: 216, shrink: 0, padding: 8, gap: 2, background: c.panel, borderColor: c.border, borderWidth: { right: 1 }, minHeight: 0 }}>
      <NavItem id="nav-home" d={icons.home} label="Home" active={page.kind === "home"} onClick={() => state.open({ kind: "home" })} />
      <NavItem id="nav-search" d={icons.search} label="Search" active={page.kind === "search"} onClick={() => state.open({ kind: "search", query: state.query })} />
      <NavItem id="nav-library" d={icons.library} label="Your Library" active={page.kind === "library"} onClick={() => state.open({ kind: "library" })} />
      <Text size={11} weight={700} color={c.muted} style={{ padding: { left: 10, top: 18, bottom: 6 }, letterSpacing: 0.6 }}>PLAYLISTS</Text>
      {state.signedIn
        ? <Scroll flex={1} style={{ minHeight: 0 }}>
          <Column gap={2}>
            {(state.library ?? []).map((entry, j) => {
              const open = page.kind === "collection" && page.entry.id === entry.id;
              const playing = state.playing && state.source === entry.title && !!current;
              return (
                <Pressable key={`${j}-${entry.id}`} id={`side-${j}`} onClick={() => state.open({ kind: "collection", entry })} control={{ role: "button", label: entry.title }}
                  style={{ padding: 6, radius: 8, gap: 10, direction: "row", align: "center", cursor: "pointer", background: open ? c.selected : "transparent", hover: { background: open ? c.selected : c.hover } }}>
                  {entry.id === "VLLM"
                    ? <View style={{ width: 36, height: 36, radius: 6, background: c.liked, align: "center", justify: "center" }}><Glyph d={icons.heart} size={16} fill color={c.text} /></View>
                    : <Art url={entry.thumbnail} size={36} />}
                  <Column gap={1} style={{ flex: 1, minWidth: 0 }}>
                    <Text size={13} color={playing ? c.accent : c.text} style={ellipsis}>{entry.title}</Text>
                    <Text size={11} color={c.muted} style={ellipsis}>{entry.subtitle}</Text>
                  </Column>
                </Pressable>
              );
            })}
          </Column>
        </Scroll>
        : <Column gap={10} style={{ padding: { left: 10, right: 10 } }}>
          <Text size={12} color={c.muted}>Sign in to see your playlists and liked music.</Text>
          <Pressable id="side-sign-in" onClick={() => { state.signIn = "choose"; }} control={{ role: "button", label: "Sign in" }}
            style={{ height: 30, radius: 8, background: c.accent, align: "center", justify: "center", cursor: "pointer", hover: { opacity: 0.9 } }}>
            <Text size={13} weight={600} color={c.accentInk}>Sign in</Text>
          </Pressable>
        </Column>}
    </Column>
  );
}

/** The window's own title bar: drag it to move the window; the controls stay clickable. */
function TopBar() {
  return (
    <TitleBar id="titlebar" height={44} style={{ background: c.panel, foreground: c.text, borderColor: c.border, padding: { left: 8 } }}>
    <Row align="center" style={{ flex: 1, minWidth: 0, height: "100%", padding: { right: 8 }, gap: 8 }}>
      <Row gap={8} align="center" style={{ width: 200, shrink: 0, padding: { left: 6 } }}>
        <View style={{ width: 24, height: 24, radius: 12, background: c.accent, align: "center", justify: "center" }}><Glyph d={icons.play} size={12} fill color={c.accentInk} /></View>
        <Text size={15} weight={700}>Music</Text>
      </Row>
      <IconButton id="back" d={icons.back} label="Back" tip="bottom" onClick={state.goBack} disabled={!state.back.length} />
      {/* The field is the pill: hover and focus show on it, the icon sits inside. */}
      <View style={{ width: 380, height: 34, shrink: 1, minWidth: 160, position: "relative" }}>
        <Input id="search" type="search" placeholder="Search songs, albums, artists" value={state.query}
          onChange={value => { state.query = value; }}
          onSubmit={value => { if (value.trim()) state.open({ kind: "search", query: value.trim() }); }}
          style={{ width: "100%", height: 34, minWidth: 0, radius: 17, background: c.raised, borderColor: c.raised, foreground: c.text, caretColor: c.text,
            fontSize: 13, padding: { left: 36, right: 14 },
            hover: { background: "#2a2a2a", borderColor: "#2a2a2a" },
            focus: { background: "#1a1a1a", borderColor: "#ffffff40", outlineWidth: 0 } }} />
        <View style={{ position: "absolute", left: 12, top: 10, pointerEvents: "auto" }}><Glyph d={icons.search} size={14} color={c.muted} /></View>
      </View>
      <View flex={1} />
      <IconButton id="toggle-queue" d={icons.queue} label={state.showQueue ? "Hide queue" : "Show queue"} tip="bottom" active={state.showQueue} onClick={() => { state.showQueue = !state.showQueue; }} />
      {state.signedIn
        // Signed in: an avatar; Sign out lives in its menu, out of the way.
        ? <DropdownMenu id="account" label="Account" open={state.accountOpen} onOpenChange={open => { state.accountOpen = open; }}
            items={[{ value: "sign-out", label: "Sign out" }]} onSelect={value => { if (value === "sign-out") state.signOut(); }}
            trigger={<View style={{ width: 30, height: 30, radius: 15, background: c.selected, align: "center", justify: "center", hover: { background: "#3a3a3a" } }}><Glyph d={icons.user} size={15} color={c.text} /></View>}
            contentStyle={{ left: undefined, right: 0, minWidth: 160, background: c.raised, borderColor: c.border }} />
        : <Pressable id="account" onClick={() => { state.signIn = "choose"; }} control={{ role: "button", label: "Sign in" }}
            style={{ height: 30, padding: { left: 10, right: 12 }, gap: 6, direction: "row", align: "center", radius: 15, cursor: "pointer", background: c.raised, hover: { background: c.selected } }}>
            <Glyph d={icons.user} size={14} color={c.muted} />
            <Text size={12} color={c.text}>Sign in</Text>
          </Pressable>}
    </Row>
    </TitleBar>
  );
}

function openItem(item: Item, shelf: Shelf): void {
  if (item.kind === "song") {
    const songs = shelf.items.filter((x): x is Song => x.kind === "song");
    state.play(songs, songs.indexOf(item), shelf.title);
  } else state.open({ kind: "collection", entry: item });
}

// `image` is the loaded cover: a memoized card renders again only when its own cover arrives.
const Card = memo(({ item, shelf, slot }: { item: Item; shelf: Shelf; slot: string; image: ImageBytesSource | undefined }) => {
  const subtitle = item.kind === "song" ? item.artist : item.subtitle;
  return (
    <Pressable id={`card-${slot}`} onClick={() => openItem(item, shelf)} control={{ role: "button", label: item.title }}
      style={{ width: 168, shrink: 0, direction: "column", gap: 8, padding: 8, radius: 10, cursor: "pointer", hover: { background: c.hover } }}>
      <Art url={item.thumbnail} size={152} radius={8} round={item.kind === "artist"} />
      <Column gap={2}>
        <Text size={13} weight={600} style={ellipsis}>{item.title}</Text>
        <Text size={12} color={c.muted} style={ellipsis}>{subtitle}</Text>
      </Column>
    </Pressable>
  );
});

const ROW = 40;
const PAD = { left: 24, right: 24, top: 20, bottom: 28 } as const;

/** One song row; memoized, so scrolling reuses the rows already on screen. */
const SongRow = memo(({ song, index, list, source, isCurrent, playing }: { song: Song; index: number; list: Song[]; source: string; isCurrent: boolean; playing: boolean; image: ImageBytesSource | undefined }) => (
  <Pressable id={`row-${index}-${song.id}`} onClick={() => state.play(list, index, source)} control={{ role: "button", label: `Play ${song.title}` }}
    style={{ width: "100%", height: ROW, direction: "row", align: "center", gap: 16, padding: { left: 12, right: 16 }, radius: 6, cursor: "pointer",
      background: isCurrent ? c.selected : "transparent", hover: { background: isCurrent ? c.selected : c.hover } }}>
    <View style={{ width: 24, shrink: 0, align: "center" }}>
      {isCurrent ? <Glyph d={playing ? icons.bars : icons.note} size={14} color={c.accent} /> : <Text size={12} color={c.muted}>{index + 1}</Text>}
    </View>
    <Row gap={10} align="center" style={{ flex: 1, minWidth: 0 }}>
      <Art url={song.thumbnail} size={28} radius={4} />
      <Text size={13} color={isCurrent ? c.accent : c.text} style={{ ...ellipsis, flex: 1, minWidth: 0 }}>{song.title}</Text>
    </Row>
    <Text size={13} color={c.muted} style={{ ...ellipsis, width: "26%" }}>{song.artist}</Text>
    <Text size={13} color={c.muted} style={{ ...ellipsis, width: "22%" }}>{song.album}</Text>
    <Text size={12} color={c.muted} style={{ width: 52, textAlign: "end", shrink: 0 }}>{clock(song.duration)}</Text>
  </Pressable>
));

/** Fills the space below its header; VirtualList renders only the rows in view. */
function TrackTable({ songs, source, list }: { songs: Song[]; source: string; list: string }) {
  const current = state.queue[state.index]?.id;
  return (
    <Column flex={1} style={{ minHeight: 0 }}>
      <Row align="center" gap={16} style={{ height: 32, shrink: 0, padding: { left: 12, right: 16 }, background: c.row, radius: 6 }}>
        <Text size={11} color={c.muted} style={{ width: 24, textAlign: "center", shrink: 0 }}>#</Text>
        <Text size={11} color={c.muted} style={{ flex: 1 }}>TITLE</Text>
        <Text size={11} color={c.muted} style={{ width: "26%" }}>ARTIST</Text>
        <Text size={11} color={c.muted} style={{ width: "22%" }}>ALBUM</Text>
        <Text size={11} color={c.muted} style={{ width: 52, textAlign: "end", shrink: 0 }}>LENGTH</Text>
      </Row>
      <VirtualList id={list} items={songs} itemHeight={ROW} overscan={8} offset={state.listOffset}
        keyForItem={(song, index) => `${index}-${song.id}`}
        onScroll={offset => { state.listOffset = offset; }}
        renderItem={(song, index) => <SongRow song={song} index={index} list={songs} source={source} isCurrent={song.id === current} playing={state.playing} image={cover(song.thumbnail, 28)} />} />
    </Column>
  );
}

function Message({ children }: { children: string }) {
  return <Text size={14} color={c.muted} style={{ padding: { top: 24, left: 4 } }}>{children}</Text>;
}

function PrimaryButton({ id, label, d, onClick }: { id: string; label: string; d: string; onClick: () => void }) {
  return (
    <Pressable id={id} onClick={onClick} control={{ role: "button", label }}
      style={{ height: 32, padding: { left: 12, right: 14 }, gap: 6, direction: "row", align: "center", radius: 8, background: c.accent, cursor: "pointer", hover: { opacity: 0.88 } }}>
      <Glyph d={d} size={14} fill color={c.accentInk} />
      <Text size={13} weight={600} color={c.accentInk}>{label}</Text>
    </Pressable>
  );
}

function CollectionPage({ entry }: { entry: Collection }) {
  const opened = state.opened?.header.id === entry.id ? state.opened : null;
  const header = opened?.header ?? entry;
  const songs = opened?.songs ?? null;
  const total = songs?.reduce((sum, song) => sum + (song.duration ?? 0), 0) ?? 0;
  const playingHere = state.source === header.title && state.playing;
  return (
    <Column flex={1} gap={20} style={{ minHeight: 0, padding: { ...PAD, bottom: 0 } }}>
      <Row gap={20} align="end" style={{ shrink: 0 }}>
        <Art url={header.thumbnail ?? songs?.[0]?.thumbnail} size={148} radius={10} round={entry.kind === "artist"} />
        <Column gap={6} style={{ minWidth: 0, flex: 1 }}>
          <Text size={11} weight={700} color={c.muted} style={{ letterSpacing: 0.8 }}>{entry.kind.toUpperCase()}</Text>
          <Text size={30} weight={800} style={ellipsis}>{header.title}</Text>
          <Text size={12} color={c.muted} style={ellipsis}>{[header.subtitle, songs ? `${songs.length} songs` : "", total ? clock(total) : ""].filter(Boolean).join(" • ")}</Text>
          <Row gap={8} style={{ margin: { top: 8 } }}>
            <PrimaryButton id="play-all" label={playingHere ? "Pause" : "Play"} d={playingHere ? icons.pause : icons.play}
              onClick={() => { if (playingHere) state.media()?.pause(); else if (songs?.length) state.play(songs, 0, header.title); }} />
            <IconButton id="shuffle-all" d={icons.shuffle} label="Shuffle play" onClick={() => { if (!songs?.length) return; state.shuffle = false; state.play(songs, Math.floor(Math.random() * songs.length), header.title); state.toggleShuffle(); }} />
          </Row>
        </Column>
      </Row>
      {songs ? songs.length ? <TrackTable songs={songs} source={header.title} list={`songs-${entry.id}`} /> : <Message>Nothing playable here.</Message> : <Message>Loading…</Message>}
    </Column>
  );
}

/** Pages of cards scroll as a whole; song lists keep their header and scroll their rows. */
function Scrolling({ id, children }: { id: string; children: Child }) {
  return (
    <Scroll id={id} flex={1} style={{ minHeight: 0, minWidth: 0 }}>
      <Column style={{ padding: PAD }}>{children}</Column>
    </Scroll>
  );
}

/** The song playing, large: opened from the player bar. */
function NowPlaying() {
  const song = state.queue[state.index];
  if (!song) return <Scrolling id="main-playing"><Message>Nothing playing. Pick a song to start.</Message></Scrolling>;
  // The artwork takes what the area leaves after the text below it, so a short
  // window shrinks it instead of pushing it over the title bar.
  const stage = state.stage;
  const art = stage ? Math.max(96, Math.min(420, stage.width - 48, stage.height - 150)) : 320;
  return (
    <Column id="main-playing" flex={1} align="center" justify="center" gap={18} style={{ minHeight: 0, minWidth: 0, padding: PAD, overflow: "hidden" }}
      onSize={size => { if (size.width !== state.stage?.width || size.height !== state.stage?.height) state.stage = size; }}>
      <Art url={song.thumbnail} size={Math.round(art)} radius={10} />
      <Column gap={6} align="center" style={{ maxWidth: 520, minWidth: 0 }}>
        <Text size={26} weight={800} style={{ ...ellipsis, maxWidth: 520 }}>{song.title}</Text>
        <Text size={15} color={c.muted} style={{ ...ellipsis, maxWidth: 520 }}>{[song.artist, song.album].filter(Boolean).join(" • ")}</Text>
        {state.source ? <Text size={12} color={c.muted} style={{ ...ellipsis, maxWidth: 520 }}>Playing from {state.source}</Text> : null}
      </Column>
    </Column>
  );
}

function Content() {
  const page = state.page;
  if (page.kind === "playing") return <NowPlaying />;
  if (state.pageError) return <Scrolling id="main-error"><Message>{state.pageError}</Message></Scrolling>;
  if (page.kind === "home") {
    if (!state.shelves) return <Scrolling id="main-home"><Message>Loading…</Message></Scrolling>;
    return (
      <Scrolling id="main-home">
        <Column gap={28}>
          {state.shelves.map((shelf, i) => (
            <Column key={`${i}-${shelf.title}`} gap={6}>
              <Text size={20} weight={700} style={{ padding: { left: 8 } }}>{shelf.title}</Text>
              <Scroll orientation="horizontal" style={{ shrink: 0 }}>
                <Row gap={4} style={{ padding: { bottom: 6 } }}>{shelf.items.map((item, j) => <Card key={`${j}-${item.id}`} slot={`${i}-${j}`} item={item} shelf={shelf} image={cover(item.thumbnail, 152)} />)}</Row>
              </Scroll>
            </Column>
          ))}
        </Column>
      </Scrolling>
    );
  }
  if (page.kind === "search") {
    if (!page.query) return <Scrolling id="main-search"><Message>Type in the search box and press Enter.</Message></Scrolling>;
    return (
      <Column flex={1} gap={16} style={{ minHeight: 0, padding: { ...PAD, bottom: 0 } }}>
        <Text size={24} weight={800} style={{ shrink: 0 }}>Songs for “{page.query}”</Text>
        {state.results ? state.results.length ? <TrackTable songs={state.results} source={`Search: ${page.query}`} list={`songs-search-${page.query}`} /> : <Message>No songs found.</Message> : <Message>Searching…</Message>}
      </Column>
    );
  }
  if (page.kind === "library") {
    if (!state.signedIn) return <Scrolling id="main-library"><Message>Sign in to see your library.</Message></Scrolling>;
    if (!state.library) return <Scrolling id="main-library"><Message>Loading…</Message></Scrolling>;
    const shelf = { title: "Your Library", items: state.library };
    return (
      <Scrolling id="main-library">
        <Column gap={12}>
          <Text size={24} weight={800}>Your Library</Text>
          <Row gap={4} style={{ wrap: true }}>{state.library.map((entry, j) => <Card key={`${j}-${entry.id}`} slot={`lib-${j}`} item={entry} shelf={shelf} image={cover(entry.thumbnail, 152)} />)}</Row>
        </Column>
      </Scrolling>
    );
  }
  return <CollectionPage entry={page.entry} />;
}

// Each region renders again only when what it shows changes: the clock ticking
// four times a second re-renders the player bar, not the song list.
const SidebarRegion = memo((_: { page: Page; library: Collection[] | null; signedIn: boolean; source: string; playing: boolean; current: string | undefined; art: number }) => <Sidebar />);
const ContentRegion = memo((_: { page: Page; shelves: Shelf[] | null; results: Song[] | null; opened: unknown; library: Collection[] | null; signedIn: boolean;
  pageError: string | null; listOffset: number; current: string | undefined; playing: boolean; source: string; art: number; stage: unknown }) => <Content />);
const QueueRegion = memo((_: { queue: Song[]; index: number; source: string; art: number }) => <QueuePanel />);

function QueueRow({ song, index, dim = false }: { song: Song; index: number; dim?: boolean }) {
  const current = index === state.index;
  return (
    <Pressable id={`queue-${index}`} onClick={() => state.jump(index)} control={{ role: "button", label: `Play ${song.title}` }}
      style={{ padding: 6, gap: 10, direction: "row", align: "center", radius: 8, cursor: "pointer", opacity: dim ? 0.6 : 1, hover: { background: c.hover } }}>
      <Art url={song.thumbnail} size={36} radius={4} />
      <Column gap={1} style={{ flex: 1, minWidth: 0 }}>
        <Text size={13} color={current ? c.accent : c.text} style={ellipsis}>{song.title}</Text>
        <Text size={11} color={c.muted} style={ellipsis}>{song.artist}</Text>
      </Column>
    </Pressable>
  );
}

function QueuePanel() {
  const history = state.queue.slice(Math.max(0, state.index - 3), Math.max(0, state.index));
  const upNext = state.queue.slice(state.index + 1, state.index + 51);
  const current = state.queue[state.index];
  const label = (text: string) => <Text size={11} weight={700} color={c.muted} style={{ padding: { left: 6, top: 14, bottom: 4 }, letterSpacing: 0.6 }}>{text}</Text>;
  return (
    <Column style={{ width: 264, shrink: 0, background: c.panel, borderColor: c.border, borderWidth: { left: 1 }, minHeight: 0 }}>
      <Row align="center" style={{ height: 36, padding: { left: 14, right: 8 }, borderColor: c.border, borderWidth: { bottom: 1 } }}>
        <Text size={11} weight={700} color={c.muted} style={{ letterSpacing: 0.6, flex: 1 }}>QUEUE</Text>
        <Text size={11} color={c.muted}>{state.queue.length ? `${state.index + 1} / ${state.queue.length}` : ""}</Text>
      </Row>
      <Scroll flex={1} style={{ minHeight: 0 }}>
        <Column style={{ padding: { left: 8, right: 8, bottom: 12 } }}>
          {current ? <>
            {history.length ? <>{label("HISTORY")}{history.map((song, i) => <QueueRow key={`h${i}`} song={song} index={state.index - history.length + i} dim />)}</> : null}
            {label(state.source ? `NOW PLAYING · ${state.source.toUpperCase()}` : "NOW PLAYING")}
            <QueueRow song={current} index={state.index} />
            {upNext.length ? <>{label("UP NEXT")}{upNext.map((song, i) => <QueueRow key={`n${i}-${song.id}`} song={song} index={state.index + 1 + i} />)}</> : null}
          </> : <Text size={12} color={c.muted} style={{ padding: { top: 14, left: 6 } }}>Play something to fill the queue.</Text>}
        </Column>
      </Scroll>
    </Column>
  );
}

/** Clicking the bar (outside its controls) opens the playing song as the main view; again, goes back. */
function togglePlaying(): void {
  if (state.page.kind === "playing") state.goBack();
  else state.open({ kind: "playing" });
}

function PlayerBar() {
  const song = state.queue[state.index];
  const duration = state.duration || song?.duration || 0;
  const volume = state.muted ? 0 : state.volume;
  const ready = !!state.path && state.loading === null;
  const status = state.playError ?? (state.loading !== null || (state.path && !state.playing && state.time === 0) ? "Loading…" : null);
  return (
    <Pressable id="player-bar" onClick={togglePlaying} control={{ role: "button", label: state.page.kind === "playing" ? "Close now playing" : "Open now playing" }}
      style={{ direction: "row", align: "center", height: 68, shrink: 0, padding: { left: 12, right: 16 }, gap: 16, background: state.page.kind === "playing" ? c.raised : c.panel, borderColor: c.border, borderWidth: { top: 1 }, cursor: "pointer" }}>
      <Row gap={12} align="center" style={{ width: 300, shrink: 0, minWidth: 0 }}>
        {song ? <>
          <Art url={song.thumbnail} size={44} radius={6} />
          <Column gap={2} style={{ flex: 1, minWidth: 0 }}>
            <Text id="now-title" size={13} weight={600} style={ellipsis}>{song.title}</Text>
            <Text id="now-status" size={12} color={state.playError ? "#ff8a8a" : c.muted} style={ellipsis}>{status ?? song.artist}</Text>
          </Column>
        </> : <Text size={12} color={c.muted}>Nothing playing</Text>}
      </Row>
      <Column flex={1} gap={4} align="center" style={{ minWidth: 0 }}>
        <Row gap={6} align="center">
          <IconButton id="shuffle" d={icons.shuffle} label="Shuffle" size={15} active={state.shuffle} onClick={state.toggleShuffle} />
          <IconButton id="previous" d={icons.prev} label="Previous" size={16} fill onClick={state.previous} disabled={!song} />
          <Pressable id="play" onClick={() => { if (!ready) return; if (state.playing) state.media()?.pause(); else state.media()?.play(); }}
            control={{ role: "button", label: state.playing ? "Pause" : "Play" }}
            style={{ width: 34, height: 34, radius: 999, background: c.text, align: "center", justify: "center", cursor: "pointer", opacity: ready ? 1 : 0.5, hover: { transform: "scale(1.06)" } }}>
            <Glyph d={state.playing ? icons.pause : icons.play} size={16} fill color={c.window} />
          </Pressable>
          <IconButton id="next" d={icons.next} label="Next" size={16} fill onClick={state.next} disabled={!song} />
          <IconButton id="repeat" d={icons.repeat} label={`Repeat: ${state.repeat}`} size={15} active={state.repeat !== "off"}
            onClick={() => { state.repeat = state.repeat === "off" ? "all" : state.repeat === "all" ? "one" : "off"; }} />
        </Row>
        <Row gap={10} align="center" style={{ width: "100%", maxWidth: 560 }}>
          <Text id="time" size={11} color={c.muted} style={{ width: 36, textAlign: "end", shrink: 0 }}>{clock(song ? state.time : null)}</Text>
          <Slider id="progress" label="Position" value={Math.min(state.time, duration)} min={0} max={Math.max(duration, 0.001)} step={0.1}
            disabled={!ready} onValueChange={value => { state.time = value; state.media()?.seek(value); }}
            style={{ flex: 1, minWidth: 0, width: "auto", foreground: c.accent }} />
          <Text size={11} color={c.muted} style={{ width: 36, shrink: 0 }}>{clock(song ? duration : null)}</Text>
        </Row>
      </Column>
      <Row gap={6} align="center" justify="end" style={{ width: 300, shrink: 0 }}>
        <IconButton id="mute" d={volume === 0 ? icons.mute : icons.volume} label={state.muted ? "Unmute" : "Mute"} size={16} onClick={() => { state.muted = !state.muted; }} />
        <Slider id="volume" label="Volume" value={Math.round(volume * 100)} min={0} max={100} step={1}
          onValueChange={value => { state.volume = value / 100; state.muted = value === 0; }}
          style={{ width: 110, foreground: c.text }} />
      </Row>
    </Pressable>
  );
}

function SignInDialog() {
  if (state.signIn === "closed") return null;
  const button = (id: string, label: string, onClick: () => void, primary = false) => (
    <Pressable id={id} onClick={onClick} control={{ role: "button", label }}
      style={{ height: 34, padding: { left: 16, right: 16 }, radius: 8, align: "center", justify: "center", cursor: "pointer",
        background: primary ? c.accent : c.raised, hover: { opacity: 0.88 } }}>
      <Text size={13} weight={600} color={primary ? c.accentInk : c.text}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, zIndex: 100, background: "#000000a8", align: "center", justify: "center" }}>
      <Column gap={14} style={{ width: 440, padding: 24, radius: 14, background: c.panel, borderWidth: 1, borderColor: c.border }}>
        <Text size={18} weight={700}>Sign in to YouTube Music</Text>
        {state.signIn === "browser" ? <>
          <Text size={13} color={c.muted}>Finish signing in in the browser window that opened. It closes on its own once YouTube Music has your account.</Text>
          <Row gap={8} justify="end">{button("sign-in-cancel", "Cancel", () => { state.signIn = "closed"; })}</Row>
        </> : state.signIn === "paste" ? <>
          <Text size={13} color={c.muted}>On music.youtube.com (signed in), open DevTools → Network, pick any request to music.youtube.com and copy its Cookie request header here.</Text>
          <Input id="cookie-input" type="password" placeholder="SAPISID=…; __Secure-3PAPISID=…; …" value={state.pastedCookies} onChange={value => { state.pastedCookies = value; }}
            onSubmit={state.savePastedCookies} style={{ background: c.raised, borderColor: c.border, foreground: c.text }} />
          {state.signInError ? <Text size={12} color="#ff8a8a">{state.signInError}</Text> : null}
          <Row gap={8} justify="end">{button("paste-cancel", "Cancel", () => { state.signIn = "closed"; })}{button("paste-save", "Sign in", state.savePastedCookies, true)}</Row>
        </> : <>
          <Text size={13} color={c.muted}>Sign in with your Google account in a browser window. Your Premium account gives 256 kbps audio and your library.</Text>
          {state.signInError ? <Text size={12} color="#ff8a8a">{state.signInError}</Text> : null}
          <Row gap={8} justify="end">
            {button("choose-cancel", "Cancel", () => { state.signIn = "closed"; })}
            {button("choose-paste", "Paste cookies", () => { state.signIn = "paste"; state.signInError = null; })}
            {button("choose-browser", "Sign in with Google", state.signInWithBrowser, true)}
          </Row>
        </>}
      </Column>
    </View>
  );
}

export function YouTubeMusicView() {
  const song = state.queue[state.index];
  return (
    <Window title={state.playing && song ? `${song.title} • ${song.artist}` : "Music"} width={1320} height={820} minWidth={960} minHeight={580}
      position="center" theme={ytmTheme} style={{ background: c.window, foreground: c.text, fontFamily: "Inter", borderColor: c.border }}>
      <audio id={AUDIO_ID} src={state.path} autoPlay volume={state.volume} muted={state.muted} loop={state.repeat === "one"}
        onPlay={() => { state.playing = true; }}
        onPause={() => { state.playing = false; }}
        onTimeUpdate={info => { state.time = info.currentTime; }}
        onSeeked={info => { state.time = info.currentTime; }}
        onLoadedMetadata={info => { if (info.duration !== null) state.duration = info.duration; }}
        onEnded={() => { state.playing = false; state.next(); }}
        onError={message => { state.playError = message; state.playing = false; }} />
      <Column flex={1} style={{ minHeight: 0 }}>
        <TopBar />
        <Row flex={1} align="stretch" style={{ minHeight: 0 }}>
          <SidebarRegion page={state.page} library={state.library} signedIn={state.signedIn} source={state.source} playing={state.playing} current={song?.id} art={state.art} />
          <Column flex={1} style={{ minHeight: 0, minWidth: 0 }}>
            <ContentRegion page={state.page} shelves={state.shelves} results={state.results} opened={state.opened} library={state.library} signedIn={state.signedIn}
              pageError={state.pageError} listOffset={state.listOffset} current={song?.id} playing={state.playing} source={state.source} art={state.art} stage={state.stage} />
          </Column>
          {state.showQueue ? <QueueRegion queue={state.queue} index={state.index} source={state.source} art={state.art} /> : null}
        </Row>
        <PlayerBar />
      </Column>
      <SignInDialog />
    </Window>
  );
}
