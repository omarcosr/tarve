import { Button, Column, Row, Text, Window, theme } from "@tarve/core";

export const state = { muted: false, sent: 0, ping: () => {}, hide: () => {} };

export function TrayView() {
  return (
    <Window title="Tray" width={420} height={240} style={{ background: theme.colors.background, padding: 24, gap: 12 }}>
      <Column style={{ gap: 8 }}>
        <Text style={{ fontSize: 18, fontWeight: 600 }}>System tray</Text>
        <Text style={{ color: theme.colors.mutedForeground }}>
          Closing the window hides it. Click the tray icon to bring it back; right-click it for the menu.
        </Text>
        <Text>Notifications sent: {String(state.sent)}{state.muted ? " (muted)" : ""}</Text>
      </Column>
      <Row style={{ gap: 8 }}>
        <Button id="ping" disabled={state.muted} onClick={() => state.ping()}>Send notification</Button>
        <Button id="hide" variant="outline" onClick={() => state.hide()}>Hide to tray</Button>
      </Row>
    </Window>
  );
}
