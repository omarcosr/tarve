import { Button, Icon, Row } from "@tarve/core";

<Row gap={8}>
  <Button onClick={() => console.log("saved")}>Save</Button>
  <Button variant="outline">Cancel</Button>
  <Button variant="ghost" size="sm">
    <Icon name="plus" />
    New
  </Button>
  <Button variant="destructive" disabled>Delete</Button>
</Row>;
