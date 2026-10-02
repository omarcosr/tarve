import { Checkbox } from "@tarve/core";

let accepted = false;

<Checkbox
  label="Accept terms and conditions"
  checked={accepted}
  onCheckedChange={(checked) => {
    accepted = checked;
  }}
/>;
