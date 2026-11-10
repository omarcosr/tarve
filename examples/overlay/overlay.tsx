import { Button, Column, Modal, Row, Text, TextArea, TitleBar, Window, createApp } from "@tarve/core";

// Hit-test playground: a scrollable text area with different layers in front of it.
// Try the wheel, the scrollbar and a thumb drag over the text area in each mode.
type Mode = "none" | "plain" | "block" | "modal";

const modes: { id: Mode; label: string; hint: string }[] = [
  { id: "none", label: "Nada na frente", hint: "Nada cobre a textarea: roda e scrollbar rolam." },
  {
    id: "plain",
    label: "Caixa comum",
    hint: "Uma view sem pointerEvents: o ponteiro passa por ela e a textarea ainda rola (no CSS ela bloquearia).",
  },
  {
    id: "block",
    label: "pointerEvents: block",
    hint: "A mesma caixa com pointerEvents: \"block\": roda, scrollbar e arraste param nela.",
  },
  {
    id: "modal",
    label: "<Modal>",
    hint: "O Modal do core (overlay com modal + pointerEvents: block): a textarea fica intocável.",
  },
];

let mode: Mode = "none";
let text = Array.from({ length: 200 }, (_, i) => `linha ${i + 1}`).join("\n");

function Layer() {
  if (mode !== "plain" && mode !== "block") return null;
  return (
    <Column
      align="center"
      justify="center"
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        radius: 8,
        background: mode === "plain" ? "#3b82f655" : "#ef444455",
        ...(mode === "block" ? { pointerEvents: "block" as const } : {}),
      }}
    >
      <Text size={16} weight={600}>
        {mode === "plain" ? "Caixa comum (sem pointerEvents)" : "pointerEvents: \"block\""}
      </Text>
    </Column>
  );
}

function Overlay() {
  const current = modes.find((m) => m.id === mode)!;
  return (
    <Window title="Overlay x textarea" width={720} height={560} minWidth={560} minHeight={420}>
      <TitleBar title="Overlay x textarea" />
      <Column padding={20} gap={14} flex={1} style={{ position: "relative" }}>
        <Row gap={8} style={{ wrap: true }}>
          {modes.map((m) => (
            <Button
              size="sm"
              variant={mode === m.id ? "default" : "outline"}
              onClick={() => {
                mode = m.id;
              }}
            >
              {m.label}
            </Button>
          ))}
        </Row>
        <Text size={13}>{current.hint}</Text>
        <Column flex={1} style={{ position: "relative" }}>
          <TextArea
            value={text}
            onChange={(value) => {
              text = value;
            }}
            // Pinned to the box: a percentage height under a flex-sized parent resolves
            // to auto, and the area would grow to its 200 lines with nothing to scroll.
            style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, width: "auto", height: "auto", minWidth: 0, minHeight: 0 }}
          />
          <Layer />
        </Column>
        <Modal
          open={mode === "modal"}
          title="Modal aberto"
          description="Tente rolar a textarea atrás dele: nada deve acontecer."
          closeOnOverlay={false}
          onOpenChange={(open) => {
            if (!open) mode = "none";
          }}
        >
          <Button onClick={() => (mode = "none")}>Fechar</Button>
        </Modal>
      </Column>
    </Window>
  );
}

const app = createApp(Overlay);
await app.ready;
await app.closed;
