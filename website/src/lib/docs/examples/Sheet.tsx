import { Sheet, Switch } from "@tarve/core";

let open = true;
let compact = false;

<Sheet
  open={open}
  side="right"
  title="Preferences"
  onOpenChange={(next) => {
    open = next;
  }}
>
  <Switch label="Compact mode" checked={compact} onCheckedChange={(value) => (compact = value)} />
</Sheet>;
