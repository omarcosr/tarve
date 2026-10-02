import { ContextMenu, Text, View } from "@tarve/core";

let open = false;

<ContextMenu
  id="canvas-menu"
  open={open}
  trigger={
    <View padding={40}>
      <Text>Right-click here</Text>
    </View>
  }
  items={[
    { value: "copy", label: "Copy", shortcut: "Ctrl+C" },
    { value: "paste", label: "Paste", shortcut: "Ctrl+V" },
  ]}
  onOpenChange={(next) => {
    open = next;
  }}
  onSelect={(value) => console.log(value)}
/>;
