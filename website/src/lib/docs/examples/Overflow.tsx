import { Button, Column, DropdownMenu, Overflow, Slider, Text } from "@tarve/core";

const tools = ["Bold", "Italic", "Underline", "Link", "Quote", "Code", "List", "Table"];
let width = 320;
let menu = false;

<Column gap={12}>
  <Slider value={width} min={120} max={560} onValueChange={(value) => (width = value)} />
  <Overflow
    id="toolbar"
    items={tools}
    gap={6}
    style={{ width }}
    renderItem={(tool) => <Button size="sm" variant="outline">{tool}</Button>}
    renderOverflow={(hidden) => (
      <DropdownMenu
        id="toolbar-more"
        open={menu}
        onOpenChange={(next) => (menu = next)}
        trigger={<Button size="sm" variant="ghost">{`+${hidden.length}`}</Button>}
        items={hidden.map((tool) => ({ value: tool, label: tool }))}
      />
    )}
  />
  <Text size={12}>{`${width}px`}</Text>
</Column>;
