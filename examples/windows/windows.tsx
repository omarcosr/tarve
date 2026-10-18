import { Button, Column, createApp, Row, Text, Window, type AppHandle } from "@tarve/core";

// Several windows of one app: the main window opens a settings window and any number
// of note windows. Each is a view of its own with its own handle; they share the
// app's state, so a change in one updates the others.

let volume = 50;
let notes = 0;
let settings: AppHandle | undefined;
const open = new Set<AppHandle>();
const updateAll = () => { app.update(); for (const window of open) window.update(); };

function openSettings(): void {
  if (settings) return;
  const window = app.openWindow(() => (
    <Window title="Settings" width={320} height={200} resizable={false}>
      <Column style={{ padding: 20, gap: 12 }}>
        <Text style={{ fontSize: 16, fontWeight: 600 }}>Settings</Text>
        <Row style={{ gap: 8, align: "center" }}>
          <Button onClick={() => { volume = Math.max(0, volume - 10); updateAll(); }}>−</Button>
          <Text>{`Volume ${volume}`}</Text>
          <Button onClick={() => { volume = Math.min(100, volume + 10); updateAll(); }}>+</Button>
        </Row>
        <Button variant="outline" onClick={() => window.close()}>Done</Button>
      </Column>
    </Window>
  ), { id: "settings" });
  settings = window;
  open.add(window);
  void window.closed.then(() => { open.delete(window); settings = undefined; app.update(); });
  app.update();
}

function openNote(): void {
  const number = ++notes;
  const window = app.openWindow(() => (
    <Window title={`Note ${number}`} width={260} height={160}>
      <Column style={{ padding: 16, gap: 8 }}>
        <Text style={{ fontWeight: 600 }}>{`Note ${number}`}</Text>
        <Text style={{ fontSize: 12 }}>{`The volume is ${volume} here too.`}</Text>
      </Column>
    </Window>
  ));
  open.add(window);
  void window.closed.then(() => { open.delete(window); app.update(); });
  app.update();
}

const app = createApp(() => (
  <Window title="Windows" width={420} height={260}>
    <Column style={{ padding: 24, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: 600 }}>Several windows</Text>
      <Text>{`Volume ${volume} · ${open.size} other window${open.size === 1 ? "" : "s"} open`}</Text>
      <Row style={{ gap: 8 }}>
        <Button onClick={openSettings} disabled={!!settings}>Settings…</Button>
        <Button variant="outline" onClick={openNote}>New note</Button>
      </Row>
      <Text style={{ fontSize: 12 }}>Closing this window closes the others.</Text>
    </Column>
  </Window>
));
// The window's native menu bar (Windows): the same commands, with accelerators.
app.menuBar([
  { label: "&File", items: [
    { id: "note", label: "&New note", accelerator: "Ctrl+N", onSelect: openNote },
    { id: "settings", label: "&Settings…", accelerator: "Ctrl+,", onSelect: openSettings },
    { type: "separator" },
    { id: "quit", label: "E&xit", onSelect: () => app.close() },
  ] },
]);
await app.closed;
