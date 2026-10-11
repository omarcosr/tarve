import { createApp, Window, Column, Slider, Text } from "@tarve/core";
let value = 40;

function App() {
  return (
    <Window title="Slider" width={480} height={320}>
      <Column gap={6} padding={16}>
        <Slider label="Value" value={value} min={0} max={100} onValueChange={next => { value = next; }} />
        <Text>Value: {value}</Text>
      </Column>
    </Window>
  );
}

createApp(App);
