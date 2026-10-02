import { TextArea } from "@tarve/core";

let notes = "";

<TextArea
  value={notes}
  placeholder="Write something…"
  submitOnEnter={false}
  onChange={(value) => {
    notes = value;
  }}
  style={{ height: 160 }}
/>;
