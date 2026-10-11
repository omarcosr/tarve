import { createApp, Window, Diff } from "@tarve/core";
const patch = [
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,2 +1,2 @@",
  "-const speed = 1;",
  "+const speed = 2;",
  " export { speed };",
  "",
].join("\n");

function App() {
  return (
    <Window title="Diff" width={480} height={320}>
      <Diff wordDiff source={patch} style={{ padding: 8 }} />
    </Window>
  );
}

createApp(App);
