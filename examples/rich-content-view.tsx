import {
  Badge,
  Code,
  Column,
  Diff,
  Markdown,
  Row,
  Scroll,
  Text,
  TitleBar,
  Window,
  theme,
  type Child,
} from "tarve";

const c = theme.colors;

const beforeLines = Array.from(
  { length: 180 },
  (_, index) => `const task${String(index + 1).padStart(3, "0")} = "pending";`,
);
const afterLines = beforeLines.map((line, index) =>
  index % 4 === 0 ? line.replace('"pending"', '"complete"') : line,
);

function Panel({ title, description, children }: { title: string; description: string; children: Child }) {
  return (
    <Column
      gap={12}
      padding={18}
      style={{ width: "100%", background: c.card, borderWidth: 1, borderColor: c.border, radius: 10 }}
    >
      <Row align="center" justify="between">
        <Column gap={3}>
          <Text size={16} weight={650}>{title}</Text>
          <Text size={12} color={c.mutedForeground}>{description}</Text>
        </Column>
        <Badge variant="secondary">Native</Badge>
      </Row>
      {children}
    </Column>
  );
}

export function App() {
  return (
    <Window title="Tarve — Rich content" width={1040} height={900} minWidth={760} minHeight={620} position="center">
      <TitleBar title="Tarve — Rich content" />
      <Scroll id="rich-content-page" flex={1}>
        <Column gap={18} padding={24} style={{ width: "100%" }}>
          <Column gap={5}>
            <Text size={26} weight={700}>Markdown, code and diffs</Text>
            <Text color={c.mutedForeground}>
              Rich documents stay in native leaf nodes, with Parley layout and selectable text.
            </Text>
          </Column>

          <Panel title="Markdown" description="GFM tables, task lists, links, quotes and fenced code.">
            <Markdown
              id="rich-markdown"
              source={'# Release notes\n\nTarve keeps **rich documents** in one native node. Use `bun run rich-content` to open this example.\n\n- [x] Select and copy rendered text\n- [x] Open links through the platform\n- [ ] Add your next feature\n\n| Feature | Native behavior |\n| --- | --- |\n| Tables | Aligned columns |\n| Code | Syntax ranges |\n| Links | Click callbacks |\n\n> Large documents do not become long TSX child lists.\n\n```ts\nconst renderer = "native";\n```'}
            />
          </Panel>

          <Panel title="Code" description="Syntect highlighting with native selection and copy.">
            <Code
              id="rich-code"
              language="typescript"
              code={'export interface Project {\n  name: string;\n  status: "ready" | "building";\n}\n\nexport function label(project: Project): string {\n  return `${project.name}: ${project.status}`;\n}'}
              style={{ padding: 14, background: c.muted, radius: 8 }}
            />
          </Panel>

          <Panel title="Diff" description="Generated from old/new text; changed lines and words are highlighted.">
            <Scroll
              id="rich-diff-scroll"
              orientation="vertical"
              style={{ height: 300, width: "100%", borderWidth: 1, borderColor: c.border, radius: 8 }}
            >
              <Diff
                id="rich-diff"
                oldText={`${beforeLines.join("\n")}\n`}
                newText={`${afterLines.join("\n")}\n`}
                style={{ padding: 8, width: "100%", fontSize: 12 }}
              />
            </Scroll>
          </Panel>
        </Column>
      </Scroll>
    </Window>
  );
}
