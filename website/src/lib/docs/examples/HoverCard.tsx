import { Avatar, HoverCard, Row, Text } from "@tarve/core";

let open = false;

<HoverCard
  open={open}
  trigger={<Text>@omarcosr</Text>}
  onOpenChange={(next) => {
    open = next;
  }}
>
  <Row gap={12} align="center">
    <Avatar fallback="MR" />
    <Text>Building native UI for Bun.</Text>
  </Row>
</HoverCard>;
