import { Button, Column, Text, Window, createApp } from "@tarve/core";

let count = 0;

function App() {
  return (
    <Window title="Contador (Tarve)" width={400} height={240}>
      <Column flex={1} padding={24} style={{ background: "#f4f4f5" }}>
        <Column gap={12} padding={16}
          style={{ background: "#ffffff", radius: 8, borderWidth: 1, borderColor: "#e4e4e7" }}>
          <Text size={20} weight={700} style={{ foreground: "#09090b" }}>Contador</Text>
          <Text size={42} style={{ foreground: "#09090b" }}>{count}</Text>
          <Button onClick={() => count++}>Aumentar</Button>
        </Column>
      </Column>
    </Window>
  );
}

const app = createApp(App);
await app.ready;
await app.closed;
