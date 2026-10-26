import { Button, Column, Row, Text, Window, createApp } from "@tarve/core";

// State is plain variables: Tarve re-renders after every event handler.
let count = 0;

function App() {
  return (
    <Window title="__APP_TITLE__" width={520} height={360}>
      <Column flex={1} align="center" justify="center" gap={16}>
        <Text size={20} weight={600}>__APP_TITLE__</Text>
        <Text size={42} weight={700}>{count}</Text>
        <Row gap={8}>
          <Button variant="outline" onClick={() => count--}>Decrease</Button>
          <Button onClick={() => count++}>Increase</Button>
        </Row>
      </Column>
    </Window>
  );
}

const app = createApp(App);
await app.ready;
await app.closed;
