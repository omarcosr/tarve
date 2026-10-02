import { Column, Progress, Row, Text, theme } from "@tarve/core";

<Column gap={8} style={{ width: 280 }}>
  <Row justify="between">
    <Text size={13}>Uploading</Text>
    <Text size={13} color={theme.colors.mutedForeground}>64%</Text>
  </Row>
  <Progress value={64} label="Uploading" />
</Column>;
