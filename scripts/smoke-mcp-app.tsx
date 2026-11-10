import { Button, Column, Input, Text, Window, render } from "@tarve/core";

// The app scripts/smoke-mcp.ts drives through @tarve/mcp.
let count = 0;
let name = "";
console.log("smoke-mcp app up");

await render(() => (
  <Window title="Tarve MCP Smoke" width={420} height={260}>
    <Column padding={16} gap={8}>
      <Text id="count">{`Count: ${count}`}</Text>
      <Button id="bump" onClick={() => { count++; console.log("bumped", count); }}>Bump</Button>
      <Input id="name" placeholder="Name" value={name} onChange={value => { name = value; }} />
      <Text id="hello">{name ? `Hello ${name}` : "Nobody yet"}</Text>
    </Column>
  </Window>
));
