import {
  Badge,
  Button,
  Code,
  Column,
  DataGrid,
  Diff,
  Dialog,
  DropdownMenu,
  Input,
  Markdown,
  Progress,
  Resizable,
  Row,
  Scroll,
  Separator,
  Sidebar,
  Slider,
  Switch,
  Tabs,
  Text,
  TitleBar,
  View,
  Window,
  darkTheme,
  theme,
  type Child,
  type DataGridKey,
  type DataGridSort,
} from "tarve";

// "Tarve Studio": the application shown in the launch film, built with real
// Tarve components. Search filters the DataGrid, "New" opens a DropdownMenu,
// "Build executable…" opens a Dialog that compiles this example with the
// `tarve/build` API, and the inspector sits behind a native Resizable splitter.

const c = theme.colors;

export interface ComponentRow {
  name: string;
  kind: "control" | "input" | "overlay" | "layout" | "navigation" | "rich" | "data";
  layoutMs: number;
}

export const componentRows: ComponentRow[] = [
  ["Button", "control"], ["Input", "input"], ["Select", "input"], ["DropdownMenu", "overlay"],
  ["Dialog", "overlay"], ["Resizable", "layout"], ["ScrollArea", "layout"], ["Tabs", "navigation"],
  ["Markdown", "rich"], ["Code", "rich"], ["Diff", "rich"], ["DataGrid", "data"],
  ["VirtualList", "data"], ["TreeView", "data"], ["CommandPalette", "overlay"], ["TextArea", "input"],
  ["Slider", "input"], ["Tooltip", "overlay"],
].map(([name, kind], index) => ({
  name,
  kind: kind as ComponentRow["kind"],
  layoutMs: Number((0.02 + ((index * 37) % 26) / 100).toFixed(2)),
}));

const nativeKinds = new Set<ComponentRow["kind"]>(["rich", "data"]);

export const appSource = `import { Window, Row, DataGrid, Markdown } from "tarve";

export function Studio() {
  return (
    <Window title="Tarve Studio" width={1280}>
      <Row flex={1} gap={12}>
        <Sidebar items={routes} />
        <DataGrid rows={metrics} virtual />
        <Markdown source={notes} />
      </Row>
    </Window>
  );
}`;

export const readme = `# Tarve

Native desktop UI for **Bun + TypeScript**. No browser. No DOM. Just native pixels.

### Under the hood

- **Taffy** — flexbox & grid layout
- **Parley** — shaping, selection, IME
- **Vello** — GPU vector rendering

\`\`\`ts
const app = createApp(App);
\`\`\`

> Retained. Incremental. Native.`;

// Hunk header counts must match the body exactly.
export const renderPatch = [
  "diff --git a/native/src/render.rs b/native/src/render.rs",
  "--- a/native/src/render.rs",
  "+++ b/native/src/render.rs",
  "@@ -41,4 +41,6 @@ impl Surface",
  " fn present(&mut self, scene: &Scene) -> Result<()> {",
  "-    self.renderer.render(scene)?;",
  "+    let frame = self.swapchain.acquire()?;",
  "+    self.renderer.render_to(scene, &frame)?;",
  "+    frame.present(Present::Immediate);",
  "     Ok(())",
  " }",
  "",
].join("\n");

type BuildState =
  | { phase: "idle" }
  | { phase: "building" }
  | { phase: "done"; path: string; seconds: number }
  | { phase: "failed"; message: string };

let section = "components";
let sidebarCollapsed = false;
let query = "";
let gridOffset = 0;
let gridSort: DataGridSort | undefined;
let selected: DataGridKey[] = ["VirtualList"];
let menuOpen = false;
let dialogOpen = false;
let buildState: BuildState = { phase: "idle" };
let inspectorSize = 30;
let vsync = true;
let overscan = 8;
let documentTab = "code";
let status = "Ready";

let refresh = () => {};
let buildExecutable: () => Promise<string> = async () => {
  throw new Error("No build handler connected.");
};

export function connectStudio(options: { refresh: () => void; build: () => Promise<string> }) {
  refresh = options.refresh;
  buildExecutable = options.build;
}

async function runBuild() {
  buildState = { phase: "building" };
  status = "Compiling studio.tsx…";
  refresh();
  const started = performance.now();
  try {
    const path = await buildExecutable();
    const seconds = (performance.now() - started) / 1000;
    buildState = { phase: "done", path, seconds };
    status = `Built ${path} in ${seconds.toFixed(1)}s`;
  } catch (error) {
    buildState = { phase: "failed", message: error instanceof Error ? error.message : String(error) };
    status = "Build failed";
  }
  refresh();
}

function Property({ name, value }: { name: string; value: string }) {
  return (
    <Row justify="between" align="center" style={{ width: "100%", padding: { top: 6, bottom: 6 }, borderWidth: { bottom: 1 }, borderColor: c.border }}>
      <Text size={12} color={c.mutedForeground}>{name}</Text>
      <Text size={12}>{value}</Text>
    </Row>
  );
}

function Inspector() {
  const row = componentRows.find(item => item.name === selected[0]);
  return (
    <Column gap={12} padding={16} style={{ width: "100%", height: "100%", background: c.card }}>
      <Column gap={2}>
        <Text size={13} weight={650}>Inspector</Text>
        <Text id="inspector-selection" size={12} color={c.primary}>{row ? `<${row.name}>` : "No selection"}</Text>
      </Column>
      <Column gap={0} style={{ width: "100%" }}>
        <Property name="renderer" value="d3d11" />
        <Property name="layout" value="taffy" />
        <Property name="text" value="parley" />
        <Property name="kind" value={row?.kind ?? "—"} />
        <Property name="layout time" value={row ? `${row.layoutMs.toFixed(2)} ms` : "—"} />
      </Column>
      <Switch id="inspector-vsync" label="VSync" checked={vsync} onCheckedChange={value => { vsync = value; }} />
      <Column gap={6} style={{ width: "100%" }}>
        <Row justify="between" style={{ width: "100%" }}>
          <Text size={12} color={c.mutedForeground}>Overscan</Text>
          <Text size={12}>{overscan} rows</Text>
        </Row>
        <Slider id="inspector-overscan" label="Overscan" value={overscan} min={0} max={32} onValueChange={value => { overscan = value; }} style={{ width: "100%" }} />
      </Column>
      <Column gap={6} style={{ width: "100%" }}>
        <Text size={12} color={c.mutedForeground}>Frame budget used</Text>
        <Progress label="Frame budget used" value={row ? Math.round(row.layoutMs / 8.33 * 100 * 10) : 0} max={100} />
      </Column>
    </Column>
  );
}

function ComponentGrid() {
  return (
    <DataGrid
      id="studio-grid"
      rows={componentRows}
      rowKey={row => row.name}
      height={330}
      rowHeight={38}
      offset={gridOffset}
      overscan={overscan}
      filter={query}
      sort={gridSort}
      selectionMode="single"
      selectedKeys={selected}
      empty={<Text color={c.mutedForeground}>No components match “{query}”.</Text>}
      onScroll={offset => { gridOffset = offset; }}
      onSortChange={sort => { gridSort = sort; }}
      onSelectionChange={keys => { selected = keys; }}
      onRowActivate={row => { status = `Opened ${row.name}`; }}
      columns={[
        { key: "name", header: "Component", sortable: true, searchable: true },
        {
          key: "kind",
          header: "Status",
          sortable: true,
          render: row => <Badge variant={nativeKinds.has(row.kind) ? "default" : "secondary"}>{nativeKinds.has(row.kind) ? "native" : "stable"}</Badge>,
        },
        { key: "layoutMs", header: "Layout", sortable: true, value: row => row.layoutMs, render: row => <Text size={13}>{row.layoutMs.toFixed(2)} ms</Text> },
      ]}
    />
  );
}

function Toolbar() {
  return (
    <Row gap={8} align="center" style={{ width: "100%" }}>
      <Input
        id="studio-search"
        type="search"
        value={query}
        placeholder="Search components…"
        onChange={value => { query = value; }}
        style={{ flex: 1, minWidth: 160 }}
      />
      <Button id="studio-clear" variant="outline" size="sm" disabled={!query} onClick={() => { query = ""; }}>Clear</Button>
      <DropdownMenu
        id="studio-new"
        open={menuOpen}
        onOpenChange={open => { menuOpen = open; }}
        trigger={<Text size={13} weight={600}>+  New</Text>}
        side="bottom"
        items={[
          { value: "window", label: "New window", icon: "plus", shortcut: "Ctrl N" },
          { value: "open", label: "Open file…", icon: "folder", shortcut: "Ctrl O" },
          { value: "build", label: "Build executable…", icon: "download", shortcut: "Ctrl B" },
          { value: "theme", label: "Toggle theme", icon: "star", shortcut: "Ctrl T" },
          { value: "preferences", label: "Preferences", icon: "settings", shortcut: "Ctrl ," },
        ]}
        onSelect={value => {
          if (value === "build") {
            buildState = { phase: "idle" };
            dialogOpen = true;
          } else {
            status = `Selected “${value}”`;
          }
        }}
      />
    </Row>
  );
}

function Documents() {
  return (
    <Tabs
      id="studio-documents"
      value={documentTab}
      onValueChange={value => { documentTab = value; }}
      items={[
        {
          value: "code",
          label: "app.tsx",
          content: <Code id="studio-code" code={appSource} language="tsx" showLineNumbers style={{ width: "100%", padding: 14, background: c.muted, radius: 8 }} />,
        },
        {
          value: "readme",
          label: "README.md",
          content: <Markdown id="studio-readme" source={readme} style={{ width: "100%", padding: 14 }} />,
        },
        {
          value: "diff",
          label: "render.rs",
          content: <Diff id="studio-diff" source={renderPatch} wordDiff style={{ width: "100%", padding: 8, fontSize: 12 }} />,
        },
      ]}
      style={{ width: "100%" }}
    />
  );
}

function BuildDialog() {
  const building = buildState.phase === "building";
  let result: Child = null;
  if (buildState.phase === "done") result = <Text id="build-result" size={12} color={c.primary}>Built {buildState.path} in {buildState.seconds.toFixed(1)}s</Text>;
  if (buildState.phase === "failed") result = <Text id="build-result" size={12} color={c.destructive}>{buildState.message}</Text>;
  return (
    <Dialog
      id="build-dialog"
      open={dialogOpen}
      onOpenChange={open => { if (!building) dialogOpen = open; }}
      title="Build native executable?"
      description="Compile studio.tsx into a standalone native executable with tarve/build."
      width={460}
      footer={
        <Row gap={8} justify="end">
          <Button id="build-cancel" variant="outline" disabled={building} onClick={() => { dialogOpen = false; }}>
            {buildState.phase === "done" ? "Close" : "Cancel"}
          </Button>
          <Button id="build-confirm" disabled={building} onClick={() => { void runBuild(); }}>
            {building ? "Building…" : buildState.phase === "done" ? "Rebuild" : "Build"}
          </Button>
        </Row>
      }
    >
      <Column gap={10} style={{ width: "100%" }}>
        <View style={{ width: "100%", padding: 10, background: c.muted, radius: 6 }}>
          <Text size={13}>$ tarve build studio.tsx --outfile dist/Studio</Text>
        </View>
        {result}
      </Column>
    </Dialog>
  );
}

export function App() {
  return (
    <Window title="Tarve Studio" width={1280} height={820} minWidth={900} minHeight={600} position="center" theme={darkTheme}>
      <TitleBar title="Tarve Studio" />
      <Row flex={1} gap={0} style={{ width: "100%" }}>
        <Sidebar
          id="studio-sidebar"
          value={section}
          collapsed={sidebarCollapsed}
          width={210}
          collapsedWidth={58}
          header={<Text size={11} weight={600} color={c.mutedForeground}>WORKSPACE</Text>}
          footer={<Text size={11} color={c.mutedForeground}>d3d11 · 120 Hz</Text>}
          onValueChange={value => { section = value; }}
          onCollapsedChange={value => { sidebarCollapsed = value; }}
          items={[
            { value: "overview", label: "Overview", icon: "house" },
            { value: "components", label: "Components", icon: "star", badge: <Badge variant="secondary">{componentRows.length}</Badge> },
            { value: "layout", label: "Layout", icon: "chevron-right" },
            { value: "renderer", label: "Renderer", icon: "info" },
            { value: "profiler", label: "Profiler", icon: "search" },
            { value: "accessibility", label: "Accessibility", icon: "user" },
            { value: "settings", label: "Settings", icon: "settings" },
          ]}
        />
        <Resizable
          id="studio-split"
          size={100 - inspectorSize}
          min={50}
          max={85}
          label="Resize inspector"
          onSizeChange={value => { inspectorSize = 100 - value; }}
          style={{ flex: 1, height: "100%" }}
          first={
            <Scroll id="studio-main" flex={1} style={{ width: "100%", height: "100%" }}>
              <Column gap={14} padding={18} style={{ width: "100%" }}>
                <Toolbar />
                <ComponentGrid />
                <Separator />
                <Documents />
              </Column>
            </Scroll>
          }
          second={<Inspector />}
        />
      </Row>
      <Row justify="between" align="center" padding={8} style={{ width: "100%", background: c.card, borderWidth: { top: 1 }, borderColor: c.border }}>
        <Text id="studio-status" size={12} color={c.mutedForeground}>{status}</Text>
        <Text size={12} color={c.mutedForeground}>{query ? `Filter: “${query}”` : `${componentRows.length} components`}</Text>
      </Row>
      <BuildDialog />
    </Window>
  );
}
