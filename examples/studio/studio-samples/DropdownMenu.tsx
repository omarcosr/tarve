import { createApp, Window, DropdownMenu, Row, Text } from "@tarve/core";
let open = false;
let picked = "—";

function App() {
  return (
    <Window title="DropdownMenu" width={480} height={320}>
      <Row gap={8} align="center" padding={16}>
        <DropdownMenu
          id="menu"
          open={open}
          onOpenChange={value => { open = value; }}
          trigger={<Text>Open menu</Text>}
          items={[{ value: "copy", label: "Copy" }, { value: "paste", label: "Paste" }, { value: "delete", label: "Delete" }]}
          onSelect={value => { picked = value; }}
        />
        <Text>Picked: {picked}</Text>
      </Row>
    </Window>
  );
}

createApp(App);
