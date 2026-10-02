import { Column, ScrollArea, Text } from "@tarve/core";

<ScrollArea orientation="both" style={{ width: 360, height: 220 }}>
  <Column gap={8} style={{ width: 720, padding: 12 }}>
    {Array.from({ length: 16 }, (_, index) => (
      <Text key={index}>Line {index + 1}: content wider than the area scrolls on both axes inside a themed scroll area.</Text>
    ))}
  </Column>
</ScrollArea>;
