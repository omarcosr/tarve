import { DataGrid, type DataGridKey, type DataGridSort } from "@tarve/core";

const files = Array.from({ length: 5_000 }, (_, index) => ({ id: index, name: `file-${index}.ts`, size: index * 13 }));
let offset = 0;
let sort: DataGridSort | undefined = { column: "name", direction: "asc" };
let selected: DataGridKey[] = [];

<DataGrid
  id="files"
  rows={files}
  rowKey={(row) => row.id}
  height={400}
  offset={offset}
  selectionMode="multiple"
  selectedKeys={selected}
  sort={sort}
  columns={[
    { key: "name", header: "Name", value: (row) => row.name, sortable: true, searchable: true },
    { key: "size", header: "Size", value: (row) => row.size, sortable: true, align: "end" },
  ]}
  onScroll={(next) => {
    offset = next;
  }}
  onSortChange={(next) => {
    sort = next;
  }}
  onSelectionChange={(keys) => {
    selected = keys;
  }}
/>;
