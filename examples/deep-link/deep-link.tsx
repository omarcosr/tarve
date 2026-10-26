// Deep links and file associations: `tarvedemo://…` links and `*.tarvedemo` files open
// this app. A later launch (a clicked link, a double-clicked file) hands its arguments to
// the running window through requestSingleInstance, and both reach onOpenUrl/onOpenFiles.
//
//   bun examples/deep-link/deep-link.tsx                 then "Register" (per user, no admin)
//   start tarvedemo://hello/world?x=1                    (Windows) / xdg-open tarvedemo://hello (Linux)
//   bun examples/deep-link/deep-link.tsx note.tarvedemo  a file argument, as a double-click passes it
import {
  Button, Column, Row, Text, TitleBar, Window, createApp,
  registerFileType, registerProtocol, requestSingleInstance, unregisterFileType, unregisterProtocol,
  type FileTypeAssociation,
} from "@tarve/core";

const SCHEME = "tarvedemo";
const FILE_TYPE: FileTypeAssociation = { ext: "tarvedemo", name: "Tarve deep-link demo" };

const instance = await requestSingleInstance({ id: "dev.tarve.deep-link", schemes: [SCHEME] });
if (!instance.primary) process.exit(0); // the running window got this launch

const opened: string[] = [];
let status = `Register, then open ${SCHEME}://… from a browser, Run dialog or terminal.`;

function DeepLink() {
  return (
    <Window title="Deep links" width={640} height={480} minWidth={480} minHeight={360}>
      <TitleBar title="Deep links" />
      <Column padding={24} gap={14} flex={1}>
        <Text size={15}>{status}</Text>
        <Row gap={8} style={{ wrap: true }}>
          <Button onClick={() => {
            try {
              registerProtocol(SCHEME, { name: "Tarve deep-link demo" });
              registerFileType(FILE_TYPE);
              status = `Registered ${SCHEME}:// and *.${FILE_TYPE.ext} for this user.`;
            } catch (error) {
              status = `Registration failed: ${error instanceof Error ? error.message : String(error)}`;
            }
          }}>Register</Button>
          <Button variant="outline" onClick={() => {
            unregisterProtocol(SCHEME);
            unregisterFileType(FILE_TYPE);
            status = "Unregistered.";
          }}>Unregister</Button>
          <Button variant="outline" onClick={() => { opened.length = 0; }}>Clear</Button>
        </Row>
        <Text size={13} weight={600}>Opened ({opened.length})</Text>
        <Column gap={6}>
          {opened.length ? opened.map(line => <Text size={13}>{line}</Text>) : <Text size={13}>Nothing yet.</Text>}
        </Column>
      </Column>
    </Window>
  );
}

const app = createApp(DeepLink, { protocols: [SCHEME], fileTypes: [FILE_TYPE] });
// Every later launch brings the window forward, with or without a link or file.
instance.onSecondInstance(() => app.activate());
app.onOpenUrl((url, event) => {
  opened.unshift(`${event.initial ? "launch" : "forwarded"}  link  ${url}`);
  app.update();
});
app.onOpenFiles((files, event) => {
  for (const file of files) opened.unshift(`${event.initial ? "launch" : "forwarded"}  file  ${file}`);
  app.update();
});
await app.ready;
await app.closed;
