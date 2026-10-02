import { Badge, Sidebar, Text } from "@tarve/core";

let page = "inbox";
let collapsed = false;

<Sidebar
  value={page}
  collapsed={collapsed}
  header={<Text weight={700}>Acme</Text>}
  items={[
    { value: "inbox", label: "Inbox", icon: "mail", badge: <Badge>4</Badge> },
    { value: "starred", label: "Starred", icon: "star" },
    { value: "settings", label: "Settings", icon: "settings" },
  ]}
  onValueChange={(value) => {
    page = value;
  }}
  onCollapsedChange={(value) => {
    collapsed = value;
  }}
/>;
