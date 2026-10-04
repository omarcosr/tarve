import { createApp, Window, Column, Text, TextArea } from "@tarve/core";
let text = "Multi-line text.\nShift+Enter adds a line.";

function App() {
  return (
    <Window title="TextArea" width={480} height={320}>
      <Column gap={6} padding={16}>
        <TextArea value={text} onChange={value => { text = value; }} />
        <Text>{text.split("\n").length} lines</Text>
      </Column>
    </Window>
  );
}

createApp(App);
