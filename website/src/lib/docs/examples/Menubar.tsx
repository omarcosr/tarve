import { Menubar } from "@tarve/core";

let openMenu: string | undefined = "file";

<Menubar
  openMenu={openMenu}
  menus={[
    {
      value: "file",
      label: "File",
      items: [
        { value: "new", label: "New", shortcut: "Ctrl+N" },
        { value: "open", label: "Open…", shortcut: "Ctrl+O" },
      ],
    },
    { value: "edit", label: "Edit", items: [{ value: "undo", label: "Undo", shortcut: "Ctrl+Z" }] },
  ]}
  onOpenMenuChange={(value) => {
    openMenu = value;
  }}
  onSelect={(menu, item) => console.log(menu, item)}
/>;
