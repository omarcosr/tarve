import { Switch } from "@tarve/core";

let airplane = false;

<Switch
  label="Airplane mode"
  checked={airplane}
  onCheckedChange={(checked) => {
    airplane = checked;
  }}
/>;
