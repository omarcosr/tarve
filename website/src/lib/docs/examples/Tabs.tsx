import { Tabs, Text } from "@tarve/core";

let tab = "account";

<Tabs
  value={tab}
  items={[
    { value: "account", label: "Account", content: <Text>Account settings</Text> },
    { value: "password", label: "Password", content: <Text>Change your password</Text> },
  ]}
  onValueChange={(value) => {
    tab = value;
  }}
/>;
