import { Column, Glass, Icon, Input, Pressable, Row, Slider, Switch, Text, View, Window, memo, type IconName, type VNode, Image } from "@tarve/core";
import type { SvgNode } from "@tarve/core";

/** 160x24 RGBA noise, deterministic, mostly transparent: the grain of the budget bar. */
const grain = (() => {
  const width = 160, height = 24, rgba = new Uint8Array(width * height * 4);
  let seed = 7;
  for (let i = 0; i < width * height; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const v = seed >>> 24;
    const light = v & 1;
    rgba.set([light ? 255 : 0, light ? 255 : 30, light ? 255 : 10, v < 90 ? 40 + (v % 50) : 0], i * 4);
  }
  return { rgba, width, height, cacheKey: "budget-grain" };
})();


/**
 * A dashboard of liquid-glass widgets (after Rakibul's "Liquid Glass Widget Components"):
 * weather, calendar, smart-home tiles, thermostat, activity, music and batteries, each a
 * Glass panel over a cool blue wallpaper. Blur, edge refraction and rim are native.
 */

const WIDTH = 1100;
const HEIGHT = 760;

let dark = false;
let thermostat = 22;
let brightness = 0.7;
let playing = true;
let progress = 0.42;
let query = "";
let unread = 3;
let menu: "profile" | "notifications" | null = null;
const devices = [
  { id: "lights", label: "Lights", room: "Living room", icon: "bulb", on: true },
  { id: "ac", label: "Air", room: "Bedroom", icon: "fan", on: false },
  { id: "tv", label: "TV", room: "Living room", icon: "tv", on: true },
  { id: "lock", label: "Door", room: "Entrance", icon: "lock", on: true },
] as const satisfies readonly { id: string; label: string; room: string; icon: string; on: boolean }[];
const deviceOn: Record<string, boolean> = Object.fromEntries(devices.map(d => [d.id, d.on]));

const glyphs: Record<string, readonly SvgNode[]> = {
  sun: [["circle", { cx: 12, cy: 12, r: 4 }], ["path", { d: "M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" }]],
  cloud: [["path", { d: "M17.5 19H8a6 6 0 1 1 5.7-8h1.8a4.5 4.5 0 0 1 0 9z" }]],
  rain: [["path", { d: "M17.5 15H8a6 6 0 1 1 5.7-8h1.8a4.5 4.5 0 0 1 0 9zM8 19v2M12 19v2M16 19v2" }]],
  bulb: [["path", { d: "M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V16h8v-1.3A7 7 0 0 0 12 2z" }]],
  fan: [["circle", { cx: 12, cy: 12, r: 2 }], ["path", { d: "M12 10c0-4 1-7 4-7s2 5-2 7M14 12c4 0 7 1 7 4s-5 2-7-2M12 14c0 4-1 7-4 7s-2-5 2-7M10 12c-4 0-7-1-7-4s5-2 7 2" }]],
  tv: [["rect", { x: 2, y: 7, width: 20, height: 13, rx: 2 }], ["path", { d: "m7 2 5 5 5-5" }]],
  lock: [["rect", { x: 4, y: 11, width: 16, height: 10, rx: 2 }], ["path", { d: "M8 11V7a4 4 0 0 1 8 0v4" }]],
  drop: [["path", { d: "M12 2.7 6.3 9.4a7 7 0 1 0 11.4 0z" }]],
  wind: [["path", { d: "M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h8" }]],
  thermo: [["path", { d: "M14 14.8V4a2 2 0 0 0-4 0v10.8a4 4 0 1 0 4 0z" }]],
  battery: [["rect", { x: 2, y: 7, width: 17, height: 10, rx: 2 }], ["path", { d: "M22 11v2" }]],
  phone: [["rect", { x: 6, y: 2, width: 12, height: 20, rx: 3 }], ["path", { d: "M11 18h2" }]],
  watch: [["circle", { cx: 12, cy: 12, r: 6 }], ["path", { d: "M9 6.5 9.5 2h5l.5 4.5M9 17.5l.5 4.5h5l.5-4.5M12 10v2l1 1" }]],
  buds: [["path", { d: "M7 4a3 3 0 0 0-3 3v2a3 3 0 0 0 3 3V19a1 1 0 0 0 2 0V7a3 3 0 0 0-2-3zM17 4a3 3 0 0 1 3 3v2a3 3 0 0 1-3 3V19a1 1 0 0 1-2 0V7a3 3 0 0 1 2-3z" }]],
};

const ink = () => (dark ? "#f4f8ff" : "#14213a");
const muted = () => (dark ? "#f4f8ffa0" : "#14213a99");
const faint = () => (dark ? "#ffffff24" : "#14213a1a");
const accent = "#2f7bff";
const look = () => ({ appearance: (dark ? "dark" : "light") as "dark" | "light" });

function Glyph({ name, size = 20, color }: { name: string; size?: number; color?: string }): VNode {
  return glyphs[name] ? <Icon iconNode={glyphs[name]} size={size} color={color ?? ink()} /> : <Icon name={name as IconName} size={size} color={color ?? ink()} />;
}

function Wallpaper(): VNode {
  const blobs = dark
    ? [{ x: -120, y: -80, s: 520, c: "#1f4fff" }, { x: 640, y: -140, s: 560, c: "#6a3cff" }, { x: 300, y: 380, s: 520, c: "#00a3ff" }, { x: 820, y: 420, s: 420, c: "#13c2c2" }]
    : [{ x: -120, y: -80, s: 520, c: "#5aa2ff" }, { x: 640, y: -140, s: 560, c: "#9db8ff" }, { x: 300, y: 380, s: 520, c: "#6fd3ff" }, { x: 820, y: 420, s: 420, c: "#b7a4ff" }];
  return (
    <View id="wallpaper" style={{
      position: "absolute", top: 0, left: 0, width: WIDTH, height: HEIGHT, overflow: "hidden",
      background: dark ? "linear-gradient(160deg, #050b1d, #0d1838 55%, #101a2e)" : "linear-gradient(160deg, #e9f1ff, #cfdcf2 55%, #dfe7f3)",
    }}>
      {blobs.map((b, i) => (
        <View key={i} style={{ position: "absolute", left: b.x, top: b.y, width: b.s, height: b.s, radius: b.s / 2, background: `radial-gradient(circle at 40% 35%, ${b.c}, ${b.c}00 70%)`, opacity: 0.9 }} />
      ))}
      {Array.from({ length: 5 }, (_, i) => (
        <View key={`r${i}`} style={{ position: "absolute", left: 120 + i * 210, top: 60 + (i % 2) * 380, width: 120, height: 120, radius: 60, borderWidth: 14, borderColor: dark ? "#ffffff22" : "#ffffffaa" }} />
      ))}
    </View>
  );
}

function Widget({ id, children, style, tint }: { id: string; children?: unknown; style?: Record<string, unknown>; tint?: string }): VNode {
  return (
    <Glass id={id} {...look()} variant="regular" tint={tint} radius={28} material={{ blur: 28, saturate: 1.7, refraction: 14, highlight: 0.75, magnify: 0.05 }}
      style={{ padding: 20, gap: 14, overflow: "hidden", ...style }}>
      <View style={{ position: "absolute", top: 0, left: 0, right: 0, height: 90, background: dark ? "linear-gradient(180deg, #ffffff14, #ffffff00)" : "linear-gradient(180deg, #ffffff66, #ffffff00)" }} />
      {children as VNode}
    </Glass>
  );
}

function HeaderButton({ id, label, onClick, children }: { id: string; label: string; onClick: () => void; children?: unknown }): VNode {
  return (
    <Pressable id={id} control={{ role: "button", label }} onClick={onClick}
      style={{ hover: { transform: "scale(1.06)" }, active: { transform: "scale(0.92)" }, transition: { transform: { duration: 360, easing: "spring" } } }}>
      {children as VNode}
    </Pressable>
  );
}

function Header(): VNode {
  return (
    <Row align="center" justify="between" gap={16}>
      <Column gap={2}>
        <Text size={13} weight={600} color={muted()}>Tuesday, 9 June</Text>
        <Text size={28} weight={800} color={ink()} style={{ letterSpacing: -0.6 }}>Good morning, Ana</Text>
      </Column>
      <Row gap={12} align="center">
        <Glass id="search" {...look()} radius={22} style={{ height: 44, width: 260, padding: { left: 16, right: 12 }, direction: "row", align: "center", gap: 10 }}>
          <Icon name="search" size={18} color={muted()} />
          <Input id="search-input" value={query} placeholder="Search devices, rooms…" onChange={next => { query = next; }}
            style={{ flex: 1, height: 36, padding: 0, background: "#00000000", borderWidth: 0, fontSize: 14, foreground: ink(), placeholderColor: muted(), caretColor: accent }} />
          {query ? (
            <Pressable id="search-clear" control={{ role: "button", label: "Clear search" }} onClick={() => { query = ""; }}
              style={{ width: 22, height: 22, radius: 11, align: "center", justify: "center", background: faint() }}>
              <Icon name="x" size={12} color={ink()} />
            </Pressable>
          ) : null}
        </Glass>
        <HeaderButton id="theme" label="Toggle dark mode" onClick={() => { dark = !dark; }}>
          <Glass {...look()} radius={22} style={{ width: 44, height: 44, align: "center", justify: "center" }}>
            <Glyph name={dark ? "sun" : "cloud"} size={18} />
          </Glass>
        </HeaderButton>
        <HeaderButton id="notifications" label={unread ? `${unread} notifications` : "Notifications"} onClick={() => { unread = 0; menu = menu === "notifications" ? null : "notifications"; }}>
          <Glass {...look()} radius={22} style={{ width: 44, height: 44, align: "center", justify: "center" }}>
            <Icon name="bell" size={18} color={ink()} />
            {unread ? <View style={{ position: "absolute", top: 10, right: 11, width: 8, height: 8, radius: 4, background: "#ff4d6d" }} /> : null}
          </Glass>
        </HeaderButton>
        <HeaderButton id="profile" label="Profile" onClick={() => { menu = menu === "profile" ? null : "profile"; }}>
          <View style={{ width: 44, height: 44, radius: 22, background: "linear-gradient(135deg, #7fb2ff, #b28bff)", borderWidth: 2, borderColor: "#ffffffcc", align: "center", justify: "center" }}>
            <Text size={16} weight={700} color="#ffffff">A</Text>
          </View>
        </HeaderButton>
      </Row>
    </Row>
  );
}

function Menu(): VNode | null {
  if (!menu) return null;
  const rows: { icon: string; label: string; hint?: string }[] = menu === "profile"
    ? [{ icon: "user", label: "Ana Costa", hint: "ana@home.app" }, { icon: "settings", label: "Settings" }, { icon: "lock", label: "Sign out" }]
    : [{ icon: "lock", label: "Front door locked", hint: "2 min ago" }, { icon: "bulb", label: "Lights on in living room", hint: "10 min ago" }, { icon: "drop", label: "Humidity back to 48%", hint: "1 h ago" }];
  return (
    <Glass id="menu" {...look()} radius={22} dismissOnOutside onOutsideClick={() => { menu = null; }}
      style={{ position: "absolute", top: 84, right: menu === "profile" ? 28 : 84, width: 260, padding: 8, gap: 2 }}>
      {rows.map((r, i) => (
        <Pressable key={r.label} id={`menu-${i}`} control={{ role: "menuitem", label: r.label }} onClick={() => { menu = null; }}
          style={{ direction: "row", align: "center", gap: 12, padding: { top: 10, bottom: 10, left: 12, right: 12 }, radius: 14, hover: { background: faint() } }}>
          <Glyph name={r.icon} size={18} />
          <Column gap={1} flex={1}>
            <Text size={13} weight={600} color={ink()}>{r.label}</Text>
            {r.hint ? <Text size={11} color={muted()}>{r.hint}</Text> : null}
          </Column>
        </Pressable>
      ))}
    </Glass>
  );
}

function Weather(): VNode {
  const hours = [["Now", "sun", 24], ["11", "sun", 25], ["12", "cloud", 26], ["13", "cloud", 25], ["14", "rain", 22], ["15", "cloud", 23]] as const;
  return (
    <Widget id="weather" style={{ height: 330 }} tint={dark ? "#2f7bff22" : "#2f7bff14"}>
      <Row justify="between" align="start">
        <Column gap={2}>
          <Text size={15} weight={700} color={ink()}>Lisbon</Text>
          <Text size={13} color={muted()}>Mostly sunny</Text>
        </Column>
        <View style={{ width: 64, height: 64, radius: 32, background: "radial-gradient(circle at 40% 35%, #fff6c2, #ffc53d 55%, #ff9f1c)", boxShadow: [{ blur: 30, color: "#ffb02e88" }, { y: 6, blur: 14, color: "#ff8a0055" }] }} />
      </Row>
      <Row align="end" gap={8}>
        <Text size={72} weight={300} color={ink()} style={{ letterSpacing: -3 }}>24°</Text>
        <Column gap={2} style={{ padding: { bottom: 14 } }}>
          <Text size={13} color={muted()}>H 27°  L 17°</Text>
        </Column>
      </Row>
      <Row justify="between">
        {hours.map(([h, g, t]) => (
          <Column key={h} gap={6} align="center">
            <Text size={12} color={muted()}>{h}</Text>
            <Glyph name={g} size={20} color={g === "sun" ? "#ffb02e" : ink()} />
            <Text size={13} weight={600} color={ink()}>{t}°</Text>
          </Column>
        ))}
      </Row>
    </Widget>
  );
}

function Stat({ icon, label, value }: { icon: string; label: string; value: string }): VNode {
  return (
    <Glass {...look()} variant="clear" radius={20} shadow={false} style={{ flex: 1, padding: 14, gap: 8 }}>
      <Glyph name={icon} size={18} color={accent} />
      <Text size={12} color={muted()}>{label}</Text>
      <Text size={18} weight={700} color={ink()}>{value}</Text>
    </Glass>
  );
}

function Climate(): VNode {
  return (
    <Widget id="climate" style={{ flex: 1 }}>
      <Row justify="between" align="center">
        <Text size={15} weight={700} color={ink()}>Climate</Text>
        <Text size={12} color={muted()}>Auto</Text>
      </Row>
      <Row gap={10}>
        <Stat icon="drop" label="Humidity" value="48%" />
        <Stat icon="wind" label="Air" value="Good" />
      </Row>
      <Row align="center" justify="between">
        <Row gap={8} align="center"><Glyph name="thermo" size={18} /><Text size={14} color={ink()}>Thermostat</Text></Row>
        <Text size={22} weight={700} color={ink()}>{thermostat.toFixed(0)}°</Text>
      </Row>
      <Slider id="thermostat" label="Thermostat" value={thermostat} min={16} max={30} step={0.5} onValueChange={v => { thermostat = v; }}
        style={{ width: "100%", height: 22, trackThickness: 8, trackInset: 0, trackBackground: faint(), foreground: "linear-gradient(90deg, #4cc9ff, #2f7bff 50%, #ff7a59)", thumbSize: 22, thumbColor: "#ffffff", thumbBorderWidth: 0, thumbShadow: "0 2px 6px #14213a40" }} />
    </Widget>
  );
}

function Calendar(): VNode {
  const days = ["M", "T", "W", "T", "F", "S", "S"];
  const events = [
    { time: "09:30", title: "Design review", color: "#2f7bff" },
    { time: "12:00", title: "Lunch with Rui", color: "#13c2a3" },
    { time: "16:15", title: "Yoga class", color: "#9b6bff" },
  ];
  return (
    <Widget id="calendar" style={{ height: 330 }}>
      <Row justify="between" align="center">
        <Text size={15} weight={700} color={ink()}>June</Text>
        <Row gap={4}><Icon name="chevron-left" size={16} color={muted()} /><Icon name="chevron-right" size={16} color={muted()} /></Row>
      </Row>
      <Row justify="between">
        {days.map((d, i) => {
          const today = i === 1;
          return (
            <Column key={i} gap={6} align="center" style={{ width: 34, padding: { top: 6, bottom: 6 }, radius: 14, background: today ? accent : "#00000000", boxShadow: today ? { y: 6, blur: 14, color: "#2f7bff66" } : [] }}>
              <Text size={11} color={today ? "#ffffffcc" : muted()}>{d}</Text>
              <Text size={14} weight={700} color={today ? "#ffffff" : ink()}>{8 + i}</Text>
            </Column>
          );
        })}
      </Row>
      <Column gap={8}>
        {events.map(e => (
          <Row key={e.title} gap={10} align="center" style={{ padding: { top: 8, bottom: 8, left: 10, right: 10 }, radius: 14, background: faint() }}>
            <View style={{ width: 4, height: 26, radius: 2, background: e.color }} />
            <Column gap={1} flex={1}>
              <Text size={13} weight={600} color={ink()}>{e.title}</Text>
              <Text size={11} color={muted()}>{e.time}</Text>
            </Column>
          </Row>
        ))}
      </Column>
    </Widget>
  );
}

function Budget(): VNode {
  // After the "Budget used" glass card: thin amber bars fading to white, a green progress capsule.
  const bars = [6, 6, 4, 4, 6, 6, 2, 2, 4, 4, 4, 4, 4, 3, 3, 6, 6, 3, 3, 6, 6, 2, 2, 4, 4, 6, 6, 4, 4, 3, 3];
  const used = 120.95, total = 200, share = used / total;
  return (
    <Widget id="budget" style={{ flex: 1, gap: 10 }} tint={dark ? "#00000033" : "#14213a0f"}>
      <Text size={13} weight={500} color={muted()} style={{ letterSpacing: 0.6 }}>BUDGET USED</Text>
      <Text size={30} weight={700} color={ink()} style={{ letterSpacing: -0.8 }}>${used.toFixed(2)} Millions</Text>
      <Row align="end" justify="between" style={{ flex: 1, minHeight: 50 }}>
        {bars.map((v, i) => (
          <View key={i} style={{ width: 3, height: `${v * 16}%`, radius: 2, background: "linear-gradient(180deg, #f2b705, #f2b705cc 45%, #fff3d6)" }} />
        ))}
      </Row>
      <Glass id="budget-bar" {...look()} variant="clear" radius={14} shadow={false} material={{ blur: 18, saturate: 1.4, refraction: 6, highlight: 0.5 }}
        style={{ height: 40, borderWidth: 1, borderColor: dark ? "#ffffff3a" : "#ffffffc0", overflow: "hidden", direction: "row", align: "center", justify: "between", padding: { left: 14, right: 14 } }}>
        {/* Green that deepens to the left and feathers out past the used share, no hard edge. */}
        <View style={{ position: "absolute", top: 0, left: 0, bottom: 0, width: `${(share + 0.14) * 100}%`,
          background: "linear-gradient(90deg, #3f8a58f2, #5aa271ee 55%, #94cfa0d9 82%, #a8dcb200)" }} />
        {/* Film grain, as in the reference: static RGBA noise over the fill. */}
        <Image src={grain} fit="fill" style={{ position: "absolute", top: 0, left: 0, bottom: 0, width: `${(share + 0.1) * 100}%`, opacity: 0.28 }} />
        <Text size={12} weight={600} color="#ffffff" style={{ textShadow: "0 1px 2px #0003" }}>{(share * 100).toFixed(2)}% of ${total}M</Text>
        <Text size={12} weight={600} color={dark ? "#ffffff" : ink()}>${(total - used).toFixed(2)}M Remaining</Text>
      </Glass>
    </Widget>
  );
}

function DeviceTile({ d }: { d: (typeof devices)[number] }): VNode {
  const on = deviceOn[d.id]!;
  return (
    <Pressable id={`dev-${d.id}`} control={{ role: "switch", label: `${d.label}, ${d.room}`, checked: on }} onClick={() => { deviceOn[d.id] = !on; }}
      style={{ flex: 1, active: { transform: "scale(0.96)" }, transition: { transform: { duration: 380, easing: "spring" } } }}>
      <Glass {...look()} variant={on ? "tinted" : "clear"} tint={on ? (dark ? "#2f7bffaa" : "#2f7bffcc") : undefined} radius={22} shadow={on}
        style={{ height: 112, padding: 14, gap: 6, justify: "between" }}>
        <Row justify="between" align="center">
          <View style={{ width: 36, height: 36, radius: 18, align: "center", justify: "center", background: on ? "#ffffff33" : faint() }}>
            <Glyph name={d.icon} size={18} color={on ? "#ffffff" : ink()} />
          </View>
          {/* The tile is the switch (one control, one click target); this is its state, drawn like
              the glass Switch: a green track when on under an animated glass knob. */}
          <View style={{ position: "relative", width: 36, height: 20, radius: 10, shrink: 0, background: on ? "#34c759" : faint(),
            transition: { background: { duration: 240, easing: "easeOut" } } }}>
            <View style={{ position: "absolute", top: 2, left: on ? 14 : 2, width: 20, height: 16, radius: 8, background: "#fffffff2",
              glass: { blur: 0.5, saturate: 1, refraction: 8, highlight: 1, magnify: 0.12 },
              boxShadow: [{ y: 1, blur: 4, color: "#00000033" }, { y: 0, blur: 1, color: "#0000001a" }],
              transition: { left: { duration: 300, easing: "easeOut" } } }} />
          </View>
        </Row>
        <Column gap={1}>
          <Text size={14} weight={700} color={on ? "#ffffff" : ink()}>{d.label}</Text>
          <Text size={11} color={on ? "#ffffffcc" : muted()}>{d.room} · {on ? "On" : "Off"}</Text>
        </Column>
      </Glass>
    </Pressable>
  );
}

function Home(): VNode {
  return (
    <Widget id="home" style={{ height: 330 }}>
      <Row justify="between" align="center">
        <Text size={15} weight={700} color={ink()}>Smart home</Text>
        <Text size={12} color={muted()}>{Object.values(deviceOn).filter(Boolean).length} active</Text>
      </Row>
      <Row gap={10}><DeviceTile d={devices[0]} /><DeviceTile d={devices[1]} /></Row>
      <Row gap={10}><DeviceTile d={devices[2]} /><DeviceTile d={devices[3]} /></Row>
    </Widget>
  );
}

function Music(): VNode {
  return (
    <Widget id="music" style={{ flex: 1 }}>
      <Row gap={14} align="center">
        <View style={{ width: 58, height: 58, radius: 16, background: "linear-gradient(135deg, #4cc9ff, #6a5cff 60%, #ff6bcb)", boxShadow: { y: 6, blur: 16, color: "#6a5cff55" } }} />
        <Column flex={1} gap={2}>
          <Text size={15} weight={700} color={ink()}>Blue Hour</Text>
          <Text size={12} color={muted()}>Nils Frahm · Living room</Text>
        </Column>
      </Row>
      <Slider id="progress" label="Position" value={progress} min={0} max={1} step={0.001} onValueChange={v => { progress = v; }}
        style={{ width: "100%", height: 14, trackThickness: 5, trackInset: 0, trackBackground: faint(), foreground: ink(), thumbSize: 0, hover: { thumbSize: 12 } }} />
      <Row justify="center" align="center" gap={18}>
        <Icon name="skip-back" size={18} color={ink()} />
        <Pressable id="play" control={{ role: "button", label: playing ? "Pause" : "Play" }} onClick={() => { playing = !playing; }}
          style={{ width: 46, height: 46, radius: 23, align: "center", justify: "center", background: ink(), active: { transform: "scale(0.92)" }, transition: { transform: { duration: 360, easing: "spring" } } }}>
          <Icon name={playing ? "pause" : "play"} size={18} color={dark ? "#14213a" : "#ffffff"} />
        </Pressable>
        <Icon name="skip-forward" size={18} color={ink()} />
      </Row>
    </Widget>
  );
}

function Batteries(): VNode {
  const items = [{ icon: "phone", level: 0.82 }, { icon: "watch", level: 0.46 }, { icon: "buds", level: 0.18 }];
  return (
    <Widget id="batteries" style={{ height: 124, direction: "row", justify: "between", align: "center", gap: 0 }}>
      {items.map(b => {
        const low = b.level < 0.2;
        // A progress ring: the conic gradient fills the round border up to the level, clockwise from the top.
        const fill = `${Math.round(b.level * 1000) / 10}%`;
        return (
          <Column key={b.icon} gap={8} align="center">
            <View style={{ width: 54, height: 54, radius: 27, align: "center", justify: "center", borderWidth: 5, background: faint(),
              borderColor: `conic-gradient(${low ? "#ff4d6d" : "#34c77b"} 0 ${fill}, ${dark ? "#ffffff26" : "#14213a1f"} 0)` }}>
              <Glyph name={b.icon} size={20} />
            </View>
            <Text size={13} weight={700} color={ink()}>{Math.round(b.level * 100)}%</Text>
          </Column>
        );
      })}
    </Widget>
  );
}

function Lighting(): VNode {
  return (
    <Widget id="lighting" style={{ flex: 1, gap: 12 }}>
      <Row justify="between" align="center">
        <Row gap={8} align="center"><Glyph name="bulb" size={18} color="#ffb02e" /><Text size={15} weight={700} color={ink()}>Brightness</Text></Row>
        <Text size={15} weight={700} color={ink()} style={{ fontVariantNumeric: "tabular-nums" }}>{Math.round(brightness * 100)}%</Text>
      </Row>
      <Slider id="brightness" label="Brightness" value={brightness} min={0} max={1} step={0.01} onValueChange={v => { brightness = v; }}
        style={{ width: "100%", height: 34, radius: 17, trackThickness: "fill", thumbSize: 0, trackBackground: faint(), foreground: "linear-gradient(90deg, #ffd27a, #ffb02e)" }} />
    </Widget>
  );
}

/**
 * Each widget renders again only when what it reads changes (passed as props) or a handler
 * inside it ran: dragging the brightness slider renders the Lighting widget, not the whole
 * dashboard.
 */
type Reads = { dark: boolean; a?: unknown; b?: unknown; c?: unknown };
const MWallpaper = memo((_: Reads) => Wallpaper());
const MHeader = memo((_: Reads) => Header());
const MWeather = memo((_: Reads) => Weather());
const MClimate = memo((_: Reads) => Climate());
const MCalendar = memo((_: Reads) => Calendar());
const MBudget = memo((_: Reads) => Budget());
const MHome = memo((_: Reads) => Home());
const MLighting = memo((_: Reads) => Lighting());
const MBatteries = memo((_: Reads) => Batteries());

export function App(): VNode {
  return (
    <Window title="Glass Widgets" width={WIDTH} height={HEIGHT} minWidth={WIDTH} minHeight={HEIGHT} resizable={false}
      style={{ background: dark ? "#050b1d" : "#e9f1ff", radius: 0, borderWidth: 0 }}>
      <View id="stage" style={{ position: "relative", flex: 1, overflow: "hidden" }}>
        <MWallpaper dark={dark} />
        <Column style={{ position: "absolute", top: 0, left: 0, width: WIDTH, height: HEIGHT, padding: 28, gap: 22 }}>
          <MHeader dark={dark} a={query} b={unread} c={menu} />
          <Row gap={20} align="stretch" style={{ flex: 1 }}>
            <Column gap={20} style={{ flex: 1 }}><MWeather dark={dark} /><MClimate dark={dark} a={thermostat} /></Column>
            <Column gap={20} style={{ flex: 1 }}><MCalendar dark={dark} /><MBudget dark={dark} /></Column>
            <Column gap={20} style={{ flex: 1 }}><MHome dark={dark} /><MLighting dark={dark} a={brightness} /><MBatteries dark={dark} /></Column>
          </Row>
        </Column>
        <Menu />
      </View>
    </Window>
  );
}
