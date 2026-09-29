import { CameraIcon as HeroCamera } from "@heroicons/react/24/outline";
import { Camera as PhosphorCamera } from "@phosphor-icons/react";
import { IconCamera as TablerCamera } from "@tabler/icons-react";
import { Camera } from 'lucide-react';
import {
  Alert,
  AspectRatio,
  Attachment,
  Bubble,
  Button,
  ButtonGroup,
  Carousel,
  Chart,
  Circle,
  Column,
  DataGrid,
  Direction,
  Drawer,
  Empty,
  Field,
  Icon,
  Image,
  Input,
  InputGroup,
  InputOTP,
  Item,
  Kbd,
  Label,
  Link,
  Marker,
  Message,
  MessageScroller,
  NativeSelect,
  NavigationMenu,
  Path,
  Questionnaire,
  Resizable,
  Row,
  Scroll,
  ScrollArea,
  Sidebar,
  Svg,
  Text,
  TextArea,
  theme,
  TitleBar,
  Toggle,
  ToggleGroup,
  TreeView,
  Typography,
  View,
  Window,
  type Child,
  type QuestionnaireAnswer,
  type Style,
  type SvgNode,
} from "@tarve/core";
import vectorScene from "./assets/vector-scene.svg" with { type: "file" };
const c = theme.colors;

const panel: Style = {
  width: "100%",
  padding: 20,
  gap: 14,
  background: c.card,
  borderWidth: 1,
  borderColor: c.border,
  radius: 10,
};

function Section({ title, description, children }: { title: string; description: string; children: Child }) {
  return (
    <Column style={panel}>
      <Column gap={3}>
        <Text size={17} weight={650}>{title}</Text>
        <Text size={12} color={c.mutedForeground}>{description}</Text>
      </Column>
      {children}
    </Column>
  );
}

let carouselIndex = 0;
let drawerOpen = false;
let otp = "12";
let framework = "tarve";
let navigationValue = "overview";
let navigationOpen: string | undefined;
let split = 42;
let sidebarValue = "dashboard";
let sidebarCollapsed = false;
let bold = false;
let alignment: string | string[] = "left";
let questionnaireCurrent = 0;
let questionnaireValues: Record<string, QuestionnaireAnswer | undefined> = {
  name: "Marco",
  runtime: "bun",
  interests: ["native"],
};
let attachmentVisible = true;
let treeExpanded = ["src"];
let treeSelected = "components";
let gridOffset = 0;
let gridSort: { column: string; direction: "asc" | "desc" } | undefined = { column: "name", direction: "asc" };
let gridSelected: (string | number)[] = [2];
let imeInput = "";
let imeNotes = "";
let imeAligned = "";

const lucideStyleIcons: { id: string; label: string; iconNode: readonly SvgNode[] }[] = [
  { id: "house", label: "House", iconNode: [["path", { d: "M3 10.8 12 3l9 7.8V21h-6v-7H9v7H3z" }]] },
  { id: "user", label: "User", iconNode: [["circle", { cx: 12, cy: 8, r: 4 }], ["path", { d: "M4 21a8 8 0 0 1 16 0" }]] },
  { id: "bell", label: "Bell", iconNode: [["path", { d: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" }]] },
  { id: "heart", label: "Heart", iconNode: [["path", { d: "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z" }]] },
  { id: "download", label: "Download", iconNode: [["path", { d: "M12 3v12m0 0 4-4m-4 4-4-4M4 21h16" }]] },
  { id: "mail", label: "Mail", iconNode: [["rect", { x: 3, y: 5, width: 18, height: 14, rx: 2 }], ["path", { d: "m3 7 9 6 9-6" }]] },
];

const gridRows = [
  { id: 1, name: "Renderer", area: "Rust", status: "Ready" },
  { id: 2, name: "Components", area: "TypeScript", status: "Active" },
  { id: 3, name: "Protocol", area: "Shared", status: "v29" },
  { id: 4, name: "Examples", area: "Bun", status: "Ready" },
  { id: 5, name: "Packaging", area: "Bun", status: "Ready" },
];

const questionnaireQuestions = [
  { id: "name", title: "What should we call you?", type: "text" as const, required: true, placeholder: "Your name" },
  {
    id: "runtime",
    title: "Preferred runtime",
    type: "single" as const,
    required: true,
    options: [
      { value: "bun", label: "Bun" },
      { value: "node", label: "Node.js" },
      { value: "deno", label: "Deno" },
    ],
  },
  {
    id: "interests",
    title: "What are you building?",
    type: "multiple" as const,
    options: [
      { value: "native", label: "Native desktop apps" },
      { value: "tools", label: "Developer tools" },
      { value: "dashboards", label: "Dashboards" },
    ],
  },
];


let emailAddress = "hello@example.com";

export function App() {
  return (
    <Window title="Tarve — Components" width={1180} height={900} minWidth={900} minHeight={650} position="center">
      <TitleBar title="Tarve — Components" />
      <Scroll id="components-scroll" flex={1} speed={1}>
        <Column gap={20} padding={28} style={{ width: "100%" }}>
          <Column gap={5}>
            <Text size={28} weight={700}>Component showcase</Text>
            <Text color={c.mutedForeground}>Interactive examples for the 27 high-level components added to Tarve.</Text>
          </Column>

          <View style={{ display: "grid", columns: 2, gap: 18 }}>
            <Section title="Alert" description="Status messages with semantic variants.">
              <Column gap={8}>
                <Alert title="Default alert" description="A neutral application message." />
                <Alert variant="success" title="Saved" description="Your workspace was updated." />
                <Alert variant="destructive" title="Something went wrong" description="The request could not be completed." />
              </Column>
            </Section>

            <Section title="AspectRatio" description="Keeps media at a predictable proportion.">
              <AspectRatio ratio={16 / 9} width={360} style={{ background: c.muted, radius: 8, align: "center", justify: "center" }}>
                <Typography variant="muted">16:9 media surface</Typography>
              </AspectRatio>
            </Section>

            <Section title="ButtonGroup" description="Groups adjacent actions.">
              <ButtonGroup>
                <Button variant="outline">Back</Button>
                <Button>Continue</Button>
                <Button variant="outline">More</Button>
              </ButtonGroup>
            </Section>

            <Section title="Composed Button" description="Buttons can compose icons, text and nested layout while remaining one interactive control.">
              <Row gap={10}>
                <Button id="demo-composed-button">
                  <Icon name="plus" />
                  <Text>Create project</Text>
                </Button>
                <Button variant="outline">
                  <Icon name="search" />
                  <Column gap={0} align="start">
                    <Text weight={600}>Search</Text>
                    <Text size={10}>Ctrl+K</Text>
                  </Column>
                </Button>
              </Row>
            </Section>

            <Section title="SVG + Icons" description="Native SVG plus external icon libraries through pluggable component adapters.">
              <Column gap={14}>
                <Row gap={14} align="center">
                  <View style={{ width: 220, height: 124, shrink: 0, background: c.muted, borderWidth: 1, borderColor: c.border, radius: 10 }}>
                    <Image id="demo-svg-image" src={vectorScene} width={220} height={124} fit="contain" style={{ radius: 10 }} />
                  </View>
                  <Column gap={7} flex={1}>
                    <Text weight={650}>File SVG + declarative TSX</Text>
                    <Text size={11} color={c.mutedForeground}>Image can load a .svg file, while Svg/Path/Circle declare vector geometry directly in TSX.</Text>
                    <Svg id="demo-inline-svg" size={48} viewBox="0 0 24 24" color={c.foreground} strokeWidth={1.8}>
                      <Circle cx={12} cy={12} r={9} />
                      <Path d="M8 12.5 10.7 15 16 9" />
                    </Svg>
                    <Row gap={8}>
                      <Button size="sm"><Icon iconNode={lucideStyleIcons[4].iconNode} /><Text>Export</Text></Button>
                      <Button size="sm" variant="outline"><Icon iconNode={lucideStyleIcons[5].iconNode} /><Text>Mail</Text></Button>
                    </Row>
                  </Column>
                </Row>
                <Row id="demo-external-icon-libraries" gap={10} style={{ wrap: true }}>
                  <Column gap={5} align="center" style={{ width: 100, padding: 10, background: c.muted, radius: 8 }}>
                    <Camera id="demo-lucide-react-camera" size={28} strokeWidth={1.8} />
                    <Text size={10} color={c.mutedForeground}>Lucide</Text>
                  </Column>
                  <Column gap={5} align="center" style={{ width: 100, padding: 10, background: c.muted, radius: 8 }}>
                    <HeroCamera id="demo-heroicons-camera" width={28} height={28} />
                    <Text size={10} color={c.mutedForeground}>Heroicons</Text>
                  </Column>
                  <Column gap={5} align="center" style={{ width: 100, padding: 10, background: c.muted, radius: 8 }}>
                    <PhosphorCamera id="demo-phosphor-camera" size={28} weight="duotone" />
                    <Text size={10} color={c.mutedForeground}>Phosphor</Text>
                  </Column>
                  <Column gap={5} align="center" style={{ width: 100, padding: 10, background: c.muted, radius: 8 }}>
                    <TablerCamera id="demo-tabler-camera" color="#ff00ff" size={28} stroke={1.8} />
                    <Text size={10} color={c.mutedForeground}>Tabler</Text>
                  </Column>
                </Row>
                <View id="demo-lucide-icons" style={{ display: "grid", columns: 3, gap: 8 }}>
                  {lucideStyleIcons.map(({ id, label, iconNode }) => (
                    <Column key={id} gap={5} align="center" style={{ padding: 9, background: c.muted, radius: 8 }}>
                      <Icon id={`demo-icon-${id}`} iconNode={iconNode} size={20} strokeWidth={1.8} />
                      <Text size={10} color={c.mutedForeground}>{label}</Text>
                    </Column>
                  ))}
                </View>
              </Column>
            </Section>

            <Section title="Horizontal ScrollArea" description="Horizontal and bidirectional native scrolling with wheel/trackpad support.">
              <ScrollArea
                id="demo-horizontal-scroll"
                orientation="horizontal"
                style={{ width: "100%", maxWidth: "100%", height: 96, borderWidth: 1, borderColor: c.border, radius: 8 }}
              >
                <Row gap={10} padding={8} style={{ width: 1120, height: 94, shrink: 0 }}>
                  {["Overview", "Activity", "Deployments", "Analytics", "Members"].map((label, index) => (
                    <View
                      key={label}
                      style={{ width: 126, height: 62, shrink: 0, padding: 10, background: c.muted, radius: 7, justify: "center" }}
                    >
                      <Text weight={600}>{label}</Text>
                      <Text size={10} color={c.mutedForeground}>Panel {index + 1}</Text>
                    </View>
                  ))}
                  <Button id="demo-horizontal-target" variant="outline">
                    <Icon name="chevron-right" />
                    <Text>Last action</Text>
                  </Button>
                </Row>
              </ScrollArea>
            </Section>

            <Section title="Carousel" description="Controlled slide navigation with indicators.">
              <Carousel
                id="demo-carousel"
                index={carouselIndex}
                loop
                onIndexChange={(index) => { carouselIndex = index; }}
                items={[
                  { value: "one", label: "First slide", content: <View style={{ height: 110, background: c.muted, radius: 8, align: "center", justify: "center" }}><Text weight={600}>Slide one</Text></View> },
                  { value: "two", label: "Second slide", content: <View style={{ height: 110, background: c.secondary, radius: 8, align: "center", justify: "center" }}><Text weight={600}>Slide two</Text></View> },
                  { value: "three", label: "Third slide", content: <View style={{ height: 110, background: c.successMuted, radius: 8, align: "center", justify: "center" }}><Text weight={600}>Slide three</Text></View> },
                ]}
              />
            </Section>

            <Section title="Chart" description="Dependency-free bar chart using native primitives.">
              <Chart
                id="demo-chart"
                height={180}
                data={[
                  { label: "Mon", value: 28 },
                  { label: "Tue", value: 52 },
                  { label: "Wed", value: 41 },
                  { label: "Thu", value: 76 },
                  { label: "Fri", value: 64 },
                ]}
              />
            </Section>

            <Section title="Drawer" description="Sheet-based drawer with a controlled open state.">
              <Column gap={10}>
                <Button id="open-drawer" onClick={() => { drawerOpen = true; }}>Open drawer</Button>
                <Text size={12} color={c.mutedForeground} style={{ userSelect: "text" }}>The drawer opens from the bottom and uses the native modal overlay.</Text>
                <Link href="https://example.com" style={{
                  // color: "#ff00ff",
                  hover: {
                    color: "#ff00ff"
                  }
                }}>
                  <Row gap={6}>
                    {/* <Icon name="book" /> */}
                    <Text>Documentation</Text>
                  </Row>
                </Link>
              </Column>
            </Section>

            <Section title="Empty" description="A polished empty state with optional actions.">
              <Empty
                id="demo-empty"
                title="No projects yet"
                description="Create your first project to get started."
                action={<Button size="sm">Create project</Button>}
              />
            </Section>

            <Section title="Field" description="Label, description, validation and control layout.">
              <Field label="Email address" description="We only use this for account notifications." required>
                <Input type="email" value={emailAddress} onChange={(value) => { emailAddress = value; }} />
              </Field>
              <Field label="Password" description="Choose a strong password." required>
                <Input type="password" value="secret" />
              </Field>
            </Section>

            <Section title="InputGroup" description="Prefixes and suffixes around an input.">
              <InputGroup prefix={<Text color={c.mutedForeground}>https://</Text>} suffix={<Kbd>.com</Kbd>}>
                <Input value="tarve" style={{ width: "100%", borderWidth: 0, background: "#00000000" }} />
              </InputGroup>
            </Section>

            <Section title="InputOTP" description="Segmented controlled one-time-code input.">
              <Column gap={8}>
                <InputOTP id="demo-otp" value={otp} length={6} onValueChange={(value) => { otp = value; }} />
                <Text size={12} color={c.mutedForeground}>Current value: {otp || "empty"}</Text>
              </Column>
            </Section>

            <Section title="Item" description="Structured list row with leading and trailing content.">
              <Column gap={4}>
                <Item title="Account" description="Profile, email and password" trailing={<Text color={c.mutedForeground}>›</Text>} />
                <Item title="Billing" description="Invoices and subscription" selected trailing={<Text color={c.mutedForeground}>›</Text>} />
              </Column>
            </Section>

            <Section title="Kbd + Label" description="Compact keyboard hints and form labels.">
              <Column gap={10}>
                <Row gap={6}><Kbd>Ctrl</Kbd><Text>+</Text><Kbd>K</Kbd><Text color={c.mutedForeground}>opens command search</Text></Row>
                <Label required>Workspace name</Label>
              </Column>
            </Section>

            <Section title="NativeSelect" description="Native Tarve select exposed through a shadcn-like name.">
              <NativeSelect
                id="framework-select"
                value={framework}
                options={[
                  { value: "tarve", label: "Tarve" },
                  { value: "react", label: "React" },
                  { value: "svelte", label: "Svelte" },
                ]}
                onValueChange={(value) => { framework = value; }}
                style={{ width: "100%" }}
              />
            </Section>

            <Section title="NavigationMenu" description="Portal-backed navigation with nested links.">
              <NavigationMenu
                id="demo-nav"
                value={navigationValue}
                openValue={navigationOpen}
                onValueChange={(value) => { navigationValue = value; }}
                onOpenValueChange={(value) => { navigationOpen = value; }}
                items={[
                  { value: "overview", label: "Overview" },
                  {
                    value: "docs",
                    label: "Docs",
                    links: [
                      { value: "getting-started", label: "Getting started", description: "Install and create your first window." },
                      { value: "components", label: "Components", description: "Browse the native UI toolkit." },
                    ],
                  },
                ]}
              />
            </Section>

            <Section title="Resizable" description="Two controlled panels with a native draggable splitter.">
              <Resizable
                id="demo-resizable"
                size={split}
                min={20}
                max={80}
                onSizeChange={(value) => { split = value; }}
                first={<View style={{ height: 120, padding: 12, background: c.muted, borderWidth: { right: 1 }, borderColor: c.border }}><Text>Navigation</Text></View>}
                second={<View style={{ height: 120, padding: 12, background: c.card }}><Text>Editor</Text></View>}
              />
            </Section>

            <Section title="Sidebar" description="Collapsible controlled application sidebar.">
              <View style={{ height: 230, borderWidth: 1, borderColor: c.border, radius: 8 }}>
                <Sidebar
                  id="demo-sidebar"
                  value={sidebarValue}
                  collapsed={sidebarCollapsed}
                  width={220}
                  collapsedWidth={58}
                  header={<Text weight={650}>Acme</Text>}
                  footer={<Text size={11} color={c.mutedForeground}>v0.1</Text>}
                  onValueChange={(value) => { sidebarValue = value; }}
                  onCollapsedChange={(value) => { sidebarCollapsed = value; }}
                  items={[
                    { value: "dashboard", label: "Dashboard", icon: "info" },
                    { value: "projects", label: "Projects", icon: "search" },
                    { value: "settings", label: "Settings", icon: "check" },
                  ]}
                />
              </View>
            </Section>

            <Section title="Toggle + ToggleGroup" description="Controlled pressed-state buttons.">
              <Column gap={10}>
                <Toggle id="bold-toggle" pressed={bold} variant="outline" onPressedChange={(value) => { bold = value; }}>Bold</Toggle>
                <ToggleGroup
                  id="alignment"
                  type="single"
                  value={alignment}
                  onValueChange={(value) => { alignment = value; }}
                  items={[
                    { value: "left", label: "Left" },
                    { value: "center", label: "Center" },
                    { value: "right", label: "Right" },
                  ]}
                />
              </Column>
            </Section>

            <Section title="Border styles + text shadow" description="borderStyle reuses the outline styles; textShadow paints a solid offset copy.">
              <Column gap={14}>
                <Row gap={10} style={{ wrap: true }}>
                  {(["solid", "dashed", "dotted", "double", "groove", "ridge", "inset", "outset"] as const).map(borderStyle => (
                    <Column key={borderStyle} style={{ width: 96, height: 56, align: "center", justify: "center",
                      borderWidth: borderStyle === "double" || borderStyle === "groove" || borderStyle === "ridge" ? 6 : 3,
                      borderStyle, borderColor: c.primary, radius: 8 }}>
                      <Text size={12}>{borderStyle}</Text>
                    </Column>
                  ))}
                </Row>
                <Row gap={24} align="center">
                  <Text size={28} weight={700} style={{ textShadow: { x: 0, y: 2, blur: 6, color: "#0f172a55" } }}>Soft shadow</Text>
                  <Text size={28} weight={700} color="#ffffff" style={{ background: "#2563eb", padding: 8, radius: 8,
                    textShadow: { x: 0, y: 2, color: "#1e3a8a" } }}>Lifted</Text>
                  <Text size={28} weight={800} color="#fde047" style={{ textShadow: { x: 3, y: 3, color: "#dc2626" } }}>Retro</Text>
                  <Button variant="outline" style={{ hover: { textShadow: { x: 1, y: 1, color: "#93c5fd" } } }}>Hover me</Button>
                </Row>
              </Column>
            </Section>

            <Section title="Box shadow" description="Blurred, spread, hard, layered and inset shadows on every renderer.">
              <Row gap={28} style={{ wrap: true, padding: 12 }}>
                {([
                  ["Soft", { boxShadow: { y: 8, blur: 24, color: "#0f172a33" } }],
                  ["Spread", { boxShadow: { spread: 3, color: "#2563eb" } }],
                  ["Hard", { boxShadow: { x: 6, y: 6, color: "#0f172a" } }],
                  ["Layered", { boxShadow: "0 1px 2px rgba(0, 0, 0, 0.12), 0 12px 28px -4px rgba(37, 99, 235, 0.33)" }],
                  ["Inset", { boxShadow: { inset: true, y: 4, blur: 12, color: "#0f172a55" } }],
                ] as const).map(([label, style]) => (
                  <Column key={label} style={{ width: 120, height: 72, radius: 12, background: "#ffffff", align: "center", justify: "center", ...style }}>
                    <Text size={12}>{label}</Text>
                  </Column>
                ))}
                <Column style={{ width: 120, height: 72, radius: 12, background: "#ffffff", align: "center", justify: "center",
                  borderWidth: 1, borderColor: "#e2e8f0",
                  boxShadow: { y: 2, blur: 6, color: "#0f172a22" },
                  hover: { background: "#eff6ff", borderColor: "#93c5fd", transform: "translateY(-4px) scale(1.03)", boxShadow: { y: 14, blur: 28, spread: -2, color: "#2563eb44" } },
                  transition: { all: { duration: 220, easing: "easeOut" } } }}>
                  <Text size={12}>Hover me</Text>
                </Column>
              </Row>
            </Section>

            <Section title="Gradients" description="linear-gradient and radial-gradient backgrounds, also in hover with transitions.">
              <Row gap={20} style={{ wrap: true, padding: 12 }}>
                {([
                  ["135deg", "linear-gradient(135deg, #2563eb, #9333ea)"],
                  ["to right", "linear-gradient(to right, #f97316, #facc15 50%, #22c55e)"],
                  ["Hard stops", "linear-gradient(90deg, #0ea5e9 0 33%, #f43f5e 33% 66%, #a3e635 66%)"],
                  ["Radial", "radial-gradient(#fef3c7, #f59e0b 60%, #b45309)"],
                  ["Circle at corner", "radial-gradient(circle at top left, #e0f2fe, #0369a1)"],
                  ["Closest side", "radial-gradient(closest-side, #fde68a, #7c3aed)"],
                  ["Stripes", "repeating-linear-gradient(45deg, #0f172a 0 8px, #334155 8px 16px)"],
                  ["Rings", "repeating-radial-gradient(circle at 30% 40%, #0ea5e9 0 6px, #0369a1 6px 12px)"],
                ] as const).map(([label, background]) => (
                  <Column key={label} style={{ width: 120, height: 72, radius: 12, background, align: "center", justify: "center" }}>
                    <Text size={12} weight={600} color="#ffffff" style={{ textShadow: "0 1px #0006" }}>{label}</Text>
                  </Column>
                ))}
                <Column style={{ width: 120, height: 72, radius: 12, align: "center", justify: "center",
                  background: "linear-gradient(135deg, #1e293b, #334155)",
                  hover: { background: "linear-gradient(135deg, #4f46e5, #db2777)" },
                  transition: { background: { duration: 300, easing: "easeOut" } } }}>
                  <Text size={12} weight={600} color="#ffffff">Hover me</Text>
                </Column>
                <Column style={{ width: 120, height: 72, radius: 12, align: "center", justify: "center", background: "#ffffff",
                  borderWidth: 3, borderColor: "linear-gradient(135deg, #f97316, #db2777, #7c3aed)" }}>
                  <Text size={12} weight={600}>Gradient border</Text>
                </Column>
                <Text size={32} weight={800} style={{ foreground: "linear-gradient(90deg, #2563eb, #db2777 60%, #f97316)" }}>Gradient text</Text>
              </Row>
            </Section>

            <Section title="Typography" description="Preset text hierarchy and supporting styles.">
              <Column gap={8}>
                <Typography variant="h2">Build native interfaces</Typography>
                <Typography variant="lead">Bun + TypeScript on top, Rust rendering underneath.</Typography>
                <Typography variant="p">Typography keeps visual hierarchy consistent without repeating style objects.</Typography>
                <Typography variant="code">bun run components</Typography>
                <Typography variant="blockquote">Native UI can still feel like a modern component system.</Typography>
              </Column>
            </Section>

            <Section title="Direction" description="Simple layout direction helper.">
              <Column gap={8}>
                <Text size={12} color={c.mutedForeground}>LTR</Text>
                <Direction gap={8}><Button size="sm">One</Button><Button size="sm">Two</Button><Button size="sm">Three</Button></Direction>
                <Text size={12} color={c.mutedForeground}>RTL</Text>
                <Direction dir="rtl" gap={8}><Button size="sm">One</Button><Button size="sm">Two</Button><Button size="sm">Three</Button></Direction>
              </Column>
            </Section>

            <Section title="Questionnaire" description="Multi-step controlled form flow.">
              <Questionnaire
                id="demo-questionnaire"
                questions={questionnaireQuestions}
                values={questionnaireValues}
                current={questionnaireCurrent}
                onCurrentChange={(index) => { questionnaireCurrent = index; }}
                onValueChange={(questionId, value) => { questionnaireValues = { ...questionnaireValues, [questionId]: value }; }}
                onSubmit={() => { questionnaireCurrent = 0; }}
              />
            </Section>

            <Section title="Attachment" description="File card with upload/removal states.">
              <Column gap={8}>
                {attachmentVisible ? (
                  <Attachment
                    id="demo-attachment"
                    name="design-system.fig"
                    size="4.8 MB"
                    status="uploading"
                    progress={72}
                    onRemove={() => { attachmentVisible = false; }}
                  />
                ) : <Button size="sm" variant="outline" onClick={() => { attachmentVisible = true; }}>Restore attachment</Button>}
              </Column>
            </Section>

            <Section title="Bubble + Marker" description="Low-level chat composition primitives.">
              <Column gap={10}>
                <Bubble>Incoming message</Bubble>
                <Row justify="end"><Bubble side="outgoing">Outgoing message</Bubble></Row>
                <Marker label="Today" />
              </Column>
            </Section>

            <Section title="Message + MessageScroller" description="Conversation layout with avatars, timestamps and scrolling.">
              <MessageScroller id="demo-messages" height={270}>
                <Marker label="Today" />
                <Message author="Alex" avatarFallback="AM" timestamp="10:14">
                  Can Tarve render a real component showcase?
                </Message>
                <Message side="outgoing" author="You" avatarFallback="YO" timestamp="10:15">
                  Yes. Every component in this page is native.
                </Message>
                <Message author="Alex" avatarFallback="AM" timestamp="10:16" actions={<Button size="sm" variant="ghost">Reply</Button>}>
                  Nice. The scroll region is native too.
                </Message>
              </MessageScroller>
            </Section>

            <Section title="TreeView" description="Controlled hierarchical navigation with expansion, selection and keyboard focus.">
              <TreeView
                id="demo-tree"
                expandedIds={treeExpanded}
                selectedId={treeSelected}
                onExpandedChange={(ids) => { treeExpanded = ids; }}
                onSelectedChange={(id) => { treeSelected = id; }}
                nodes={[
                  {
                    id: "src",
                    label: "packages",
                    icon: "chevron-right",
                    children: [
                      { id: "components", label: "components.ts", icon: "info" },
                      { id: "runtime", label: "runtime.rs", icon: "info" },
                      { id: "protocol", label: "protocol.ts", icon: "info" },
                    ],
                  },
                  { id: "readme", label: "README.md", icon: "info" },
                ]}
              />
            </Section>

            <Section title="DataGrid" description="Virtualized rows with controlled sorting and selection.">
              <DataGrid
                id="demo-grid"
                rows={gridRows}
                rowKey={(row) => row.id}
                height={260}
                rowHeight={40}
                offset={gridOffset}
                sort={gridSort}
                selectionMode="multiple"
                selectedKeys={gridSelected}
                onScroll={(offset) => { gridOffset = offset; }}
                onSortChange={(sort) => { gridSort = sort; }}
                onSelectionChange={(keys) => { gridSelected = keys; }}
                columns={[
                  { key: "name", header: "Name", sortable: true },
                  { key: "area", header: "Area", sortable: true },
                  { key: "status", header: "Status", sortable: true },
                ]}
              />
            </Section>

            <Section title="IME / Composition" description="Native preedit, candidate positioning and CJK composition for Input and TextArea.">
              <Column gap={12}>
                <Text size={12} color={c.mutedForeground}>
                  Enable a Japanese, Chinese or Korean IME in Windows and compose text below. Preedit stays visual until commit.
                </Text>
                <Field label="Single-line composition" description={`Committed value: ${imeInput || "empty"}`}>
                  <Input
                    id="demo-ime-input"
                    value={imeInput}
                    placeholder="Compose Japanese / Chinese / Korean text…"
                    onChange={(value) => { imeInput = value; }}
                  />
                </Field>
                <Field label="Wrapped TextArea" description={`Committed value: ${imeNotes || "empty"}`}>
                  <TextArea
                    id="demo-ime-textarea"
                    value={imeNotes}
                    placeholder="Long composition wraps and keeps the IME candidate at the shaped caret…"
                    onChange={(value) => { imeNotes = value; }}
                    style={{ width: "100%", height: 92 }}
                  />
                </Field>
                <Field label="End-aligned TextArea" description="Candidate and marked ranges follow Parley text alignment.">
                  <TextArea
                    id="demo-ime-aligned"
                    value={imeAligned}
                    placeholder="Compose here…"
                    onChange={(value) => { imeAligned = value; }}
                    style={{ width: "100%", height: 72, textAlign: "end" }}
                  />
                </Field>
              </Column>
            </Section>
          </View>

          <Text size={12} color={c.mutedForeground}>29 high-level components plus the native IME/composition showcase in one executable example.</Text>
        </Column>
      </Scroll>

      <Drawer
        id="component-drawer"
        open={drawerOpen}
        title="Drawer example"
        description="This is the Drawer component built on Tarve's modal sheet primitive."
        onOpenChange={(open) => { drawerOpen = open; }}
      >
        <Column gap={12}>
          <Text>Use drawers for focused secondary workflows.</Text>
          <Button onClick={() => { drawerOpen = false; }}>Done</Button>
        </Column>
      </Drawer>
    </Window>
  );
}
