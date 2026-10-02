import { Button, Drawer, Text } from "@tarve/core";

let open = true;

<>
  <Button variant="outline" onClick={() => (open = true)}>
    Show activity
  </Button>
  <Drawer
    open={open}
    size={280}
    title="Activity"
    onOpenChange={(next) => {
      open = next;
    }}
  >
    <Text>3 new events</Text>
  </Drawer>
</>;
