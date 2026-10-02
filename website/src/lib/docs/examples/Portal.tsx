import { Badge, Portal, Text, View, theme } from "@tarve/core";

<View style={{ position: "relative", width: 300, padding: { top: 16, right: 72, bottom: 16, left: 16 }, radius: 10, borderWidth: 1, borderColor: theme.colors.border }}>
  <Text size={13}>Portal content is painted above the rest of the window.</Text>
  <Portal style={{ position: "absolute", top: 10, right: 10 }}>
    <Badge>Portal</Badge>
  </Portal>
</View>;
