import { Badge, DataTable } from "@tarve/core";

const users = [
  { id: 1, name: "Ada", role: "Owner" },
  { id: 2, name: "Grace", role: "Member" },
];

<DataTable
  data={users}
  rowKey={(row) => row.id}
  empty="No users."
  columns={[
    { key: "name", header: "Name", accessor: "name" },
    { key: "role", header: "Role", render: (row) => <Badge variant="secondary">{row.role}</Badge> },
  ]}
  onRowClick={(row) => console.log(row.name)}
/>;
