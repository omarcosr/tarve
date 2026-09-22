import { Button, Column, Row, Text, TitleBar, Window, render } from "tarve";

let count = 0;
export function Counter() {
  return (
    <Window title="Counter" width={460} height={300} minWidth={360} minHeight={240}>
      <TitleBar title="Counter" />
      <Column padding={32} gap={20} align="center" justify="center" flex={1}>
        <Text size={15}>A native Bun application</Text>
        <Text size={42} weight={600}>
          {count}
        </Text>
        <Row gap={10}>
          <Button variant="outline" onClick={() => count--}>
            - Decrease
          </Button>
          <Button onClick={() => count++}>Increase +</Button>
        </Row>
      </Column>
    </Window>
  );
}
await render(Counter);
