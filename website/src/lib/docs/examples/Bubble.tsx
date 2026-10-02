import { Bubble, Column, Row, Text } from "@tarve/core";

<Column gap={8} style={{ width: 320 }}>
  <Row>
    <Bubble side="incoming">
      <Text>Is the release ready?</Text>
    </Bubble>
  </Row>
  <Row justify="end">
    <Bubble side="outgoing">
      <Text>Shipping it now.</Text>
    </Bubble>
  </Row>
</Column>;
