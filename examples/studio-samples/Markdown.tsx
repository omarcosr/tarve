import { createApp, Window, Markdown } from "@tarve/core";
const source = "## Markdown\n\nRendered **natively**, with `code`, lists and [links](https://example.com).\n\n- one\n- two";

function App() {
  return (
    <Window title="Markdown" width={480} height={320}>
      <Markdown source={source} style={{ padding: 16 }} />
    </Window>
  );
}

createApp(App);
