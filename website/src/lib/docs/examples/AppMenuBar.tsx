import { AppMenuBar, Column, Text, TitleBar, Window, darkTheme } from "@tarve/core";

<Window title="Notes" width={640} height={260} theme={darkTheme}>
  <TitleBar height={36}>
    <AppMenuBar
      items={[
        {
          label: "&File",
          items: [
            { id: "new", label: "New", accelerator: "Ctrl+N" },
            { id: "open", label: "Open…", accelerator: "Ctrl+O" },
            { type: "separator" },
            { label: "Recent", items: [{ id: "recent-1", label: "notes.md" }] },
          ],
        },
        { label: "&View", items: [{ id: "wrap", label: "Word wrap", checked: true }] },
      ]}
      onSelect={(id) => console.log("menu", id)}
    />
  </TitleBar>
  <Column flex={1} padding={24}>
    <Text>Alt+F opens File; F10 focuses the bar.</Text>
  </Column>
</Window>;
