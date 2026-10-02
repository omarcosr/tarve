import { Input } from "@tarve/core";

let email = "";

<Input
  type="email"
  value={email}
  placeholder="you@example.com"
  onChange={(value) => {
    email = value;
  }}
  onSubmit={(value) => console.log("submitted", value)}
/>;
