import { RadioGroup } from "@tarve/core";

let plan = "pro";

<RadioGroup
  value={plan}
  options={[
    { value: "free", label: "Free" },
    { value: "pro", label: "Pro" },
    { value: "team", label: "Team", disabled: true },
  ]}
  onValueChange={(value) => {
    plan = value;
  }}
/>;
