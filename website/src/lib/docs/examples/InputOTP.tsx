import { InputOTP } from "@tarve/core";

let code = "";

<InputOTP
  id="code"
  length={6}
  value={code}
  onValueChange={(value) => {
    code = value;
  }}
/>;
