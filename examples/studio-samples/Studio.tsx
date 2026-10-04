import { createApp, DataGrid, Markdown, Row, Sidebar, TitleBar, Window } from "@tarve/core";

const routes = [
  { value: "overview", label: "Overview", icon: "house" as const },
  { value: "components", label: "Components", icon: "star" as const },
  { value: "settings", label: "Settings", icon: "settings" as const },
];
const metrics = [
  { name: "Button", layoutMs: 0.02 },
  { name: "DataGrid", layoutMs: 0.11 },
  { name: "Markdown", layoutMs: 0.07 },
];
const notes = "## Tarve Studio\n\nNative pixels, **no browser**.";
let section = "components";

function App() {
  return (
    <Window title="Tarve Studio" width={1280} height={820}>
      <TitleBar title="Tarve Studio" />
      <Row flex={1} gap={12}>
        <Sidebar id="nav" items={routes} value={section} onValueChange={value => { section = value; }} />
        <DataGrid
          rows={metrics}
          rowKey={row => row.name}
          height={300}
          columns={[
            { key: "name", header: "Component", sortable: true },
            { key: "layoutMs", header: "Layout (ms)", sortable: true, value: row => row.layoutMs },
          ]}
        />
        <Markdown source={notes} style={{ padding: 16 }} />
      </Row>
    </Window>
  );
}

createApp(App);
