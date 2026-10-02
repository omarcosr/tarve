import { Table } from "@tarve/core";

const invoices = [
  { id: "INV001", status: "Paid", amount: "$250.00" },
  { id: "INV002", status: "Pending", amount: "$150.00" },
];

<Table
  data={invoices}
  rowKey={(row) => row.id}
  columns={[
    { key: "id", header: "Invoice", accessor: "id" },
    { key: "status", header: "Status", accessor: "status" },
    { key: "amount", header: "Amount", accessor: "amount", align: "end" },
  ]}
/>;
