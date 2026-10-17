import { Column, Row, Text, TitleBar, View, Window, darkTheme, type WindowBackdrop } from "@tarve/core";

const ink = "#f4f4f5";
const muted = "#d4d4d8b3";

function Swatch({ label, color }: { label: string; color: string }) {
  return (
    <Column style={{ flex: 1, gap: 6 }}>
      <View style={{ height: 56, radius: 12, background: color, borderWidth: 1, borderColor: "#ffffff26" }} />
      <Text style={{ fontSize: 11, foreground: muted }}>{label}</Text>
    </Column>
  );
}

/**
 * The window background is fully transparent: the desktop (or the system
 * material) shows through it, and every box with an alpha colour tints it.
 */
export function TranslucentView({ backdrop }: { backdrop: WindowBackdrop }) {
  return (
    <Window title="Translucent" width={520} height={360} minWidth={380} minHeight={280} frameless
      backdrop={backdrop} theme={darkTheme} style={{ background: "#18181b40" }}>
      <TitleBar title={`Translucent · ${backdrop}`} style={{ background: "transparent" }} />
      <Column style={{ flex: 1, padding: 20, gap: 16 }}>
        <Column style={{ gap: 4 }}>
          <Text style={{ fontSize: 22, fontWeight: 600, foreground: ink }}>See-through window</Text>
          <Text style={{ fontSize: 13, foreground: muted }}>
            Window background #18181b40: what is behind the window shows through, {backdrop === "transparent" ? "untouched" : "blurred by the system"}.
          </Text>
        </Column>
        <Row style={{ gap: 12 }}>
          <Swatch label="0% (clear)" color="#00000000" />
          <Swatch label="25% black" color="#00000040" />
          <Swatch label="50% indigo" color="#6366f180" />
          <Swatch label="opaque" color="#27272a" />
        </Row>
        <View style={{ padding: 14, radius: 14, background: "#ffffff14", borderWidth: 1, borderColor: "#ffffff1f" }}>
          <Text style={{ fontSize: 12, foreground: ink }}>
            Text and opaque boxes stay solid; only what is translucent lets the backdrop through.
          </Text>
        </View>
      </Column>
    </Window>
  );
}
