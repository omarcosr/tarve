import { createApp, Window, Column, Input, Text } from "@tarve/core";
let text = "";

function App() {
  return (
    <Window title="Input" width={480} height={320}>
      <Column gap={6} padding={16}>
        <Input value={text} placeholder="Type something…" onChange={value => { text = value; }} />
        <Text>{text.length} characters</Text>
      </Column>
    </Window>
  );
}

createApp(App);
