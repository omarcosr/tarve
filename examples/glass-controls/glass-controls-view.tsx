import {
  AnimatePresence,
  Button,
  Column,
  Glass,
  Image,
  Input,
  Pressable,
  Row,
  Scroll,
  Select,
  Switch,
  Text,
  TitleBar,
  Toggle,
  ToggleGroup,
  View,
  Window,
  viewport,
  type GlassOptions,
  type VNode,
} from "@tarve/core";
import { CircleCheck, Download, Heart, House, Images, Mail, Plus, Share, SlidersHorizontal, Sparkles, Trash, type LucideIcon } from "lucide-react";

/**
 * Liquid Glass controls as Apple lays them out: the content (a photo library) fills the
 * window and scrolls edge to edge, and the controls float over it in glass, never glass on
 * glass. Every control is the ordinary one with `glass`:
 *
 *   <Button glass>Share</Button>
 *   <Button glass={{ tint: "#007aff" }}>Import</Button>     prominent
 *   <Button glass variant="destructive">Delete</Button>
 *   <Toggle glass pressed={on} onPressedChange={…} />
 *   <ToggleGroup glass value={…} items={…} />
 *   <Select glass value={…} options={…} />
 *   <Switch glass checked={…} label="…" />
 *   <Input glass placeholder="Search" />
 *
 * Scroll the photos under the bars to see the lens bend them; press a control and it swells.
 * Icons are lucide-react, drawn natively through the adapter the entry installs.
 */

/** Set by the entry: re-renders after a timer (the toast hides itself). */
let refresh = () => {};
export function bindRefresh(next: () => void): void { refresh = next; }

interface Photo { id: number; title: string; place: string; album: "trips" | "people" | "city" | "nature"; favorite: boolean }

const places = ["Lisbon", "Kyoto", "Patagonia", "Reykjavík", "Marrakesh", "Oslo", "Bali", "Porto"];
const albums = ["nature", "city", "trips", "people"] as const;
const ids = [10, 11, 15, 16, 17, 18, 19, 22, 24, 25, 27, 28, 29, 37, 39, 42, 43, 49, 50, 53, 54, 57, 58, 59];
let photos: Photo[] = ids.map((id, i) => ({
  id, title: `IMG_${4120 + i}`, place: places[i % places.length]!, album: albums[i % albums.length]!, favorite: i % 5 === 0,
}));

/** Shown while a photo downloads, or offline. */
const tones = [["#ff9a8b", "#ff6a88"], ["#8ec5fc", "#e0c3fc"], ["#43e97b", "#38f9d7"], ["#fa709a", "#fee140"], ["#30cfd0", "#330867"], ["#a18cd1", "#fbc2eb"]];
const photoUrl = (id: number) => `https://picsum.photos/id/${id}/600/600`;

// ── State ──
let dark = false;
let clearGlass = false;
let album = "all";
let size: "s" | "m" | "l" = "m";
let favoritesOnly = false;
let tab = "library";
let query = "";
let selected: number | null = null;
let settings = false;
let captions = true;
let toast: { text: string; icon: LucideIcon } | null = null;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

function notify(text: string, icon: LucideIcon = CircleCheck): void {
  toast = { text, icon };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast = null; refresh(); }, 2400);
}

/** One glass look for every control: the appearance and variant the settings pick. */
const glass = (): GlassOptions => ({ variant: clearGlass ? "clear" : "regular", appearance: dark ? "dark" : "light" });
const ink = () => (dark ? "#ffffff" : "#1c1c1e");
const soft = () => (dark ? "#ffffff99" : "#1c1c1e99");
const accent = () => (dark ? "#0a84ff" : "#007aff");
/** Glass that holds text over photos gets a denser veil, so the text never sinks into the picture. */
const legible = () => (dark ? "#1c1c1e8c" : "#ffffff8c");

/** Window margin, shared by the bars and the grid so their edges line up. */
const PAD = 20;
const GAP = 12;
/** Preferred tile side per size; the grid fits whole columns and stretches them to the edges. */
const TILE = { s: 170, m: 240, l: 340 } as const;

/** An icon at the controls' size and stroke, so every glyph sits on the same grid. */
function Glyph({ icon: IconComponent, color, size: side = 18 }: { icon: LucideIcon; color: string; size?: number }): VNode {
  return <IconComponent size={side} strokeWidth={2} color={color} />;
}

function visiblePhotos(): Photo[] {
  const needle = query.trim().toLowerCase();
  return photos.filter(photo =>
    (album === "all" || photo.album === album)
    && (!favoritesOnly || photo.favorite)
    && (!needle || photo.place.toLowerCase().includes(needle) || photo.title.toLowerCase().includes(needle)));
}

function PhotoTile({ photo, index, side }: { photo: Photo; index: number; side: number }): VNode {
  const active = selected === photo.id;
  const [a, b] = tones[index % tones.length]!;
  return (
    <Pressable id={`photo-${photo.id}`} control={{ role: "option", label: `${photo.title}, ${photo.place}`, selected: active }}
      onClick={() => { selected = active ? null : photo.id; }}
      style={{
        position: "relative", width: side, height: side, shrink: 0, radius: 16, overflow: "hidden",
        background: `linear-gradient(135deg, ${a}, ${b})`,
        transition: { transform: { duration: 260, easing: "easeOut" } },
        hover: { transform: "scale(1.015)" }, active: { transform: "scale(0.98)" },
      }}>
      <Image src={photoUrl(photo.id)} fit="cover" style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%" }} />
      {captions ? (
        <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: { left: 12, right: 12, top: 28, bottom: 10 },
          background: "linear-gradient(180deg, #00000000, #00000099)", gap: 1 }}>
          <Text size={13} weight={600} color="#ffffff">{photo.place}</Text>
          <Text size={11} color="#ffffffb3">{photo.title}</Text>
        </View>
      ) : null}
      {photo.favorite ? <View style={{ position: "absolute", top: 10, right: 10 }}><Glyph icon={Heart} color="#ffffff" size={16} /></View> : null}
      {/* Selection ring drawn over the photo, inside the rounded clip. */}
      {active ? <View style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, radius: 16, borderWidth: 3, borderColor: accent() }} /> : null}
    </Pressable>
  );
}

function Library(): VNode {
  const shown = visiblePhotos();
  const heading = album === "all" ? "Library" : album[0]!.toUpperCase() + album.slice(1);
  // Whole columns, stretched so the grid meets the same margin on both sides.
  const width = viewport().width - PAD * 2;
  const columns = Math.max(2, Math.floor((width + GAP) / (TILE[size] + GAP)));
  const side = Math.floor((width - GAP * (columns - 1)) / columns);
  const rows: Photo[][] = [];
  for (let i = 0; i < shown.length; i += columns) rows.push(shown.slice(i, i + columns));
  return (
    <Scroll id="library" style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}>
      <Column padding={{ top: 80, left: PAD, right: PAD, bottom: 110 }} gap={18}>
        <Column gap={2}>
          <Text size={34} weight={800} color={ink()} style={{ letterSpacing: -0.8 }}>{heading}</Text>
          <Text size={14} color={soft()}>{shown.length} photos{favoritesOnly ? " · favourites" : ""}{query ? ` · “${query}”` : ""}</Text>
        </Column>
        {shown.length === 0
          ? <Text size={15} color={soft()} style={{ padding: { top: 40 } }}>Nothing matches. Clear the search or the filters.</Text>
          : (
            <Column gap={GAP}>
              {rows.map((row, r) => (
                <Row key={r} gap={GAP}>
                  {row.map((photo, i) => <PhotoTile key={photo.id} photo={photo} index={r * columns + i} side={side} />)}
                </Row>
              ))}
            </Column>
          )}
      </Column>
    </Scroll>
  );
}

function Toolbar(): VNode {
  const g = glass();
  return (
    <Row id="toolbar" style={{ position: "absolute", left: PAD, right: PAD, top: 14, gap: 10, align: "center", zIndex: 10 }}>
      <Select id="album" glass={g} value={album} style={{ width: 168 }} onValueChange={next => { album = next; selected = null; }}
        options={[
          { value: "all", label: "All photos" }, { value: "nature", label: "Nature" }, { value: "city", label: "City" },
          { value: "trips", label: "Trips" }, { value: "people", label: "People" },
        ]} />
      <View dragRegion style={{ flex: 1, height: 44 }} />
      <ToggleGroup id="size" glass={g} value={size} onValueChange={next => { if (next) size = next as typeof size; }}
        items={[{ value: "s", label: "Small" }, { value: "m", label: "Medium" }, { value: "l", label: "Large" }]} />
      <Toggle id="favorites" glass={{ ...g, tint: "#ff2d55e6" }} label="Favourites only" pressed={favoritesOnly} onPressedChange={next => { favoritesOnly = next; }}
        style={{ width: 40, height: 40, radius: 20, padding: 0 }}>
        <Glyph icon={Heart} color={favoritesOnly ? "#ffffff" : ink()} />
      </Toggle>
      <Button id="settings" glass={g} control={{ role: "button", label: "Settings", expanded: settings }} onClick={() => { settings = !settings; }}
        style={{ width: 40, height: 40, radius: 20, padding: 0 }}>
        <Glyph icon={SlidersHorizontal} color={ink()} />
      </Button>
      <TitleBar id="chrome" glass={g.variant} appearance={g.appearance} height={40} showMinimize showMaximize showClose
        style={{ radius: 20, padding: { left: 2, right: 2 }, gap: 0 }} />
    </Row>
  );
}

function SettingsPopover(): VNode {
  return (
    <AnimatePresence id="settings-presence" present={settings} enter={{ opacity: 0, top: 54 }} exit={{ opacity: 0, top: 54 }}
      transition={{ opacity: { duration: 180 }, top: { duration: 260, easing: "easeOut" } }}>
      {/* A glass popover holds plain content: the switches' knobs are the only lenses inside. */}
      <Glass id="settings-popover" variant="regular" appearance={dark ? "dark" : "light"} tint={legible()} radius={24} dismissOnOutside onOutsideClick={() => { settings = false; }}
        style={{ position: "absolute", top: 64, right: 150, width: 280, padding: { left: 18, right: 18, top: 14, bottom: 14 }, gap: 4, zIndex: 30 }}>
        <Text size={13} weight={600} color={soft()} style={{ padding: { bottom: 4 } }}>Appearance</Text>
        <Switch id="dark" glass={glass()} label="Dark" checked={dark} onCheckedChange={next => { dark = next; }} />
        <Switch id="clear" glass={glass()} label="Clear glass" checked={clearGlass} onCheckedChange={next => { clearGlass = next; }} />
        <Switch id="captions" glass={glass()} label="Captions" checked={captions} onCheckedChange={next => { captions = next; }} />
      </Glass>
    </AnimatePresence>
  );
}

function TabLabel({ icon, label, active }: { icon: LucideIcon; label: string; active: boolean }): VNode {
  const color = active ? accent() : ink();
  return (
    <Row gap={7} align="center">
      <Glyph icon={icon} color={color} size={17} />
      <Text weight={600} color={color}>{label}</Text>
    </Row>
  );
}

function BottomBar(): VNode {
  const g = glass();
  const photo = photos.find(p => p.id === selected);
  if (photo) {
    // A selection swaps the bar for its actions.
    const fav = photo.favorite ? "#ffffff" : ink();
    return (
      <Row id="actions" style={{ position: "absolute", left: 0, right: 0, bottom: 22, justify: "center", gap: 10, zIndex: 10 }}>
        <Button id="share" glass={g} size="lg" onClick={() => notify(`Shared ${photo.title}`, Share)}>
          <Glyph icon={Share} color={ink()} />Share
        </Button>
        <Toggle id="favorite" glass={{ ...g, tint: "#ff2d55e6" }} size="lg" label="Favourite" pressed={photo.favorite}
          onPressedChange={next => { photo.favorite = next; notify(next ? "Added to favourites" : "Removed from favourites", Heart); }}>
          <Row gap={7} align="center">
            <Glyph icon={Heart} color={fav} />
            <Text weight={600} color={fav}>Favourite</Text>
          </Row>
        </Toggle>
        <Button id="download" glass={g} size="lg" control={{ role: "button", label: "Save" }} onClick={() => notify(`Saved ${photo.title}`, Download)}
          style={{ width: 40, padding: 0 }}>
          <Glyph icon={Download} color={ink()} />
        </Button>
        <Button id="delete" glass={g} variant="destructive" size="lg"
          onClick={() => { photos = photos.filter(p => p !== photo); selected = null; notify(`Deleted ${photo.title}`, Trash); }}>
          <Glyph icon={Trash} color="#ffffff" />Delete
        </Button>
        <Button id="done" glass={{ ...g, tint: "#007affe6" }} size="lg" onClick={() => { selected = null; }}>Done</Button>
      </Row>
    );
  }
  return (
    <Row id="tab-bar" style={{ position: "absolute", left: 0, right: 0, bottom: 22, justify: "center", align: "center", gap: 10, zIndex: 10 }}>
      <ToggleGroup id="tabs" glass={g} value={tab} onValueChange={next => { if (next) tab = next as string; }}
        items={[
          { value: "library", label: "Library", content: <TabLabel icon={House} label="Library" active={tab === "library"} /> },
          { value: "for-you", label: "For You", content: <TabLabel icon={Sparkles} label="For You" active={tab === "for-you"} /> },
          { value: "albums", label: "Albums", content: <TabLabel icon={Images} label="Albums" active={tab === "albums"} /> },
        ]} />
      <Input id="search" glass={g} type="search" value={query} placeholder="Search places" onChange={next => { query = next; }} style={{ width: 220, height: 40, radius: 20 }} />
      <Button id="import" glass={{ ...g, tint: "#007affe6" }} onClick={() => notify("Import started", Download)} style={{ height: 40, radius: 20 }}>
        <Glyph icon={Plus} color="#ffffff" />Import
      </Button>
    </Row>
  );
}

function Toast(): VNode {
  const ToastIcon = toast?.icon ?? Mail;
  return (
    <AnimatePresence id="toast-presence" present={toast !== null} enter={{ opacity: 0, top: 50 }} exit={{ opacity: 0, top: 50 }}
      transition={{ opacity: { duration: 200 }, top: { duration: 260, easing: "easeOut" } }}>
      <Row style={{ position: "absolute", left: 0, right: 0, top: 68, justify: "center", zIndex: 40 }}>
        <Glass id="toast" variant="regular" appearance={dark ? "dark" : "light"} tint={legible()} radius={22}
          style={{ height: 44, padding: { left: 16, right: 18 }, direction: "row", align: "center", gap: 10 }}>
          <Glyph icon={ToastIcon} color={accent()} size={17} />
          <Text size={14} weight={600} color={ink()}>{toast?.text ?? ""}</Text>
        </Glass>
      </Row>
    </AnimatePresence>
  );
}

export function App(): VNode {
  return (
    <Window title="Glass Controls" width={1040} height={760} minWidth={760} minHeight={520}
      style={{ background: dark ? "#000000" : "#f5f5f7", radius: 0, borderWidth: 0 }}>
      <View id="stage" style={{ position: "relative", flex: 1, overflow: "hidden" }}>
        <Library />
        <Toolbar />
        <BottomBar />
        <SettingsPopover />
        <Toast />
      </View>
    </Window>
  );
}
