import { createApp, Window, Text, VirtualList } from "@tarve/core";
const rows = Array.from({ length: 1000 }, (_, i) => `Row ${i + 1}`);
let offset = 0;

function App() {
  return (
    <Window title="VirtualList" width={480} height={320}>
      <VirtualList
        items={rows}
        itemHeight={24}
        height={280}
        offset={offset}
        onScroll={value => { offset = value; }}
        renderItem={row => <Text>{row}</Text>}
      />
    </Window>
  );
}

createApp(App);
