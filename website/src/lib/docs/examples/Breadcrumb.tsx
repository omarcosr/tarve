import { Breadcrumb } from "@tarve/core";

<Breadcrumb
  items={[
    { label: "Home", onClick: () => console.log("home") },
    { label: "Projects", onClick: () => console.log("projects") },
    { label: "tarve" },
  ]}
/>;
