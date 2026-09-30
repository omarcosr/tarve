import { Column, Row, Text, Window } from "@tarve/core";

const card = { width: 150, height: 96, radius: 14, padding: 12, justify: "end" } as const;

function Swatch({ label, background }: { label: string; background: string }) {
  return (
    <Column style={{ ...card, background }}>
      <Text style={{ fontSize: 12, fontWeight: 600, foreground: "#ffffff" }}>{label}</Text>
    </Column>
  );
}

function Bordered({ label, borderStyle, borderColor }: { label: string; borderStyle: string; borderColor: string }) {
  return (
    <Column style={{ ...card, background: "#ffffff", borderWidth: 6, borderStyle: borderStyle as never, borderColor }}>
      <Text style={{ fontSize: 12, fontWeight: 600, foreground: "#334155" }}>{label}</Text>
    </Column>
  );
}

const section = { fontSize: 13, fontWeight: 700, foreground: "#64748b" } as const;

export function App() {
  return (
    <Window title="Gradients" width={720} height={640} style={{ background: "#f8fafc" }}>
      <Column style={{ padding: 24, gap: 14 }}>
        <Text style={{ fontSize: 40, fontWeight: 800, foreground: "linear-gradient(90deg, #6366f1, #ec4899, #f59e0b)" }}>
          Gradients
        </Text>
        <Text style={section}>linear · radial · conic</Text>
        <Row style={{ gap: 12 }}>
          <Swatch label="linear" background="linear-gradient(135deg, royalblue, mediumorchid)" />
          <Swatch label="radial" background="radial-gradient(circle at 30% 30%, gold, darkorange 60%, crimson)" />
          <Swatch label="conic" background="conic-gradient(from 90deg, tomato, gold, limegreen, deepskyblue, violet, tomato)" />
          <Swatch label="pie" background="conic-gradient(at 35% 60%, teal 0 40%, coral 0 70%, slategray 0)" />
        </Row>
        <Text style={section}>repeating</Text>
        <Row style={{ gap: 12 }}>
          <Swatch label="stripes" background="repeating-linear-gradient(45deg, navy 0 8px, steelblue 8px 16px)" />
          <Swatch label="rings" background="repeating-radial-gradient(circle, darkcyan 0 6px, teal 6px 12px)" />
          <Swatch label="checkerboard" background="repeating-conic-gradient(#0f172a 0 25%, #475569 0 50%)" />
          <Swatch label="sunburst" background="repeating-conic-gradient(from 0deg, orangered 0 10deg, orange 0 20deg)" />
        </Row>
        <Text style={section}>borders</Text>
        <Row style={{ gap: 12 }}>
          <Bordered label="solid" borderStyle="solid" borderColor="linear-gradient(90deg, hotpink, rebeccapurple)" />
          <Bordered label="dashed" borderStyle="dashed" borderColor="linear-gradient(90deg, dodgerblue, lime)" />
          <Bordered label="dotted" borderStyle="dotted" borderColor="conic-gradient(red, gold, lime, aqua, blue, magenta, red)" />
          <Bordered label="double" borderStyle="double" borderColor="radial-gradient(circle, crimson, indigo)" />
        </Row>
      </Column>
    </Window>
  );
}
