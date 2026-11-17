import { Button, Column, Flyout, Pressable, Text, theme } from "@tarve/core";

let open = true;
const actions = ["Rename", "Duplicate", "Delete"];

// Pressing the anchor again closes it: that press is the light-dismiss press outside the flyout.
<Flyout
  id="actions"
  open={open}
  placement="bottom-end"
  anchor={<Button variant="outline">Actions</Button>}
  onOpenChange={(next) => {
    open = next;
  }}
>
  <Column
    style={{ minWidth: 160, padding: 4, radius: 8, background: theme.colors.card, borderWidth: 1, borderColor: theme.colors.border }}
  >
    {actions.map((action) => (
      <Pressable
        key={action}
        onClick={() => (open = false)}
        style={{ padding: { left: 8, right: 8, top: 6, bottom: 6 }, radius: 6, hover: { background: theme.colors.muted } }}
      >
        <Text>{action}</Text>
      </Pressable>
    ))}
  </Column>
</Flyout>;
