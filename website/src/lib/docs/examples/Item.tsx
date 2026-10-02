import { Avatar, Badge, Item } from "@tarve/core";

<Item
  title="Ada Lovelace"
  description="ada@example.com"
  leading={<Avatar fallback="AL" size={32} />}
  trailing={<Badge variant="secondary">Owner</Badge>}
  onClick={() => console.log("open profile")}
/>;
