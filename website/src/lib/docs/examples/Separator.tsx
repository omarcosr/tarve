import { Column, Row, Separator, Text } from "@tarve/core";

<Column gap={12}>
  <Text>Account</Text>
  <Separator />
  <Row gap={12} style={{ height: 20 }}>
    <Text>Profile</Text>
    <Separator orientation="vertical" />
    <Text>Billing</Text>
  </Row>
</Column>;
