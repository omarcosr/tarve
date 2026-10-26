import { TitleBar, Window, theme } from "@tarve/core";
import studio from "../assets/studio.png" with { type: "file" };

// Plain HTML in a Tarve window: only HTML elements and CSS-style inline styles
// inside the <Window>, with the browser's default styles and behaviour. A form
// whose named fields submit together, phrasing elements in a paragraph, lists,
// tables, media and interactive elements. Each column is a block container
// (adjacent margins collapse, as in a browser) that scrolls (overflow: auto).

const c = theme.colors;
export const state = { submitted: "", invalid: "" };

// A little author CSS, as a real page would have: full-width fields and
// bordered tables. Everything else is the browser's default look.
const field = { width: "100%" } as const;
const cell = { padding: { top: 4, right: 10, bottom: 4, left: 10 }, background: c.background } as const;
const grid = { background: c.border, gap: 1, padding: 1 } as const;

export function App() {
  return (
    <Window title="Tarve — HTML" width={900} height={780} minWidth={360} minHeight={520} position="center">
      <TitleBar title="Tarve — HTML" />
      <div style={{ display: "flex", flexDirection: "column", md: { direction: "row" }, gap: 18, flex: 1, width: "100%", minHeight: 0, background: c.background, padding: { left: 18, right: 6, top: 12 } }}>
        <div id="left" style={{ overflow: "auto", flex: 1, minHeight: 0, minWidth: 0 }}>
          <div style={{ display: "block", width: "100%", padding: { right: 12, bottom: 18 } }}>
            <h2>Form</h2>
            <form id="signup"
              onSubmit={values => { state.submitted = JSON.stringify(values).replace(/,/g, ", "); state.invalid = ""; }}
              onInvalid={name => { state.invalid = `${name} is required`; }}>
              <fieldset>
                <legend>Account</legend>
                <label htmlFor="name">Name</label>
                <input id="name" name="name" placeholder="Ana Maria" />
                <label htmlFor="email">Email (required)</label>
                <input id="email" name="email" type="email" required placeholder="you@example.com" />
                <label htmlFor="password">Password</label>
                <input id="password" name="password" type="password" placeholder="At least 8 characters" />
                <label htmlFor="country">Country</label>
                <select id="country" name="country" style={field}>
                  <option value="br">Brazil</option>
                  <option value="pt">Portugal</option>
                  <option value="us">United States</option>
                </select>
                <label htmlFor="message">Message</label>
                <textarea id="message" name="message" placeholder="Tell us something" style={{ height: 72 }} />
              </fieldset>
              <fieldset>
                <legend>Preferences</legend>
                <input id="news" type="checkbox" name="news" label="Send me news" />
                <input id="plan-free" type="radio" name="plan" value="free" label="Free" defaultChecked />
                <input id="plan-pro" type="radio" name="plan" value="pro" label="Pro" />
                <input id="volume" type="range" name="volume" min={0} max={10} label="Volume" style={field} />
                <input id="start" type="date" name="start" style={field} />
                <input id="alarm" type="time" name="alarm" style={field} />
                <input id="accent" type="color" name="accent" defaultValue="#3b82f6" label="Accent colour" />
                <input id="avatar" type="file" name="avatar" accept=".png,.jpg" />
              </fieldset>
              <div style={{ display: "flex", gap: 8, margin: { top: 10 } }}>
                <button id="submit">Submit</button>
                <button id="reset" type="button">Do nothing</button>
              </div>
            </form>
            {state.invalid ? <p id="invalid" style={{ color: c.destructiveText }}>{state.invalid}</p> : null}
            {state.submitted ? <pre id="submitted" style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{state.submitted}</pre> : null}
          </div>
        </div>
        <div id="right" style={{ overflow: "auto", flex: 1, minHeight: 0, minWidth: 0 }}>
          <div style={{ display: "block", width: "100%", padding: { right: 12, bottom: 18 } }}>
            <h1>Text</h1>
            <p>
              <strong>strong</strong>, <b>b</b>, <em>em</em>, <i>i</i>, <u>u</u>, <s>s</s>, <del>del</del>, <ins>ins</ins>,
              {" "}<code>code</code>, <kbd>Ctrl</kbd>+<kbd>S</kbd>, <samp>samp</samp>, <var>x</var>, <cite>cite</cite>, <dfn>dfn</dfn>,
              {" "}<mark>mark</mark>, <small>small</small>, H<sub>2</sub>O, E = mc<sup>2</sup>
              <br />and a line break, an <abbr title="HyperText Markup Language">HTML</abbr> abbreviation, a <a href="https://example.com">link</a> and a{" "}
              <span style={{ cursor: "help", textDecoration: "underline" }}>help cursor</span>.
            </p>
            <h3>Lists</h3>
            <ul><li>Flexbox and grid</li><li>Inline text with <strong>runs</strong></li><li>Native controls</li></ul>
            <ol start={3}><li>Third</li><li>Fourth, which is long enough to wrap inside its indent</li></ol>
            <dl>
              <dt>Tarve</dt><dd>Native TSX desktop apps</dd>
              <dt>Taffy</dt><dd>Flexbox, grid and block layout</dd>
            </dl>
            <h3>Tables</h3>
            <table id="people" style={grid}>
              <caption>Team</caption>
              <thead><tr><th style={cell}>Name</th><th style={cell}>Role</th><th style={cell}>Since</th></tr></thead>
              <tbody>
                <tr><td style={cell}>Ana Maria</td><td style={cell}>Design</td><td style={cell}>2021</td></tr>
                <tr><td style={cell}>Bo</td><td style={cell}>Engineering</td><td style={cell}>2019</td></tr>
              </tbody>
              <tfoot><tr><td colSpan={3} style={{ ...cell, color: c.mutedForeground }}>2 people</td></tr></tfoot>
            </table>
            <table id="spans" style={{ ...grid, margin: { top: 12 } }}>
              <tr><td colSpan={2} style={{ ...cell, background: c.muted }}>colSpan 2</td></tr>
              <tr><td rowSpan={2} style={{ ...cell, background: c.muted }}>rowSpan 2</td><td style={cell}>b</td></tr>
              <tr><td style={cell}>c</td></tr>
            </table>
            <h3>Blocks</h3>
            <pre id="pre">{"pre  keeps\n  spaces"}</pre>
            <blockquote><p>A quotation, indented 40px on both sides.</p></blockquote>
            <hr />
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}><label htmlFor="disk">Disk</label><meter id="disk" value={0.7} /></div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}><label htmlFor="upload">Upload</label><progress id="upload" value={64} max={100} style={{ flex: 1 }} /></div>
            <h3>Media</h3>
            <img id="photo" src={studio} width={240} height={150} style={{ objectFit: "cover", borderRadius: 8 }} />
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
            <svg width={120} height={60} viewBox="0 0 120 60" stroke="none">
              <rect x={4} y={4} width={52} height={52} rx={8} fill="#22c55e" />
              <circle cx={90} cy={30} r={26} fill="#f59e0b" />
            </svg>
            <h3>Details</h3>
            <details id="more"><summary>What is this?</summary><p>Plain HTML elements, laid out like a browser.</p></details>
          </div>
        </div>
      </div>
    </Window>
  );
}
