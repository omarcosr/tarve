import { Button, Column, Row, Text, TitleBar, Window, createApp, theme } from "@tarve/core";

const state = { muted: false, sent: 0 };

function App() {
  return (
    <Window title="__APP_TITLE__" width={420} height={280} position="center">
      <TitleBar title="__APP_TITLE__" />
      <Column flex={1} gap={12} padding={24} style={{ background: theme.colors.background }}>
        <Text style={{ fontSize: 18, fontWeight: 600 }}>__APP_TITLE__</Text>
        <Text style={{ color: theme.colors.mutedForeground }}>
          Closing the window hides it. Click the tray icon to bring it back; right-click it for the menu.
        </Text>
        <Text>Notifications sent: {String(state.sent)}{state.muted ? " (muted)" : ""}</Text>
        <Row gap={8}>
          <Button disabled={state.muted} onClick={() => ping()}>Send notification</Button>
          <Button variant="outline" onClick={() => app.hide()}>Hide to tray</Button>
        </Row>
      </Column>
    </Window>
  );
}

// "hide": closing the window keeps the app alive in the tray. The tray icon defaults to
// package.json "tarve.icon" (assets/icon.png).
const app = createApp(App, { closeBehavior: "hide" });

function menu() {
  return [
    { id: "show", label: "Show window", onSelect: () => app.show() },
    { id: "mute", label: "Mute notifications", checked: state.muted, onSelect: () => { state.muted = !state.muted; sync(); } },
    { type: "separator" as const },
    { id: "notify", label: "Send a notification", disabled: state.muted, onSelect: () => ping() },
    { type: "separator" as const },
    { id: "quit", label: "Quit", onSelect: () => app.close() },
  ];
}

const tray = app.tray({ tooltip: "__APP_TITLE__", onClick: () => app.show(), menu: menu() });

function sync(): void {
  tray.update({ tooltip: state.muted ? "__APP_TITLE__ (muted)" : "__APP_TITLE__", menu: menu() });
  app.update();
}

function ping(): void {
  state.sent++;
  app.notify({ title: "__APP_TITLE__", body: `Notification #${state.sent}`, onClick: () => app.show() });
  app.update();
}

await app.closed;
