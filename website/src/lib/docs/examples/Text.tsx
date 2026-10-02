import { Column, Text, theme } from "@tarve/core";

<Column gap={4}>
  <Text size={28} weight={700}>Native text</Text>
  <Text color={theme.colors.mutedForeground}>Shaped by Parley, painted by Vello or D3D11.</Text>
  <Text size={13} style={{ textShadow: { x: 0, y: 1, blur: 2, color: "#00000044" } }}>With a text shadow</Text>
</Column>;
