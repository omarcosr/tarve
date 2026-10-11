import { createApp, Window, DataGrid, type DataGridKey } from "@tarve/core";
const rows = Array.from({ length: 50 }, (_, i) => ({ name: `Row ${i + 1}`, size: (i * 7) % 23 }));
let selected: DataGridKey[] = [];

function App() {
  return (
    <Window title="DataGrid" width={480} height={320}>
      <DataGrid
        rows={rows}
        rowKey={row => row.name}
        height={280}
        rowHeight={30}
        selectionMode="multiple"
        selectedKeys={selected}
        onSelectionChange={keys => { selected = keys; }}
        columns={[
          { key: "name", header: "Name", sortable: true },
          { key: "size", header: "Size", sortable: true, value: row => row.size },
        ]}
      />
    </Window>
  );
}

createApp(App);
