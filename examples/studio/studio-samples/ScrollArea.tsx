import { createApp, Window, Column, ScrollArea, Text } from "@tarve/core";
let offset = 0;

function App() {
  return (
    <Window title="ScrollArea" width={480} height={320}>
      <ScrollArea onScroll={value => { offset = value; }} style={{ width: "100%", height: "100%" }}>
        <Column gap={4} padding={10}>
          {Array.from({ length: 30 }, (_, i) => <Text key={i}>Line {i + 1}</Text>)}
          <Text>offset {offset.toFixed(0)}px</Text>
        </Column>
      </ScrollArea>
    </Window>
  );
}

createApp(App);
