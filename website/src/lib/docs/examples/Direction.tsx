import { Badge, Column, Direction, Text, theme } from "@tarve/core";

<Column gap={12}>
  <Direction dir="ltr" gap={8}>
    <Badge>1</Badge>
    <Badge variant="secondary">2</Badge>
    <Badge variant="outline">3</Badge>
    <Text color={theme.colors.mutedForeground}>dir="ltr"</Text>
  </Direction>
  <Direction dir="rtl" gap={8}>
    <Badge>1</Badge>
    <Badge variant="secondary">2</Badge>
    <Badge variant="outline">3</Badge>
    <Text color={theme.colors.mutedForeground}>dir="rtl"</Text>
  </Direction>
</Column>;
