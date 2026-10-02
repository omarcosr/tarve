import { Drawer, Text } from "@tarve/core";

let open = true;

<Drawer
  open={open}
  size={280}
  title="Activity"
  onOpenChange={(next) => {
    open = next;
  }}
>
  <Text>3 new events</Text>
</Drawer>;
