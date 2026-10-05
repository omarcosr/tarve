import { Column, Row, Text, TitleBar, View, Window, theme } from "@tarve/core";

// CSS text in Tarve: phrasing elements inside a paragraph, white-space, ellipsis,
// line clamps and overflow, each next to the CSS it mirrors.

const c = theme.colors;
export const state = { clicks: 0, width: 260 };
const long = "Tarve lays text out with the same rules as a browser: wrapping, collapsing white space and cutting overflow with an ellipsis.";

function Demo({ title, css, children }: { title: string; css: string; children: unknown }) {
  return (
    <Column gap={6} padding={12} style={{ width: "100%", background: c.card, radius: 8, borderWidth: 1, borderColor: c.border }}>
      <Row justify="between" align="center" style={{ width: "100%" }}>
        <Text size={13} weight={650}>{title}</Text>
        <Text size={11} color={c.mutedForeground} style={{ fontFamily: "monospace" }}>{css}</Text>
      </Row>
      {children as never}
    </Column>
  );
}

export function App() {
  return (
    <Window title="Tarve — Text" width={760} height={820} position="center">
      <TitleBar title="Tarve — Text" />
      <Column gap={12} padding={18} flex={1} style={{ width: "100%", background: c.background, overflow: "hidden" }}>
        <Demo title="Inline elements" css="<p> + phrasing">
          <p id="inline">
            Text can be <strong>strong</strong>, <em>emphasised</em>, <u>underlined</u>, <s>struck</s>,
            {" "}<code>code</code>, <kbd>Ctrl</kbd>+<kbd>K</kbd>, <mark id="marked">highlighted</mark> or
            {" "}<small>small</small>, with <strong>nested <em>styles</em></strong> and a line break<br />
            right here. Read the <a href="https://github.com/omarcosr/tarve">docs</a> or
            {" "}<span id="counter" onClick={() => { state.clicks++; }} style={{ color: c.primary, textDecoration: "underline" }}>click this span</span>
            {" "}({state.clicks} clicks).
          </p>
        </Demo>
        <Demo title="Ellipsis" css="nowrap + overflow: hidden + text-overflow">
          <p id="ellipsis" style={{ width: state.width, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{long}</p>
        </Demo>
        <Demo title="Line clamp" css="-webkit-line-clamp: 2">
          <p id="clamp" style={{ width: state.width, lineClamp: 2, overflow: "hidden" }}>{long}</p>
        </Demo>
        <Demo title="White space" css="normal / pre / pre-line">
          <Row gap={12} style={{ width: "100%" }}>
            <p style={{ flex: 1, whiteSpace: "normal" }}>{"normal:   runs   of\nspaces collapse"}</p>
            <p style={{ flex: 1, whiteSpace: "pre", fontFamily: "monospace" }}>{"pre:\n  keeps   it\n  all"}</p>
            <p style={{ flex: 1, whiteSpace: "pre-line" }}>{"pre-line:   keeps\nnewlines   only"}</p>
          </Row>
        </Demo>
        <Demo title="Typography" css="letter-spacing · word-spacing · text-transform · italic">
          <Column gap={4}>
            <p style={{ letterSpacing: 2, textTransform: "uppercase", fontSize: 12 }}>section heading</p>
            <p style={{ wordSpacing: 12 }}>word spacing widens the gaps</p>
            <p style={{ fontStyle: "italic" }}>An italic paragraph</p>
            <p style={{ textTransform: "capitalize" }}>every word capitalised</p>
          </Column>
        </Demo>
        <Demo title="Overflow" css="overflow: hidden">
          <Row gap={8} style={{ width: "100%" }}>
            <View id="clip" style={{ width: 180, height: 44, overflow: "hidden", radius: 8, background: c.muted }}>
              <View style={{ width: 260, height: 80, background: "#2563eb", shrink: 0 }} />
            </View>
            <Text size={12} color={c.mutedForeground} style={{ flex: 1 }}>The blue box is 260×80 inside a 180×44 parent: it is clipped to the rounded parent, as in CSS.</Text>
          </Row>
        </Demo>
      </Column>
    </Window>
  );
}
