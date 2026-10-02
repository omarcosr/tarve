import { Button, CommandPalette } from "@tarve/core";

let open = true;
let query = "";

<>
  <Button variant="outline" onClick={() => (open = true)}>
    Open command palette
  </Button>
  <CommandPalette
    id="palette"
    open={open}
    query={query}
    placeholder="Type a command…"
    items={[
      { value: "new", label: "New file", keywords: ["create"] },
      { value: "theme", label: "Toggle theme" },
      { value: "quit", label: "Quit" },
    ]}
    onOpenChange={(next) => {
      open = next;
    }}
    onQueryChange={(next) => {
      query = next;
    }}
    onSelect={(value) => console.log(value)}
  />
</>;
