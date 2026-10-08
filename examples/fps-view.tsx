import { Button, Column, Row, Slider, Switch, Text, View, Window } from "@tarve/core";

export const caps = [15, 30, 60, 120, 144, 240, null] as const;

export const state = {
  /** null follows the display's refresh rate. */
  cap: 60 as number | null,
  fps: 0,
  history: [] as number[],
  animate: true,
  load: 48,
  setCap: (_cap: number | null) => { },
};

const bg = "#0b0d12", panel = "#151924", line = "#262c3b", muted = "#8b93a7";
const colors = ["#22d3ee", "#a78bfa", "#f472b6", "#34d399", "#fbbf24", "#60a5fa"];

function fpsColor(fps: number): string {
  const target = state.cap ?? 60;
  if (fps >= target * 0.9) return "#34d399";
  if (fps >= target * 0.5) return "#fbbf24";
  return "#f87171";
}

function Meter() {
  const max = Math.max(60, ...(state.cap ? [state.cap] : []), ...state.history);
  return (
    <Column gap={10} style={{ background: panel, radius: 12, padding: 16, borderWidth: 1, borderColor: line }}>
      <Row align="end" justify="between">
        <Row align="end" gap={8}>
          <Text id="fps-value" size={56} weight={800} color={fpsColor(state.fps)} style={{ lineHeight: 1, fontFamily: "monospace" }}>{state.fps.toFixed(0)}</Text>
          <Text size={16} color={muted} style={{ margin: { bottom: 8 } }}>fps</Text>
        </Row>
        <Column align="end" gap={4}>
          <Text size={12} color={muted}>Limit</Text>
          <Text id="fps-cap" size={18} weight={700}>{state.cap === null ? "Display rate" : `${state.cap} fps`}</Text>
        </Column>
      </Row>
      <Row id="fps-graph" align="end" gap={2} style={{ height: 80 }}>
        {Array.from({ length: 60 }, (_, index) => {
          const value = state.history[state.history.length - 60 + index];
          return <View key={index} style={{ flex: 1, height: value === undefined ? 1 : Math.max(2, value / max * 80), radius: 2,
            background: value === undefined ? line : fpsColor(value) }} />;
        })}
      </Row>
      <Text size={12} color={muted}>Last 30 seconds, sampled twice per second. Animations are clock-based: a lower rate draws fewer frames, the spinners keep their speed. Without setMaxFps, animations run at 60 fps.</Text>
    </Column>
  );
}

function Controls() {
  return (
    <Column gap={14} style={{ background: panel, radius: 12, padding: 16, borderWidth: 1, borderColor: line }}>
      <Text weight={700}>Animation frame rate</Text>
      <Row gap={8} style={{ wrap: true }}>
        {caps.map(cap => (
          <Button key={String(cap)} id={`cap-${cap ?? "display"}`} size="sm" variant={state.cap === cap ? "default" : "outline"}
            onClick={() => state.setCap(cap)}>{cap === null ? "Display" : String(cap)}</Button>
        ))}
      </Row>
      <Row gap={12} align="center">
        <Text size={13} color={muted} style={{ width: 70 }}>Custom</Text>
        <Slider id="cap-slider" label="Frame rate limit" value={state.cap ?? 240} min={1} max={240} step={1}
          onValueChange={value => state.setCap(Math.round(value))} style={{ flex: 1, width: "auto" }} />
        <Text size={13} style={{ width: 56, textAlign: "end", fontFamily: "monospace" }}>{state.cap === null ? "display" : String(state.cap)}</Text>
      </Row>
      <Row gap={12} align="center">
        <Text size={13} color={muted} style={{ width: 70 }}>Spinners</Text>
        <Slider id="load-slider" label="Number of spinners" value={state.load} min={6} max={600} step={6}
          onValueChange={value => { state.load = Math.round(value); }} style={{ flex: 1, width: "auto" }} />
        <Text size={13} style={{ width: 56, textAlign: "end", fontFamily: "monospace" }}>{String(state.load)}</Text>
      </Row>
      <Row gap={10} align="center">
        <Switch id="animate" label="Animate" checked={state.animate} onCheckedChange={checked => { state.animate = checked; }} />
        <Text size={13}>Animate (off: the window stops drawing, 0 fps)</Text>
      </Row>
    </Column>
  );
}

function Stage() {
  return (
    <Row id="stage" flex={1} gap={8} style={{ wrap: true, align: "start", padding: 16, background: panel, radius: 12, borderWidth: 1, borderColor: line, overflow: "hidden", minHeight: 0 }}>
      {Array.from({ length: state.load }, (_, index) => (
        <View key={index} style={{ width: 28, height: 28, radius: index % 3 === 0 ? 14 : 6,
          background: `linear-gradient(135deg, ${colors[index % colors.length]}, ${colors[(index + 2) % colors.length]})`,
          spin: state.animate ? 600 + (index % 7) * 250 : undefined }} />
      ))}
    </Row>
  );
}

export function FpsView() {
  return (
    <Window title={`Frame rate — ${state.fps.toFixed(0)} fps`} width={940} height={640} minWidth={640} minHeight={480} position="center"
      style={{ background: bg, foreground: "#e5e7eb" }}>
      <Row flex={1} gap={14} align="stretch" style={{ padding: 14, minHeight: 0 }}>
        <Column gap={14} style={{ width: 380, shrink: 0 }}>
          <Meter />
          <Controls />
        </Column>
        <Stage />
      </Row>
    </Window>
  );
}
