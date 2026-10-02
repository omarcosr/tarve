import { Bubble, Column, Text } from "@tarve/core";

<Column gap={8}>
  <Bubble side="incoming">
    <Text>Is the release ready?</Text>
  </Bubble>
  <Bubble side="outgoing" variant="secondary">
    <Text>Shipping it now.</Text>
  </Bubble>
</Column>;
