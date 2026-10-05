import { Column, Row, Scroll, Text, TitleBar, Window, theme } from "@tarve/core";

// Plain HTML elements in a Tarve window: inputs, a form, lists, a table and
// details, with the browser's default behaviour.

const c = theme.colors;
export const state = { submitted: "", invalid: "" };

export function App() {
  return (
    <Window title="Tarve — HTML" width={820} height={760} position="center">
      <TitleBar title="Tarve — HTML" />
      <Row gap={18} padding={18} flex={1} style={{ width: "100%", background: c.background, align: "start", overflow: "hidden" }}>
        <Column gap={14} style={{ flex: 1, minWidth: 0 }}>
          <h3>Form</h3>
          <form id="signup"
            onSubmit={values => { state.submitted = JSON.stringify(values).replace(/,/g, ", "); state.invalid = ""; }}
            onInvalid={name => { state.invalid = `${name} is required`; }}>
            <fieldset>
              <legend>Account</legend>
              <label htmlFor="email">Email (required)</label>
              <input id="email" name="email" type="email" required placeholder="you@example.com" />
              <input id="news" type="checkbox" name="news" label="Send me news" />
              <input id="plan-free" type="radio" name="plan" value="free" label="Free" defaultChecked />
              <input id="plan-pro" type="radio" name="plan" value="pro" label="Pro" />
              <input id="volume" type="range" name="volume" min={0} max={10} label="Volume" />
              <input id="start" type="date" name="start" />
              <input id="avatar" type="file" name="avatar" accept=".png,.jpg" />
              <input id="accent" type="color" name="accent" defaultValue="#3b82f6" label="Accent colour" />
              <input id="alarm" type="time" name="alarm" />
            </fieldset>
            <Row gap={8} style={{ margin: { top: 10 } }}>
              <button id="submit">Submit</button>
              <button id="reset" type="button" variant="outline">Do nothing</button>
            </Row>
          </form>
          {state.invalid ? <p id="invalid" style={{ color: c.destructiveText }}>{state.invalid}</p> : null}
          {state.submitted ? <p id="submitted" style={{ fontFamily: "monospace", fontSize: 12 }}>{state.submitted}</p> : null}
        </Column>
        <Scroll id="right" style={{ flex: 1, height: "100%" }}>
        <Column gap={14} style={{ width: "100%" }}>
          <h3>Lists</h3>
          <ul><li>Flexbox and grid</li><li>Inline text with <strong>runs</strong></li><li>Native controls</li></ul>
          <ol start={3}><li>Third</li><li>Fourth, which is long enough to wrap inside its indent</li></ol>
          <h3>Table</h3>
          <table id="people">
            <thead><tr><th>Name</th><th>Role</th><th>Since</th></tr></thead>
            <tbody>
              <tr><td>Ana Maria</td><td>Design</td><td>2021</td></tr>
              <tr><td>Bo</td><td>Engineering</td><td>2019</td></tr>
            </tbody>
          </table>
          <h3>More elements</h3>
          <table id="spans">
            <tr><td colSpan={2} style={{ background: c.muted }}>colSpan 2</td></tr>
            <tr><td rowSpan={2} style={{ background: c.muted }}>rowSpan 2</td><td>b</td></tr>
            <tr><td>c</td></tr>
          </table>
          <pre id="pre">{"pre  keeps\n  spaces"}</pre>
          <blockquote><p>A quotation, indented 40px on both sides.</p></blockquote>
          <Row gap={8} align="center"><Text>Disk</Text><meter id="disk" value={0.7} /></Row>
          <p>An <abbr title="HyperText Markup Language">HTML</abbr> abbreviation, and a <span style={{ cursor: "help", textDecoration: "underline" }}>help cursor</span>.</p>
          <h3>Details</h3>
          <details id="more"><summary>What is this?</summary><p>Plain HTML elements, laid out like a browser.</p></details>
        </Column>
        </Scroll>
      </Row>
    </Window>
  );
}
