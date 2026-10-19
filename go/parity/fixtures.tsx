// Views exercising what the examples do not: variants, inline runs, HTML elements, glass, audio
// controls. go/tarve/fixtures_test.go builds the same views in Go.
import { Accordion, Badge, Card, Checkbox, Code, Column, darkTheme, Diff, Glass, Link, Markdown, Progress, RadioGroup, Row, Separator, Switch, Tabs, Text, TextArea, Theme, TitleBar, View, Window } from "@tarve/core";

const dark = Theme.create(darkTheme, { colors: { primary: "#ff0033" } });

export const fixtures: Record<string, () => unknown> = {
  variants: () => (
    <Window title="variants" width={900} height={600} theme={dark}>
      <Column gap={4}>
        {[0, 1, 2, 3].map(i => (
          <div key={i} style={{ padding: 8, background: "#111111", first: { padding: { top: 20 } }, last: { background: "#222222" }, odd: { radius: 4 }, even: { radius: { topLeft: 9 } } }}>
            <Text style={{ fontSize: 12, md: { fontSize: 16 }, lg: { fontSize: 20 }, dark: { foreground: "#eeeeee", hover: { foreground: "#ffffff" } } }}>Row {i}</Text>
          </div>
        ))}
      </Column>
    </Window>
  ),
  inline: () => (
    <Window title="inline" width={800} height={600}>
      <Text size={15}>Plain <strong>bold <em>both</em></strong> and <a href="https://example.com">a link</a>, <code>code()</code>, x<sup>2</sup>, <mark>marked</mark>.<br />Next   line <span style={{ color: "#ff0000" }} onClick={() => {}}>clickable</span> <small>small</small> <del>gone</del> <u>under</u> <abbr title="t">abbr</abbr></Text>
      <Text style={{ whiteSpace: "pre-line" }}>{"keep\n  lines   here\nsecond"}</Text>
      <Text style={{ textTransform: "uppercase" }}>shout this</Text>
      <Text style={{ textTransform: "capitalize" }}>every word here <strong>bold one</strong></Text>
      <Text style={{ whiteSpace: "pre" }}>{"  pre  kept "}</Text>
    </Window>
  ),
  html: () => (
    <Window title="html" width={800} height={600}>
      <h1>Title</h1>
      <h3 style={{ color: "#333333" }}>Sub</h3>
      <p>Paragraph text</p>
      <span>a span</span>
      <strong>loose strong</strong>
      <img src="https://example.com/a.png" style={{ width: 40, height: 40, objectFit: "contain" }} />
    </Window>
  ),
  glass: () => (
    <Window title="glass" width={800} height={600} backdrop="blur">
      <TitleBar title="Glass" glass appearance="dark" style={{ radius: 12 }} />
      <Glass variant="tinted" tint="#3366ff40" radius={18} style={{ padding: 12 }}><Text>inside</Text></Glass>
      <Glass variant="clear" appearance="dark" merge="bar" shadow={false}><View style={{ width: 10, height: 10 }} /></Glass>
    </Window>
  ),
  biglist: () => (
    <Window title="big" width={800} height={600}>
      <Column>
        {Array.from({ length: 700 }, (_, i) => i % 7 === 3 ? `loose ${i}` : (
          <div key={i} style={{ height: 30, first: { background: "#ff0000" }, last: { background: "#00ff00" }, even: { padding: { left: i % 50 } } }}>
            <Text style={{ fontSize: 10 + (i % 5), color: i % 3 ? "#111111" : "#222222" }}>Row {i} <strong onClick={() => {}}>go</strong></Text>
            <Text>{i % 11 === 0 ? <em>em {i}</em> : "plain"}</Text>
          </div>
        ))}
      </Column>
    </Window>
  ),
  controls: () => (
    <Window title="controls" width={900} height={700}>
      <Checkbox checked label="Check" onCheckedChange={() => {}} />
      <Checkbox checked={false} label="Off" disabled />
      <Switch checked label="On" />
      <Switch checked={false} label="Off" style={{ foreground: "#123456" }} />
      <RadioGroup value="b" orientation="horizontal" options={[{ value: "a", label: "A" }, { value: "b", label: "B" }, { value: "c", label: "C", disabled: true }]} />
      <Card title="Card" description="desc" footer={<Text>foot</Text>}><Text>body</Text></Card>
      <Badge variant="outline">new</Badge>
      <Separator orientation="vertical" />
      <Progress value={30} max={120} label="Load" style={{ foreground: "#00ff00", radius: 2 }} />
      <Tabs value="two" items={[{ value: "one", label: "One", content: <Text>1</Text> }, { value: "two", label: "Two", content: <Text>2</Text> }]} />
      <Accordion value="x" items={[{ value: "x", title: "X", content: <Text>open</Text> }, { value: "y", title: "Y", content: <Text>closed</Text>, disabled: true }]} />
      <Markdown source={"# Hi\n\n- a"} />
      <Code code="let a = 1" language="ts" showLineNumbers />
      <Diff oldText={"a\nb"} newText={"a\nc"} />
      <TextArea value={"line\r\nnext"} placeholder="type" submitOnEnter />
      <Link href="https://example.com" style={{ fontSize: 18 }}>Docs</Link>
    </Window>
  ),
  audio: () => (
    <Window title="audio" width={800} height={600}>
      <audio id="player" src="https://example.com/a.mp3" controls muted ariaLabel="Song" style={{ width: 400 }} />
      <audio id="silent" src="https://example.com/b.mp3" />
    </Window>
  ),
};
