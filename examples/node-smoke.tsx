import { Button, Column, Text, Window, createApp, Image, readPngRgba } from "@tarve/core";
import studio from "./assets/studio.png";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function App() {
  return <Window title="Node smoke" width={360} height={260}>
    <Column><Text>Native UI</Text><Image src={studio} width={32} height={32} /><Button onClick={() => {}}>Ready</Button></Column>
  </Window>;
}

const app = createApp(App, { headless: true, renderer: "cpu", debug: true });
await app.ready;
const snapshot = await app.inspect();
if (snapshot.layoutNodes < 3) throw new Error("Native scene was not rendered");
const capture = join(tmpdir(), `tarve-node-smoke-${process.pid}.png`);
try {
  await app.capture(capture);
  const image = await readPngRgba(capture);
  if (image.width < 1 || image.height < 1) throw new Error("Native capture was empty");
} finally {
  rmSync(capture, { force: true });
}
app.close();
await app.closed;
console.log("tarve-node-ready");
