import { Button, Column, Text, Window } from "@tarve/core-internal";

let clicks = 0;

export function App() {
  return (
    <Window title="Tarve standalone verification" width={560} height={420}>
      <Column padding={24} gap={12}>
        <Text size={22} weight={600}>Standalone runtime verification</Text>
        <Text>Native rendering, text shaping and Bun event dispatch are active.</Text>
        <Text>Embedded native runtime smoke fixture.</Text>
        <Button id="smoke-action" onClick={() => { clicks++; }}>Dispatch event</Button>
        <Text id="smoke-status">Clicked: {clicks}</Text>
      </Column>
    </Window>
  );
}
