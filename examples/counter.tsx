import { Button, Column, Row, Text, TitleBar, Window, createApp } from "tarve";

let count = 0;
let status = "Ctrl+S is registered as a global app hotkey.";
let protectClose = true;
let app!: ReturnType<typeof createApp>;

export function Counter() {
  return (
    <Window
      title="Counter"
      width={620}
      height={520}
      minWidth={520}
      minHeight={420}
      onCloseRequest={(event) => {
        if (protectClose) {
          event.preventDefault();
          status = "Close prevented. Click ‘Allow close’ before closing the window.";
        }
      }}
    >
      <TitleBar title="Counter" />
      <Column padding={32} gap={20} align="center" justify="center" flex={1}>
        <Text size={15}>A native Bun application + desktop APIs</Text>
        <Text size={42} weight={600}>
          {count}
        </Text>
        <Row gap={10}>
          <Button variant="outline" onClick={() => count--}>
            - Decrease
          </Button>
          <Button onClick={() => count++}>Increase +</Button>
        </Row>
        <Text size={13}>{status}</Text>
        <Row gap={8} style={{ wrap: true }}>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              const path = await app.openFileDialog({
                title: "Open a text file",
                filters: [{ name: "Text", extensions: ["txt", "md"] }],
              });
              status = path ? `Opened: ${path}` : "Open file cancelled";
              app.update();
            }}
          >Open file</Button>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              const paths = await app.openFilesDialog({ title: "Open multiple files" });
              status = paths.length ? `Selected ${paths.length} files` : "Open files cancelled";
              app.update();
            }}
          >Open files</Button>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              const path = await app.openFolderDialog({ title: "Choose a folder" });
              status = path ? `Folder: ${path}` : "Folder selection cancelled";
              app.update();
            }}
          >Open folder</Button>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              const path = await app.saveFileDialog({
                title: "Save counter",
                fileName: "counter.txt",
                filters: [{ name: "Text", extensions: ["txt"] }],
              });
              status = path ? `Save target: ${path}` : "Save cancelled";
              app.update();
            }}
          >Save file</Button>
        </Row>
        <Button
          size="sm"
          variant={protectClose ? "destructive" : "secondary"}
          onClick={() => {
            protectClose = !protectClose;
            status = protectClose ? "Window close protection enabled" : "Window may now be closed";
          }}
        >
          {protectClose ? "Allow close" : "Protect close"}
        </Button>
      </Column>
    </Window>
  );
}

app = createApp(Counter, {
  renderer: "gpu",
});
app.registerHotkey("Ctrl+S", () => {
  status = `Ctrl+S handled at count ${count}`;
});
await app.ready;
await app.closed;
