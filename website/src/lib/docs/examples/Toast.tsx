import { Toast } from "@tarve/core";

<Toast
  id="saved"
  variant="success"
  title="Changes saved"
  description="Everything is up to date."
  action={{ label: "Undo", onClick: () => console.log("undo") }}
  onDismiss={(id) => console.log("dismissed", id)}
/>;
