import { Row, Toggle } from "@tarve/core";

let bold = true;
let italic = false;

<Row gap={6}>
  <Toggle
    label="Bold"
    variant="outline"
    pressed={bold}
    onPressedChange={(pressed) => {
      bold = pressed;
    }}
  >
    B
  </Toggle>
  <Toggle
    label="Italic"
    variant="outline"
    pressed={italic}
    onPressedChange={(pressed) => {
      italic = pressed;
    }}
  >
    I
  </Toggle>
</Row>
