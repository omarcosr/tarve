import { InputOTP } from "@tarve/core";

let code = "";

<InputOTP
  length={6}
  value={code}
  onValueChange={(value) => {
    code = value;
  }}
/>;
