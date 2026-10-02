import { Badge, Column, Row, Text, TitleBar, Window } from "@tarve/core";

<Window title="Editor" width={960} height={640}>
  <TitleBar height={40} showMaximize={false}>
    <Row gap={8} align="center" padding={12}>
      <Text weight={600}>Editor</Text>
      <Badge variant="secondary">main.ts</Badge>
    </Row>
  </TitleBar>
  <Column flex={1} padding={24}>
    <Text>Window content</Text>
  </Column>
</Window>;
