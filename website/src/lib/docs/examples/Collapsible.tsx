import { Collapsible, Text } from "@tarve/core";

let open = false;

<Collapsible
  open={open}
  trigger={<Text weight={600}>Advanced options</Text>}
  onOpenChange={(next) => {
    open = next;
  }}
>
  <Text>Hidden until expanded.</Text>
</Collapsible>;
