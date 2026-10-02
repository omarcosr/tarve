import { NativeSelect } from "@tarve/core";

let size = "m";

<NativeSelect
  id="size"
  value={size}
  placeholder="Size"
  options={[
    { value: "s", label: "Small" },
    { value: "m", label: "Medium" },
    { value: "l", label: "Large" },
  ]}
  onValueChange={(value) => {
    size = value;
  }}
/>;
