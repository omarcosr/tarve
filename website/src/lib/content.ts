import { orderedNames } from "./docs/catalog";
import counter from "./playground/hero/Counter.tsx?raw";

export const snippets = {
  counter: counter.replace(/\n$/, ""),
  install: `bun add @tarve/core
bun add -d typescript @types/bun`,
  tsconfig: `{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "jsx": "react-jsx",
    "jsxImportSource": "@tarve/core",
    "types": ["bun", "@tarve/core/assets"]
  }
}`,
  run: `# runs the source directly, no build step
bun app.tsx`,
  build: `# Windows → .exe with the native runtime embedded
bun run tarve build app.tsx --outfile dist/App.exe

# cross-compile for Linux x64, no Rust toolchain needed
bun run tarve build app.tsx --target linux-x64 --outfile dist/App`,
  style: `<Column style={{
  background: "linear-gradient(180deg, #fbfaf6, #ece8dc)",
  borderColor: "#15140f",
  borderWidth: 1,
  radius: 4,
  boxShadow: { y: 1, blur: 2, color: "#15140f1f" },
  hover: {
    transform: "translateY(-2px)",
    boxShadow: { y: 10, blur: 24, color: "#15140f2e" },
  },
  transition: { all: { duration: 180, easing: "easeOut" } },
}} />`,
};

export const componentCount = orderedNames.length;

export const spec = [
  { label: "Runtime", value: "Bun 1.4+", note: "TypeScript and TSX run directly, no build step in development" },
  { label: "Platforms", value: "Windows x64, Linux x64", note: "both runtimes ship inside the npm package" },
  { label: "Layout", value: "Taffy", note: "retained Flexbox and Grid, updated incrementally" },
  { label: "Text", value: "Parley", note: "shaping, selection, IME composition, Unicode editing" },
  { label: "Rendering", value: "D3D11 / DXGI, Vello / WGPU, vello_cpu", note: "chosen per machine, with fallbacks" },
  { label: "Accessibility", value: "AccessKit", note: "UI Automation on Windows, AT-SPI on Linux" },
  { label: "Components", value: String(componentCount), note: "each with a reference page and a live example" },
  { label: "Frames while idle", value: "0", note: "nothing is presented until something changes" },
  { label: "Output", value: "One executable", note: "per target, runtime embedded, cross-compiled" },
  { label: "Not included", value: "Chromium, the DOM, a CSS engine, React", note: "" },
  { label: "License", value: "Apache-2.0", note: "" },
];

export const pipeline = [
  { tag: "01", title: "TSX", where: "Bun", body: "A view is a function that returns TSX, compiled against Tarve's own JSX runtime. React is not involved." },
  { tag: "02", title: "Diff", where: "Bun", body: "The reconciler compares the new tree with the last one and keeps only the nodes that changed." },
  { tag: "03", title: "Bridge", where: "Bun → Rust", body: "The mutations cross to the native runtime once. Nothing polls; both sides sleep between events." },
  { tag: "04", title: "Layout", where: "Taffy", body: "Flexbox and Grid on a retained tree, so a changed label does not re-measure the whole window." },
  { tag: "05", title: "Text", where: "Parley", body: "Shaping, line breaking, selection and IME composition for every Text, Input and TextArea." },
  { tag: "06", title: "Paint", where: "D3D11 · Vello · CPU", body: "The damaged region is painted and presented. Then the window goes quiet again." },
];

export const features = [
  { title: "Text editing", body: "Selection, clipboard with text, files and images, IME composition, undo and redo, grapheme-aware cursor movement." },
  { title: "Rich content", body: "Markdown, syntax-highlighted Code and Diff are native leaves, so a 10,000-line file is one node, not 10,000." },
  { title: "Long lists", body: "VirtualList with fixed, measured or externally windowed rows." },
  { title: "Accessibility", body: "Every control is exposed through AccessKit to UI Automation on Windows and AT-SPI on Linux." },
  { title: "Desktop APIs", body: "Global hotkeys, native file dialogs, custom title bars, window positioning, close interception." },
  { title: "Development", body: "Error overlay inside the window, same-window remount under bun --hot, and a frame-time graph." },
  { title: "Themes", body: "Light and dark token sets in the shape of shadcn/ui, swappable at runtime without recreating the window." },
  { title: "Testing", body: "@tarve/headless renders any view to pixels or queries it by role, with no window, GPU or native binary." },
];
