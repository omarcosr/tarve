import { createApp, Window, Text, Tooltip, View } from "@tarve/core";
let open = false;

function App() {
  return (
    <Window title="Tooltip" width={480} height={320}>
      <View padding={16}>
        <Tooltip
          id="tip"
          open={open}
          onOpenChange={value => { open = value; }}
          trigger={<Text>Hover me</Text>}
          content={<Text>Native tooltip</Text>}
        />
      </View>
    </Window>
  );
}

createApp(App);
