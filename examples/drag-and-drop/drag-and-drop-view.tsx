import { Column, Pressable, Row, Text, Window } from "@tarve/core";

type Lane = "todo" | "doing" | "done";
const lanes: { id: Lane; title: string }[] = [
  { id: "todo", title: "To do" },
  { id: "doing", title: "In progress" },
  { id: "done", title: "Done" },
];

const cards = new Map<string, { title: string; lane: Lane }>([
  ["c1", { title: "Sketch the onboarding flow", lane: "todo" }],
  ["c2", { title: "Wire the settings page", lane: "todo" }],
  ["c3", { title: "Profile the first frame", lane: "doing" }],
  ["c4", { title: "Ship 0.5.0", lane: "done" }],
]);

/** The card being dragged, its press origin and the current pointer offset. */
let drag: { id: string; origin: { x: number; y: number }; dx: number; dy: number } | null = null;
let over: Lane | null = null;
let status = "Drag a card to another column, or focus it and press ← / →.";

function move(id: string, lane: Lane): void {
  const card = cards.get(id);
  if (!card || card.lane === lane) return;
  // Re-insert so the card lands at the bottom of its new column.
  cards.delete(id);
  cards.set(id, { ...card, lane });
  status = `Moved “${card.title}” to ${lanes.find(l => l.id === lane)!.title}.`;
}

function shift(id: string, step: number): void {
  const card = cards.get(id);
  if (!card) return;
  const next = lanes[lanes.findIndex(l => l.id === card.lane) + step];
  if (next) move(id, next.id);
}

function Card({ id, title }: { id: string; title: string }) {
  const dragging = drag?.id === id;
  return (
    <Pressable
      id={`card-${id}`}
      draggable
      onDragStart={origin => { drag = { id, origin, dx: 0, dy: 0 }; }}
      onDragMove={({ x, y }) => { if (drag) { drag.dx = x - drag.origin.x; drag.dy = y - drag.origin.y; } }}
      onDragEnd={({ target, cancelled }) => {
        if (cancelled) status = "Drag cancelled.";
        else if (!target) status = "Dropped outside a column.";
        drag = null;
        over = null;
      }}
      onKeyDown={key => {
        if (key === "ArrowLeft") shift(id, -1);
        if (key === "ArrowRight") shift(id, 1);
      }}
      control={{ role: "button", label: `${title}. Use left and right arrows to move between columns.` }}
      style={{
        padding: 12,
        radius: 10,
        background: "#ffffff",
        borderWidth: 1,
        borderColor: dragging ? "#6366f1" : "#e2e8f0",
        boxShadow: dragging
          ? { y: 12, blur: 24, color: "#0f172a33" }
          : { y: 1, blur: 2, color: "#0f172a14" },
        transform: dragging ? { x: drag!.dx, y: drag!.dy, scale: 1.03 } : undefined,
        zIndex: dragging ? 10 : 0,
        opacity: dragging ? 0.95 : 1,
        hover: { borderColor: "#a5b4fc" },
      }}
    >
      <Text style={{ fontSize: 14, foreground: "#0f172a" }}>{title}</Text>
    </Pressable>
  );
}

function LaneColumn({ id, title }: { id: Lane; title: string }) {
  const items = [...cards].filter(([, card]) => card.lane === id);
  const active = over === id && drag !== null && cards.get(drag.id)?.lane !== id;
  return (
    <Column
      id={`lane-${id}`}
      onDragEnter={() => { over = id; }}
      onDragLeave={() => { if (over === id) over = null; }}
      onDrop={({ source }) => move(source.replace(/^card-/, ""), id)}
      style={{
        flex: 1,
        gap: 10,
        padding: 12,
        radius: 14,
        minHeight: 360,
        background: active ? "#eef2ff" : "#f1f5f9",
        borderWidth: 2,
        borderStyle: "dashed",
        borderColor: active ? "#6366f1" : "transparent",
      }}
    >
      <Row style={{ justify: "between" }}>
        <Text style={{ fontSize: 13, fontWeight: 700, foreground: "#475569" }}>{title}</Text>
        <Text style={{ fontSize: 12, foreground: "#94a3b8" }}>{String(items.length)}</Text>
      </Row>
      {items.map(([cardId, card]) => <Card key={cardId} id={cardId} title={card.title} />)}
    </Column>
  );
}

export function App() {
  return (
    <Window title="Drag and drop" width={900} height={560} style={{ background: "#f8fafc" }}>
      <Column style={{ padding: 24, gap: 16, flex: 1 }}>
        <Text style={{ fontSize: 24, fontWeight: 800, foreground: "#0f172a" }}>Board</Text>
        <Row style={{ gap: 16, align: "start", flex: 1 }}>
          {lanes.map(lane => <LaneColumn key={lane.id} id={lane.id} title={lane.title} />)}
        </Row>
        <Text id="status" style={{ fontSize: 13, foreground: "#64748b" }}>{status}</Text>
      </Column>
    </Window>
  );
}
