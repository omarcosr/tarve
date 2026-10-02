import { Button, Popover, Text } from "@tarve/core";

let open = true;

<Popover
  id="filters"
  open={open}
  trigger={<Button variant="outline">Filters</Button>}
  onOpenChange={(next) => {
    open = next;
  }}
>
  <Text>Filter options go here.</Text>
</Popover>;
