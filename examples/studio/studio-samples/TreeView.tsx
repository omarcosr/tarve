import { createApp, Window, TreeView } from "@tarve/core";
let expanded = ["src"];
let selected = "app";
const nodes = [
  { id: "src", label: "src", children: [{ id: "app", label: "app.tsx" }, { id: "view", label: "view.tsx" }] },
  { id: "pkg", label: "package.json" },
];

function App() {
  return (
    <Window title="TreeView" width={480} height={320}>
      <TreeView
        nodes={nodes}
        expandedIds={expanded}
        selectedId={selected}
        onExpandedChange={ids => { expanded = ids; }}
        onSelectedChange={id => { selected = id; }}
      />
    </Window>
  );
}

createApp(App);
