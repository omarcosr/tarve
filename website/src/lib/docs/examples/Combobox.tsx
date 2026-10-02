import { Combobox } from "@tarve/core";

let open = false;
let query = "";
let framework = "tarve";

<Combobox
  id="framework"
  open={open}
  query={query}
  value={framework}
  options={[
    { value: "tarve", label: "Tarve", keywords: ["native", "bun"] },
    { value: "electron", label: "Electron" },
    { value: "tauri", label: "Tauri" },
  ]}
  onOpenChange={(next) => {
    open = next;
  }}
  onQueryChange={(next) => {
    query = next;
  }}
  onValueChange={(value) => {
    framework = value;
  }}
/>;
