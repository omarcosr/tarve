import { Button, Column, Text, Window, createApp } from "@tarve/core";

let count = 0;

function App() {
  return (
    <Window title="Counter" width={520} height={360}>
      <Column flex={1} align="center" justify="center" gap={16}>
        <Text size={42} weight={700}>{count}</Text>
        <Button onClick={() => count++}>Increase</Button>
      </Column>
    </Window>
  );
}

const app = createApp(App);
await app.ready;
await app.closed;
