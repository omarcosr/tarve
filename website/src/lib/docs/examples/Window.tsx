import { Column, Text, Window, createApp, darkTheme } from "@tarve/core";

function App() {
  return (
    <Window title="Notes" width={720} height={480} minWidth={480} minHeight={320} position="center" theme={darkTheme}>
      <Column flex={1} padding={24} gap={8}>
        <Text size={24} weight={700}>Hello from Tarve</Text>
        <Text>This is a native window. No browser involved.</Text>
      </Column>
    </Window>
  );
}

const app = createApp(App);
await app.ready;
await app.closed;
