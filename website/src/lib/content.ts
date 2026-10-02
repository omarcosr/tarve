import { orderedNames } from "./docs/catalog";

export const snippets = {
  counter: `import { Button, Column, Text, Window, createApp } from "@tarve/core";

let count = 0;

function App() {
  return (
    <Window title="Counter" width={520} height={360}>
      <Column flex={1} align="center" justify="center" gap={16}>
        <Text size={42} weight={700}>{count}</Text>
        <Button onClick={() => count++}>Increase</Button>
      </Column>
    </Window>
  );
}

const app = createApp(App);
await app.ready;
await app.closed;`,
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
  background: "linear-gradient(135deg, #2563eb, #9333ea 80%)",
  radius: 16,
  boxShadow: { y: 2, blur: 6, color: "#0f172a22" },
  hover: {
    transform: "translateY(-2px) scale(1.02)",
    boxShadow: { y: 14, blur: 28, color: "#2563eb44" },
  },
  transition: { all: { duration: 220, easing: "easeOut" } },
}} />`,
};

export const componentCount = orderedNames.length;

export const stats = [
  { value: "0", label: "frames presented while the window is idle" },
  { value: String(componentCount), label: "native components in the box" },
  { value: "3", label: "render paths: D3D11, Vello and CPU" },
  { value: "1", label: "standalone executable per build" },
];

export const pipeline = [
  { tag: "01", title: "TSX", body: "You write components against the dedicated @tarve/core JSX runtime. No React underneath." },
  { tag: "02", title: "Retained tree", body: "The reconciler compiles your tree and sends only the mutations that changed to native." },
  { tag: "03", title: "Bun ↔ Rust bridge", body: "Event-driven, with no continuous polling. Nothing happens until something changes." },
  { tag: "04", title: "Taffy", body: "Retained Flexbox and Grid layout with incremental property and structural updates." },
  { tag: "05", title: "Parley", body: "Text shaping, selection, IME composition and Unicode-aware editing." },
  { tag: "06", title: "Pixels", body: "D3D11/DXGI, Vello/WGPU or vello_cpu + softbuffer — you choose the path." },
];

export const features = [
  { icon: "M4 6h16M4 12h10M4 18h7", title: "Real text editing", body: "Selection, clipboard with text, files and images, IME composition, native undo/redo and Unicode editing." },
  { icon: "M8 4h8l4 4v12H4V4h4m0 8h8m-8 4h5", title: "Rich content", body: "Native Markdown, syntax-highlighted Code and Diff leaves designed for large documents." },
  { icon: "M4 5h16M4 10h16M4 15h16M4 20h16", title: "VirtualList", body: "Fixed-height, measured variable-height or externally windowed. Huge lists without effort." },
  { icon: "M12 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6Zm-7 8h14m-7 0v9m-4 0 4-5 4 5", title: "Accessible", body: "AccessKit built in: UI Automation on Windows and AT-SPI on Linux." },
  { icon: "M3 7h18v12H3zM3 7l2-3h14l2 3M8 12h8", title: "Truly desktop", body: "Global hotkeys, native file dialogs, custom title bars and window positioning." },
  { icon: "M12 3v4m0 10v4M3 12h4m10 0h4M6 6l2.5 2.5m7 7L18 18M6 18l2.5-2.5m7-7L18 6", title: "Zero idle frames", body: "A window at rest presents no frames at all. Your users' batteries will thank you." },
  { icon: "M4 17l6-6-6-6M12 19h8", title: "Dev mode", body: "In-window error overlay, same-window remount under bun --hot and a native frame-time graph." },
  { icon: "M12 3 4 7v6c0 4 3.5 7 8 8 4.5-1 8-4 8-8V7l-8-4Z", title: "Semantic themes", body: "shadcn-inspired light/dark tokens, switchable at runtime without recreating the window." },
];
