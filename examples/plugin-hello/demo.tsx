// Demo app of tarve-plugin-hello: a button calls the Rust `hello_add` through the plugin.
// Build the library first: `cargo build --release --manifest-path native/Cargo.toml`.
// Run: `bun ../../packages/core/cli.ts run demo.tsx` (or `tarve run demo.tsx`).
import { Button, Column, Row, Text, Window, createApp } from "@tarve/core";
import hello from "./plugin";

let a = 2;
let b = 3;
let result = "Press = to call the native hello_add";
let info = "";

function Demo() {
  return (
    <Window title="Plugin hello" width={480} height={300}>
      <Column padding={28} gap={16} align="center" justify="center" flex={1}>
        <Text size={15}>tarve-plugin-hello (Rust cdylib via FFI)</Text>
        <Row gap={10} align="center">
          <Button variant="outline" onClick={() => { a--; }}>a −</Button>
          <Text size={28} weight={600}>{`${a} + ${b}`}</Text>
          <Button variant="outline" onClick={() => { b++; }}>b +</Button>
          <Button
            onClick={async () => {
              try {
                result = `= ${await hello.client(app).add(a, b)}`;
              } catch (error) {
                result = `Error: ${(error as Error).message}`;
              }
              app.update();
            }}
          >=</Button>
        </Row>
        <Text size={24}>{result}</Text>
        <Text size={12}>{info}</Text>
      </Column>
    </Window>
  );
}

const app = createApp(Demo, {
  plugins: [hello],
  onError: event => { result = `Error (${event.source}${event.event ? `:${event.event}` : ""}): ${event.error.message}`; },
});
await app.ready;
const details = await hello.client(app).info();
info = `${details.target} · ${details.ffi} · ${details.library}`;
app.update();
await app.closed;
