import {
  Badge,
  Button,
  Column,
  Input,
  Row,
  Scroll,
  Text,
  TitleBar,
  ToggleGroup,
  View,
  VirtualList,
  Window,
  darkTheme,
  theme,
} from "@tarve/core";

// The performance sequence from the launch film: a 100,000-row VirtualList
// that flies to a row at high speed, plus a card grid that reflows live as the
// native window is resized.
//
// Native scroll position is owned by the runtime: a VirtualList `offset` only
// mirrors it. Programmatic scrolling therefore goes through
// `app.scrollToItem`, which needs a keyed VirtualList (`id` +
// `estimatedItemHeight`). The windowed form mounts only the rows around the
// viewport, so 100,000 rows cost the same per update as 60.

const c = theme.colors;

const ADJ = ["Async", "Native", "Retained", "Vector", "Layout", "Glyph", "Frame", "Signal", "Shader", "Buffer", "Portal", "Cursor", "Atlas", "Scene"];
const NOUN = ["Pipeline", "Surface", "Node", "Batch", "Viewport", "Tree", "Queue", "Handle", "Layer", "Region", "Stream", "Cache", "Commit"];

export const ROW_COUNT = 100_000;
export const ROW_HEIGHT = 48;
export const LIST_HEIGHT = 560;
export const LIST_ID = "performance-list";
// Rows mounted above and below the viewport.
const WINDOW_MARGIN = 24;
export const TARGET_ROW = 84_216;

export interface ListItem {
  index: number;
  title: string;
  node: string;
  ms: number;
}

// Deterministic row data so every run shows the same list.
function mix(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

export const rows: ListItem[] = Array.from({ length: ROW_COUNT }, (_, index) => {
  const h = mix(index);
  return {
    index,
    title: `${ADJ[h % ADJ.length]} ${NOUN[(h >>> 8) % NOUN.length]}`,
    node: (h & 0xffffff).toString(16).padStart(6, "0"),
    ms: 0.05 + ((h >>> 4) % 40) / 100,
  };
});

export const cards = ["Dialog", "Sidebar", "Tabs", "Table", "Slider", "Toast", "Select", "Tree", "Menu", "Card", "Sheet", "Chart", "Diff", "Code", "Markdown", "Resizable"];

let view = "list";
let offset = 0;
let jumpText = String(TARGET_ROW);
let flight: { from: number; to: number; started: number; duration: number } | undefined;
let flightTimer: ReturnType<typeof setInterval> | undefined;
let lastFlight = "";

let refresh = () => { };
let scrollToItem: (id: string, index: number, offset?: number) => void = () => { };
export function connectPerformance(app: { update(): void; scrollToItem(id: string, index: number, offset?: number): void }) {
  refresh = () => app.update();
  scrollToItem = (id, index, offset) => app.scrollToItem(id, index, offset);
}

const maxOffset = () => ROW_COUNT * ROW_HEIGHT - LIST_HEIGHT;
const clampOffset = (value: number) => Math.max(0, Math.min(value, maxOffset()));
const easeInOutQuint = (t: number) => (t < 0.5 ? 16 * t ** 5 : 1 - (-2 * t + 2) ** 5 / 2);

function scrollListTo(position: number) {
  offset = clampOffset(position);
  const index = Math.floor(offset / ROW_HEIGHT);
  scrollToItem(LIST_ID, index, offset - index * ROW_HEIGHT);
}

function stopFlight() {
  if (flightTimer) clearInterval(flightTimer);
  flightTimer = undefined;
  flight = undefined;
}

/** Eases the list to `row` with one native scroll request per ~16 ms tick. */
export function flyTo(row: number, duration = 900) {
  stopFlight();
  const to = clampOffset(Math.max(0, Math.min(Math.floor(row), ROW_COUNT - 1)) * ROW_HEIGHT);
  flight = { from: offset, to, started: performance.now(), duration };
  let ticks = 0;
  flightTimer = setInterval(() => {
    if (!flight) return;
    ticks++;
    const elapsed = performance.now() - flight.started;
    const k = Math.min(1, elapsed / flight.duration);
    scrollListTo(flight.from + (flight.to - flight.from) * easeInOutQuint(k));
    if (k >= 1) {
      const rows = Math.round(Math.abs(flight.to - flight.from) / ROW_HEIGHT);
      lastFlight = `${rows.toLocaleString("en-US")} rows in ${Math.round(elapsed)} ms · ${Math.round(ticks / (elapsed / 1000))} scroll updates/s`;
      stopFlight();
    }
    refresh();
  }, 16);
}

function ListRow({ row, target }: { row: ListItem; target: boolean }) {
  const accent = row.index % 5 === 0;
  return (
    <Row
      gap={14}
      align="center"
      style={{
        width: "100%",
        height: ROW_HEIGHT,
        padding: { left: 16, right: 16 },
        background: target ? c.selection : "#00000000",
        borderWidth: { bottom: 1 },
        borderColor: c.border,
      }}
    >
      <Text size={11} color={c.mutedForeground} style={{ width: 64 }}>#{String(row.index).padStart(6, "0")}</Text>
      <View style={{ width: 28, height: 28, radius: 14, shrink: 0, align: "center", justify: "center", background: accent ? c.primary : c.muted }}>
        <Text size={10} weight={650} color={accent ? c.primaryForeground : c.foreground}>{row.title.split(" ").map(word => word[0]).join("")}</Text>
      </View>
      <Column gap={1} flex={1}>
        <Text id={`row-title-${row.index}`} size={13} weight={500}>{row.title}</Text>
        <Text size={11} color={c.mutedForeground}>node {row.node} · {row.ms.toFixed(2)} ms</Text>
      </Column>
    </Row>
  );
}

function Card({ name, index }: { name: string; index: number }) {
  return (
    <Column
      gap={8}
      padding={10}
      style={{ background: c.card, borderWidth: 1, borderColor: c.border, radius: 10 }}
    >
      <View style={{ width: "100%", height: 56, radius: 6, background: index % 4 === 1 ? c.primary : c.muted }} />
      <Text size={13} weight={500}>{name}</Text>
      <Text size={11} color={c.mutedForeground}>{(0.03 + (mix(index) % 20) / 100).toFixed(2)} ms</Text>
    </Column>
  );
}

export function App() {
  const first = Math.floor(offset / ROW_HEIGHT);
  const visible = Math.ceil(LIST_HEIGHT / ROW_HEIGHT);
  const target = Number.parseInt(jumpText.replace(/[^0-9]/g, ""), 10);
  const windowStart = Math.max(0, first - WINDOW_MARGIN);
  const windowEnd = Math.min(ROW_COUNT, first + visible + WINDOW_MARGIN);
  return (
    <Window title="Tarve — 100,000 rows" width={1080} height={820} minWidth={560} minHeight={600} position="center" theme={darkTheme}>
      <TitleBar title="Tarve — 100,000 rows" />
      <Column gap={14} padding={20} flex={1} style={{ width: "100%" }}>
        <Row justify="between" align="center" style={{ width: "100%" }}>
          <Column gap={3}>
            <Text size={22} weight={700}>VirtualList at speed</Text>
            <Text size={12} color={c.mutedForeground}>Only the visible window of rows exists as native nodes. Resize the window to watch the grid reflow.</Text>
          </Column>
          <ToggleGroup
            id="performance-view"
            value={view}
            onValueChange={value => { if (typeof value === "string" && value) view = value; }}
            items={[{ value: "list", label: "List" }, { value: "grid", label: "Grid" }]}
          />
        </Row>

        {view === "list" ? (
          <Column gap={12} flex={1} style={{ width: "100%" }}>
            <Row gap={8} align="center" style={{ width: "100%" }}>
              <Input id="jump-row" type="number" value={jumpText} onChange={value => { jumpText = value; }} style={{ width: 140 }} />
              <Button id="fly-to-row" disabled={!Number.isFinite(target) || flight !== undefined} onClick={() => flyTo(target)}>Fly to row</Button>
              <Button id="fly-to-top" variant="outline" disabled={flight !== undefined} onClick={() => flyTo(0, 700)}>Top</Button>
              <Badge variant="secondary">{rows.length.toLocaleString("en-US")} rows</Badge>
              <Text id="flight-status" size={12} color={c.mutedForeground}>{flight ? "Scrolling…" : lastFlight}</Text>
            </Row>
            <View style={{ width: "100%", borderWidth: 1, borderColor: c.border, radius: 10, background: c.card }}>
              <VirtualList
                id={LIST_ID}
                items={rows.slice(windowStart, windowEnd)}
                itemCount={ROW_COUNT}
                windowStart={windowStart}
                estimatedItemHeight={ROW_HEIGHT}
                height={LIST_HEIGHT}
                offset={offset}
                keyForItem={row => row.index}
                onScroll={next => { if (!flight) offset = next; }}
                renderItem={row => <ListRow row={row} target={row.index === target} />}
              />
            </View>
            <Text id="visible-range" size={12} color={c.mutedForeground}>
              Rows {(first + 1).toLocaleString("en-US")}–{Math.min(ROW_COUNT, first + visible).toLocaleString("en-US")} of {ROW_COUNT.toLocaleString("en-US")}
            </Text>
          </Column>
        ) : (
          <Scroll id="performance-grid" flex={1} style={{ width: "100%" }}>
            <View style={{ width: "100%", display: "grid", columns: "repeat(auto-fill, minmax(176px, 1fr))", gap: 14 }}>
              {cards.map((name, index) => <Card key={name} name={name} index={index} />)}
            </View>
          </Scroll>
        )}
      </Column>
    </Window>
  );
}
