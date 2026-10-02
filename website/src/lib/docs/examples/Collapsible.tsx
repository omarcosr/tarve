import { Collapsible, Column, Icon, Row, Text } from "@tarve/core";

let open = true;

<Collapsible
  open={open}
  label="Advanced options"
  trigger={
    <Row gap={8} align="center" style={{ width: 280, justify: "between" }}>
      <Text weight={600}>Advanced options</Text>
      <Icon name={open ? "chevron-up" : "chevron-down"} size={16} />
    </Row>
  }
  onOpenChange={(next) => {
    open = next;
  }}
>
  <Column gap={4} style={{ padding: { top: 8 } }}>
    <Text size={13}>Hardware acceleration</Text>
    <Text size={13}>Experimental renderer</Text>
  </Column>
</Collapsible>;
