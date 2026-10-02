import { AlertDialog } from "@tarve/core";

let open = true;

<AlertDialog
  open={open}
  title="Delete project?"
  description="This action cannot be undone."
  actionLabel="Delete"
  actionVariant="destructive"
  onAction={() => console.log("deleted")}
  onOpenChange={(next) => {
    open = next;
  }}
/>;
