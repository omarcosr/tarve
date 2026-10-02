import { Column, Text, Window, createApp, darkTheme } from "@tarve/core";

function App() {
  return (
    <Window title="Notes" width={640} height={320} minWidth={480} minHeight={240} position="center" theme={darkTheme}>
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
