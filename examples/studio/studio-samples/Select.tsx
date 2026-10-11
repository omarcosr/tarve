import { createApp, Window, Column, Select, Text } from "@tarve/core";
let renderer = "native";

function App() {
  return (
    <Window title="Select" width={480} height={320}>
      <Column gap={6} padding={16}>
        <Select
          id="renderer"
          value={renderer}
          onValueChange={value => { renderer = value; }}
          options={[
            { value: "native", label: "Native pixels" },
            { value: "gpu", label: "GPU" },
            { value: "cpu", label: "CPU fallback" },
          ]}
        />
        <Text>Selected: {renderer}</Text>
      </Column>
    </Window>
  );
}

createApp(App);
