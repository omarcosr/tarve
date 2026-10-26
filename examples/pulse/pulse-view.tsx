// Pulse (pulse.egoist.dev) rebuilt in Tarve: Overview, Processes and the
// per-device pages, with live data from pulse-source.ts. Sizes and colours are
// measured from Pulse's own dark screenshots (1240×820).
import { AppWindowIcon } from "@phosphor-icons/react/dist/csr/AppWindow";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { CubeIcon } from "@phosphor-icons/react/dist/csr/Cube";
import { DesktopIcon } from "@phosphor-icons/react/dist/csr/Desktop";
import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";
import { GlobeSimpleIcon } from "@phosphor-icons/react/dist/csr/GlobeSimple";
import { HardDriveIcon } from "@phosphor-icons/react/dist/csr/HardDrive";
import { LightningIcon } from "@phosphor-icons/react/dist/csr/Lightning";
import { ListBulletsIcon } from "@phosphor-icons/react/dist/csr/ListBullets";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { MemoryIcon } from "@phosphor-icons/react/dist/csr/Memory";
import { PauseIcon } from "@phosphor-icons/react/dist/csr/Pause";
import { PlayIcon } from "@phosphor-icons/react/dist/csr/Play";
import { PulseIcon } from "@phosphor-icons/react/dist/csr/Pulse";
import { SidebarSimpleIcon } from "@phosphor-icons/react/dist/csr/SidebarSimple";
import { SquaresFourIcon } from "@phosphor-icons/react/dist/csr/SquaresFour";
import { StackIcon } from "@phosphor-icons/react/dist/csr/Stack";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { XCircleIcon } from "@phosphor-icons/react/dist/csr/XCircle";
import { viewport, Column, darkTheme, Image, Input, memo, Modal, Path, Pressable, Row, Scroll, Svg, Text, Theme, TitleBar, Tooltip, View, VirtualList, Window, type Child, type VNode } from "@tarve/core";
import { cpuBasis, iconFor, setCpuBasis, type CpuBasis, type Proc, type Sample } from "./pulse-source";

export type Page = "overview" | "processes" | "cpu" | "memory" | "gpu" | "disk" | "network" | "energy" | "system";
export type Range = "1m" | "5m" | "15m" | "1h";
type Sort = "cpu" | "memory" | "power" | "name" | "pid" | "threads" | "cpuTime";
type Filter = "all" | "apps" | "system";

/** Samples kept: an hour at one a second. */
const KEEP = 3600;

export const state = {
  page: "overview" as Page,
  range: "1m" as Range,
  paused: false,
  history: [] as Sample[],
  /** Samples pushed so far, including those dropped from `history`. */
  total: 0,
  host: { name: "", model: "", uptime: 0 },
  query: "",
  sort: "cpu" as Sort,
  filter: "all" as Filter,
  selected: null as number | null,
  /** Processes of one program shown as one row; the inspector panel shown. */
  group: false,
  inspector: false,
  /** Grouped apps opened to list their processes; the app row selected (null: a single process). */
  expanded: new Set<string>(),
  selectedGroup: null as string | null,
  /** The toolbar button whose tooltip shows. */
  /** The quit confirmation: which processes, and why the last attempt failed. */
  quit: null as { pids: number[]; name: string; error?: string } | null,
  /** Processes just ended: out of every list at once, and out of later samples until Windows stops reporting them. */
  ended: new Set<number>(),
  /** Takes ended processes out of the samples already shown, without waiting for the next refresh. */
  forget(pids: number[]) {
    for (const pid of pids) this.ended.add(pid);
    for (const sample of this.history) sample.procs = sample.procs.filter(p => !this.ended.has(p.pid));
    if (this.selected !== null && this.ended.has(this.selected)) { this.selected = null; this.selectedGroup = null; }
    this.tick++;
  },
  listOffset: 0,
  /** Measured widths of the dot charts, so their columns fill the card. */
  widths: {} as Record<string, number>,
  /** The chart column under the pointer. */
  hover: null as { id: string; col: number } | null,
  /** Sidebar shown (from the start only where it fits beside the content); settings panel open; the choices made there. */
  sidebar: viewport().width >= 640,
  settings: false,
  prefs: { cpu: cpuBasis() as CpuBasis, interval: "1" as "1" | "2" | "5", network: "bits" as "bits" | "bytes", temperature: "c" as "c" | "f", virtual: "show" as "show" | "hide" },
  skipped: 0,
  /** Bumped per sample (and per new program icon) so memoized regions render again. */
  tick: 0,
  push(sample: Sample) {
    if (this.ended.size) {
      // A process can take a moment to exit; once a sample no longer lists it, its id may be reused.
      const listed = new Set(sample.procs.map(p => p.pid));
      for (const pid of this.ended) if (!listed.has(pid)) this.ended.delete(pid);
      sample.procs = sample.procs.filter(p => !this.ended.has(p.pid));
    }
    // The warm-up sample stands in until the first full one replaces it.
    const warm = this.history.at(-1)?.warmup === true;
    if (warm) { this.history.pop(); this.total--; }
    if (this.paused && !warm && !sample.warmup) return;
    // Refresh every 1, 2 or 5 s: keep one sample in N (each a 1 s reading);
    // the first samples always show.
    if (this.history.length > 0 && ++this.skipped < Number(this.prefs.interval)) return;
    this.skipped = 0;
    this.history.push(sample);
    this.total++;
    if (this.history.length > KEEP) this.history.splice(0, this.history.length - KEEP);
    this.tick++;
  },
};

// Colours sampled from Pulse's dark screenshots.
const c = {
  sidebar: "#19181d", content: "#131315", card: "#1f1e23", raised: "#2a292e", line: "#2a292f", text: "#f5f5f7", muted: "#8e8d93", faint: "#5f5e64",
  select: "#3b82f6", segment: "#232227", segmentOn: "#3f3e44",
  cpu: "#3b82f6", system: "#ef4444", memory: "#22c55e", wired: "#f59e0b", compressed: "#38bdf8", cached: "#8e8d93", gpu: "#f43f5e",
  disk: "#f59e0b", network: "#2dd4bf", battery: "#22c55e", energy: "#facc15", about: "#8e8d93", warn: "#f59e0b",
};
const FONT = "Inter Variable";
const nums = { fontVariantNumeric: "tabular-nums" } as const;
const ellipsis = { whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" } as const;
// Built-in parts (scrollbars, focus rings, menus, the caption buttons) in the same palette.
const pulseTheme = Theme.create(darkTheme, {
  colors: {
    background: c.content, card: c.card, foreground: c.text, muted: c.segmentOn, mutedForeground: c.muted, border: c.line, input: c.segment,
    scrollbar: "#4a494f", ring: "#ffffff55", selection: "#3b82f666", placeholder: c.faint, overlay: "#00000066"
  },
});

// ── formatting ───────────────────────────────────────────────────────────────────────
const pct = (v: number) => (v * 100).toFixed(v < 0.1 ? 1 : 0);
// Sizes as Windows writes them (Task Manager, Explorer): powers of 1024
// labelled KB, MB, GB, with one decimal. Network speeds in bits, powers of
// 1000 (Kbps, Mbps), as Task Manager shows them.
function bytes(n: number): [string, string] {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 * 0.9995 && i < units.length - 1) { n /= 1024; i++; }
  return [i === 0 || n >= 100 ? n.toFixed(0) : n.toFixed(1), units[i]!];
}
const size = (n: number) => bytes(n).join(" ");
const rate = (n: number) => size(n) + "/s";
function bitsParts(bytesPerSecond: number): [string, string] {
  let n = bytesPerSecond * 8, i = 0;
  const units = ["bps", "Kbps", "Mbps", "Gbps"];
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return [i === 0 || n >= 100 ? n.toFixed(0) : n.toFixed(1), units[i]!];
}
const bits = (n: number) => bitsParts(n).join(" ");
/** A network speed in the unit chosen in Settings. */
const netParts = (n: number): [string, string] => { if (state.prefs.network === "bits") return bitsParts(n); const [v, u] = bytes(n); return [v, u + "/s"]; };
const net = (n: number) => netParts(n).join(" ");
const ghz = (v: number | null | undefined) => v == null ? "—" : v.toFixed(2) + " GHz";
const of = (used: number, total: number) => { const [u, uu] = bytes(used), [t, unit] = bytes(total); return uu === unit ? u + "/" + t + " " + unit : size(used) + " / " + size(total); };
const watts = (w: number | null | undefined) => w == null ? "—" : w >= 10 ? w.toFixed(1) + " W" : w >= 1 ? w.toFixed(2) + " W" : (w * 1000).toFixed(0) + " mW";
const celsius = (c: number | null | undefined) => c == null ? "—" : state.prefs.temperature === "f" ? Math.round(c * 9 / 5 + 32) + " °F" : Math.round(c) + " °C";
/** Load per core, in Pulse's words. */
const loadWord = (load: number, cores: number) => load / cores < 0.3 ? "Light" : load / cores < 0.7 ? "Moderate" : "Heavy";
function duration(s: number): string {
  const d = Math.floor(s / 86400), h = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60;
  return d ? d + "d " + h + "h" : h ? h + "h " + m + "m" : m + "m";
}
function clock(s: number): string {
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = Math.floor(s % 60);
  return h + ":" + String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0");
}

// ── icons ───────────────────────────────────────────────────────────────────────────
type IconComponent = (props: { size?: number; weight?: "fill" | "bold" | "regular"; color?: string }) => unknown;
const ICONS: Record<Page | "warn", IconComponent> = {
  overview: SquaresFourIcon, processes: ListBulletsIcon, cpu: CpuIcon, memory: MemoryIcon, gpu: CubeIcon,
  disk: HardDriveIcon, network: GlobeSimpleIcon, energy: LightningIcon, system: DesktopIcon, warn: WarningIcon,
} as never;
function Glyph({ icon, size = 14, color = c.text, weight = "fill", mirrored }: { icon: IconComponent; size?: number; color?: string; weight?: "fill" | "bold" | "regular"; mirrored?: boolean }) {
  const Icon = icon as unknown as (p: { size: number; weight: string; color: string; mirrored?: boolean }) => VNode;
  return mirrored ? <Icon size={size} weight={weight} color={color} mirrored /> : <Icon size={size} weight={weight} color={color} />;
}
/** Pulse's category badge: a filled rounded square with a white glyph (sidebar), or a tinted one (card headers). */
function Badge({ page, color, size = 20, tinted = false }: { page: Page; color: string; size?: number; tinted?: boolean }) {
  return (
    <View style={{ width: size, height: size, radius: size * 0.27, background: tinted ? color + "2e" : color, align: "center", justify: "center", shrink: 0 }}>
      <Glyph icon={ICONS[page]} size={Math.round(size * 0.62)} color={tinted ? color : "#ffffff"} />
    </View>
  );
}
/** A program's own icon (extracted by pulse-source), or a neutral window glyph. */
function AppIcon({ proc, size = 16 }: { proc: Pick<Proc, "path" | "name">; size?: number }) {
  const src = iconFor(proc.path);
  // Keyed by variant: a row showing another app swaps the node instead of
  // changing an image into a view in place, which would rebuild the whole tree.
  return <>{[src
    ? <Image key="icon" src={src} width={size} height={size} fit="contain" style={{ shrink: 0, radius: 0 }} />
    : <View key="fallback" style={{ width: size, height: size, radius: size * 0.25, background: "#3a393f", align: "center", justify: "center", shrink: 0 }}><Glyph icon={AppWindowIcon as never} size={size * 0.7} color={c.muted} /></View>]}</>;
}

// ── history ─────────────────────────────────────────────────────────────────────────
const RANGE_SECONDS: Record<Range, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600 };
/** Samples in the selected range at the chosen refresh interval. */
const span = () => Math.ceil(RANGE_SECONDS[state.range] / Number(state.prefs.interval));
/** The newest samples, as many as the selected range holds. */
const recent = () => state.history.slice(-span());
/**
 * The samples behind column `col` of `count` over the selected range, as
 * running sample numbers [from, to). Columns are buckets fixed in time, not
 * slices of the current window: a new sample only ever moves the chart left by
 * whole columns, so a dot stays with its moment instead of hopping between
 * neighbours. A bucket no sample fell in (more columns than seconds) borrows
 * the previous sample, so it reads like its neighbour instead of a hole.
 */
function bucket(col: number, count: number): [from: number, to: number] | null {
  const per = span() / count;
  const b = Math.floor((state.total - 1) / per) - (count - 1 - col);
  const first = state.total - state.history.length;
  let from = Math.max(first, Math.ceil(b * per));
  const to = Math.min(state.total, Math.ceil((b + 1) * per));
  if (b < 0 || to <= first) return null;
  if (from >= to) from = to - 1;
  return [from, to];
}

/**
 * Every numeric leaf averaged over `samples`; other leaves come from the last.
 * The process list is left out: no readout shows it, and averaging a few
 * hundred processes per column was most of a render.
 */
function mean<T>(samples: T[]): T {
  const last = samples[samples.length - 1]!;
  if (samples.length === 1) return last;
  if (typeof last === "number") return ((samples as number[]).reduce((x, y) => x + y, 0) / samples.length) as T;
  if (Array.isArray(last)) return last.map((_, i) => mean(samples.map(s => (s as unknown[])[i]))) as T;
  if (last && typeof last === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(last)) out[k] = k === "procs" ? (last as Record<string, unknown>)[k] : mean(samples.map(s => (s as Record<string, unknown>)?.[k]).filter(v => v !== undefined && v !== null));
    return out as T;
  }
  return last;
}

/** Column `col`'s sample: the mean of its bucket, which is what its dots show. */
function columnSample(col: number, count: number): { sample: Sample; newest: number } | null {
  const r = bucket(col, count);
  if (!r) return null;
  const first = state.total - state.history.length;
  return { sample: mean(state.history.slice(r[0] - first, r[1] - first)), newest: r[1] - 1 };
}
/** Column `col`'s values: `series` of each sample in its bucket, averaged. */
function columnValues(col: number, count: number, series: (s: Sample) => number[]): number[] | null {
  const r = bucket(col, count);
  if (!r) return null;
  const first = state.total - state.history.length;
  if (r[1] - r[0] === 1) return series(state.history[r[0] - first]!);
  let out: number[] | null = null;
  for (let i = r[0]; i < r[1]; i++) {
    const v = series(state.history[i - first]!);
    if (!out) out = v.slice(); else for (let k = 0; k < out.length; k++) out[k]! += v[k] ?? 0;
  }
  return out!.map(x => x / (r[1] - r[0]));
}
const avg = (v: number[]) => v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;

// ── dot matrix ────────────────────────────────────────────────────────────────────────
type Readout = [label: string, value: string, color: string][];
const AGE_STEPS = 6;

/**
 * Pulse's history chart: a grid of round dots, one column per slice of time,
 * lit from the bottom by stacked series and fading with age toward the left
 * edge. One <Path> per colour and age step; each dot a zero-length round-capped
 * segment. Hovering scrubs it: the column under the pointer is marked and a
 * card above the chart reads that moment out.
 */
function Dots({ id, series, colors, tint, height, pitch = 6.75, readout }: { id: string; series: (s: Sample) => number[]; colors: string[]; tint: string; height: number; pitch?: number; readout?: (s: Sample) => Readout }) {
  const width = state.widths[id] ?? 0;
  const cols = width ? Math.max(2, Math.floor((width - pitch * 1.6) / pitch) + 1) : 0;
  const values = Array.from({ length: cols }, (_, col) => columnValues(col, cols, series));
  const rows = Math.max(1, Math.floor((height - pitch * 1.6) / pitch) + 1);
  const x0 = (width - (cols - 1) * pitch) / 2, y0 = height - (height - (rows - 1) * pitch) / 2;
  const hover = state.hover?.id === id ? Math.max(0, Math.min(cols - 1, state.hover.col)) : -1;
  // paths[colour][age step]: older columns are drawn fainter, as Pulse does.
  const paths = colors.map(() => Array.from({ length: AGE_STEPS }, () => ""));
  let dim = "";
  values.forEach((stack, col) => {
    const x = (x0 + col * pitch).toFixed(1);
    const step = col === hover ? AGE_STEPS - 1 : Math.min(AGE_STEPS - 1, Math.floor((col / Math.max(1, cols - 1)) * AGE_STEPS));
    let row = 0;
    if (stack) {
      // Round the stack's running total, not each series: the column's height
      // follows the sum, series stay in order, and any load lights a dot.
      const parts = stack.map(v => Math.max(0, Math.min(1, v)));
      const total = Math.min(1, parts.reduce((p, q) => p + q, 0));
      const lit = total > 0 ? Math.max(1, Math.round(total * rows)) : 0;
      let sum = 0;
      parts.forEach((v, k) => {
        sum += v;
        const top = k === parts.length - 1 ? lit : Math.min(lit, Math.round((sum / (total || 1)) * lit));
        for (; row < top; row++) paths[k]![step] += "M" + x + " " + (y0 - row * pitch).toFixed(1) + "h.01";
      });
    }
    for (; row < rows; row++) dim += "M" + x + " " + (y0 - row * pitch).toFixed(1) + "h.01";
  });
  const alpha = (step: number) => Math.round((0.45 + 0.55 * (step + 1) / AGE_STEPS) * 255).toString(16).padStart(2, "0");

  // The hovered column's bucket, read out as its dots show it.
  const hovered = hover < 0 ? null : columnSample(hover, cols);
  const sample = hovered?.sample;
  const ago = hovered ? Math.max(0, state.total - 1 - hovered.newest) * Number(state.prefs.interval) : 0;
  const rowsOut = sample && readout ? readout(sample) : [];
  const cardWidth = 176, columnX = x0 + hover * pitch;
  const cardLeft = Math.max(0, Math.min(width - cardWidth, columnX - cardWidth / 2));
  const when = ago === 0 ? "Now" : ago < 60 ? ago + " s ago" : Math.floor(ago / 60) + " min " + (ago % 60 ? (ago % 60) + " s " : "") + "ago";
  return (
    <View style={{ width: "100%", height, position: "relative", zIndex: hover >= 0 ? 20 : 0 }}>
      <View id={id} onSize={size => { if (Math.round(size.width) !== width) { state.widths[id] = Math.round(size.width); state.tick++; } }}
        onPointerMove={point => { const col = Math.round((point.x - x0) / pitch); if (state.hover?.id !== id || state.hover.col !== col) state.hover = { id, col }; }}
        onPointerLeave={() => { if (state.hover?.id === id) state.hover = null; }}
        style={{ width: "100%", height, radius: 10, background: tint + "1a", overflow: "hidden", position: "relative" }}>
        {hover >= 0 ? <View style={{ position: "absolute", left: columnX - pitch / 2, top: 3, width: pitch, height: height - 6, radius: pitch / 2, background: tint + "33" }} /> : null}
        {width ? <Svg width={width} height={height} viewBox={"0 0 " + width + " " + height} fill="none" strokeWidth={pitch * 0.56} strokeLinecap="round" style={{ position: "absolute", left: 0, top: 0 }}>
          <Path d={dim || "M0 0"} stroke={tint + "38"} />
          {/* Every path every time, empty ones too: the tree keeps its shape, so a new sample patches it rather than rebuilding it. */}
          {paths.flatMap((steps, k) => steps.map((d, step) => <Path d={d || "M0 0"} stroke={colors[k]! + alpha(step)} />))}
        </Svg> : null}
      </View>
      {rowsOut.length ? (
        <Column gap={5} style={{
          position: "absolute", left: cardLeft, bottom: height + 8, width: cardWidth, padding: { left: 10, right: 10, top: 8, bottom: 9 }, radius: 10,
          background: "#2c2b31f2", borderWidth: 1, borderColor: "#ffffff14", boxShadow: "0 8px 24px #00000080", pointerEvents: "auto"
        }}>
          <Text size={11} weight={500} color={c.muted} style={nums}>{when}</Text>
          {rowsOut.map(([label, value, color]) => (
            <Row align="center" gap={7}>
              <View style={{ width: 7, height: 7, radius: 4, background: color }} />
              <Text size={12} color={c.text} style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap" }}>{label}</Text>
              <Text size={12} weight={600} style={{ ...nums, whiteSpace: "nowrap" }}>{value}</Text>
            </Row>
          ))}
        </Column>
      ) : null}
    </View>
  );
}
/** Rates on a log scale, so idle traffic still lights a dot. */
const level = (n: number) => n <= 0 ? 0 : Math.min(1, Math.log10(1 + n / 1000) / 5);

// ── cards ───────────────────────────────────────────────────────────────────────────
function Big({ value, unit, size = 34 }: { value: string; unit?: string; size?: number }) {
  return (
    <Row align="end" gap={2}>
      <Text size={size} weight={600} style={{ ...nums, lineHeight: 1, letterSpacing: -0.5 }}>{value}</Text>
      {unit ? <Text size={size * 0.5} weight={500} color={c.muted} style={{ lineHeight: 1, margin: { bottom: size * 0.06 } }}>{unit}</Text> : null}
    </Row>
  );
}
function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <Column gap={3} style={{ flex: 1, minWidth: 0 }}>
      <Text size={12} color={c.muted} style={ellipsis}>{label}</Text>
      <Text size={13} weight={600} style={{ ...ellipsis, ...nums }}>{value}</Text>
      {note ? <Text size={11} color={c.faint} style={ellipsis}>{note}</Text> : null}
    </Column>
  );
}
function Pill({ text, color }: { text: string; color: string }) {
  return (
    <Row align="center" gap={4} style={{ height: 20, padding: { left: 7, right: 8 }, radius: 6, background: color + "26" }}>
      <Glyph icon={ICONS.warn} size={11} color={color} />
      <Text size={11} weight={600} color={color}>{text}</Text>
    </Row>
  );
}
function CardHeader({ page, color, title, aside, caret }: { page: Page; color: string; title: string; aside?: Child; caret?: boolean }) {
  return (
    <Row align="center" gap={9} style={{ height: 24 }}>
      <Badge page={page} color={color} size={24} tinted />
      <Text size={15} weight={600} color={color} style={{ flex: 1 }}>{title}</Text>
      {aside ?? (caret ? <Glyph icon={CaretRightIcon as never} size={13} weight="bold" color={c.faint} /> : null)}
    </Row>
  );
}
/** A header with nothing live in it, rendered once rather than every second. */
const StaticCardHeader = memo((props: { page: Page; color: string; title: string; caret: boolean }) => <CardHeader {...props} />);

function Card({ id, title, page, color, open, aside, children, style }: { id: string; title: string; page: Page; color: string; open?: Page; aside?: Child; children: Child; style?: object }) {
  const header = aside ? <CardHeader page={page} color={color} title={title} aside={aside} /> : <StaticCardHeader page={page} color={color} title={title} caret={!!open} />;
  const base = { flex: 1, minWidth: 0, minHeight: 230, padding: 14, gap: 12, radius: 16, background: c.card, ...style };
  return open
    ? <Pressable id={id} onClick={() => { state.page = open; }} control={{ role: "button", label: title }} style={{ ...base, direction: "column", cursor: "pointer", hover: { background: "#252429" } }}>{header}{children}</Pressable>
    : <Column id={id} style={base}>{header}{children}</Column>;
}

const DOTS_H = 50;

function CpuCard({ s }: { s: Sample }) {
  return (
    <Card id="card-cpu" title="CPU" page="cpu" color={c.cpu} open="cpu">
      <Column gap={4}><Text size={12} color={c.muted}>Now</Text><Big value={pct(s.cpu.user + s.cpu.system)} unit="%" /></Column>
      <Row gap={8}><Stat label="User" value={pct(s.cpu.user) + "%"} /><Stat label="System" value={pct(s.cpu.system) + "%"} /><Stat label="Speed" value={ghz(s.cpu.speed)} /></Row>
      <Dots id="dots-cpu" height={DOTS_H} readout={x => [["User", pct(x.cpu.user) + "%", c.cpu], ["System", pct(x.cpu.system) + "%", c.system]]} tint={c.cpu} colors={[c.system, c.cpu]} series={x => [x.cpu.system, x.cpu.user]} />
    </Card>
  );
}
function MemoryCard({ s }: { s: Sample }) {
  const m = s.memory, [v, u] = bytes(m.used);
  return (
    <Card id="card-memory" title="Memory" page="memory" color={c.memory} open="memory"
      aside={m.commit / Math.max(1, m.commitLimit) > 0.8 || m.free + m.cached < m.total * 0.1 ? <Pill text="Elevated" color={c.warn} /> : undefined}>
      <Column gap={4}><Text size={12} color={c.muted}>{"In use of " + size(m.total)}</Text><Big value={v} unit={u} /></Column>
      <Row gap={8}><Stat label="Available" value={size(m.available)} /><Stat label="Committed" value={of(m.commit, m.commitLimit)} /><Stat label="Cached" value={size(m.cached)} /></Row>
      <Dots id="dots-memory" height={DOTS_H} readout={x => [["App", size(x.memory.app), c.memory], ["Compressed", size(x.memory.compressed), c.compressed], ["Wired", size(x.memory.wired), c.wired]]} tint={c.memory} colors={[c.wired, c.compressed, c.memory]}
        series={x => [x.memory.wired / x.memory.total, x.memory.compressed / x.memory.total, x.memory.app / x.memory.total]} />
    </Card>
  );
}
/** One adapter (`index` into `s.gpus`), or on the overview the one with the most dedicated memory. */
function GpuCard({ s, index }: { s: Sample; index?: number }) {
  const i = index ?? Math.max(0, s.gpus.findIndex(g => g.name === s.gpu?.name));
  const g = s.gpus[i];
  const series = recent().map(x => x.gpus[i]?.util ?? 0);
  const others = index === undefined ? s.gpus.filter((_, k) => k !== i) : [];
  return (
    <Card id={"card-gpu" + (index ?? "")} title={index === undefined ? "GPU" : "GPU " + i} page="gpu" color={c.gpu} open={index === undefined ? "gpu" : undefined}>
      <Column gap={4}><Text size={12} color={c.muted} style={ellipsis}>{g?.name ?? "No GPU"}</Text><Big value={pct(g?.util ?? 0)} unit="%" /></Column>
      <Row gap={8}>
        <Stat label="Dedicated memory" value={g ? of(g.dedicated, g.dedicatedTotal) : "—"} />
        {others.length ? others.map(o => <Stat label={o.name} value={pct(o.util) + "%"} />) : <Stat label="Shared memory" value={g ? of(g.shared, g.sharedTotal) : "—"} />}
        <Stat label={g?.temperature != null ? "Temperature" : "Average"} value={g?.temperature != null ? celsius(g.temperature) : pct(avg(series)) + "%"} />
      </Row>
      <Dots id={"dots-gpu" + (index ?? "")} height={DOTS_H} readout={x => { const y = x.gpus[i]; return [["Utilization", pct(y?.util ?? 0) + "%", c.gpu], ["Dedicated", size(y?.dedicated ?? 0), c.muted]]; }} tint={c.gpu} colors={[c.gpu]} series={x => [x.gpus[i]?.util ?? 0]} />
    </Card>
  );
}
/** Task Manager's per-engine graphs and memory for one adapter. */
function GpuEngines({ s, index }: { s: Sample; index: number }) {
  const g = s.gpus[index]!;
  return (
    <Card id={"gpu-engines" + index} title={"GPU " + index + " · " + g.name} page="gpu" color={c.gpu}>
      <Row gap={12} align="stretch">
        {g.engines.map((e, k) => (
          <Column gap={6} style={{ flex: 1, minWidth: 0 }}>
            <Row><Text size={12} color={c.muted} style={{ ...ellipsis, flex: 1 }}>{e.name}</Text><Text size={12} weight={600} style={nums}>{pct(e.util) + "%"}</Text></Row>
            <Dots id={"dots-gpu" + index + "-" + k} height={44} pitch={6} tint={c.gpu} colors={[c.gpu]} series={x => [x.gpus[index]?.engines.find(y => y.name === e.name)?.util ?? 0]} />
          </Column>
        ))}
      </Row>
      <Rows rows={[["Dedicated GPU memory", of(g.dedicated, g.dedicatedTotal)], ["Shared GPU memory", of(g.shared, g.sharedTotal)], ["GPU memory", of(g.dedicated + g.shared, g.dedicatedTotal + g.sharedTotal)],
      ...(g.temperature != null ? [["Temperature", celsius(g.temperature)] as [string, string]] : []), ...(g.power != null ? [["Power", watts(g.power)] as [string, string]] : [])]} />
    </Card>
  );
}
/** One disk (`index` into `s.disk.disks`), or on the overview every disk's active time. */
function DiskCard({ s, index }: { s: Sample; index?: number }) {
  if (index !== undefined) {
    const d = s.disk.disks[index]!, id = d.index;
    const pick = (x: Sample) => x.disk.disks.find(y => y.index === id);
    return (
      <Card id={"card-disk" + id} title={d.name} page="disk" color={c.disk}>
        <Column gap={4}><Text size={12} color={c.muted} style={ellipsis}>{d.model + " · " + d.kind + " · " + size(d.size)}</Text><Row align="end" gap={8}><Big value={pct(d.active)} unit="%" /><Text size={12} color={c.muted} style={{ margin: { bottom: 3 } }}>active time</Text></Row></Column>
        <Row gap={8}><Stat label="Read speed" value={rate(d.read)} /><Stat label="Write speed" value={rate(d.write)} /><Stat label="Average response time" value={d.response.toFixed(1) + " ms"} /></Row>
        <Dots id={"dots-disk" + id} height={DOTS_H} readout={x => { const y = pick(x); return [["Active time", pct(y?.active ?? 0) + "%", c.disk], ["Read", rate(y?.read ?? 0), c.disk], ["Write", rate(y?.write ?? 0), c.compressed]]; }} tint={c.disk} colors={[c.disk]} series={x => [pick(x)?.active ?? 0]} />
      </Card>
    );
  }
  const busiest = s.disk.disks.reduce<Sample["disk"]["disks"][number] | null>((b, d) => !b || d.active > b.active ? d : b, null);
  return (
    <Card id="card-disk" title="Disk" page="disk" color={c.disk} open="disk">
      <Column gap={4}><Text size={12} color={c.muted} style={ellipsis}>{busiest ? "Active time · " + busiest.name : "No disks"}</Text><Big value={pct(busiest?.active ?? 0)} unit="%" /></Column>
      <Row gap={8}>{s.disk.disks.length > 1 ? s.disk.disks.slice(0, 3).map(d => <Stat label={d.name} value={pct(d.active) + "% · " + rate(d.read + d.write)} />)
        : [<Stat label="Read speed" value={rate(s.disk.read)} />, <Stat label="Write speed" value={rate(s.disk.write)} />]}</Row>
      <Dots id="dots-disk" height={DOTS_H} readout={x => x.disk.disks.map(d => [d.name, pct(d.active) + "%", c.disk] as [string, string, string])} tint={c.disk} colors={[c.disk]} series={x => [Math.max(0, ...x.disk.disks.map(d => d.active))]} />
    </Card>
  );
}
/** One adapter (`index` into `s.net.adapters`), or on the overview the physical adapters together. */
function NetworkCard({ s, index }: { s: Sample; index?: number }) {
  const a = index === undefined ? null : s.net.adapters[index]!;
  const pick = (x: Sample) => a ? x.net.adapters.find(y => y.name === a.name) ?? { down: 0, up: 0 } : x.net;
  const now = pick(s), [v, u] = netParts(now.down);
  return (
    <Card id={"card-network" + (a ? index : "")} title={a ? a.name : "Network"} page="network" color={c.network} open={a ? undefined : "network"}>
      <Column gap={4}><Text size={12} color={c.muted} style={ellipsis}>{a ? a.description + (a.virtual ? " · virtual" : "") : "Receiving"}</Text><Big value={v} unit={u} /></Column>
      <Row gap={8}><Stat label="Sending" value={net(now.up)} />
        {a ? <Stat label="Link speed" value={a.speed > 0 ? bits(a.speed / 8) : "—"} /> : <Stat label="Received" value={size(s.net.received)} />}
        {a ? <Stat label="Type" value={a.wireless ? "Wi-Fi" : a.virtual ? "Virtual" : "Ethernet"} /> : <Stat label="Sent" value={size(s.net.sent)} />}</Row>
      <Dots id={"dots-network" + (a ? index : "")} height={DOTS_H} readout={x => [["Receiving", net(pick(x).down), c.network], ["Sending", net(pick(x).up), c.cpu]]} tint={c.network} colors={[c.network, c.cpu]} series={x => [level(pick(x).down) / 2, level(pick(x).up) / 2]} />
    </Card>
  );
}
function remaining(b: Sample["battery"]): string {
  if (!b) return "—";
  if (b.plugged) return b.charging ? "Charging" : "On power";
  if (!b.draw || !b.fullCapacity) return "—";
  return duration((b.percent * b.fullCapacity) / 1000 / b.draw * 3600);
}
function BatteryCard({ s }: { s: Sample }) {
  const b = s.battery;
  return (
    <Card id="card-battery" title="Battery" page="energy" color={c.battery} open="energy">
      <Column gap={4}><Text size={12} color={c.muted}>{b ? (b.plugged ? "On Power Adapter" : "On Battery") : "No battery"}</Text><Big value={b ? pct(b.percent) : "—"} unit={b ? "%" : undefined} /></Column>
      <Row gap={8}><Stat label="Remaining" value={remaining(b)} /><Stat label="Power Draw" value={watts(b?.draw ?? s.power.system)} /><Stat label="Health" value={b?.health ? pct(b.health) + "%" : "—"} /></Row>
      <Dots id="dots-battery" height={DOTS_H} readout={x => [["Charge", x.battery ? pct(x.battery.percent) + "%" : "—", c.battery], ["Power draw", watts(x.battery?.draw ?? x.power.system), c.energy]]} tint={c.battery} colors={[c.battery]} series={x => [x.battery?.percent ?? 0]} />
    </Card>
  );
}

const DONUT = "M48 12a36 36 0 1 1 0 72a36 36 0 1 1 0-72";
/** Pulse's "Memory by Type": a ring of what holds memory and its legend. */
function MemoryByType({ s }: { s: Sample }) {
  const m = s.memory;
  const parts = [
    { label: "App", value: m.app, color: c.memory },
    { label: "Wired", value: m.wired, color: c.wired },
    { label: "Compressed", value: m.compressed, color: c.compressed },
    { label: "Cached", value: m.cached, color: c.cached },
    { label: "Free", value: m.free, color: "#3a393f" },
  ];
  const circumference = 2 * Math.PI * 36;
  let offset = 0;
  const arcs = parts.slice(0, 4).filter(p => p.value > 0).map(p => {
    const length = Math.max(0, (p.value / m.total) * circumference - 2);
    const arc = { color: p.color, dash: length.toFixed(2) + " " + (circumference - length).toFixed(2), offset: (-offset).toFixed(2) };
    offset += length + 2;
    return arc;
  });
  return (
    <Card id="card-memory-type" title="Memory by Type" page="memory" color={c.memory}>
      <Row align="center" gap={22} style={{ flex: 1 }}>
        <View style={{ width: 96, height: 96, position: "relative", shrink: 0 }}>
          <Svg width={96} height={96} viewBox="0 0 96 96" fill="none" strokeLinecap="round">
            <Path d={DONUT} stroke="#2e2d33" strokeWidth={10} />
            {arcs.map(a => <Path d={DONUT} stroke={a.color} strokeWidth={10} {...{ "stroke-dasharray": a.dash, "stroke-dashoffset": a.offset }} />)}
          </Svg>
          <Column align="center" justify="center" style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }}>
            <Text size={19} weight={700} style={nums}>{pct(m.used / m.total) + "%"}</Text>
            <Text size={10} color={c.muted}>in use</Text>
          </Column>
        </View>
        <Column gap={6} style={{ flex: 1, minWidth: 0 }}>
          {parts.map(p => (
            <Row align="center" gap={8}>
              <View style={{ width: 8, height: 8, radius: 4, background: p.color }} />
              <Text size={13} style={{ flex: 1 }}>{p.label}</Text>
              <Text size={13} color={c.muted} style={nums}>{size(p.value)}</Text>
            </Row>
          ))}
        </Column>
      </Row>
    </Card>
  );
}

function byApp(procs: Proc[], key: "memory" | "cpu" | "power" | "connections"): { proc: Proc; value: number }[] {
  const groups = new Map<string, { proc: Proc; value: number }>();
  for (const p of procs) {
    const g = groups.get(p.name);
    if (g) g.value += p[key]; else groups.set(p.name, { proc: p, value: p[key] });
  }
  return [...groups.values()].sort((a, b) => b.value - a.value);
}

/** Treemap: the biggest app takes the left column, the next two share the middle, four small ones the right. */
function MemoryByApp({ s }: { s: Sample }) {
  const apps = byApp(s.procs, "memory").slice(0, 7);
  const total = byApp(s.procs, "memory").reduce((sum, a) => sum + a.value, 0);
  const tile = (a: { proc: Proc; value: number }, labelled: boolean) => (
    <Column justify="between" style={{ flex: 1, minWidth: 0, minHeight: 0, padding: 8, radius: 9, background: "#2a292e", hover: { background: "#353439" } }}>
      <AppIcon proc={a.proc} size={18} />
      {labelled ? <Column gap={1}><Text size={12} weight={600} style={ellipsis}>{a.proc.name}</Text><Text size={11} color={c.muted} style={nums}>{size(a.value)}</Text></Column> : null}
    </Column>
  );
  return (
    <Card id="card-memory-app" title="Memory by App" page="overview" color={c.memory}
      aside={<Text size={12} color={c.muted} style={nums}>{size(total) + " in all"}</Text>}>
      {apps.length < 7 ? <Text size={12} color={c.muted}>Collecting…</Text> :
        <Row gap={5} align="stretch" style={{ flex: 1, minHeight: 120 }}>
          <Column style={{ flex: 1.3, minWidth: 0 }}>{tile(apps[0]!, true)}</Column>
          <Column gap={5} style={{ flex: 1, minWidth: 0 }}>{tile(apps[1]!, true)}{tile(apps[2]!, true)}</Column>
          <Column gap={5} style={{ flex: 0.5, minWidth: 0 }}>{apps.slice(3, 7).map(a => tile(a, false))}</Column>
        </Row>}
    </Card>
  );
}

/** Energy by app: the measured package and GPU power above idle, split by each app's CPU and GPU time (pulse-source.ts). */
function EnergyByApp({ s }: { s: Sample }) {
  const all = byApp(s.procs, "power");
  const apps = all.slice(0, 5);
  const top = Math.max(0.0001, apps[0]?.value ?? 0);
  return (
    <Card id="card-energy-app" title="Energy by App" page="energy" color={c.energy}
      aside={<Text size={12} color={c.muted} style={nums}>{watts(all.reduce((a, b) => a + b.value, 0)) + " in all"}</Text>}>
      <Column gap={9}>
        {apps.map(a => (
          <Column gap={4}>
            <Row align="center" gap={8}>
              <AppIcon proc={a.proc} size={16} />
              <Text size={13} style={{ ...ellipsis, flex: 1 }}>{a.proc.name}</Text>
              <Text size={12} color={c.muted} style={nums}>{watts(a.value)}</Text>
            </Row>
            <View style={{ height: 4, radius: 2, background: "#2e2d33", margin: { left: 24 } }}>
              <View style={{ width: `${Math.max(2, (a.value / top) * 100)}%` as `${number}%`, height: 4, radius: 2, background: c.energy }} />
            </View>
          </Column>
        ))}
      </Column>
    </Card>
  );
}

const PAD = { left: 24, right: 24, top: 2, bottom: 24 } as const;

function Overview() {
  const s = state.history.at(-1)!;
  return (
    <Scroll id="overview" flex={1} style={{ minHeight: 0, scrollbarWidth: "none" }}>
      <Column gap={16} style={{ padding: PAD }}>
        <Row gap={16} align="stretch" style={{ direction: "column", md: { direction: "row", height: 248 } }}><CpuCard s={s} /><MemoryCard s={s} /><GpuCard s={s} /></Row>
        <Row gap={16} align="stretch" style={{ direction: "column", md: { direction: "row", height: 248 } }}><DiskCard s={s} /><NetworkCard s={s} /><BatteryCard s={s} /></Row>
        <Row gap={16} align="stretch" style={{ minHeight: 230, direction: "column", md: { direction: "row" } }}><MemoryByType s={s} /><MemoryByApp s={s} /><EnergyByApp s={s} /></Row>
      </Column>
    </Scroll>
  );
}

// ── processes ─────────────────────────────────────────────────────────────────────────
const SYSTEM_DIR = /^c:\\windows\\/i;
const isSystem = (p: Proc) => !p.path || SYSTEM_DIR.test(p.path);
const COLUMNS: { key: Sort; label: string; width: number }[] = [
  { key: "cpu", label: "% CPU", width: 64 }, { key: "memory", label: "Memory", width: 84 }, { key: "power", label: "Power", width: 70 },
  { key: "threads", label: "Threads", width: 64 }, { key: "cpuTime", label: "CPU Time", width: 80 }, { key: "pid", label: "PID", width: 56 },
];

type ListRow = Proc & { count?: number };
type Item = { kind: "group"; row: ListRow; open: boolean } | { kind: "proc"; row: ListRow; child: boolean };
/** One row per program: its processes' figures summed, selected through its first process. */
function groupByApp(procs: Proc[]): ListRow[] {
  const groups = new Map<string, ListRow>();
  for (const p of procs) {
    const g = groups.get(p.name);
    if (!g) { groups.set(p.name, { ...p, count: 1 }); continue; }
    g.count!++; g.cpu += p.cpu; g.memory += p.memory; g.power += p.power; g.threads += p.threads; g.cpuTime += p.cpuTime; g.gpu = Math.max(g.gpu, p.gpu);
    g.read += p.read; g.write += p.write; g.connections += p.connections;
  }
  return [...groups.values()];
}
function NoSelection() {
  return (
    <Column align="center" justify="center" gap={6} style={{ width: 266, shrink: 0, background: c.content, borderColor: c.line, borderWidth: { left: 1 } }}>
      <Text size={13} weight={600} color={c.muted}>No Selection</Text>
      <Text size={11} color={c.faint}>Select a process to inspect it</Text>
    </Column>
  );
}

function ProcessRow({ p, index, selected, caret, indent = false }: { p: ListRow; index: number; selected: boolean; caret?: "open" | "closed"; indent?: boolean }) {
  const hot = p.cpu >= 0.25;
  const group = caret !== undefined;
  const toggle = () => { if (state.expanded.has(p.name)) state.expanded.delete(p.name); else state.expanded.add(p.name); };
  return (
    <Pressable id={(group ? "group-" : "proc-") + p.pid} onClick={() => { state.selected = p.pid; state.selectedGroup = group ? p.name : null; state.inspector = true; }}
      control={{ role: "row", label: p.name, ...(group ? { expanded: caret === "open" } : {}) }}
      style={{
        width: "100%", height: 23, direction: "row", align: "center", gap: 10, padding: { left: 8, right: 10 }, radius: 6, cursor: "default",
        background: selected ? c.select : index % 2 ? "#ffffff05" : "transparent", hover: { background: selected ? c.select : "#ffffff10" }
      }}>
      <Row align="center" gap={8} style={{ flex: 1, minWidth: 0, padding: { left: indent ? 34 : state.group && !group ? 18 : 0 } }}>
        {group ? <Pressable id={"expand-" + p.pid} onClick={toggle} control={{ role: "button", label: (caret === "open" ? "Collapse " : "Expand ") + p.name }}
          style={{ width: 12, height: 16, align: "center", justify: "center", cursor: "pointer", shrink: 0 }}>
          <Glyph icon={(caret === "open" ? CaretDownIcon : CaretRightIcon) as never} size={10} weight="bold" color={selected ? c.text : c.muted} />
        </Pressable> : null}
        <AppIcon proc={p} size={15} /><Text size={13} style={ellipsis}>{p.name}</Text>{p.count && p.count > 1 ? <Text size={12} color={selected ? c.text : c.faint} style={nums}>{String(p.count)}</Text> : null}</Row>
      <Text size={13} weight={hot ? 600 : 400} color={selected ? c.text : hot ? c.warn : c.text} style={{ width: 64, shrink: 0, textAlign: "end", ...nums }}>{(p.cpu * 100).toFixed(1)}</Text>
      <Text size={13} color={selected ? c.text : hot ? c.warn : c.text} style={{ width: 84, shrink: 0, textAlign: "end", ...nums }}>{size(p.memory)}</Text>
      <Text size={13} color={selected ? c.text : p.power < 0.0005 ? c.faint : c.text} style={{ width: 70, shrink: 0, textAlign: "end", ...nums }}>{p.power < 0.0005 ? "0" : watts(p.power)}</Text>
      <Text size={13} style={{ width: 64, shrink: 0, textAlign: "end", ...nums }}>{String(p.threads)}</Text>
      <Text size={13} style={{ width: 80, shrink: 0, textAlign: "end", ...nums }}>{clock(p.cpuTime)}</Text>
      <Text size={13} color={selected ? c.text : c.muted} style={{ width: 56, shrink: 0, textAlign: "end", ...nums }}>{p.count && p.count > 1 ? "—" : String(p.pid)}</Text>
    </Pressable>
  );
}

function ProcessDetail({ p }: { p: ListRow }) {
  // A grouped app: every process of the program, summed; otherwise the one process.
  const many = (p.count ?? 1) > 1;
  const mine = (x: Sample) => many ? x.procs.filter(o => o.name === p.name) : x.procs.filter(o => o.pid === p.pid);
  const pids = mine(state.history.at(-1)!).map(o => o.pid);
  const series = (key: "cpu" | "memory") => (x: Sample) => {
    const total = mine(x).reduce((a, q) => a + (key === "cpu" ? q.cpu : q.memory), 0);
    return [key === "cpu" ? total * 4 : total / Math.max(1, x.memory.total) * 4];
  };
  const rows: [string, string][] = [
    ...(many ? [["Processes", String(p.count)] as [string, string]] : []),
    ["CPU time", clock(p.cpuTime)], ["Threads", String(p.threads)], [many ? "Memory, all processes" : "Resident memory", size(p.memory)], ["Power", watts(p.power)], ["GPU", pct(p.gpu) + "%"],
    ["Disk read", rate(p.read)], ["Disk written", rate(p.write)], ["Connections", String(p.connections)],
    ...(many ? [] : [["Parent", String(p.parent)] as [string, string]]), ["Path", p.path ?? "—"],
  ];
  const action = (id: string, label: string, color: string, onClick: () => void, grow = true) => (
    <Pressable id={id} onClick={onClick} control={{ role: "button", label }}
      style={{ ...(grow ? { flex: 1 } : { width: 36 }), height: 30, radius: 8, align: "center", justify: "center", cursor: "pointer", background: "#29282d", borderWidth: 1, borderColor: "#34333a", hover: { background: "#303036" } }}>
      <Text size={13} weight={500} color={color}>{label}</Text>
    </Pressable>
  );
  return (
    <Column gap={12} style={{ width: 266, shrink: 0, padding: { left: 14, right: 14, top: 12, bottom: 12 }, background: c.content, borderColor: c.line, borderWidth: { left: 1 }, minHeight: 0 }}>
      <Row align="center" gap={10}>
        <AppIcon proc={p} size={36} />
        <Column gap={2} style={{ flex: 1, minWidth: 0 }}>
          <Text size={15} weight={700} style={ellipsis}>{p.name}</Text>
          <Text size={11} color={c.muted} style={nums}>{many ? p.count + " processes" : "PID " + p.pid}</Text>
        </Column>
        <Pressable id="close-detail" onClick={() => { state.selected = null; state.selectedGroup = null; }} control={{ role: "button", label: "Close" }}
          style={{ width: 24, height: 24, radius: 6, align: "center", justify: "center", cursor: "pointer", hover: { background: "#ffffff12" } }}>
          <Glyph icon={XIcon as never} size={13} weight="bold" color={c.muted} />
        </Pressable>
      </Row>
      <Row gap={8}>{action("quit", "Quit", c.text, () => { state.quit = { pids, name: p.name }; })}{action("force-quit", "Force Quit", "#f87171", () => { state.quit = { pids, name: p.name }; })}</Row>
      {([["cpu", "CPU", c.cpu, pct(p.cpu) + "%"], ["memory", "Memory", c.memory, size(p.memory)]] as const).map(([key, label, color, value]) => (
        <Column gap={8} style={{ padding: 10, radius: 12, background: color + "1c" }}>
          <Row><Text size={12} weight={600} color={color} style={{ flex: 1 }}>{label}</Text><Text size={12} weight={600} style={nums}>{value}</Text></Row>
          <Dots id={"detail-" + key} height={36} pitch={6} tint={color} colors={[color]} series={series(key)} />
        </Column>
      ))}
      <Text size={11} weight={600} color={c.muted} style={{ margin: { top: 4 } }}>DETAILS</Text>
      <Column gap={9}>
        {rows.map(([k, v]) => (
          <Row gap={10}><Text size={12} color={c.muted} style={{ width: 110 }}>{k}</Text><Text size={12} weight={500} style={{ ...ellipsis, flex: 1, textAlign: "end", ...nums }}>{v}</Text></Row>
        ))}
      </Column>
    </Column>
  );
}

function Processes() {
  const s = state.history.at(-1)!;
  const q = state.query.trim().toLowerCase();
  const list = s.procs.filter(p => (state.filter === "all" || (state.filter === "system") === isSystem(p))
    && (!q || p.name.toLowerCase().includes(q) || String(p.pid) === q));
  const order = <T extends Proc>(rows: T[]) => rows.sort((a, b) => state.sort === "name" ? a.name.localeCompare(b.name) : (b[state.sort] as number) - (a[state.sort] as number));
  // Grouped: one row per app, opened to list its processes beneath it.
  const items: Item[] = state.group
    ? order(groupByApp(list)).flatMap(g => {
      const many = (g.count ?? 1) > 1, open = many && state.expanded.has(g.name);
      const head: Item = many ? { kind: "group", row: g, open } : { kind: "proc", row: g, child: false };
      return open ? [head, ...order(list.filter(p => p.name === g.name)).map(p => ({ kind: "proc", row: p, child: true }) as Item)] : [head];
    })
    : order([...list]).map(p => ({ kind: "proc", row: p, child: false }));
  const selected = state.selected === null ? undefined : s.procs.find(p => p.pid === state.selected);
  // The inspector shows the selected process, or the whole app when its group row is selected.
  const inspected: ListRow | undefined = selected && state.group && state.selectedGroup === selected.name ? groupByApp(s.procs.filter(p => p.name === selected.name))[0] : selected;
  const head = (key: Sort, label: string, width: number | "flex") => (
    <Pressable id={"sort-" + key} onClick={() => { state.sort = key; }} control={{ role: "button", label: "Sort by " + label }}
      style={{ ...(width === "flex" ? { flex: 1 } : { width }), direction: "row", justify: width === "flex" ? "start" : "end", gap: 3, cursor: "pointer" }}>
      <Text size={12} weight={state.sort === key ? 700 : 500} color={state.sort === key ? c.text : c.muted}>{label}</Text>
      {state.sort === key ? <Text size={10} color={c.text}>⌄</Text> : null}
    </Pressable>
  );
  const cpu = s.cpu.user + s.cpu.system;
  return (
    <Column flex={1} style={{ minHeight: 0 }}>
      <Row flex={1} align="stretch" style={{ minHeight: 0 }}>
        <Column flex={1} style={{ minWidth: 0, minHeight: 0, padding: { left: 14, right: 8 } }}>
          <Row align="center" gap={10} style={{ height: 28, padding: { left: 8, right: 10 } }}>
            {head("name", "Name", "flex")}{COLUMNS.map(col => head(col.key, col.label, col.width))}
          </Row>
          <VirtualList id="process-list" items={items} itemHeight={23} overscan={8} keyForItem={x => x.kind === "group" ? "g:" + x.row.name : String(x.row.pid)}
            offset={state.listOffset} onScroll={offset => { state.listOffset = offset; }}
            renderItem={(x, i) => x.kind === "group"
              ? <ProcessRow p={x.row} index={i} caret={x.open ? "open" : "closed"} selected={state.selectedGroup === x.row.name} />
              : <ProcessRow p={x.row} index={i} indent={x.child} selected={state.selectedGroup === null && x.row.pid === state.selected} />} />
        </Column>
        {state.inspector ? inspected ? <ProcessDetail p={inspected} /> : <NoSelection /> : null}
      </Row>
      <Row align="center" justify="end" gap={16} style={{ height: 30, padding: { right: 16 }, borderColor: c.line, borderWidth: { top: 1 } }}>
        {([["CPU", pct(cpu) + "%", c.cpu], ["Memory", size(s.memory.used), c.memory], ["Processes", String(s.procs.length), c.muted]] as const).map(([k, v, color]) => (
          <Row align="center" gap={6}><View style={{ width: 6, height: 6, radius: 3, background: color }} /><Text size={12} color={c.muted}>{k}</Text><Text size={12} weight={600} style={nums}>{v}</Text></Row>
        ))}
      </Row>
    </Column>
  );
}

// ── device pages ──────────────────────────────────────────────────────────────────────
function Legend({ items }: { items: [string, string][] }) {
  return <Row gap={12}>{items.map(([label, color]) => <Row align="center" gap={5}><View style={{ width: 7, height: 7, radius: 4, background: color }} /><Text size={12} color={c.muted}>{label}</Text></Row>)}</Row>;
}
function TopList({ title, page, color, metric, format }: { title: string; page: Page; color: string; metric: "cpu" | "memory" | "power" | "connections"; format: (v: number) => string }) {
  const s = state.history.at(-1)!;
  const apps = byApp(s.procs.filter(p => p.pid !== 4), metric).filter(a => metric !== "connections" || a.value > 0).slice(0, 8);
  const sort: Sort = metric === "connections" ? "cpu" : metric;
  return (
    <Card id={"top-" + page} title={title} page={page} color={color} aside={<Pressable id={"show-all-" + page} onClick={() => { state.page = "processes"; state.sort = sort; state.filter = "all"; state.query = ""; state.selected = null; state.listOffset = 0; }} control={{ role: "button", label: "Show all processes" }}
      style={{ cursor: "pointer", padding: { left: 6, right: 6, top: 2, bottom: 2 }, radius: 6, hover: { background: color + "1f" } }}><Text size={12} weight={600} color={color}>Show All ›</Text></Pressable>}>
      <Row gap={28} align="start">
        {[0, 1].map(half => (
          <Column gap={4} style={{ flex: 1, minWidth: 0 }}>
            {apps.map((a, i) => i % 2 !== half ? null : (
              <Row align="center" gap={10} style={{ height: 26 }}>
                <AppIcon proc={a.proc} size={18} />
                <Text size={13} style={{ ...ellipsis, flex: 1 }}>{a.proc.name}</Text>
                <Text size={13} weight={600} style={nums}>{format(a.value)}</Text>
              </Row>
            ))}
          </Column>
        ))}
      </Row>
    </Card>
  );
}

const MARKS: Record<Range, string[]> = { "1m": ["−1m", "−45s", "−30s", "−15s"], "5m": ["−5m", "−4m", "−3m", "−1m"], "15m": ["−15m", "−10m", "−5m", "−2m"], "1h": ["−1h", "−45m", "−30m", "−15m"] };

/** Pulse's Network page: all traffic over time, each interface, and the apps using the network most. */
function NetworkPage() {
  const s = state.history.at(-1)!;
  const [v, u] = netParts(s.net.down);
  const peak = Math.max(0, ...recent().map(x => x.net.down));
  const adapters = s.net.adapters.flatMap((a, i) => a.virtual && state.prefs.virtual === "hide" ? [] : [i]);
  return (
    <Scroll flex={1} style={{ minHeight: 0, scrollbarWidth: "none" }}>
      <Column gap={16} style={{ padding: PAD }}>
        <Card id="network-traffic" title="Network" page="network" color={c.network} aside={<Legend items={[["Download", c.network], ["Upload", c.cpu]]} />}>
          <Row align="start">
            <Column gap={4} style={{ width: 178 }}><Text size={12} color={c.muted}>Downloading</Text><Big value={v} unit={u} size={40} /></Column>
            {([["Uploading", net(s.net.up)], ["Received", size(s.net.received)], ["Sent", size(s.net.sent)], ["Peak", net(peak)]] as const).map(([label, value]) => (
              <Column gap={3} style={{ width: 163, minWidth: 0 }}><Text size={12} color={c.muted}>{label}</Text><Text size={13} weight={600} style={{ ...ellipsis, ...nums }}>{value}</Text></Column>
            ))}
          </Row>
          <Column gap={6} style={{ margin: { top: 8 } }}>
            <Dots id="dots-network-traffic" height={160} pitch={8} readout={x => [["Download", net(x.net.down), c.network], ["Upload", net(x.net.up), c.cpu]]} tint={c.network} colors={[c.cpu, c.network]}
              series={x => [level(x.net.up) / 2, level(x.net.down) / 2]} />
            <Row justify="between" style={{ padding: { left: 6, right: 6 } }}>{[...MARKS[state.range], "now"].map(m => <Text size={10} color={c.faint}>{m}</Text>)}</Row>
          </Column>
        </Card>
        {adapters.map(i => <InterfaceCard s={s} index={i} />)}
        <TopList title="Using the Network Most" page="network" color={c.network} metric="connections" format={n => n + (n === 1 ? " connection" : " connections")} />
      </Column>
    </Scroll>
  );
}

/** One interface: its traffic now, totals since it came up, and its addresses. */
function InterfaceCard({ s, index }: { s: Sample; index: number }) {
  const a = s.net.adapters[index]!;
  const [v, u] = netParts(a.down);
  const rows: [string, string][] = [["IPv4", a.ipv4.join(", ") || "—"], ["IPv6", a.ipv6[0] ?? "—"], ["Hardware", a.mac || "—"]];
  return (
    <Card id={"interface-" + index} title={a.name} page="network" color={c.network}
      aside={<Text size={12} color={c.muted} style={{ ...ellipsis, maxWidth: 360 }}>{a.description + (a.virtual ? " · virtual" : "")}</Text>}>
      <Column gap={4}><Text size={12} color={c.muted}>Downloading</Text><Big value={v} unit={u} size={28} /></Column>
      <Column gap={0} style={{ margin: { top: 6 } }}>
        <Row gap={8} style={{ margin: { bottom: 8 } }}><Stat label="Uploading" value={net(a.up)} /><Stat label="Received" value={size(a.received)} /><Stat label="Sent" value={size(a.sent)} /></Row>{rows.map(([k, value]) => <Row align="center" style={{ height: 21 }}><Text size={13} color={c.muted} style={{ flex: 1 }}>{k}</Text><Text size={13} weight={600} style={{ ...nums, ...ellipsis, maxWidth: 520 }}>{value}</Text></Row>)}</Column>
    </Card>
  );
}

function CpuPage() {
  const s = state.history.at(-1)!;
  const load = recent().map(x => x.cpu.user + x.cpu.system);
  const marks = MARKS[state.range];
  const procs = s.procs.length, threads = s.procs.reduce((a, p) => a + p.threads, 0);
  return (
    <Scroll flex={1} style={{ minHeight: 0, scrollbarWidth: "none" }}>
      <Column gap={16} style={{ padding: PAD }}>
        <Card id="processor-load" title="Processor Load" page="cpu" color={c.cpu} aside={<Legend items={[["User", c.cpu], ["System", c.system]]} />}>
          <Row gap={24} align="start">
            <Column gap={4} style={{ width: 90 }}><Text size={12} color={c.muted}>Now</Text><Big value={pct(s.cpu.user + s.cpu.system)} unit="%" size={40} /></Column>
            <Stat label="User" value={pct(s.cpu.user) + "%"} /><Stat label="System" value={pct(s.cpu.system) + "%"} />
            <Stat label="Temperature" value={celsius(s.cpu.temperature)} note={s.temperatures.length > 1 ? "hottest " + celsius(Math.max(...s.temperatures.map(t => t.celsius))) : undefined} /><Stat label="Average" value={pct(avg(load)) + "%"} />
          </Row>
          <Column gap={6}>
            <Dots id="dots-cpu-load" height={140} pitch={8} readout={x => [["User", pct(x.cpu.user) + "%", c.cpu], ["System", pct(x.cpu.system) + "%", c.system]]} tint={c.cpu} colors={[c.system, c.cpu]} series={x => [x.cpu.system, x.cpu.user]} />
            <Row justify="between" style={{ padding: { left: 6, right: 6 } }}>{[...marks, "now"].map(m => <Text size={10} color={c.faint}>{m}</Text>)}</Row>
          </Column>
        </Card>
        <Row gap={16} align="stretch">
          <Card id="cores" title="Cores" page="cpu" color={c.cpu} aside={<Text size={12} color={c.muted}>{s.cpu.cores.length + " logical processors"}</Text>}>
            <Row gap={24} align="start">{[0, 1].map(half => <Column gap={6} style={{ flex: 1, minWidth: 0 }}>
              {s.cpu.cores.map((v, i) => i % 2 !== half ? null : (
                <Row align="center" gap={10} style={{ height: 20 }}>
                  <Text size={13} style={{ width: 54 }}>{"Core " + (i + 1)}</Text>
                  <View style={{ flex: 1, height: 5, radius: 3, background: "#2e2d33" }}><View style={{ width: `${Math.max(1, v * 100)}%` as `${number}%`, height: 5, radius: 3, background: i % 2 ? c.compressed : c.cpu }} /></View>
                  <Text size={13} weight={600} style={{ width: 44, shrink: 0, textAlign: "end", ...nums }}>{pct(v) + "%"}</Text>
                </Row>
              ))}
            </Column>)}</Row>
          </Card>
          <Card id="activity" title="Activity" page="cpu" color={c.muted}>
            <Column gap={8}>
              {([["Load, last minute", s.cpu.load[0].toFixed(2) + " · " + loadWord(s.cpu.load[0], s.cpu.cores.length)], ["Load, 5 minutes", s.cpu.load[1].toFixed(2)], ["Load, 15 minutes", s.cpu.load[2].toFixed(2)],
              ["Speed", ghz(s.cpu.speed)], ["Base speed", ghz(s.cpu.baseSpeed)], ["Processes", String(procs)], ["Threads", String(threads)], ["Handles", String(s.memory.handles)], ["Package power", watts(s.cpu.power)], ["Uptime", duration(state.host.uptime)]] as const).map(([k, v]) => (
                <Row><Text size={13} color={c.muted} style={{ flex: 1 }}>{k}</Text><Text size={13} weight={600} style={nums}>{v}</Text></Row>
              ))}
            </Column>
          </Card>
        </Row>
        <TopList title="Using the Most CPU" page="cpu" color={c.cpu} metric="cpu" format={v => pct(v) + "%"} />
      </Column>
    </Scroll>
  );
}

/** The other device pages: the overview card at full width and what uses it most. */
function DevicePage({ page }: { page: Page }) {
  const s = state.history.at(-1)!;
  const pair = (cards: Child[]) => { const rows: Child[] = []; for (let i = 0; i < cards.length; i += 2) rows.push(<Row gap={16} style={{ height: 248 }} align="stretch">{cards[i]}{cards[i + 1] ?? <View style={{ flex: 1 }} />}</Row>); return rows; };
  if (page === "gpu" || page === "disk" || page === "network") {
    const cards = page === "gpu" ? s.gpus.map((_, i) => <GpuCard s={s} index={i} />) : page === "disk" ? s.disk.disks.map((_, i) => <DiskCard s={s} index={i} />) : s.net.adapters.flatMap((a, i) => a.virtual && state.prefs.virtual === "hide" ? [] : [<NetworkCard s={s} index={i} />]);
    return (
      <Scroll flex={1} style={{ minHeight: 0, scrollbarWidth: "none" }}>
        <Column gap={16} style={{ padding: PAD }}>
          {cards.length ? pair(cards) : <Text size={13} color={c.muted}>Nothing to show.</Text>}
          {page === "gpu" ? s.gpus.map((_, i) => <GpuEngines s={s} index={i} />) : null}
        </Column>
      </Scroll>
    );
  }
  const card = page === "memory" ? <MemoryCard s={s} /> : <BatteryCard s={s} />;
  return (
    <Scroll flex={1} style={{ minHeight: 0, scrollbarWidth: "none" }}>
      <Column gap={16} style={{ padding: PAD }}>
        <Row style={{ height: 248 }} align="stretch">{card}</Row>
        {page === "memory" ? <Row gap={16} align="stretch" style={{ minHeight: 230 }}><MemoryByType s={s} /><MemoryByApp s={s} /></Row> : null}
        {page === "memory" ? <Card id="memory-details" title="Memory details" page="memory" color={c.memory}>
          <Rows rows={[["In use", size(s.memory.used)], ["Available", size(s.memory.available)], ["Committed", of(s.memory.commit, s.memory.commitLimit)], ["Cached", size(s.memory.cached)],
          ["Paged pool", size(s.memory.paged)], ["Non-paged pool", size(s.memory.nonpaged)], ["Usable", size(s.memory.total)]]} />
        </Card> : null}
        {page === "memory" ? <TopList title="Using the Most Memory" page="memory" color={c.memory} metric="memory" format={size} /> : null}

      </Column>
    </Scroll>
  );
}

function Rows({ rows }: { rows: [string, string][] }) {
  return (
    <Column gap={8}>
      {rows.map(([k, v]) => <Row><Text size={13} color={c.muted} style={{ flex: 1 }}>{k}</Text><Text size={13} weight={600} style={nums}>{v}</Text></Row>)}
    </Column>
  );
}

/** Battery, what the computer draws, temperatures and energy by app. */
function EnergyPage() {
  const s = state.history.at(-1)!;
  const b = s.battery;
  return (
    <Scroll flex={1} style={{ minHeight: 0, scrollbarWidth: "none" }}>
      <Column gap={16} style={{ padding: PAD }}>
        <Row gap={16} align="stretch" style={{ direction: "column", md: { direction: "row", height: 248 } }}>
          <BatteryCard s={s} />
          <Card id="power" title="Power" page="energy" color={c.energy}>
            <Column gap={4}><Text size={12} color={c.muted}>{b?.draw ? "Drawing from the battery" : "CPU package + GPU"}</Text><Big value={watts(s.power.system).replace(/ m?W$/, "")} unit={watts(s.power.system).endsWith("mW") ? "mW" : "W"} /></Column>
            <Row gap={8}><Stat label="CPU package" value={watts(s.power.cpu)} /><Stat label="GPU" value={watts(s.power.gpu)} /><Stat label="Apps" value={watts(s.procs.reduce((a, p) => a + p.power, 0))} /></Row>
            <Dots id="dots-power" height={DOTS_H} readout={x => [["CPU package", watts(x.power.cpu), c.energy], ["GPU", watts(x.power.gpu), c.gpu]]} tint={c.energy} colors={[c.energy, c.gpu]} series={x => [(x.power.cpu ?? 0) / 120, (x.power.gpu ?? 0) / 120]} />
          </Card>
        </Row>
        <Row gap={16} align="stretch">
          <Card id="battery-health" title="Battery Health" page="energy" color={c.battery}>
            {b ? <Rows rows={[["Health", b.health ? pct(b.health) + "%" : "—"], ["Cycles", b.cycles ? String(b.cycles) : "—"],
            ["Full charge capacity", b.fullCapacity ? (b.fullCapacity / 1000).toFixed(1) + " Wh" : "—"], ["Design capacity", b.designCapacity ? (b.designCapacity / 1000).toFixed(1) + " Wh" : "—"],
            ["Power source", b.plugged ? "Power adapter" : "Battery"], ["State", b.charging ? "Charging" : b.plugged ? "Not charging" : "Discharging"]]} />
              : <Text size={13} color={c.muted}>This computer has no battery.</Text>}
          </Card>
          <Card id="temperatures" title="Temperatures" page="energy" color={c.system}>
            {s.temperatures.length ? <Rows rows={s.temperatures.map(t => [t.name, celsius(t.celsius)] as [string, string])} /> : <Text size={13} color={c.muted}>No sensors readable without administrator rights.</Text>}
          </Card>
        </Row>
        <TopList title="Energy by App" page="energy" color={c.energy} metric="power" format={watts} />
      </Column>
    </Scroll>
  );
}

function About() {
  const s = state.history.at(-1)!;
  const rows: [string, string][] = [["Computer", state.host.name], ["Processor", state.host.model], ["Cores", String(s.cpu.cores.length)],
  ["Memory", size(s.memory.total)], ["Graphics", s.gpus.map(g => g.name).join(", ") || "—"], ["Storage", s.disk.disks.map(d => d.name + " " + d.model + " " + size(d.size)).join(", ") || size(s.disk.total)], ["Uptime", duration(state.host.uptime)]];
  return (
    <Column gap={16} style={{ padding: PAD }}>
      <Card id="about" title="This PC" page="system" color={c.about}>
        <Column>
          {rows.map(([k, v], i) => (
            <Row align="center" style={{ height: 34, borderColor: c.line, borderWidth: { top: i ? 1 : 0 } }}>
              <Text size={13} color={c.muted} style={{ width: 140 }}>{k}</Text><Text size={13} weight={500} style={ellipsis}>{v}</Text>
            </Row>
          ))}
        </Column>
      </Card>
    </Column>
  );
}

// ── shell ───────────────────────────────────────────────────────────────────────────
const SIDEBAR = 220;

function NavItem({ page, label, color, value }: { page: Page; label: string; color: string; value?: string }) {
  const on = state.page === page;
  return (
    <Pressable id={"nav-" + page} onClick={() => { state.page = page; state.selected = null; }} control={{ role: "button", label }}
      style={{
        height: 28, padding: { left: 8, right: 10 }, gap: 9, direction: "row", align: "center", radius: 7, cursor: "pointer",
        background: on ? c.select : "transparent", hover: { background: on ? c.select : "#ffffff0b" }
      }}>
      <Badge page={page} color={on ? "#ffffff40" : color} size={20} />
      <Text size={13} weight={500} style={{ flex: 1 }}>{label}</Text>
      {value ? <Text size={12} color={on ? "#ffffffd9" : c.muted} style={nums}>{value}</Text> : null}
    </Pressable>
  );
}

function Sidebar() {
  const s = state.history.at(-1);
  const section = (t: string) => <Text size={12} weight={600} color={c.faint} style={{ padding: { left: 10, top: 14, bottom: 4 } }}>{t}</Text>;
  return (
    <Column style={{ width: SIDEBAR, shrink: 0, padding: { left: 10, right: 10, top: 0, bottom: 14 }, gap: 1, background: c.sidebar, borderColor: "#232227", borderWidth: { right: 1 } }}>
      <NavItem page="overview" label="Overview" color={c.about} />
      <NavItem page="processes" label="Processes" color={c.about} value={s ? String(s.procs.length) : undefined} />
      {section("Hardware")}
      <NavItem page="cpu" label="CPU" color={c.cpu} value={s ? pct(s.cpu.user + s.cpu.system) + "%" : undefined} />
      <NavItem page="memory" label="Memory" color={c.memory} value={s ? pct(s.memory.used / s.memory.total) + "%" : undefined} />
      <NavItem page="gpu" label="GPU" color={c.gpu} value={s?.gpus.length ? pct(Math.max(...s.gpus.map(g => g.util))) + "%" : undefined} />
      <NavItem page="disk" label="Disk" color={c.disk} value={s ? pct(Math.max(0, ...s.disk.disks.map(d => d.active))) + "%" : undefined} />
      <NavItem page="network" label="Network" color={c.network} value={s ? net(s.net.down + s.net.up) : undefined} />
      <NavItem page="energy" label="Energy" color={c.energy} value={s?.battery ? pct(s.battery.percent) + "%" : undefined} />
      {section("System")}
      <NavItem page="system" label="About This PC" color={c.about} />
      <View flex={1} />
      <Column gap={2} style={{ padding: { left: 8 } }}>
        <Text size={13} weight={600}>{state.host.name}</Text>
        <Text size={11} color={c.muted} style={ellipsis}>{state.host.model + " · Up " + duration(state.host.uptime)}</Text>
      </Column>
    </Column>
  );
}

const TITLES: Record<Page, string> = { overview: "Overview", processes: "Processes", cpu: "CPU", memory: "Memory", gpu: "GPU", disk: "Disk", network: "Network", energy: "Energy", system: "About This PC" };

function Segment<T extends string>({ id, options, value, onChange }: { id: string; options: [T, string][]; value: T; onChange: (v: T) => void }) {
  return (
    <Row gap={2} style={{ padding: 3, radius: 9, background: c.segment }}>
      {options.map(([v, label]) => (
        <Pressable id={id + "-" + v} onClick={() => onChange(v)} control={{ role: "button", label }}
          style={{ height: 22, padding: { left: 10, right: 10 }, radius: 6, align: "center", justify: "center", cursor: "pointer", background: value === v ? c.segmentOn : "transparent" }}>
          <Text size={12} weight={value === v ? 600 : 500} color={value === v ? c.text : c.muted}>{label}</Text>
        </Pressable>
      ))}
    </Row>
  );
}
/** A toolbar button's hover tooltip, dark like Pulse's. */
function Tip({ id, label, children }: { id: string; label: string; children: Child }) {
  return (
    <Tooltip id={id + "-tip"} side="bottom" label={label}
      contentStyle={{ background: "#2c2b31", foreground: c.text, borderWidth: 1, borderColor: "#ffffff1a", radius: 6, boxShadow: "0 4px 14px #00000080" }}
      content={<Text size={12} color={c.text} style={{ whiteSpace: "nowrap" }}>{label}</Text>} trigger={children} />
  );
}
function ToolButton(props: { id: string; icon: IconComponent; label: string; on?: boolean; onClick: () => void; disabled?: boolean; mirrored?: boolean; tint?: string }) {
  // The button itself is the trigger (not a component around it), so its hover opens the tip.
  return <Tip id={props.id} label={props.label}>{ToolButtonFace(props)}</Tip>;
}
function ToolButtonFace({ id, icon, label, on = false, onClick, disabled = false, mirrored, tint }: { id: string; icon: IconComponent; label: string; on?: boolean; onClick: () => void; disabled?: boolean; mirrored?: boolean; tint?: string }) {
  return (
    <Pressable id={id} onClick={() => { if (!disabled) onClick(); }} control={{ role: "button", label }}
      style={{ width: 28, height: 22, radius: 6, align: "center", justify: "center", cursor: disabled ? "default" : "pointer", background: on ? c.segmentOn : "transparent", hover: { background: disabled ? "transparent" : on ? c.segmentOn : "#ffffff12" } }}>
      <Glyph icon={icon} size={13} color={disabled ? c.faint : tint ?? (on ? c.text : c.muted)} mirrored={mirrored} />
    </Pressable>
  );
}
/** The processes of the selected row: one process, or every process of a grouped app. */
function selectedPids(): { pids: number[]; name: string } | null {
  const s = state.history.at(-1);
  const p = state.selected === null ? undefined : s?.procs.find(x => x.pid === state.selected);
  if (!s || !p) return null;
  return { pids: state.group && state.selectedGroup === p.name ? s.procs.filter(x => x.name === p.name).map(x => x.pid) : [p.pid], name: p.name };
}
/** Processes' own tools: group by app, quit the selection, show the inspector. */
function ProcessTools() {
  const target = selectedPids();
  return (
    <Row gap={2} style={{ padding: 3, radius: 9, background: c.segment }}>
      <ToolButton id="group-by-app" icon={StackIcon as never} label={state.group ? "Show every process" : "Group by app"} on={state.group} onClick={() => { state.group = !state.group; state.listOffset = 0; }} />
      <ToolButton id="quit-process" icon={XCircleIcon as never} label="Quit process" disabled={!target} onClick={() => { if (target) state.quit = target; }} />
      <ToolButton id="inspector" icon={SidebarSimpleIcon as never} label={state.inspector ? "Hide inspector" : "Show inspector"} on={state.inspector} mirrored tint={state.inspector ? c.select : undefined} onClick={() => { state.inspector = !state.inspector; state.widths = {}; }} />
    </Row>
  );
}
/** Asks before ending processes; one Windows will not let a user end says why. */
function QuitDialog() {
  const q = state.quit!;
  const end = () => {
    const failed: number[] = [];
    for (const pid of q.pids) { try { process.kill(pid); } catch { failed.push(pid); } }
    state.forget(q.pids.filter(pid => !failed.includes(pid)));
    if (failed.length) state.quit = { ...q, pids: failed, error: failed.length === q.pids.length ? "Windows did not allow it: the process belongs to the system or another user." : failed.length + " of them could not be ended." };
    else { state.quit = null; state.selected = null; }
  };
  const button = (id: string, label: string, primary: boolean, onClick: () => void) => (
    <Pressable id={id} onClick={onClick} control={{ role: "button", label }}
      style={{ height: 28, padding: { left: 14, right: 14 }, radius: 7, align: "center", justify: "center", cursor: "pointer", background: primary ? "#dc2626" : "#34333a", hover: { background: primary ? "#ef4444" : "#3d3c43" } }}>
      <Text size={13} weight={600}>{label}</Text>
    </Pressable>
  );
  // Modal brings the backdrop, Escape and the focus scope; the panel keeps Pulse's look.
  return (
    <Modal id="quit-dialog" open width={340} showClose={false} onOpenChange={open => { if (!open) state.quit = null; }}
      style={{ padding: 18, gap: 10, radius: 14, background: "#232227", borderWidth: 1, borderColor: "#ffffff14", boxShadow: "0 16px 40px #000000aa" }}>
      <Text size={15} weight={700} style={ellipsis}>{q.pids.length > 1 ? "Quit all " + q.pids.length + " processes of “" + q.name + "”?" : "Quit “" + q.name + "”?"}</Text>
      <Text size={12} color={q.error ? c.system : c.muted}>{q.error ?? "Unsaved work in it will be lost."}</Text>
      <Row justify="end" gap={8} style={{ margin: { top: 6 } }}>{button("quit-cancel", "Cancel", false, () => { state.quit = null; })}{button("quit-confirm", q.error ? "Try Again" : "Quit", true, end)}</Row>
    </Modal>
  );
}
function Tools() {
  return (
    <Row gap={2} style={{ padding: 3, radius: 9, background: c.segment }}>
      <ToolButton id="pause" icon={(state.paused ? PlayIcon : PauseIcon) as never} label={state.paused ? "Resume" : "Pause"} on={state.paused} onClick={() => { state.paused = !state.paused; }} />
      <ToolButton id="settings" icon={GearSixIcon as never} label="Settings" on={state.settings} onClick={() => { state.settings = !state.settings; }} />
    </Row>
  );
}
/** Shows or hides the sidebar, as Pulse's toolbar button does. */
function SidebarToggle() {
  return <Tip id="toggle-sidebar" label={state.sidebar ? "Hide sidebar" : "Show sidebar"}>{SidebarToggleFace()}</Tip>;
}
function SidebarToggleFace() {
  return (
    <Pressable id="toggle-sidebar" onClick={() => { state.sidebar = !state.sidebar; state.widths = {}; state.tick++; }} control={{ role: "button", label: state.sidebar ? "Hide sidebar" : "Show sidebar" }}
      style={{ width: 28, height: 26, radius: 6, align: "center", justify: "center", cursor: "pointer", shrink: 0, hover: { background: "#ffffff12" } }}>
      <Glyph icon={SidebarSimpleIcon as never} size={16} weight="regular" color={c.muted} />
    </Pressable>
  );
}

/** The window's own title bar: the sidebar's top strip, then the page title and its tools. */
function Header() {
  const s = state.history.at(-1);
  const subtitle = state.page === "processes" && s ? s.procs.length + " processes · " + s.procs.reduce((a, p) => a + p.threads, 0) + " threads" : state.host.model;
  return (
    <TitleBar id="titlebar" height={54} style={{ background: c.content, foreground: c.text, borderWidth: 0, padding: { left: 0 } }}>
      <Row align="center" style={{ flex: 1, minWidth: 0, height: "100%" }}>
        {state.sidebar ? (
          <Row align="center" gap={8} style={{ width: SIDEBAR, height: "100%", shrink: 0, padding: { left: 18, right: 10 }, background: c.sidebar, borderColor: "#232227", borderWidth: { right: 1 } }}>
            <Glyph icon={PulseIcon as never} size={16} weight="bold" color={c.cpu} />
            <Text size={13} weight={600} color={c.muted} style={{ flex: 1 }}>Pulse</Text>
            <SidebarToggle />
          </Row>
        ) : null}
        <Row align="center" gap={12} style={{ flex: 1, minWidth: 0, height: "100%", padding: { left: state.sidebar ? 24 : 12, right: 12 } }}>
          {state.sidebar ? null : <SidebarToggle />}
          <Column gap={1} style={{ flex: 1, minWidth: 0 }}>
            <Text size={15} weight={700}>{TITLES[state.page]}</Text>
            <Text size={11} color={c.muted} style={{ ...ellipsis, ...nums }}>{subtitle}</Text>
          </Column>
          {state.page === "processes" ? <>
            <View style={{ width: 200, height: 28, position: "relative" }}>
              <Input id="process-search" type="search" placeholder="Search" value={state.query} onChange={v => { state.query = v; }}
                style={{
                  width: "100%", height: 28, minWidth: 0, radius: 8, background: c.segment, borderColor: c.segment, foreground: c.text, fontSize: 13, padding: { left: 28, right: 10 },
                  focus: { borderColor: c.select, outlineWidth: 0 }
                }} />
              <View style={{ position: "absolute", left: 9, top: 7 }}><Glyph icon={MagnifyingGlassIcon as never} size={14} weight="bold" color={c.muted} /></View>
            </View>
            <Segment id="filter" value={state.filter} onChange={v => { state.filter = v; }} options={[["all", "All"], ["apps", "Apps"], ["system", "System"]]} />
            <ProcessTools />
          </> : <Segment id="range" value={state.range} onChange={v => { state.range = v; }} options={[["1m", "1m"], ["5m", "5m"], ["15m", "15m"], ["1h", "1h"]]} />}
          <Tools />
        </Row>
      </Row>
    </TitleBar>
  );
}

/** The settings popover under the gear: refresh rate and how figures are shown. */
function Settings() {
  const set = (apply: () => void) => { apply(); state.tick++; };
  const row = (label: string, note: string, control: Child) => (
    <Row align="center" gap={12} style={{ minHeight: 34 }}>
      <Column gap={1} style={{ flex: 1, minWidth: 0 }}><Text size={13} weight={500}>{label}</Text><Text size={11} color={c.muted} style={ellipsis}>{note}</Text></Column>
      {control}
    </Row>
  );
  const p = state.prefs;
  return (
    <>
      <Pressable id="settings-backdrop" onClick={() => { state.settings = false; }} control={{ role: "button", label: "Close settings" }}
        style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, zIndex: 40, background: "transparent" }} />
      <Column gap={8} style={{
        position: "absolute", right: 12, top: 50, width: 340, zIndex: 41, padding: { left: 14, right: 14, top: 12, bottom: 12 }, radius: 12,
        background: "#232227f7", borderWidth: 1, borderColor: "#ffffff14", boxShadow: "0 12px 32px #00000099"
      }}>
        <Text size={13} weight={700}>Settings</Text>
        {row("CPU usage", p.cpu === "time" ? "Time busy, as Task Manager on Windows 11 24H2+" : "Utility at the actual clock, as older Task Managers", <Segment id="pref-cpu" value={p.cpu} onChange={v => set(() => { p.cpu = v; setCpuBasis(v); })} options={[["time", "Time"], ["utility", "Utility"]]} />)}
        {row("Refresh every", "How often charts take a sample", <Segment id="pref-interval" value={p.interval} onChange={v => set(() => { p.interval = v; state.skipped = 0; })} options={[["1", "1 s"], ["2", "2 s"], ["5", "5 s"]]} />)}
        {row("Network speed", "Task Manager shows bits", <Segment id="pref-network" value={p.network} onChange={v => set(() => { p.network = v; })} options={[["bits", "Bits"], ["bytes", "Bytes"]]} />)}
        {row("Temperature", "Sensors that Windows exposes", <Segment id="pref-temperature" value={p.temperature} onChange={v => set(() => { p.temperature = v; })} options={[["c", "°C"], ["f", "°F"]]} />)}
        {row("Virtual adapters", "VPN tunnels, WSL and Hyper-V", <Segment id="pref-virtual" value={p.virtual} onChange={v => set(() => { p.virtual = v; })} options={[["show", "Show"], ["hide", "Hide"]]} />)}
      </Column>
    </>
  );
}

const Main = memo((_: { prefs: unknown; page: Page; tick: number; range: Range; query: string; sort: Sort; filter: Filter; selected: number | null; listOffset: number; hover: unknown; group: boolean; inspector: boolean; expanded: string; selectedGroup: string | null }) => {
  if (!state.history.length) return <Column flex={1} align="center" justify="center"><Text color={c.muted}>Reading the system…</Text></Column>;
  const page = state.page;
  return page === "overview" ? <Overview /> : page === "processes" ? <Processes /> : page === "cpu" ? <CpuPage /> : page === "network" ? <NetworkPage /> : page === "energy" ? <EnergyPage /> : page === "system" ? <About /> : <DevicePage page={page} />;
});
const Side = memo((_: { page: Page; tick: number; prefs: unknown }) => <Sidebar />);

export function PulseView() {
  return (
    <Window title="Pulse" width={1240} height={820} minWidth={900} minHeight={560} position="center" theme={pulseTheme}
      style={{ background: c.content, foreground: c.text, fontFamily: FONT }}>
      <Header />
      <Row flex={1} align="stretch" style={{ minHeight: 0 }}>
        {state.sidebar ? <Side page={state.page} tick={state.tick} prefs={{ ...state.prefs }} /> : null}
        <Column flex={1} style={{ minWidth: 0, minHeight: 0 }}>
          <Main prefs={{ ...state.prefs }} page={state.page} tick={state.tick} range={state.range} query={state.query} sort={state.sort} filter={state.filter} selected={state.selected} listOffset={state.listOffset} hover={state.hover} group={state.group} inspector={state.inspector} expanded={[...state.expanded].join("\n")} selectedGroup={state.selectedGroup} />
        </Column>
      </Row>
      {state.settings ? <Settings /> : null}
      {state.quit ? <QuitDialog /> : null}
    </Window>
  );
}
