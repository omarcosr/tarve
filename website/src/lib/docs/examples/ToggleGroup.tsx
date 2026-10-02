import { ToggleGroup } from "@tarve/core";

let alignment: string | string[] = "left";

<ToggleGroup
  type="single"
  value={alignment}
  items={[
    { value: "left", label: "Left" },
    { value: "center", label: "Center" },
    { value: "right", label: "Right" },
  ]}
  onValueChange={(value) => {
    alignment = value;
  }}
/>;
