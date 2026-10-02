import { Alert, AnimatePresence } from "@tarve/core";

let visible = true;

<AnimatePresence
  id="saved-banner"
  present={visible}
  enter={{ opacity: 0 }}
  exit={{ opacity: 0, height: 0 }}
  transition={{ all: { duration: 240, easing: "easeOut" } }}
>
  <Alert variant="success" title="Saved" description="Your changes are live." />
</AnimatePresence>;
