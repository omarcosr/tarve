import { Button, Tooltip } from "@tarve/core";

let open = false;

<Tooltip
  id="save-tip"
  open={open}
  side="top"
  trigger={<Button>Save</Button>}
  content="Save (Ctrl+S)"
  onOpenChange={(next) => {
    open = next;
  }}
/>;
