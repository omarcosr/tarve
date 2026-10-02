import { NavigationMenu } from "@tarve/core";

let value = "docs";
let openValue: string | undefined;

<NavigationMenu
  value={value}
  openValue={openValue}
  items={[
    {
      value: "docs",
      label: "Docs",
      links: [
        { value: "start", label: "Getting started", description: "Install and run your first window." },
        { value: "components", label: "Components", description: "Every built-in control." },
      ],
    },
    { value: "blog", label: "Blog" },
  ]}
  onValueChange={(next) => {
    value = next;
  }}
  onOpenValueChange={(next) => {
    openValue = next;
  }}
/>;
