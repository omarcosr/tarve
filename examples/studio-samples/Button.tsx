import { createApp, Window, Button, Row, Text } from "@tarve/core";
let clicks = 0;

function App() {
  return (
    <Window title="Button" width={480} height={320}>
      <Row gap={8} align="center" padding={16}>
        <Button onClick={() => { clicks++; }}>Click me</Button>
        <Button variant="outline" onClick={() => { clicks = 0; }}>Reset</Button>
        <Text>{clicks} clicks</Text>
      </Row>
    </Window>
  );
}

createApp(App);
