import { Button, Dialog, Text } from "@tarve/core";

let open = true;

<>
  <Button variant="outline" onClick={() => (open = true)}>
    About
  </Button>
  <Dialog
    open={open}
    title="About"
    width={420}
    onOpenChange={(next) => {
      open = next;
    }}
  >
    <Text>Built with Tarve.</Text>
  </Dialog>
</>;
