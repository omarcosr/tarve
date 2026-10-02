import { TextArea } from "@tarve/core";

let notes = "";

<TextArea
  value={notes}
  placeholder="Write something…"
  submitOnEnter={false}
  onChange={(value) => {
    notes = value;
  }}
  style={{ width: 380, height: 160 }}
/>;
