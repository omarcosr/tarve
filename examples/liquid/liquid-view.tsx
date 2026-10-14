import {
  Glass,
  Pressable,
  Svg,
  Text,
  TitleBar,
  View,
  Window,
  type VNode,
} from "@tarve/core";

/**
 * Liquid glass over a vivid wallpaper: a weather card and a big lens that bend what
 * lies under them, and a dock the drops fall into. Glass boxes that share a `merge`
 * key are one surface: when a drop comes close to the dock their shapes bridge and
 * flow together, and when it leaves they neck and part. Move the pointer over the
 * scene to carry a drop of your own.
 */

export const WIDTH = 1168;
export const HEIGHT = 720;

const DOCK = { left: 284, top: 580, width: 600, height: 92 };
const RINGS = { x: 440, y: 380 };

export interface Drop { id: string; size: number; x: number; y: number; opacity: number; duration: number; easing: "easeIn" | "easeOut" | "easeInOut" | "linear"; phase: number }

export const scene = {
  tab: 0,
  drops: true,
  pointer: null as { x: number; y: number } | null,
  lensLift: 0,
  orbit: 0,
  falling: [
    { id: "drop-a", size: 56, x: 360, y: -80, opacity: 0, duration: 0, easing: "easeIn", phase: 0 },
    { id: "drop-b", size: 44, x: 700, y: -80, opacity: 0, duration: 0, easing: "easeIn", phase: 2 },
    { id: "drop-c", size: 66, x: 540, y: -80, opacity: 0, duration: 0, easing: "easeIn", phase: 4 },
  ] as Drop[],
};

const random = (from: number, to: number) => from + Math.random() * (to - from);

/** One beat of the drops' life: appear high up, fall onto the dock, sink in, leave upward and fade. */
export function step(): void {
  scene.orbit = (scene.orbit + 1) % 24;
  scene.lensLift = scene.lensLift === 0 ? 1 : 0;
  if (!scene.drops) return;
  for (const drop of scene.falling) {
    drop.phase = (drop.phase + 1) % 6;
    switch (drop.phase) {
      case 0:
        drop.x = random(DOCK.left + 40, DOCK.left + DOCK.width - 40 - drop.size);
        drop.y = DOCK.top - 320 - random(0, 80);
        drop.opacity = 0;
        drop.duration = 0;
        break;
      case 1:
        drop.opacity = 1;
        drop.duration = 300;
        drop.easing = "easeOut";
        break;
      case 2:
        // Falls onto the dock; the merge bridges the two when the gap closes.
        drop.y = DOCK.top - drop.size + 18;
        drop.duration = 900;
        drop.easing = "easeIn";
        break;
      case 3:
        drop.y = DOCK.top + 8;
        drop.duration = 700;
        drop.easing = "easeOut";
        break;
      case 4:
        drop.y = DOCK.top - drop.size - 60;
        drop.x += random(-60, 60);
        drop.duration = 1000;
        drop.easing = "easeInOut";
        break;
      default:
        drop.y -= 160;
        drop.opacity = 0;
        drop.duration = 900;
        drop.easing = "easeIn";
    }
  }
}

export function Wallpaper(): VNode {
  const dots: { x: number; y: number }[] = [];
  for (let y = 24; y < HEIGHT; y += 40) for (let x = 24; x < WIDTH; x += 40) dots.push({ x, y });
  return (
    <View id="wallpaper" style={{ position: "absolute", top: 0, left: 0, width: WIDTH, height: HEIGHT, overflow: "hidden", background: "linear-gradient(150deg, #2a0f52 0%, #8a1f7a 28%, #e8457a 46%, #3b6fe0 68%, #1e2a6b 100%)" }}>
      <View style={{ position: "absolute", left: -140, top: 240, width: 620, height: 620, radius: 310, background: "radial-gradient(circle at 50% 50%, #ff4d4d, #ff4d4d00 70%)" }} />
      <View style={{ position: "absolute", left: 720, top: -220, width: 640, height: 640, radius: 320, background: "radial-gradient(circle at 50% 50%, #ffb640, #ffb64000 70%)" }} />
      <View style={{ position: "absolute", left: 520, top: 260, width: 500, height: 500, radius: 250, background: "radial-gradient(circle at 50% 50%, #35a9ff99, #35a9ff00 70%)" }} />
      {/* The dot grid and the rings as one picture: hundreds of circles are cheaper that way. */}
      <Svg width={WIDTH} height={HEIGHT} viewBox={[0, 0, WIDTH, HEIGHT]} fill="#ffffff2e" stroke="none" strokeWidth={0} style={{ position: "absolute", left: 0, top: 0 }}>
        <g>{dots.map(d => <circle key={d.x * 10000 + d.y} cx={d.x} cy={d.y} r={3.5} />)}</g>
        <g fill="none" stroke="#ffffffb3" strokeWidth={2.5}>{[38, 86, 134, 182, 230, 278, 326].map(r => <circle key={r} cx={RINGS.x} cy={RINGS.y} r={r} />)}</g>
        <circle cx={RINGS.x} cy={RINGS.y} r={10} fill="none" stroke="#ffffffb3" strokeWidth={2.5} />
      </Svg>
    </View>
  );
}

function WeatherCard(): VNode {
  return (
    <Glass id="weather" variant="clear" tint="#ff3fa64d" radius={30} material={{ blur: 1, refraction: 44, magnify: 0.14, saturate: 1.3 }}
      style={{ position: "absolute", left: 60, top: 76, width: 420, height: 228, padding: 36, justify: "center", gap: 6 }}>
      <Text size={64} weight={700} color="#ffffff" style={{ letterSpacing: -2, lineHeight: 64 }}>18°</Text>
      <Text size={19} color="#ffffffd9">Lisbon · clear, light wind</Text>
    </Glass>
  );
}

function Lens(): VNode {
  return (
    <Glass id="lens" variant="clear" tint="#ffd98a40" radius={125} material={{ blur: 5, refraction: 48, magnify: 0.3, highlight: 1, saturate: 1.4 }}
      style={{ position: "absolute", left: 824, top: 150 - scene.lensLift * 50, width: 250, height: 250, transition: { top: { duration: 2400, easing: "easeInOut" } } }} />
  );
}

function Orbiter(): VNode {
  const angle = (scene.orbit / 24) * Math.PI * 2;
  const r = 232;
  return (
    <Glass id="orbiter" variant="clear" tint="#ffffff1f" radius={24} material={{ blur: 2, refraction: 24, magnify: 0.3 }}
      style={{ position: "absolute", left: RINGS.x + Math.cos(angle) * r - 24, top: RINGS.y + Math.sin(angle) * r - 24, width: 48, height: 48, transition: { left: { duration: 2400, easing: "linear" }, top: { duration: 2400, easing: "linear" } } }} />
  );
}

function DockItem({ index, label }: { index: number; label: string }): VNode {
  const active = scene.tab === index;
  return (
    <Pressable id={`dock-${index}`} control={{ role: "tab", label, selected: active } as never} onClick={() => { scene.tab = index; }}
      style={{ flex: 1, height: 64, radius: 32, align: "center", justify: "center", background: "#00000000", hover: { background: "#ffffff1f" }, transition: { background: { duration: 200, easing: "easeOut" } } }}>
      <Text size={20} weight={600} color={active ? "#ffd166" : "#ffffff"} style={{ transition: { foreground: { duration: 300, easing: "easeOut" } } }}>{label}</Text>
    </Pressable>
  );
}

function Dock(): VNode {
  return (
    // The dock is the surface the drops join: its material and tint are theirs too.
    <Glass id="dock" variant="clear" tint="#bfe3ff4d" radius={46} merge="dock" blend={56} material={{ blur: 6, refraction: 44, magnify: 0.12, highlight: 1, saturate: 1.4 }}
      style={{ position: "absolute", ...DOCK, direction: "row", padding: 14, gap: 4 }}>
      <DockItem index={0} label="Home" />
      <DockItem index={1} label="Search" />
      <DockItem index={2} label="Library" />
      <DockItem index={3} label="Profile" />
    </Glass>
  );
}

function Drops(): VNode {
  return (
    <>
      {scene.falling.map(drop => (
        <Glass key={drop.id} id={drop.id} variant="clear" radius={drop.size / 2} merge="dock" blend={56}
          style={{
            position: "absolute", left: drop.x, top: drop.y, width: drop.size, height: drop.size, opacity: drop.opacity,
            ...(drop.duration > 0 ? { transition: {
              left: { duration: drop.duration, easing: drop.easing },
              top: { duration: drop.duration, easing: drop.easing },
              opacity: { duration: Math.min(drop.duration, 400), easing: "easeOut" },
            } } : {}),
          }} />
      ))}
      {scene.pointer && (
        <Glass id="drop-pointer" variant="clear" radius={30} merge="dock" blend={56}
          style={{ position: "absolute", left: scene.pointer.x - 30, top: scene.pointer.y - 30, width: 60, height: 60, transition: { left: { duration: 120, easing: "easeOut" }, top: { duration: 120, easing: "easeOut" } } }} />
      )}
    </>
  );
}

function Toggle(): VNode {
  return (
    <Pressable id="drops-toggle" onClick={() => { scene.drops = !scene.drops; }} style={{ position: "absolute", right: 24, top: 52, radius: 18 }}>
      <Glass variant="clear" tint="#ffffff26" radius={18} shadow={false} style={{ height: 36, padding: { left: 16, right: 16 }, justify: "center" }}>
        <Text size={13} weight={600} color="#ffffff">{scene.drops ? "Drops: on" : "Drops: off"}</Text>
      </Glass>
    </Pressable>
  );
}

export function App(): VNode {
  return (
    <Window title="Liquid" width={WIDTH} height={HEIGHT} resizable={false} style={{ background: "#2a0f52", radius: 0, borderWidth: 0 }}>
      <View id="stage" style={{ position: "relative", flex: 1, overflow: "hidden" }}
        onPointerMove={({ x, y }: { x: number; y: number }) => { scene.pointer = { x, y }; }}
        onPointerLeave={() => { scene.pointer = null; }}>
        <Wallpaper />
        <WeatherCard />
        <Lens />
        <Orbiter />
        <Dock />
        <Drops />
        <Toggle />
        <TitleBar id="chrome" glass="clear" appearance="dark" title="Liquid" height={36} showMaximize={false} style={{ position: "absolute", left: 0, right: 0, top: 0 }} />
      </View>
    </Window>
  );
}
