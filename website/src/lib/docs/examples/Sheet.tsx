import { Button, Sheet, Switch } from "@tarve/core";

let open = true;
let compact = false;

<>
  <Button variant="outline" onClick={() => (open = true)}>
    Preferences
  </Button>
  <Sheet
    open={open}
    side="right"
    title="Preferences"
    onOpenChange={(next) => {
      open = next;
    }}
  >
    <Switch label="Compact mode" checked={compact} onCheckedChange={(value) => (compact = value)} />
  </Sheet>
</>;
