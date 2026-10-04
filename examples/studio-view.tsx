import {
  Badge,
  Button,
  Code,
  Column,
  DataGrid,
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
  lightTheme,
  theme,
  type Child,
  type DataGridKey,
  type DataGridSort,
} from "@tarve/core";
import { ComponentPreview, previewSources } from "./studio-previews";

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

const FRAME_MS = 1000 / 120;
const nativeKinds = new Set<ComponentRow["kind"]>(["rich", "data"]);

export const appSource = previewSources.Studio!;

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
let dark = true;
let openedFile: { name: string; path: string; text: string } | undefined;

let refresh = () => {};
export type StudioBuild =
  | { runtime: "bun" | "node"; command: string; run: () => Promise<string> }
  | { unavailable: string };
let studioBuild: StudioBuild = { unavailable: "No build handler connected." };
let pickFile: () => Promise<{ name: string; path: string; text: string } | undefined> = async () => undefined;

export function connectStudio(options: {
  refresh: () => void;
  build: StudioBuild;
  openFile: () => Promise<{ name: string; path: string; text: string } | undefined>;
}) {
  refresh = options.refresh;
  studioBuild = options.build;
  pickFile = options.openFile;
}

async function openFile() {
  try {
    const file = await pickFile();
    if (!file) { status = "Open cancelled"; }
    else {
      openedFile = file;
      documentTab = "code";
      status = `Opened ${file.path}`;
    }
  } catch (error) {
    status = `Could not open the file: ${error instanceof Error ? error.message : String(error)}`;
  }
  refresh();
}

async function runBuild() {
  if ("unavailable" in studioBuild) return;
  buildState = { phase: "building" };
  status = `Compiling studio.tsx with ${studioBuild.runtime === "bun" ? "Bun" : "Node.js"}…`;
  refresh();
  const started = performance.now();
  try {
    const path = await studioBuild.run();
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
        <Row justify="between" style={{ width: "100%" }}>
          <Text size={12} color={c.mutedForeground}>Share of a 120 Hz frame</Text>
          <Text size={12}>{row ? `${(row.layoutMs / FRAME_MS * 100).toFixed(1)}%` : "—"}</Text>
        </Row>
        <Progress label="Layout share of a 120 Hz frame" value={row ? row.layoutMs : 0} max={FRAME_MS} />
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
          key: "status",
          header: "Status",
          sortable: true,
          // Sort and filter on the label the badge shows, not the raw kind.
          value: row => (nativeKinds.has(row.kind) ? "native" : "stable"),
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
        trigger={<Text size={13} weight={600}>Actions</Text>}
        side="bottom"
        items={[
          { value: "open", label: "Open file…", icon: "folder" },
          { value: "build", label: "Build executable…", icon: "download" },
          { value: "theme", label: dark ? "Light theme" : "Dark theme", icon: "star" },
          { value: "sidebar", label: sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar", icon: "chevron-left" },
        ]}
        onSelect={value => {
          if (value === "build") {
            buildState = { phase: "idle" };
            dialogOpen = true;
          } else if (value === "open") {
            void openFile();
          } else if (value === "theme") {
            dark = !dark;
            status = `${dark ? "Dark" : "Light"} theme`;
          } else if (value === "sidebar") {
            sidebarCollapsed = !sidebarCollapsed;
          }
        }}
      />
    </Row>
  );
}

function Documents() {
  const name = selected[0] === undefined ? undefined : String(selected[0]);
  const sample = name ? previewSources[name] : undefined;
  const codeName = openedFile?.name ?? (sample ? `${name}.tsx` : "app.tsx");
  const codeText = openedFile?.text ?? sample ?? appSource;
  return (
    <Tabs
      id="studio-documents"
      value={documentTab}
      onValueChange={value => { documentTab = value; }}
      items={[
        {
          value: "code",
          label: codeName,
          content: <Code id="studio-code" code={codeText} path={openedFile?.path ?? codeName} showLineNumbers style={{ width: "100%", padding: 14, background: c.muted, radius: 8 }} />,
        },
        {
          value: "readme",
          label: "README.md",
          content: <Markdown id="studio-readme" source={readme} style={{ width: "100%", padding: 14 }} />,
        },
      ]}
      style={{ width: "100%" }}
    />
  );
}

const sections: Record<string, { title: string; summary: string }> = {
  overview: { title: "Overview", summary: "What this window is built from." },
  components: { title: "Components", summary: "Pick a row to try a live instance of the component." },
  layout: { title: "Layout", summary: "Flexbox and grid by Taffy, measured natively." },
  renderer: { title: "Renderer", summary: "How the window is drawn." },
  profiler: { title: "Profiler", summary: "Layout cost per component, as a share of a 120 Hz frame." },
  accessibility: { title: "Accessibility", summary: "Every control is exposed to screen readers through AccessKit." },
  settings: { title: "Settings", summary: "Studio preferences." },
};

function Card({ title, children }: { title: string; children: Child }) {
  return (
    <Column gap={8} padding={14} style={{ width: "100%", background: c.card, radius: 8, borderWidth: 1, borderColor: c.border }}>
      <Text size={13} weight={650}>{title}</Text>
      {children}
    </Column>
  );
}

function Section() {
  const info = sections[section] ?? sections.overview!;
  let body: Child;
  if (section === "components") {
    body = <Column gap={14} style={{ width: "100%" }}><Toolbar /><ComponentGrid /><ComponentPreview name={selected[0] === undefined ? undefined : String(selected[0])} /><Separator /><Documents /></Column>;
  } else if (section === "overview") {
    body = (
      <Column gap={12} style={{ width: "100%" }}>
        <Row gap={12} style={{ width: "100%" }}>
          <Card title="Components"><Text size={22} weight={700}>{componentRows.length}</Text></Card>
          <Card title="Native rich content"><Text size={22} weight={700}>{componentRows.filter(row => nativeKinds.has(row.kind)).length}</Text></Card>
          <Card title="Theme"><Text size={22} weight={700}>{dark ? "Dark" : "Light"}</Text></Card>
        </Row>
        <Card title="Get started"><Button id="overview-components" onClick={() => { section = "components"; }}>Browse components</Button></Card>
        <Documents />
      </Column>
    );
  } else if (section === "layout") {
    body = (
      <Card title="Flex row with a growing middle child">
        <Row gap={8} style={{ width: "100%" }}>
          <View style={{ width: 80, height: 48, background: c.muted, radius: 6 }} />
          <View style={{ flex: 1, height: 48, background: c.primary, radius: 6 }} />
          <View style={{ width: 80, height: 48, background: c.muted, radius: 6 }} />
        </Row>
        <Text size={12} color={c.mutedForeground}>Resize the window or drag the inspector splitter: only the middle box changes width.</Text>
      </Card>
    );
  } else if (section === "renderer") {
    body = (
      <Card title="Pipeline">
        <Property name="Layout" value="Taffy (flexbox, grid)" />
        <Property name="Text" value="Parley + Swash" />
        <Property name="Windows" value="Direct3D 11, Vello/wgpu fallback, CPU last" />
        <Property name="Linux" value="Vello/wgpu, CPU fallback" />
        <Property name="VSync" value={vsync ? "on" : "off"} />
      </Card>
    );
  } else if (section === "profiler") {
    body = (
      <Card title="Layout share of a 120 Hz frame">
        {[...componentRows].sort((a, b) => b.layoutMs - a.layoutMs).map(row => (
          <Column key={row.name} gap={4} style={{ width: "100%" }}>
            <Row justify="between" style={{ width: "100%" }}><Text size={12}>{row.name}</Text><Text size={12} color={c.mutedForeground}>{row.layoutMs.toFixed(2)} ms</Text></Row>
            <Progress label={`${row.name} layout share`} value={row.layoutMs} max={FRAME_MS} />
          </Column>
        ))}
      </Card>
    );
  } else if (section === "accessibility") {
    body = (
      <Card title="Try it">
        <Text size={12} color={c.mutedForeground}>Tab moves focus between controls, Enter and Space activate them, arrow keys move inside lists, menus and tabs. Narrator and Orca read the same tree.</Text>
        <Row gap={8}><Button id="a11y-one">First</Button><Button id="a11y-two" variant="outline">Second</Button><Switch id="a11y-switch" label="A switch" checked={vsync} onCheckedChange={value => { vsync = value; }} /></Row>
      </Card>
    );
  } else {
    body = (
      <Card title="Preferences">
        <Switch id="settings-dark" label="Dark theme" checked={dark} onCheckedChange={value => { dark = value; }} />
        <Switch id="settings-vsync" label="VSync" checked={vsync} onCheckedChange={value => { vsync = value; }} />
        <Switch id="settings-sidebar" label="Collapsed sidebar" checked={sidebarCollapsed} onCheckedChange={value => { sidebarCollapsed = value; }} />
        <Button id="settings-build" variant="outline" onClick={() => { buildState = { phase: "idle" }; dialogOpen = true; }}>Build executable…</Button>
      </Card>
    );
  }
  return (
    <Column gap={14} style={{ width: "100%" }}>
      <Column gap={2}>
        <Text size={18} weight={700}>{info.title}</Text>
        <Text size={12} color={c.mutedForeground}>{info.summary}</Text>
      </Column>
      {body}
    </Column>
  );
}

function BuildDialog() {
  const building = buildState.phase === "building";
  const available = !("unavailable" in studioBuild);
  let result: Child = null;
  if (!available) result = <Text id="build-result" size={12} color={c.mutedForeground}>{(studioBuild as { unavailable: string }).unavailable}</Text>;
  if (buildState.phase === "done") result = <Text id="build-result" size={12} color={c.primary}>Built {buildState.path} in {buildState.seconds.toFixed(1)}s</Text>;
  if (buildState.phase === "failed") result = <Text id="build-result" size={12} color={c.destructive}>{buildState.message}</Text>;
  return (
    <Dialog
      id="build-dialog"
      open={dialogOpen}
      onOpenChange={open => { if (!building) dialogOpen = open; }}
      title="Build native executable?"
      description={available
        ? `Compile studio.tsx into a standalone executable with ${(studioBuild as { runtime: string }).runtime === "bun" ? "Bun" : "Node.js"} through @tarve/core/build.`
        : "Building needs the Studio source and a bundler."}
      width={460}
      footer={
        <Row gap={8} justify="end">
          <Button id="build-cancel" variant="outline" disabled={building} onClick={() => { dialogOpen = false; }}>
            {buildState.phase === "done" ? "Close" : "Cancel"}
          </Button>
          <Button id="build-confirm" disabled={building || !available} onClick={() => { void runBuild(); }}>
            {building ? "Building…" : buildState.phase === "done" ? "Rebuild" : "Build"}
          </Button>
        </Row>
      }
    >
      <Column gap={10} style={{ width: "100%" }}>
        {available
          ? <View style={{ width: "100%", padding: 10, background: c.muted, radius: 6 }}>
              <Text size={13}>$ {(studioBuild as { command: string }).command}</Text>
          </View>
          : null}
        {result}
      </Column>
    </Dialog>
  );
}

export function App() {
  return (
    <Window title="Tarve Studio" width={1280} height={820} minWidth={900} minHeight={600} position="center" theme={dark ? darkTheme : lightTheme}>
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
                <Section />
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
