import { TitleBar, Window, createApp, darkTheme, lightTheme, tw } from "@tarve/core";

// Tailwind classes are compiled natively by @tarve/core: no PostCSS or build step.
let count = 0;
let dark = false;

function App() {
  return (
    <Window title="__APP_TITLE__" width={560} height={420} theme={dark ? darkTheme : lightTheme} style={tw("bg-background")}>
      <TitleBar title="__APP_TITLE__" />
      <div class="flex flex-1 flex-col items-center justify-center gap-6 p-8">
        <span class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">__APP_TITLE__</span>
        <span class="text-6xl font-bold text-foreground">{count}</span>
        <div class="flex flex-row gap-3">
          <div class="px-4 py-2 rounded-lg border border-border text-foreground hover:bg-muted active:scale-95 transition" onClick={() => count--}>
            Decrease
          </div>
          <div class="px-4 py-2 rounded-lg bg-primary text-primary-foreground shadow-md hover:bg-primary/90 active:scale-95 transition" onClick={() => count++}>
            Increase
          </div>
        </div>
        <div class="px-3 py-1.5 rounded-md text-xs bg-muted text-muted-foreground hover:bg-accent" onClick={() => { dark = !dark; }}>
          {dark ? "Light theme" : "Dark theme"}
        </div>
      </div>
    </Window>
  );
}

const app = createApp(App);
await app.ready;
await app.closed;
