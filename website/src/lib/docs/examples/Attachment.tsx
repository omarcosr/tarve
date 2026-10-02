import { Attachment } from "@tarve/core";

<Attachment
  name="design-spec.pdf"
  size="2.4 MB"
  status="uploading"
  progress={62}
  onRemove={() => console.log("removed")}
/>;
