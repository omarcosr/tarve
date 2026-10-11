import { createApp, Window, Button, CommandPalette, Row, Text } from "@tarve/core";
let open = false;
let query = "";
let ran = "—";

function App() {
  return (
    <Window title="CommandPalette" width={480} height={320}>
      <Row gap={8} align="center" padding={16}>
        <Button onClick={() => { open = true; query = ""; }}>Open palette</Button>
        <Text>Ran: {ran}</Text>
        <CommandPalette
          id="palette"
          open={open}
          query={query}
          onOpenChange={value => { open = value; }}
          onQueryChange={value => { query = value; }}
          onSelect={value => { ran = value; }}
          items={[
            { value: "build", label: "Build executable" },
            { value: "theme", label: "Toggle theme" },
          ]}
        />
      </Row>
    </Window>
  );
}

createApp(App);
