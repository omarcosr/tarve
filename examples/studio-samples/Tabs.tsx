import { createApp, Window, Tabs, Text } from "@tarve/core";
let tab = "one";

function App() {
  return (
    <Window title="Tabs" width={480} height={320}>
      <Tabs
        value={tab}
        onValueChange={value => { tab = value; }}
        items={[
          { value: "one", label: "First", content: <Text>First tab content</Text> },
          { value: "two", label: "Second", content: <Text>Second tab content</Text> },
          { value: "three", label: "Third", content: <Text>Third tab content</Text> },
        ]}
      />
    </Window>
  );
}

createApp(App);
