import { Button, Code, Column, Input, Row, Slider, Text, TitleBar, View, Window, darkTheme, lightTheme, tw } from "@tarve/core";

let dark = false;
let tab = "Inbox";
let count = 0;
let family = "indigo";
let shade = 500;
let radius = "lg";
let gap = 6;
let playground = "px-6 py-4 rounded-xl bg-indigo-500 text-white shadow-lg hover:bg-indigo-600 active:scale-95 transition";
const corners = new Set<string>(["tl", "tr", "br", "bl"]);
const cornerNames = ["tl", "tr", "br", "bl"];
const radii = ["none", "sm", "md", "lg", "xl", "2xl", "full"];
const tabs = ["Inbox", "Sent", "Drafts"];
const palette = ["slate", "red", "orange", "amber", "lime", "emerald", "cyan", "blue", "violet", "fuchsia", "rose"];
const presets = [
  "px-6 py-4 rounded-xl bg-indigo-500 text-white shadow-lg hover:bg-indigo-600 active:scale-95 transition",
  "p-4 rounded-full bg-gradient-to-r from-pink-500 to-orange-400 text-white font-bold shadow-xl",
  "px-4 py-2 border-2 border-dashed border-emerald-500 rounded-lg text-emerald-700 dark:text-emerald-300 bg-emerald-500/10",
  "w-40 h-24 rounded-t-3xl bg-card border border-border shadow-md ring-2 ring-ring ring-offset-2 text-foreground",
  "p-3 bg-zinc-900 text-zinc-100 font-mono text-xs rounded-md tracking-wider uppercase opacity-80",
];

function Section({ title, children }: { title: string; children?: unknown }) {
  return (
    <div class="flex flex-col gap-3">
      <span class="font-semibold text-muted-foreground text-xs uppercase tracking-wider">{title}</span>
      {children as never}
    </div>
  );
}

export function App() {
  const theme = dark ? darkTheme : lightTheme;
  const radiusClasses = corners.size === 4 || corners.size === 0
    ? `rounded-${radius}`
    : [...corners].map(corner => `rounded-${corner}-${radius}`).join(" ");
  return (
    <Window title="Tailwind classes" width={820} height={760} minWidth={680} theme={theme} style={tw("bg-background")}>
      <TitleBar title="Tailwind classes" />
      <div class="flex flex-col gap-6 p-6 overflow-y-auto">
        <div class="flex justify-between items-center">
          <div class="flex flex-col gap-1">
            <h1 class="font-bold text-foreground text-2xl">class on native views</h1>
            <p class="text-muted-foreground text-sm">No CSS, no DOM: every class compiles to a native style at the JSX call site.</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => { dark = !dark; }}>
            {dark ? "Light theme" : "Dark theme"}
          </Button>
        </div>

        <Section title="Playground: type classes, see the box and the style they compile to">
          <Input value={playground} placeholder="Tailwind classes…" style={tw("w-full")} onChange={(value) => { playground = value; }} />
          <div class="flex gap-4 items-start">
            <div class="flex flex-1 justify-center items-center bg-muted/50 border border-border border-dashed rounded-lg min-h-40 p-6">
              <div class={playground}>
                <span class="font-medium text-sm">Preview</span>
              </div>
            </div>
            <div class="flex-1 min-w-0">
              <Code code={JSON.stringify(tw(playground), null, 2)} language="json" style={tw("text-xs rounded-lg")} />
            </div>
          </div>
          <div class="flex flex-wrap gap-2">
            {presets.map(preset => (
              <div
                key={preset}
                class={`px-2 py-1 rounded-md border text-xs cursor-pointer select-none ${playground === preset ? "bg-primary text-primary-foreground border-primary" : "bg-card text-muted-foreground border-border hover:bg-muted"}`}
                onClick={() => { playground = preset; }}
              >
                {preset}
              </div>
            ))}
          </div>
        </Section>

        <Section title={`Palette: pick a family, slide the shade (${family}-${shade})`}>
          <div class="flex flex-wrap gap-2">
            {palette.map((name) => (
              <div
                key={name}
                class={`size-12 rounded-md bg-${name}-${shade} hover:bg-${name}-${Math.min(shade + 100, 900)} active:scale-95 transition cursor-pointer ${family === name ? "ring-2 ring-offset-2 ring-ring" : ""}`}
                onClick={() => { family = name; }}
              />
            ))}
          </div>
          <div class="flex gap-4 items-center">
            <Slider value={shade} min={100} max={900} step={100} label="Shade" onValueChange={(value) => { shade = value; }} />
            <span class="font-mono text-muted-foreground text-sm">bg-{family}-{shade}</span>
            <div class={`flex-1 h-10 rounded-md bg-${family}-${shade}/40 border border-${family}-${shade}`} />
            <div class={`px-3 py-2 rounded-md bg-gradient-to-r from-${family}-${Math.max(shade - 200, 100)} to-${family}-${Math.min(shade + 200, 900)} text-white text-sm font-semibold shadow-md`}>
              gradient
            </div>
          </div>
        </Section>

        <Section title={`Radius: ${radiusClasses}`}>
          <div class="flex gap-4 items-center">
            <div class="flex gap-1">
              {radii.map(size => (
                <div
                  key={size}
                  class={`px-2 py-1 rounded-md border text-xs cursor-pointer select-none ${radius === size ? "bg-primary text-primary-foreground border-primary" : "bg-card text-foreground border-border hover:bg-muted"}`}
                  onClick={() => { radius = size; }}
                >
                  {size}
                </div>
              ))}
            </div>
            <div class="flex gap-1">
              {cornerNames.map(corner => (
                <div
                  key={corner}
                  class={`size-8 flex items-center justify-center rounded-md border text-xs cursor-pointer select-none ${corners.has(corner) ? "bg-secondary text-foreground border-ring" : "bg-card text-muted-foreground border-border hover:bg-muted"}`}
                  onClick={() => { if (corners.has(corner)) corners.delete(corner); else corners.add(corner); }}
                >
                  {corner}
                </div>
              ))}
            </div>
            <div class={`w-32 h-16 bg-${family}-${shade} border-2 border-${family}-${Math.min(shade + 300, 900)} shadow-sm transition ${radiusClasses}`} />
          </div>
        </Section>

        <Section title="Per-corner radius: rounded-t-* tabs over a rounded-b-* panel">
          <div class="flex flex-col">
            <div class="flex gap-1">
              {tabs.map((name) => (
                <div
                  key={name}
                  class={`px-4 py-2 rounded-t-lg cursor-pointer text-sm font-medium border border-b-0 border-border ${tab === name ? "bg-card text-foreground" : "bg-muted text-muted-foreground hover:bg-secondary"}`}
                  onClick={() => { tab = name; }}
                >
                  {name}
                </div>
              ))}
            </div>
            <div class="flex flex-col gap-3 bg-card p-4 border border-border rounded-b-lg rounded-tr-lg text-foreground text-sm">
              {tab === "Inbox" && (
                <div class="flex gap-3 items-center">
                  <div
                    class="px-3 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium cursor-pointer select-none hover:opacity-90 active:scale-95 transition"
                    onClick={() => { count++; }}
                  >
                    Mark {count} as read
                  </div>
                  <div class={`px-3 py-2 rounded-md border border-border text-sm cursor-pointer select-none hover:bg-muted active:scale-95 transition ${count === 0 ? "opacity-50" : ""}`} onClick={() => { count = 0; }}>
                    Reset
                  </div>
                  <span class="text-muted-foreground text-xs">active:scale-95 + transition on a plain div</span>
                </div>
              )}
              {tab === "Sent" && <span>Sent items live here. The panel keeps its top-right corner round because no tab sits there.</span>}
              {tab === "Drafts" && (
                <div class="flex gap-2">
                  {["Draft 1", "Draft 2", "Draft 3"].map(draft => (
                    <span key={draft} class="px-2 py-1 rounded-full bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100 text-xs">{draft}</span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Section>

        <Section title={`Flex and grid: gap-x-${gap} gap-y-${Math.max(gap - 2, 0)}, justify-around, justify-evenly`}>
          <div class="flex gap-4 items-center">
            <Slider value={gap} min={0} max={12} step={1} label="Gap" onValueChange={(value) => { gap = value; }} />
            <span class="font-mono text-muted-foreground text-sm">grid grid-cols-4 gap-x-{gap} gap-y-{Math.max(gap - 2, 0)}</span>
          </div>
          <div class={`grid grid-cols-4 gap-x-${gap} gap-y-${Math.max(gap - 2, 0)} transition`}>
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} class={`bg-${family}-${shade}/20 border border-${family}-${shade} rounded h-8`} />
            ))}
          </div>
          <div class="flex justify-around border border-border border-dashed rounded h-10">
            <div class="bg-emerald-500 rounded w-10" />
            <div class="bg-emerald-500 rounded w-10" />
            <div class="bg-emerald-500 rounded w-10" />
          </div>
          <div class="flex justify-evenly border border-border border-dashed rounded h-10">
            <div class="bg-sky-500 rounded w-10" />
            <div class="bg-sky-500 rounded w-10" />
            <div class="bg-sky-500 rounded w-10" />
          </div>
        </Section>

        <Section title="Gradients, shadows, dark: variants">
          <div class="flex gap-3">
            <div class="flex-1 bg-gradient-to-r from-violet-500 via-fuchsia-500 to-amber-400 shadow-lg rounded-xl h-20 hover:shadow-2xl hover:-translate-y-1 transition" />
            <div class="flex-1 bg-linear-to-br from-sky-400 to-blue-700 shadow-md rounded-xl ring-2 ring-sky-300 ring-offset-2 h-20 hover:ring-4 transition" />
            <div class="flex flex-1 justify-center items-center bg-white dark:bg-zinc-900 shadow-sm border border-zinc-200 dark:border-zinc-700 rounded-xl h-20 text-zinc-900 dark:text-white">
              <span class="font-semibold text-sm">dark: aware</span>
            </div>
          </div>
        </Section>

        <Section title="Typography">
          <p class="font-light text-foreground text-lg italic">Light italic, text-lg</p>
          <p class="font-semibold text-foreground text-base tracking-tight">Semibold, tracking-tight</p>
          <p class="font-bold text-rose-500 text-sm uppercase tracking-widest">Uppercase tracking-widest</p>
          <p class="max-w-md text-muted-foreground text-sm line-clamp-2">
            line-clamp-2 truncates this paragraph after two lines no matter how much more text follows it, which is
            exactly what the equivalent CSS would do in a browser, except that here the layout is native.
          </p>
          <span class="text-blue-500 text-sm decoration-wavy underline">underline decoration-wavy</span>
        </Section>

        <Section title="tw() on components, merged with an explicit style">
          <Row style={tw("gap-3 items-center")}>
            <View style={tw(`size-10 rounded-full bg-${family}-${shade}`)} />
            <Column style={{ ...tw("gap-1 p-3 rounded-lg border border-border bg-card"), minWidth: 220 }}>
              <Text style={tw("text-sm font-medium text-foreground")}>tw("…") returns a Style</Text>
              <Text style={tw("text-xs text-muted-foreground")}>Later classes win, and an inline style wins over classes.</Text>
            </Column>
          </Row>
        </Section>
      </div>
    </Window>
  );
}
