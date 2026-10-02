import { Resizable, Text } from "@tarve/core";

let split = 30;

<Resizable
  size={split}
  min={20}
  max={70}
  onSizeChange={(size) => {
    split = size;
  }}
  first={<Text>Sidebar</Text>}
  second={<Text>Editor</Text>}
  style={{ height: 320 }}
/>;
