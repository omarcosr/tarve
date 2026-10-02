import { Pressable, Text, theme } from "@tarve/core";

let selected = false;

<Pressable
  padding={12}
  onClick={() => {
    selected = !selected;
  }}
  style={{
    radius: 8,
    background: selected ? theme.colors.muted : "transparent",
    hover: { background: theme.colors.muted },
  }}
>
  <Text>{selected ? "Selected" : "Click the whole row"}</Text>
</Pressable>;
