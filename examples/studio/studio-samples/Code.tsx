import { createApp, Window, Code } from "@tarve/core";
const source = "export function hello(name: string) {\n  return `Hello, ${name}!`;\n}";

function App() {
  return (
    <Window title="Code" width={480} height={320}>
      <Code path="hello.ts" showLineNumbers code={source} style={{ padding: 16 }} />
    </Window>
  );
}

createApp(App);
