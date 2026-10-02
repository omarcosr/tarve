import { Dialog, Text } from "@tarve/core";

let open = true;

<Dialog
  open={open}
  title="About"
  width={420}
  onOpenChange={(next) => {
    open = next;
  }}
>
  <Text>Built with Tarve.</Text>
</Dialog>;
