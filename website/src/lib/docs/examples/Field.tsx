import { Field, Input } from "@tarve/core";

let username = "ad";

<Field
  label="Username"
  description="This is your public display name."
  error={username.length < 3 ? "Use at least 3 characters." : undefined}
  required
>
  <Input
    value={username}
    onChange={(value) => {
      username = value;
    }}
  />
</Field>;
