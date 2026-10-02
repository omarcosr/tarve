import { Toggle } from "@tarve/core";

let bold = false;

<Toggle
  label="Bold"
  variant="outline"
  pressed={bold}
  onPressedChange={(pressed) => {
    bold = pressed;
  }}
/>;
