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
          <h3>Canvas</h3>
          <canvas id="chart" width={300} height={120} ariaLabel="Weekly chart" onDraw={ctx => {
            const values = [12, 30, 22, 40, 28, 46, 38];
            const gradient = ctx.createLinearGradient(0, 0, 0, 120);
            gradient.addColorStop(0, "#3b82f6"); gradient.addColorStop(1, "#bfdbfe");
            ctx.fillStyle = gradient;
            values.forEach((value, i) => { ctx.beginPath(); ctx.roundRect(12 + i * 40, 110 - value * 2, 28, value * 2, 4); ctx.fill(); });
            ctx.beginPath(); ctx.strokeStyle = "#ef4444"; ctx.lineWidth = 2; ctx.lineJoin = "round";
            values.forEach((value, i) => { if (i === 0) ctx.moveTo(26, 110 - value * 2); else ctx.lineTo(26 + i * 40, 110 - value * 2); });
            ctx.stroke();
            ctx.font = "600 12px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillStyle = "#334155";
            ctx.fillText("This week", 150, 4);
          }} />
          <p>Water is H<sub>2</sub>O and E = mc<sup>2</sup>.</p>
          <h3>Details</h3>
          <details id="more"><summary>What is this?</summary><p>Plain HTML elements, laid out like a browser.</p></details>
        </Column>
        </Scroll>
      </Row>
    </Window>
  );
}
