import { Button, Input, Modal, Row } from "@tarve/core";

let open = true;
let name = "notes.md";

<>
  <Button variant="outline" onClick={() => (open = true)}>
    Rename file
  </Button>
  <Modal
    open={open}
    title="Rename file"
    description="Choose a new name for this file."
    onOpenChange={(next) => {
      open = next;
    }}
    footer={
      <Row gap={8} justify="end">
        <Button variant="outline" onClick={() => (open = false)}>Cancel</Button>
        <Button onClick={() => (open = false)}>Save</Button>
      </Row>
    }
  >
    <Input
      value={name}
      onChange={(value) => {
        name = value;
      }}
    />
  </Modal>
</>;
