import { TreeView } from "@tarve/core";

let expanded = ["src"];
let selected = "app";

<TreeView
  style={{ width: 280 }}
  expandedIds={expanded}
  selectedId={selected}
  nodes={[
    {
      id: "src",
      label: "src",
      icon: "folder",
      children: [
        { id: "app", label: "app.tsx" },
        { id: "theme", label: "theme.ts" },
      ],
    },
    { id: "readme", label: "README.md" },
  ]}
  onExpandedChange={(ids) => {
    expanded = ids;
  }}
  onSelectedChange={(id) => {
    selected = id;
  }}
/>;
