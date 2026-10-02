import { Select } from "@tarve/core";

let role = "developer";

<Select
  id="role"
  value={role}
  options={[
    { value: "developer", label: "Developer" },
    { value: "designer", label: "Designer" },
    { value: "manager", label: "Manager" },
  ]}
  onValueChange={(value) => {
    role = value;
  }}
  style={{ width: 240 }}
/>;
