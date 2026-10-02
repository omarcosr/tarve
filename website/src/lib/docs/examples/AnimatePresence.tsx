import { Alert, AnimatePresence, Button, Column } from "@tarve/core";

let visible = true;

<Column gap={16} align="center" style={{ width: 380 }}>
  <Button
    variant="outline"
    onClick={() => {
      visible = !visible;
    }}
  >
    {visible ? "Dismiss banner" : "Show banner"}
  </Button>
  <Column style={{ width: 380, height: 84 }}>
    <AnimatePresence
      id="saved-banner"
      present={visible}
      enter={{ opacity: 0, top: 16 }}
      exit={{ opacity: 0, top: -16 }}
      transition={{ all: { duration: 320, easing: "easeOut" } }}
    >
      <Column style={{ position: "relative", top: 0, opacity: 1 }}>
        <Alert variant="success" title="Saved" description="Your changes are live." />
      </Column>
    </AnimatePresence>
  </Column>
</Column>;
