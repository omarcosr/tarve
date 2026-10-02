import { DataGrid, type DataGridKey, type DataGridSort } from "@tarve/core";

const files = Array.from({ length: 5_000 }, (_, index) => ({ id: index, name: `file-${index}.ts`, size: index * 13 }));
let sort: DataGridSort | undefined = { column: "name", direction: "asc" };
let selected: DataGridKey[] = [];

<DataGrid
  rows={files}
  rowKey={(row) => row.id}
  height={400}
  selectionMode="multiple"
  selectedKeys={selected}
  sort={sort}
  columns={[
    { key: "name", header: "Name", value: (row) => row.name, sortable: true, searchable: true },
    { key: "size", header: "Size", value: (row) => row.size, sortable: true, align: "end" },
  ]}
  onSortChange={(next) => {
    sort = next;
  }}
  onSelectionChange={(keys) => {
    selected = keys;
  }}
/>;
