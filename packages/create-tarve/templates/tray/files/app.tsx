import { Button, Column, Row, Text, TitleBar, Window, createApp, theme } from "@tarve/core";

// tray: whether the tray icon can be seen (undefined until the system answers).
const state = { muted: false, sent: 0, tray: undefined as boolean | undefined };

function App() {
  return (
    <Window title="__APP_TITLE__" width={420} height={280} position="center"
      onCloseRequest={event => { if (state.tray) { event.preventDefault(); app.hide(); } }}>
      <TitleBar title="__APP_TITLE__" />
      <Column flex={1} gap={12} padding={24} style={{ background: theme.colors.background }}>
        <Text style={{ fontSize: 18, fontWeight: 600 }}>__APP_TITLE__</Text>
        <Text style={{ color: theme.colors.mutedForeground }}>
          {state.tray === false
            ? "No system tray host is running on this desktop, so the window stays open and closing it quits."
            : "Closing the window hides it. Click the tray icon to bring it back; right-click it for the menu."}
        </Text>
        <Text>Notifications sent: {String(state.sent)}{state.muted ? " (muted)" : ""}</Text>
        <Row gap={8}>
          <Button disabled={state.muted} onClick={() => ping()}>Send notification</Button>
          <Button variant="outline" disabled={!state.tray} onClick={() => app.hide()}>Hide to tray</Button>
        </Row>
      </Column>
    </Window>
  );
}

// Closing the window keeps the app alive in the tray (App's onCloseRequest) while the icon
// can be seen; with no tray host it quits. The tray icon defaults to package.json
// "tarve.icon" (assets/icon.png).
const app = createApp(App);

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

const tray = app.tray({
  tooltip: "__APP_TITLE__", onClick: () => app.show(), menu: menu(),
  // No tray host (GNOME without AppIndicator): keep the window; a host starting later shows the icon.
  onAvailability: ({ available }) => { state.tray = available; },
});

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
