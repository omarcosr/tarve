import { Scroll, Window, theme } from "tarve";
import studio from "./assets/studio.png" with { type: "file" };

const c = theme.colors;

let email = "alex@example.com";
let message = "Tarve now supports JSX intrinsics without a DOM.";
let country = "br";
let progress = 42;
let status = "Ready";

const card = {
  backgroundColor: c.card,
  borderWidth: 1,
  borderColor: c.border,
  radius: 12,
  padding: 20,
  gap: 14,
} as const;

export function App() {
  return (
    <Window title="Tarve — JSX intrinsics" width={980} height={820} minWidth={760} minHeight={620}>
      <Scroll flex={1}>
        <div
          style={{
            width: "100%",
            padding: 28,
            gap: 22,
            flexDirection: "column",
            backgroundColor: c.background,
          }}
        >
          <div style={{ gap: 6, flexDirection: "column" }}>
            <h1>JSX intrinsics</h1>
            <p style={{ color: c.mutedForeground }}>
              Familiar TSX syntax mapped directly to Tarve native components — no DOM, browser or CSS engine.
            </p>
          </div>

          <div style={{ ...card, flexDirection: "row", align: "center", gap: 18 }}>
            <img
              src={studio}
              width={148}
              height={100}
              fit="cover"
              style={{ radius: 10 }}
            />
            <div style={{ flex: 1, gap: 6, flexDirection: "column" }}>
              <h2>Native elements</h2>
              <p style={{ color: c.mutedForeground }}>
                Familiar text, media, form and vector primitives rendered directly by Tarve.
              </p>
              <span style={{ color: c.foreground, fontWeight: 600 }}>div · span · p · img · input · textarea · button · svg</span>
              <span style={{ color: c.success }}>● Protocol-backed and accessibility-aware</span>
            </div>
            <svg size={44} viewBox="0 0 24 24" color={c.primary}>
              <circle cx={12} cy={12} r={9} />
              <path d="M8 12.5 10.7 15 16 9" />
            </svg>
          </div>

          <div style={{ display: "grid", columns: 2, gap: 18 }}>
            <div style={{ ...card, flexDirection: "column" }}>
              <h3>Profile form</h3>

              <div style={{ gap: 6, flexDirection: "column" }}>
                <label id="email-label" htmlFor="email">Email address</label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  placeholder="you@example.com"
                  onChange={(value) => {
                    email = value;
                    status = `Email changed to ${value || "(empty)"}`;
                  }}
                />
              </div>

              <div style={{ gap: 6, flexDirection: "column" }}>
                <label id="country-label" htmlFor="country">Country</label>
                <select
                  id="country"
                  value={country}
                  style={{ width: "100%" }}
                  onChange={(value) => {
                    country = value;
                    status = `Country changed to ${value}`;
                  }}
                >
                  <option value="br">Brazil</option>
                  <option value="jp">Japan</option>
                  <option value="us">United States</option>
                  <option value="disabled" disabled>Unavailable option</option>
                </select>
              </div>

              <div style={{ gap: 6, flexDirection: "column" }}>
                <label id="message-label" htmlFor="message">Message</label>
                <textarea
                  id="message"
                  value={message}
                  placeholder="Write something..."
                  onChange={(value) => {
                    message = value;
                    status = `Message length: ${value.length}`;
                  }}
                />
              </div>

              <hr />

              <div style={{ flexDirection: "row", gap: 10, justify: "end" }}>
                <button
                  variant="outline"
                  onClick={() => {
                    email = "";
                    message = "";
                    country = "br";
                    progress = 0;
                    status = "Form reset";
                  }}
                >
                  Reset
                </button>
                <button
                  onClick={() => {
                    progress = Math.min(100, progress + 10);
                    status = `Saved ${email || "anonymous"}`;
                  }}
                >
                  Save changes
                </button>
              </div>
            </div>

            <div style={{ gap: 18, flexDirection: "column" }}>
              <div style={{ ...card, flexDirection: "column" }}>
                <h3>Progress</h3>
                <p style={{ color: c.mutedForeground }}>
                  The intrinsic progress element maps to Tarve's native progress semantics.
                </p>
                <progress id="demo-progress" value={progress} max={100} label="Example completion" />
                <span style={{ fontWeight: 600 }}>{progress}% complete</span>
              </div>

              <div style={{ ...card, flexDirection: "column", gap: 8 }}>
                <h3>Heading scale</h3>
                <h1 style={{ fontSize: 26 }}>Heading 1</h1>
                <h2>Heading 2</h2>
                <h3>Heading 3</h3>
                <h4>Heading 4</h4>
                <h5>Heading 5</h5>
                <h6>Heading 6</h6>
              </div>
            </div>
          </div>

          <div style={{ ...card, flexDirection: "row", justify: "between", align: "center" }}>
            <div style={{ gap: 3, flexDirection: "column" }}>
              <h4>Live state</h4>
              <span style={{ color: c.mutedForeground }}>{status}</span>
            </div>
            <span style={{ color: c.mutedForeground }}>Selected country: {country.toUpperCase()}</span>
          </div>
        </div>
      </Scroll>
    </Window>
  );
}
