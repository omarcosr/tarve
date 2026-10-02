import { Button, DropdownMenu } from "@tarve/core";

let open = true;

<DropdownMenu
  id="file-actions"
  open={open}
  trigger={<Button variant="outline">Actions</Button>}
  items={[
    { value: "rename", label: "Rename", shortcut: "F2" },
    { value: "duplicate", label: "Duplicate" },
    { value: "delete", label: "Delete", icon: "trash-2" },
  ]}
  onOpenChange={(next) => {
    open = next;
  }}
  onSelect={(value) => console.log(value)}
/>;
