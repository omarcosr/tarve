// TitleBar as a phone's top bar: `tarve build topbar/topbar.tsx --target android-arm64`.
// On Android it drops the window controls, is 56 dp tall and paints the status bar in its colour;
// on desktop the same bar keeps minimize/maximize/close after the actions.
import { Column, Icon, Pressable, Text, TitleBar, Window, createApp, type SvgNode } from "@tarve/core";

const BAR = "#1e3a8a";
const INK = "#ffffff";
const albums = ["Blue Train", "Kind of Blue", "A Love Supreme", "Mingus Ah Um"];
let open: string | null = null;
let shared = 0;

function IconButton({ label, icon, onClick }: { label: string; icon: SvgNode[]; onClick: () => void }) {
  return (
    <Pressable
      onClick={onClick}
      control={{ role: "button", label }}
      style={{ width: 48, height: 48, radius: 24, align: "center", justify: "center", background: "#00000000", active: { background: "#ffffff33" } }}
    >
      <Icon iconNode={icon} size={22} strokeWidth={2} color={INK} />
    </Pressable>
  );
}

const share: SvgNode[] = [["path", { d: "M4 12v8h16v-8M12 3v13M7 8l5-5 5 5" }]];
const search: SvgNode[] = [["circle", { cx: 11, cy: 11, r: 7 }], ["path", { d: "M21 21l-5-5" }]];
const bar = { background: BAR, foreground: INK, borderWidth: 0 };

function Library() {
  return (
    <>
      <TitleBar title="Biblioteca" style={bar} actions={<IconButton label="Buscar" icon={search} onClick={() => {}} />} />
      <Column flex={1}>
        {albums.map(album => (
          <Pressable key={album} onClick={() => { open = album; app.update(); }} style={{ padding: { left: 16, right: 16, top: 18, bottom: 18 }, background: "#00000000", active: { background: "#0000000f" } }}>
            <Text size={16}>{album}</Text>
          </Pressable>
        ))}
      </Column>
    </>
  );
}

function Album({ name }: { name: string }) {
  return (
    <>
      <TitleBar
        title={name}
        style={bar}
        onBack={() => { open = null; app.update(); }}
        actions={<IconButton label="Compartilhar" icon={share} onClick={() => { shared++; app.update(); }} />}
      />
      <Column flex={1} padding={24} gap={12}>
        <Text size={16}>Compartilhado {shared}×</Text>
      </Column>
    </>
  );
}

const app = createApp(() => (
  <Window title="Top bar" width={420} height={720}>
    {open ? <Album name={open} /> : <Library />}
  </Window>
));
await app.ready;
await app.closed;
