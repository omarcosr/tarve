import { strict as assert } from "node:assert";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Code, Column, Diff, Markdown, Scroll, Window, createApp } from "@tarve/core";
import { jsx } from "@tarve/core/jsx-runtime";

const updated = `${Array.from({ length: 2000 }, (_, index) => `line ${index}\n`).join("")}answer\n`;
const requestedRenderer = process.env.TARVE_SMOKE_RENDERER;

if (!requestedRenderer) {
  const script = resolve(import.meta.dir, "smoke-rich-content.ts");
  const modes = [
    { label: "cpu", renderer: "cpu", wgpuBackend: undefined },
    { label: "gpu-d3d11", renderer: "gpu", wgpuBackend: undefined },
    { label: "gpu-vello-dx12", renderer: "gpu", wgpuBackend: "dx12" },
  ] as const;
  for (const mode of modes) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TARVE_SMOKE_RENDERER: mode.renderer,
      TARVE_SMOKE_LABEL: mode.label,
    };
    if (mode.wgpuBackend) env.WGPU_BACKEND = mode.wgpuBackend;
    else delete env.WGPU_BACKEND;
    const child = Bun.spawn([process.execPath, script], {
      cwd: resolve(import.meta.dir, ".."), env, stdout: "inherit", stderr: "inherit",
    });
    assert.equal(await child.exited, 0, `Rich content ${mode.label} smoke failed.`);
  }
} else {
  const renderer = requestedRenderer === "gpu" ? "gpu" : "cpu";
  const label = process.env.TARVE_SMOKE_LABEL ?? renderer;
  let matchCount = -1;
  let activeIndex = 0;
  const app = createApp(() => jsx(Window, {
    title: "Tarve rich content smoke",
    width: 800,
    height: 680,
    highlight: { query: "answer", activeIndex },
    onHighlight: (event: { matchCount: number }) => { matchCount = event.matchCount; },
    children: jsx(Column, {
      style: { padding: 20, gap: 14 },
      children: [
        jsx(Markdown, { id: "wide-markdown", source: "```txt\n" + "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(4) + "\n```" }),
        jsx(Markdown, { id: "markdown", source: "# Markdown\n\n- [x] **GFM** and [links](https://example.com)\n- [ ] Unchecked task marker\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n> Native quote\n\n```ts\nconst answer = 42;\n```" }),
        jsx(Code, { id: "code", code: "const answer = 42;\nconsole.log(answer);", language: "js" }),
        jsx(Scroll, { id: "diff-scroll", style: { height: 230 }, children: jsx(Diff, { id: "diff", oldText: "", newText: updated }) }),
      ],
    }),
  }), { renderer, debug: true });

  try {
    await app.ready;
    await Bun.sleep(180);
    const first = await app.inspect();
    assert.equal(matchCount, 4);
    assert.equal(first.nodes.length, 7);
    assert.equal(first.nodes.find(node => node.id === "markdown")?.kind, "markdown");
    assert.equal(first.nodes.find(node => node.id === "code")?.kind, "code");
    assert.equal(first.nodes.find(node => node.id === "diff")?.kind, "diff");
    assert(first.nodes.find(node => node.id === "diff-scroll")!.scrollMax > 1000);
    await mkdir(resolve("work"), { recursive: true });
    const beforePath = resolve(`work/rich-content-${label}.png`);
    const afterPath = resolve(`work/rich-content-wide-scroll-${label}.png`);
    await app.capture(beforePath);
    const wide = first.nodes.find(node => node.id === "wide-markdown")!;
    app.debug({ type: "input", action: "move", x: wide.x + 35, y: wide.y + 10 });
    app.debug({ type: "input", action: "wheel", deltaX: 110, deltaY: 0 });
    await Bun.sleep(80);
    await app.capture(afterPath);
    assert.notDeepEqual(await readFile(afterPath), await readFile(beforePath), "wide Markdown should visibly scroll within its leaf");
    activeIndex = 3;
    app.update();
    await Bun.sleep(100);
    const focused = await app.inspect();
    assert(focused.nodes.find(node => node.id === "diff-scroll")!.scroll > 1000);
    assert.equal(focused.layoutNodes, first.layoutNodes);
    const scroll = first.nodes.find(node => node.id === "diff-scroll")!;
    app.debug({ type: "input", action: "move", x: scroll.x + 30, y: scroll.y + 30 });
    app.debug({ type: "input", action: "wheel", delta: 4000 });
    await Bun.sleep(100);
    const after = await app.inspect();
    assert(after.nodes.find(node => node.id === "diff-scroll")!.scroll > 0);
    assert.equal(after.layoutNodes, first.layoutNodes);
    console.log(`Rich content ${label} smoke passed: ${after.layoutNodes} native nodes, scroll ${after.nodes.find(node => node.id === "diff-scroll")!.scroll}.`);
  } finally {
    app.close();
    await app.closed;
  }
}
