import {
  Alert,
  AspectRatio,
  Attachment,
  Bubble,
  Button,
  ButtonGroup,
  Carousel,
  Chart,
  Column,
  Direction,
  DataGrid,
  Drawer,
  Empty,
  Field,
  Input,
  InputGroup,
  InputOTP,
  Item,
  Kbd,
  Label,
  Marker,
  Message,
  MessageScroller,
  NativeSelect,
  NavigationMenu,
  Questionnaire,
  Resizable,
  Row,
  Scroll,
  Sidebar,
  Text,
  TitleBar,
  TreeView,
  Toggle,
  ToggleGroup,
  Typography,
  View,
  Window,
  theme,
  type Child,
  type QuestionnaireAnswer,
  type Style,
} from "tarve";

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

const gridRows = [
  { id: 1, name: "Renderer", area: "Rust", status: "Ready" },
  { id: 2, name: "Components", area: "TypeScript", status: "Active" },
  { id: 3, name: "Protocol", area: "Shared", status: "v27" },
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
                <Text size={12} color={c.mutedForeground}>The drawer opens from the bottom and uses the native modal overlay.</Text>
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
                <Input type="email" value="hello@example.com" />
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
          </View>

          <Text size={12} color={c.mutedForeground}>29 high-level components shown in one executable example.</Text>
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
