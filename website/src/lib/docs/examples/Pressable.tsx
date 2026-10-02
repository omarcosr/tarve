import { Column, Pressable, Row, Text, theme } from "@tarve/core";

type Lane = "todo" | "doing" | "done";
const lanes: { id: Lane; title: string }[] = [
  { id: "todo", title: "To do" },
  { id: "doing", title: "Doing" },
  { id: "done", title: "Done" },
];
const cards = new Map<string, { title: string; lane: Lane }>([
  ["a", { title: "Sketch onboarding", lane: "todo" }],
  ["b", { title: "Wire settings", lane: "todo" }],
  ["c", { title: "Profile first frame", lane: "doing" }],
  ["d", { title: "Ship 0.5.0", lane: "done" }],
]);

// The dragged card follows the pointer through a transform; the drop target decides where it lands.
let drag: { id: string; x: number; y: number; dx: number; dy: number } | null = null;
let over: Lane | null = null;

function move(id: string, lane: Lane) {
  const card = cards.get(id);
  if (!card || card.lane === lane) return;
  cards.delete(id);
  cards.set(id, { ...card, lane });
}

function Card({ id, title }: { id: string; title: string }) {
  const dragging = drag?.id === id;
  return (
    <Pressable
      id={`card-${id}`}
      draggable
      onDragStart={({ x, y }) => { drag = { id, x, y, dx: 0, dy: 0 }; }}
      onDragMove={({ x, y }) => { if (drag) { drag.dx = x - drag.x; drag.dy = y - drag.y; } }}
      onDragEnd={() => { drag = null; over = null; }}
      style={{
        padding: 10,
        radius: 8,
        background: theme.colors.card,
        borderWidth: 1,
        borderColor: dragging ? theme.colors.primary : theme.colors.border,
        boxShadow: dragging ? { y: 10, blur: 20, color: "#00000040" } : undefined,
        transform: dragging ? { x: drag!.dx, y: drag!.dy, scale: 1.04 } : undefined,
        zIndex: dragging ? 10 : 0,
        hover: { borderColor: theme.colors.ring },
      }}
    >
      <Text style={{ fontSize: 13 }}>{title}</Text>
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
      onDrop={({ source }) => move(source.replace("card-", ""), id)}
      style={{
        width: 168,
        minHeight: 200,
        gap: 8,
        padding: 10,
        radius: 10,
        background: theme.colors.muted,
        borderWidth: 1,
        borderStyle: "dashed",
        borderColor: active ? theme.colors.primary : "transparent",
      }}
    >
      <Row style={{ justify: "between" }}>
        <Text style={{ fontSize: 12, fontWeight: 600, foreground: theme.colors.mutedForeground }}>{title}</Text>
        <Text style={{ fontSize: 12, foreground: theme.colors.mutedForeground }}>{String(items.length)}</Text>
      </Row>
      {items.map(([cardId, card]) => <Card key={cardId} id={cardId} title={card.title} />)}
    </Column>
  );
}

<Row gap={10} style={{ align: "start" }}>
  {lanes.map((lane) => <LaneColumn key={lane.id} id={lane.id} title={lane.title} />)}
</Row>;
