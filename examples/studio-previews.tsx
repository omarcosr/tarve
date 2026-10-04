import {
  Button,
  Code,
  Column,
  CommandPalette,
  DataGrid,
  Dialog,
  Diff,
  DropdownMenu,
  Input,
  Markdown,
  Resizable,
  Row,
  ScrollArea,
  Select,
  Slider,
  Tabs,
  Text,
  TextArea,
  Tooltip,
  TreeView,
  View,
  VirtualList,
  theme,
  type Child,
} from "@tarve/core";

// Live, interactive instances of every component listed in Studio's grid. Each
// preview keeps its own state; Tarve re-renders after any handler runs.

const c = theme.colors;
const s = {
  clicks: 0,
  input: "",
  select: "native",
  menuOpen: false,
  menuPicked: "—",
  dialogOpen: false,
  split: 50,
  scroll: 0,
  tab: "one",
  palette: false,
  palettePicked: "—",
  paletteQuery: "",
  area: "Multi-line text.\nShift+Enter adds a line.",
  slider: 40,
  tooltip: false,
  list: 0,
  tree: ["src"],
  treeSelected: "app",
  gridSelected: [] as (string | number)[],
};

const rows = Array.from({ length: 1000 }, (_, i) => `Row ${i + 1}`);

function Caption({ children }: { children: Child }) {
  return <Text size={12} color={c.mutedForeground}>{children}</Text>;
}

const previews: Record<string, () => Child> = {
  Button: () => (
    <Row gap={8} align="center">
      <Button id="p-button" onClick={() => { s.clicks++; }}>Click me</Button>
      <Button id="p-button-outline" variant="outline" onClick={() => { s.clicks = 0; }}>Reset</Button>
      <Caption>{`${s.clicks} click${s.clicks === 1 ? "" : "s"}`}</Caption>
    </Row>
  ),
  Input: () => (
    <Column gap={6} style={{ width: "100%" }}>
      <Input id="p-input" value={s.input} placeholder="Type something…" onChange={v => { s.input = v; }} style={{ width: "100%" }} />
      <Caption>{s.input ? `${s.input.length} characters: “${s.input}”` : "Empty"}</Caption>
    </Column>
  ),
  Select: () => (
    <Column gap={6}>
      <Select id="p-select" value={s.select} onValueChange={v => { s.select = v; }} options={[
        { value: "native", label: "Native pixels" }, { value: "gpu", label: "GPU" }, { value: "cpu", label: "CPU fallback" },
      ]} />
      <Caption>{`Selected: ${s.select}`}</Caption>
    </Column>
  ),
  DropdownMenu: () => (
    <Row gap={8} align="center">
      <DropdownMenu id="p-menu" open={s.menuOpen} onOpenChange={o => { s.menuOpen = o; }} trigger={<Text size={13} weight={600}>Open menu</Text>}
        items={[{ value: "copy", label: "Copy" }, { value: "paste", label: "Paste" }, { value: "delete", label: "Delete" }]}
        onSelect={v => { s.menuPicked = v; }} />
      <Caption>{`Picked: ${s.menuPicked}`}</Caption>
    </Row>
  ),
  Dialog: () => (
    <View>
      <Button id="p-dialog-open" onClick={() => { s.dialogOpen = true; }}>Open dialog</Button>
      <Dialog id="p-dialog" open={s.dialogOpen} onOpenChange={o => { s.dialogOpen = o; }} title="A native dialog"
        description="Escape, the close button or the overlay dismiss it." width={380}
        footer={<Row justify="end"><Button id="p-dialog-ok" onClick={() => { s.dialogOpen = false; }}>OK</Button></Row>} />
    </View>
  ),
  Resizable: () => (
    <Resizable id="p-split" size={s.split} min={20} max={80} label="Resize" onSizeChange={v => { s.split = v; }}
      style={{ width: "100%", height: 120 }}
      first={<View style={{ width: "100%", height: "100%", background: c.muted, padding: 10 }}><Caption>{`${s.split.toFixed(0)}%`}</Caption></View>}
      second={<View style={{ width: "100%", height: "100%", padding: 10 }}><Caption>Drag the divider</Caption></View>} />
  ),
  ScrollArea: () => (
    <ScrollArea id="p-scroll" onScroll={o => { s.scroll = o; }} style={{ width: "100%", height: 120, background: c.muted, radius: 6 }}>
      <Column gap={4} padding={10}>
        {Array.from({ length: 30 }, (_, i) => <Text key={i} size={12}>{`Line ${i + 1}`}</Text>)}
        <Caption>{`offset ${s.scroll.toFixed(0)}px`}</Caption>
      </Column>
    </ScrollArea>
  ),
  Tabs: () => (
    <Tabs id="p-tabs" value={s.tab} onValueChange={v => { s.tab = v; }} style={{ width: "100%" }} items={[
      { value: "one", label: "First", content: <Caption>First tab content</Caption> },
      { value: "two", label: "Second", content: <Caption>Second tab content</Caption> },
      { value: "three", label: "Third", content: <Caption>Third tab content</Caption> },
    ]} />
  ),
  Markdown: () => <Markdown id="p-markdown" source={"## Markdown\n\nRendered **natively**, with `code`, lists and [links](https://example.com).\n\n- one\n- two"} style={{ width: "100%" }} />,
  Code: () => <Code id="p-code" path="hello.ts" showLineNumbers code={"export function hello(name: string) {\n  return `Hello, ${name}!`;\n}"} style={{ width: "100%", padding: 10, background: c.muted, radius: 6 }} />,
  Diff: () => <Diff id="p-diff" wordDiff source={["--- a/a.ts", "+++ b/a.ts", "@@ -1,2 +1,2 @@", "-const speed = 1;", "+const speed = 2;", " export { speed };", ""].join("\n")} style={{ width: "100%", fontSize: 12 }} />,
  DataGrid: () => (
    <DataGrid id="p-grid" rows={rows.slice(0, 50).map((name, i) => ({ name, size: (i * 7) % 23 }))} rowKey={r => r.name} height={150} rowHeight={30}
      selectionMode="multiple" selectedKeys={s.gridSelected} onSelectionChange={k => { s.gridSelected = k; }}
      columns={[{ key: "name", header: "Name", sortable: true }, { key: "size", header: "Size", sortable: true, value: r => r.size }]} />
  ),
  VirtualList: () => (
    <Column gap={6} style={{ width: "100%" }}>
      <VirtualList id="p-list" items={rows} itemHeight={24} height={130} offset={s.list} onScroll={o => { s.list = o; }}
        renderItem={item => <Text size={12}>{item}</Text>} style={{ width: "100%" }} />
      <Caption>{`1,000 rows, only the visible ones exist — offset ${s.list.toFixed(0)}px`}</Caption>
    </Column>
  ),
  TreeView: () => (
    <Column gap={6}>
      <TreeView id="p-tree" expandedIds={s.tree} selectedId={s.treeSelected}
        onExpandedChange={ids => { s.tree = ids; }} onSelectedChange={id => { s.treeSelected = id; }}
        nodes={[{ id: "src", label: "src", children: [{ id: "app", label: "app.tsx" }, { id: "view", label: "view.tsx" }, { id: "lib", label: "lib", children: [{ id: "util", label: "util.ts" }] }] }, { id: "pkg", label: "package.json" }]} />
      <Caption>{`Selected: ${s.treeSelected}`}</Caption>
    </Column>
  ),
  CommandPalette: () => (
    <Row gap={8} align="center">
      <Button id="p-palette-open" onClick={() => { s.palette = true; s.paletteQuery = ""; }}>Open palette</Button>
      <Caption>{`Ran: ${s.palettePicked}`}</Caption>
      <CommandPalette id="p-palette" open={s.palette} onOpenChange={o => { s.palette = o; }} query={s.paletteQuery}
        onQueryChange={q => { s.paletteQuery = q; }} onSelect={v => { s.palettePicked = v; }}
        items={[{ value: "build", label: "Build executable" }, { value: "theme", label: "Toggle theme" }, { value: "reload", label: "Reload window" }]} />
    </Row>
  ),
  TextArea: () => (
    <Column gap={6} style={{ width: "100%" }}>
      <TextArea id="p-textarea" value={s.area} onChange={v => { s.area = v; }} style={{ width: "100%", height: 90 }} />
      <Caption>{`${s.area.split("\n").length} lines`}</Caption>
    </Column>
  ),
  Slider: () => (
    <Column gap={6} style={{ width: "100%" }}>
      <Slider id="p-slider" label="Value" value={s.slider} min={0} max={100} onValueChange={v => { s.slider = v; }} style={{ width: "100%" }} />
      <Caption>{`Value: ${s.slider}`}</Caption>
    </Column>
  ),
  Tooltip: () => (
    <Tooltip id="p-tooltip" open={s.tooltip} onOpenChange={o => { s.tooltip = o; }} content={<Text size={12}>Native tooltip</Text>}
      trigger={<Text size={13} weight={600}>Hover me</Text>} />
  ),
};

export function ComponentPreview({ name }: { name: string | undefined }) {
  const render = name ? previews[name] : undefined;
  return (
    <Column gap={10} padding={14} style={{ width: "100%", background: c.card, radius: 8, borderWidth: 1, borderColor: c.border }}>
      <Text size={13} weight={650}>{name ? `<${name}> — live preview` : "Select a component to try it"}</Text>
      {render ? render() : <Caption>Pick a row in the grid above.</Caption>}
    </Column>
  );
}

export const previewNames = Object.keys(previews);

/** A runnable app per preview (examples/studio-samples), shown in Studio's code tab. */
export { previewSources } from "./studio-samples.generated";
