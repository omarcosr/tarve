import {
  AnimatePresence,
  Column,
  Glass,
  Icon,
  Input,
  Pressable,
  Row,
  Scroll,
  Slider,
  Switch,
  Text,
  TitleBar,
  View,
  Window,
  type GlassVariant,
  type IconName,
  type VNode,
} from "@tarve/core";

/**
 * Liquid Glass as in iOS 26: a tab bar, a floating toolbar, a search field that
 * grows out of a button, a now-playing card and a settings sheet, all made of
 * glass over a colourful scrolling background. Scroll the page to see the
 * backdrop blur and bend under them.
 */

let tab = 0;
let searching = false;
let query = "";
let liked = false;
let playing = true;
let progress = 0.37;
let volume = 0.6;
let sheet = false;
let dark = false;
let variant: GlassVariant = "regular";
/** Window controls, as any TitleBar takes them. */
const chrome = { title: "Music", showMinimize: true, showMaximize: false, showClose: true };
/** One full-width glass `<TitleBar>` instead of the three capsules. */
let fullBar = false;
let pointer = { x: 0.5, y: 0.5 };

const WIDTH = 430;
const HEIGHT = 860;

const palette = [
  ["#ff2d55", "#ff9500"], ["#5856d6", "#34c759"], ["#007aff", "#af52de"],
  ["#ffcc00", "#ff3b30"], ["#30b0c7", "#5ac8fa"], ["#a2845e", "#ff9f0a"],
];

const album = (i: number) => `linear-gradient(135deg, ${palette[i % palette.length]![0]}, ${palette[i % palette.length]![1]})`;

function Wallpaper(): VNode {
  // Sharp, saturated shapes: what the glass blurs and bends.
  return (
    <View id="wallpaper" style={{
      position: "absolute", top: 0, left: 0, width: WIDTH, height: HEIGHT, overflow: "hidden",
      background: dark ? "linear-gradient(180deg, #0b1020, #1d1240 60%, #2a0f2f)" : "linear-gradient(180deg, #cde6ff, #f6d2ff 55%, #ffe3c2)"
    }}>
      {[
        { x: -80, y: 60, s: 320, c: "#ff2d55", o: 0.85 }, { x: 240, y: 180, s: 260, c: "#007aff", o: 0.8 },
        { x: 60, y: 420, s: 300, c: "#ffcc00", o: 0.8 }, { x: 260, y: 560, s: 240, c: "#34c759", o: 0.85 },
        { x: -40, y: 700, s: 220, c: "#af52de", o: 0.8 },
      ].map((b, i) => (
        <View key={i} style={{
          position: "absolute", left: b.x, top: b.y, width: b.s, height: b.s, radius: b.s / 2,
          background: `radial-gradient(circle at 35% 30%, #ffffffb0, ${b.c} 45%, ${b.c}00 72%)`, opacity: b.o
        }} />
      ))}
      {/* Hard edges for the lens to bend: a grid and big type. */}
      {Array.from({ length: 8 }, (_, i) => (
        <View key={`h${i}`} style={{ position: "absolute", left: 0, top: 90 + i * 100, width: WIDTH, height: 2, background: dark ? "#ffffff30" : "#1c1c1e26" }} />
      ))}
      {Array.from({ length: 6 }, (_, i) => (
        <View key={`v${i}`} style={{ position: "absolute", left: 40 + i * 70, top: 0, width: 2, height: HEIGHT, background: dark ? "#ffffff24" : "#1c1c1e1f" }} />
      ))}
      <Text id="clock" size={96} weight={800} color={dark ? "#ffffffd9" : "#1c1c1ee6"} style={{ position: "absolute", left: 24, top: 296, letterSpacing: -4 }}>09:41</Text>
      <Text id="date" size={22} weight={600} color={dark ? "#ffffffb3" : "#1c1c1eb3"} style={{ position: "absolute", left: 28, top: 406 }}>Tuesday, June 9</Text>
    </View>
  );
}

function TabItem({ index, icon, label }: { index: number; icon: IconName; label: string }) {
  const active = tab === index;
  return (
    <Pressable id={`tab-${index}`} control={{ role: "tab", label, selected: active }} onClick={() => { tab = index; }}
      style={{
        flex: 1, height: 48, radius: 24, align: "center", justify: "center", gap: 2, direction: "column",
        background: active ? (dark ? "#ffffff2e" : "#ffffffcc") : "#00000000",
        transition: { background: { duration: 220, easing: "easeOut" } },
        hover: { background: active ? (dark ? "#ffffff38" : "#ffffffdd") : (dark ? "#ffffff14" : "#ffffff55") }
      }}>
      <Icon name={icon} size={20} color={active ? "#007aff" : dark ? "#ffffffcc" : "#1c1c1ecc"} />
      <Text size={10} weight={600} color={active ? "#007aff" : dark ? "#ffffffcc" : "#1c1c1ecc"}>{label}</Text>
    </Pressable>
  );
}

function TabBar() {
  const appearance = dark ? "dark" : "light";
  return (
    <Row id="tab-bar-row" style={{ position: "absolute", left: 16, right: 16, bottom: 22, gap: 10, align: "center" }}>
      <Glass id="tab-bar" variant={variant} appearance={appearance} radius={30} style={{ flex: 1, height: 60, padding: 6, direction: "row", gap: 4 }}>
        <TabItem index={0} icon="house" label="Home" />
        <TabItem index={1} icon="star" label="New" />
        <TabItem index={2} icon="folder" label="Library" />
        <TabItem index={3} icon="user" label="You" />
      </Glass>
      <AnimatePresence id="search-presence" present={!searching} exit={{ opacity: 0, width: 0 }} enter={{ opacity: 0 }}
        transition={{ opacity: { duration: 180 }, width: { duration: 260, easing: "easeInOut" } }}>
        <Glass id="search-button" variant={variant} appearance={appearance} radius={30} style={{ width: 60, height: 60, align: "center", justify: "center", overflow: "hidden" }}>
          <Pressable id="search-open" control={{ role: "button", label: "Search" }} onClick={() => { searching = true; }}
            style={{ width: 60, height: 60, radius: 30, align: "center", justify: "center", hover: { background: dark ? "#ffffff14" : "#ffffff55" } }}>
            <Icon name="search" size={22} color={dark ? "#ffffffdd" : "#1c1c1edd"} />
          </Pressable>
        </Glass>
      </AnimatePresence>
    </Row>
  );
}

function SearchSheet() {
  const appearance = dark ? "dark" : "light";
  return (
    <AnimatePresence id="search-field-presence" present={searching} exit={{ opacity: 0, bottom: 10 }} enter={{ opacity: 0, bottom: 10 }}
      transition={{ opacity: { duration: 200 }, bottom: { duration: 260, easing: "easeOut" } }}>
      <Glass id="search-field" variant={variant} appearance={appearance} radius={30}
        style={{ position: "absolute", left: 16, right: 16, bottom: 96, height: 60, padding: { left: 18, right: 8 }, direction: "row", align: "center", gap: 10 }}>
        <Icon name="search" size={20} color={dark ? "#ffffffaa" : "#1c1c1e99"} />
        <Input id="search-input" value={query} placeholder="Search Music" onChange={next => { query = next; }} onSubmit={() => { searching = false; }}
          style={{ flex: 1, background: "#00000000", borderWidth: 0, fontSize: 17, foreground: dark ? "#ffffff" : "#1c1c1e", placeholderColor: dark ? "#ffffff80" : "#1c1c1e80" }} />
        <Pressable id="search-close" control={{ role: "button", label: "Close search" }} onClick={() => { searching = false; query = ""; }}
          style={{ width: 44, height: 44, radius: 22, align: "center", justify: "center", background: dark ? "#ffffff1f" : "#ffffffaa" }}>
          <Icon name="x" size={18} color={dark ? "#ffffffdd" : "#1c1c1edd"} />
        </Pressable>
      </Glass>
    </AnimatePresence>
  );
}

function ToolButton({ id, icon, label, onClick, active }: { id: string; icon: IconName; label: string; onClick: () => void; active?: boolean }) {
  return (
    <Pressable id={id} control={{ role: "button", label }} onClick={onClick}
      style={{
        width: 36, height: 36, radius: 18, align: "center", justify: "center",
        background: active ? "#ff2d55" : "#00000000", transition: { background: { duration: 200 } },
        hover: { background: active ? "#ff375f" : dark ? "#ffffff1a" : "#ffffff66" }, active: { background: active ? "#e0264c" : dark ? "#ffffff2e" : "#ffffff99" }
      }}>
      <Icon name={icon} size={18} color={active ? "#ffffff" : dark ? "#ffffffdd" : "#1c1c1edd"} />
    </Pressable>
  );
}

/**
 * The window's title bar as glass, like the macOS 26 chrome: the title capsule drags the
 * window, the window controls sit in their own capsule. `TitleBar` keeps its usual props
 * (title, showMinimize/showMaximize/showClose); the glass is only its style.
 */
function TopBar() {
  const appearance = dark ? "dark" : "light";
  const ink = dark ? "#ffffff" : "#1c1c1e";
  if (fullBar) {
    // The ordinary TitleBar, made of glass: title, toolbar and controls in one bar over the wallpaper.
    return (
      <TitleBar id="chrome" glass={variant} appearance={appearance} height={52} title={chrome.title}
        showMinimize={chrome.showMinimize} showMaximize={chrome.showMaximize} showClose={chrome.showClose}
        style={{ position: "absolute", top: 0, left: 0, width: WIDTH }}>
        <Row flex={1} align="center" justify="between" gap={8}>
          <Text size={15} weight={700} color={ink}>{chrome.title} · {["Home", "New", "Library", "You"][tab]}</Text>
          <Row gap={2}>
            <ToolButton id="tool-like" icon="heart" label="Like" active={liked} onClick={() => { liked = !liked; }} />
            <ToolButton id="tool-bell" icon="bell" label="Notifications" onClick={() => {}} />
            <ToolButton id="tool-settings" icon="settings" label="Settings" onClick={() => { sheet = !sheet; }} />
          </Row>
        </Row>
      </TitleBar>
    );
  }
    return (
    <Row id="top-bar" style={{ position: "absolute", left: 16, right: 16, top: 14, justify: "between", align: "center", gap: 10 }}>
      <Glass id="title-pill" variant={variant} appearance={appearance} radius={22} dragRegion style={{ height: 44, padding: { left: 18, right: 18 }, justify: "center", flex: 1 }}>
        <Text size={15} weight={700} color={ink}>{chrome.title} · {["Home", "New", "Library", "You"][tab]}</Text>
      </Glass>
      <Glass id="toolbar" variant={variant} appearance={appearance} radius={22} style={{ height: 44, padding: 4, direction: "row", gap: 2 }}>
        <ToolButton id="tool-like" icon="heart" label="Like" active={liked} onClick={() => { liked = !liked; }} />
        <ToolButton id="tool-bell" icon="bell" label="Notifications" onClick={() => {}} />
        <ToolButton id="tool-settings" icon="settings" label="Settings" onClick={() => { sheet = !sheet; }} />
      </Glass>
      {/* A glass TitleBar with a radius is a capsule: full rim and shadow, round controls. */}
      <TitleBar id="chrome" glass={variant} appearance={appearance} height={44} showMinimize={chrome.showMinimize} showMaximize={chrome.showMaximize} showClose={chrome.showClose}
        style={{ radius: 22, padding: { left: 4, right: 4 }, gap: 2 }} />
    </Row>
  );
}

function NowPlaying() {
  const appearance = dark ? "dark" : "light";
  const fg = dark ? "#ffffff" : "#1c1c1e";
  const muted = dark ? "#ffffffa0" : "#1c1c1ea0";
  return (
    <Glass id="now-playing" variant={variant} appearance={appearance} radius={28}
      onPointerMove={({ x, y }) => { pointer = { x: x / 398, y: y / 176 }; }}
      style={{ position: "absolute", left: 16, right: 16, top: 76, height: 176, padding: 16, gap: 12, overflow: "hidden" }}>
      <View id="sheen" style={{
        position: "absolute", top: -120 + pointer.y * 80, left: -120 + pointer.x * 240, width: 300, height: 300, radius: 150,
        background: "radial-gradient(circle, #ffffff66, #ffffff00 60%)", opacity: dark ? 0.35 : 0.7,
        transition: { left: { duration: 120 }, top: { duration: 120 } }
      }} />
      <Row gap={14} align="center">
        <View id="art" style={{ width: 64, height: 64, radius: 14, background: album(tab * 2 + 1), boxShadow: { y: 4, blur: 12, color: "#00000040" } }} />
        <Column flex={1} gap={2}>
          <Text size={17} weight={700} color={fg}>Weightless</Text>
          <Text size={14} color={muted}>Marconi Union · Ambient</Text>
        </Column>
        <ToolButton id="np-like" icon="heart" label="Like" active={liked} onClick={() => { liked = !liked; }} />
      </Row>
      <Slider id="np-progress" label="Position" value={progress} min={0} max={1} step={0.001} onValueChange={next => { progress = next; }}
        style={{ height: 6, radius: 3, background: dark ? "#ffffff33" : "#1c1c1e22", foreground: fg }} />
      <Row gap={6} align="center" justify="center">
        <ToolButton id="np-prev" icon="skip-back" label="Previous" onClick={() => { progress = 0; }} />
        <Pressable id="np-play" control={{ role: "button", label: playing ? "Pause" : "Play" }} onClick={() => { playing = !playing; }}
          style={{ width: 52, height: 52, radius: 26, align: "center", justify: "center", background: fg, hover: { opacity: 0.9 } }}>
          <Icon name={playing ? "pause" : "play"} size={22} color={dark ? "#1c1c1e" : "#ffffff"} />
        </Pressable>
        <ToolButton id="np-next" icon="skip-forward" label="Next" onClick={() => { progress = Math.min(1, progress + 0.1); }} />
      </Row>
    </Glass>
  );
}

function Card({ index }: { index: number }) {
  return (
    <Column id={`card-${index}`} gap={8} style={{ width: 180 }}>
      <View style={{ width: 180, height: 180, radius: 18, background: album(index), boxShadow: { y: 6, blur: 18, color: "#00000033" } }} />
      <Text size={14} weight={600} color={dark ? "#ffffff" : "#1c1c1e"}>{["Daybreak", "Neon Rain", "Low Tide", "Orbit", "Saffron", "Glasshouse"][index % 6]}</Text>
      <Text size={12} color={dark ? "#ffffff99" : "#1c1c1e99"}>Playlist · {12 + index * 3} songs</Text>
    </Column>
  );
}

function Content() {
  return (
    <Scroll id="content" style={{ position: "absolute", top: 0, left: 0, width: WIDTH, height: HEIGHT }}>
      <Column padding={{ top: 450, left: 16, right: 16, bottom: 140 }} gap={28}>
        {Array.from({ length: 5 }, (_, section) => (
          <Column key={section} gap={12}>
            <Text size={22} weight={700} color={dark ? "#ffffff" : "#1c1c1e"}>{["Made for you", "Recently played", "New releases", "Top charts", "Moods"][section]}</Text>
            <Row gap={14} style={{ wrap: true }}>
              <Card index={section * 2} />
              <Card index={section * 2 + 1} />
            </Row>
          </Column>
        ))}
      </Column>
    </Scroll>
  );
}

function SettingsSheet() {
  const appearance = dark ? "dark" : "light";
  const fg = dark ? "#ffffff" : "#1c1c1e";
  const chip = (value: GlassVariant) => (
    <Pressable id={`variant-${value}`} control={{ role: "radio", label: value, checked: variant === value }} onClick={() => { variant = value; }}
      style={{
        height: 34, radius: 17, padding: { left: 14, right: 14 }, align: "center", justify: "center",
        background: variant === value ? fg : dark ? "#ffffff1f" : "#ffffff99", transition: { background: { duration: 180 } }
      }}>
      <Text size={13} weight={600} color={variant === value ? (dark ? "#1c1c1e" : "#ffffff") : fg}>{value}</Text>
    </Pressable>
  );
  return (
    <AnimatePresence id="sheet-presence" present={sheet} exit={{ opacity: 0, top: 102 }} enter={{ opacity: 0, top: 102 }}
      transition={{ opacity: { duration: 220 }, top: { duration: 320, easing: "easeOut" } }}>
      <Glass id="sheet" variant={variant} appearance={appearance} radius={30} dismissOnOutside onOutsideClick={() => { sheet = false; }}
        style={{ position: "absolute", left: 16, right: 16, top: 76, padding: 20, gap: 18 }}>
        <Row justify="between" align="center">
          <Text size={20} weight={700} color={fg}>Glass</Text>
          <Pressable id="sheet-close" control={{ role: "button", label: "Close" }} onClick={() => { sheet = false; }}
            style={{ width: 32, height: 32, radius: 16, align: "center", justify: "center", background: dark ? "#ffffff1f" : "#ffffff99" }}>
            <Icon name="x" size={16} color={fg} />
          </Pressable>
        </Row>
        <Row gap={8}>{chip("regular")}{chip("clear")}{chip("tinted")}</Row>
        <Switch id="dark-switch" label="Dark appearance" checked={dark} onCheckedChange={next => { dark = next; }} style={{ foreground: fg }} />
        <Switch id="bar-switch" label="Full-width glass title bar" checked={fullBar} onCheckedChange={next => { fullBar = next; }} style={{ foreground: fg }} />
        <Column gap={6}>
          <Text size={13} color={dark ? "#ffffffa0" : "#1c1c1ea0"}>Volume</Text>
          <Slider id="volume" label="Volume" value={volume} min={0} max={1} step={0.01} onValueChange={next => { volume = next; }}
            style={{ height: 6, radius: 3, background: dark ? "#ffffff33" : "#1c1c1e22", foreground: fg }} />
        </Column>
        <Text size={12} color={dark ? "#ffffff80" : "#1c1c1e80"}>
          Everything translucent here is a Glass view: blur, edge refraction, saturation and the rim are painted natively; the sheen follows the pointer.
        </Text>
      </Glass>
    </AnimatePresence>
  );
}

export function App() {
  return (
    <Window title="Liquid Glass" width={WIDTH} height={HEIGHT} minWidth={WIDTH} minHeight={600} resizable={false}
      style={{ background: dark ? "#0b1020" : "#cde6ff", radius: 0, borderWidth: 0 }}>
      <View id="phone" style={{ position: "relative", flex: 1, overflow: "hidden" }}>
        <Wallpaper />
        <Content />
        <TopBar />
        <NowPlaying />
        <SettingsSheet />
        <SearchSheet />
        <TabBar />
      </View>
    </Window>
  );
}
