import { Command } from "@tarve/core";

let query = "";

<Command
  id="commands"
  query={query}
  items={[
    { value: "new", label: "New file", icon: "plus", shortcut: "Ctrl+N", group: "File" },
    { value: "settings", label: "Open settings", icon: "settings", group: "App" },
  ]}
  onQueryChange={(next) => {
    query = next;
  }}
  onSelect={(value) => console.log(value)}
/>;
