import { AlertDialog, Button } from "@tarve/core";

let open = true;

<>
  <Button variant="destructive" onClick={() => (open = true)}>
    Delete project
  </Button>
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
  />
</>;
