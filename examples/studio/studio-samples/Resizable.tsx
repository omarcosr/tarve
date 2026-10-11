import { createApp, Window, Resizable, Text, View } from "@tarve/core";
let split = 50;

function App() {
  return (
    <Window title="Resizable" width={480} height={320}>
      <Resizable
        size={split}
        min={20}
        max={80}
        label="Resize"
        onSizeChange={value => { split = value; }}
        style={{ width: "100%", height: "100%" }}
        first={<View padding={10}><Text>{split.toFixed(0)}%</Text></View>}
        second={<View padding={10}><Text>Drag the divider</Text></View>}
      />
    </Window>
  );
}

createApp(App);
