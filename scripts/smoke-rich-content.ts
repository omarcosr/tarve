import { strict as assert } from "node:assert";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Code, Column, Diff, Markdown, Scroll, Window, createApp } from "@tarve/core-internal";
import { darkTheme, lightTheme } from "@tarve/core-internal";
import { jsx } from "@tarve/core-internal/jsx-runtime";
import { smokeRendererModes } from "./smoke-renderer-modes";

const updated = `${Array.from({ length: 2000 }, (_, index) => `line ${index}\n`).join("")}answer\n`;
const requestedRenderer = process.env.TARVE_SMOKE_RENDERER;

// `Code` is measured on its own, apart from the rich-content page, because the
// gutter alignment is a geometry question: every number must be drawn at the
// same baseline as the code line it labels, and the code column must start at a
// fixed x that does not move while the block scrolls horizontally.
if (process.env.TARVE_SMOKE_CODE) {
  const renderer = requestedRenderer === "gpu" ? "gpu" : "cpu";
  const label = process.env.TARVE_SMOKE_LABEL ?? renderer;
  const sample = [
    "export interface Project {",
    "  name: string;",
    "  status: \"ready\" | \"building\";",
    "}",
    "",
    "export function label(project: Project): string {",
    `  return ${"project.name + ".repeat(80)}project.status;`,
    "}",
  ].join("\n");
  const app = createApp(() => jsx(Window, {
    title: "Tarve code gutter smoke",
    width: 760,
    height: 320,
    theme: lightTheme,
    children: jsx(Column, {
      style: { padding: 16, gap: 12 },
      children: [
        jsx(Code, { id: "code-gutter", showLineNumbers: true, language: "typescript", code: sample, style: { width: 700, padding: 10, fontSize: 13 } }),
        jsx(Code, { id: "code-plain", language: "typescript", code: sample, style: { width: 700, padding: 10, fontSize: 13 } }),
      ],
    }),
  }), { renderer, debug: true });
  try {
    await app.ready;
    await Bun.sleep(160);
    const info = await app.inspect();
    const guttered = info.nodes.find(node => node.id === "code-gutter")!;
    const plain = info.nodes.find(node => node.id === "code-plain")!;
    assert((guttered.scrollMaxX ?? 0) > 0, "guttered Code must be horizontally scrollable for this visual regression");
    await mkdir(resolve("work"), { recursive: true });
    const beforePath = resolve(`work/code-gutter-${label}.png`);
    const afterPath = resolve(`work/code-gutter-${label}-scrolled.png`);
    await app.capture(beforePath);
    // The block must be tall enough for every line it draws. `Layout::height`
    // under-reports a block whose lines include blanks, and sizing the node to
    // that number clips the tail of the file away — which is what made the last
    // line numbers disappear.
    const lineCount = sample.split("\n").length;
    const minLineHeight = 20;
    assert(
      guttered.height >= lineCount * minLineHeight * 0.9,
      `block height ${guttered.height} cannot hold ${lineCount} lines of ~${minLineHeight}px`,
    );
    // The gutter is chrome beside the text, never a line of its own, so it
    // must not change the height of the same code.
    assert.equal(
      Math.round(guttered.height),
      Math.round(plain.height),
      "the line-number gutter must not add height",
    );
    // The viewport is identical and the source is identical, so the numbered
    // block must reserve extra horizontal extent for the gutter. This catches
    // the old state where the numbers were painted on top of the source even
    // though vertical geometry and scrolling otherwise looked healthy.
    const gutterInset = (guttered.scrollMaxX ?? 0) - (plain.scrollMaxX ?? 0);
    assert(
      gutterInset > 16,
      `line-number gutter did not reserve horizontal space: ${guttered.scrollMaxX} vs ${plain.scrollMaxX}`,
    );
    app.debug({
      type: "input",
      action: "move",
      x: guttered.x + Math.min(120, guttered.width / 2),
      y: guttered.y + Math.min(40, guttered.height / 2),
    });
    app.debug({ type: "input", action: "wheel", deltaX: 180, deltaY: 0 });
    await Bun.sleep(80);
    const scrolledInfo = await app.inspect();
    const scrolled = scrolledInfo.nodes.find(node => node.id === "code-gutter")!;
    assert((scrolled.scrollX ?? 0) > 0, "Code did not move horizontally during gutter visual regression");
    await app.capture(afterPath);
    assert.notDeepEqual(
      await readFile(afterPath),
      await readFile(beforePath),
      "horizontal Code scroll should visibly move the source",
    );
    console.log(
      `Code gutter ${label} smoke passed: ${guttered.width}x${guttered.height} ` +
      `(plain ${plain.width}x${plain.height}), ${lineCount} lines, scrollX ${scrolled.scrollX}.`,
    );
  } finally {
    app.close();
    await app.closed;
  }
} else if (!requestedRenderer) {
  const script = resolve(import.meta.dir, "smoke-rich-content.ts");
  const modes = smokeRendererModes();
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
  // The dark theme is the case that used to be broken: the diff washes, the
  // markdown code ink and the accent bars all came from a hardcoded light
  // palette, so a dark app got a light-mode diff.
  const gitPatch = [
    "diff --git a/README.md b/README.md",
    "index 111..222 100644",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1,2 +1,2 @@",
    " # Answer",
    "-const answer = 1;",
    "+const answer = 42;",
  ].join("\n");
  const app = createApp(() => jsx(Window, {
    title: "Tarve rich content smoke",
    width: 800,
    height: 680,
    theme: darkTheme,
    highlight: { query: "answer", activeIndex },
    onHighlight: (event: { matchCount: number }) => { matchCount = event.matchCount; },
    children: jsx(Column, {
      style: { padding: 20, gap: 14 },
      children: [
        jsx(Markdown, { id: "wide-markdown", source: "```txt\n" + "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(4) + "\n```" }),
        jsx(Markdown, { id: "markdown", source: "# Markdown\n\n- [x] **GFM** and [links](https://example.com)\n- [ ] Unchecked task marker\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n> Native quote\n\n```ts\nconst answer = 42;\n```" }),
        jsx(Code, { id: "code", code: "const answer = 42;\nconsole.log(answer);", language: "js" }),
        jsx(Scroll, { id: "diff-scroll", style: { height: 230 }, children: jsx(Diff, { id: "diff", oldText: "", newText: updated }) }),
        // Bounded so the diff itself scrolls: the git patch has more rows than
        // fit, which is the case a reviewer actually hits.
        jsx(Scroll, { id: "git-diff-scroll", style: { height: 70 }, children: jsx(Diff, { id: "git-diff", source: gitPatch, wordDiff: true }) }),
      ],
    }),
  }), { renderer, debug: true });

  try {
    await app.ready;
    await Bun.sleep(180);
    const first = await app.inspect();
    // "answer" appears in the Markdown fence, the Code block, the generated
    // diff and the git patch: two in the fence/code, and once per changed line.
    assert.equal(matchCount, 7);
    // 7 leaves plus the two extra scroll containers wrapping the diffs.
    assert.equal(first.nodes.length, 9);
    assert.equal(first.nodes.find(node => node.id === "markdown")?.kind, "markdown");
    const integratedCode = first.nodes.find(node => node.id === "code")!;
    assert.equal(integratedCode.kind, "code");
    assert(
      integratedCode.height >= 20 * 2 * 0.9,
      `integrated two-line Code is clipped to ${integratedCode.height}px`,
    );
    assert.equal(first.nodes.find(node => node.id === "diff")?.kind, "diff");
    // The git patch is one leaf, not a child list, and it is scrollable.
    assert.equal(first.nodes.find(node => node.id === "git-diff")?.kind, "diff");
    assert(first.nodes.find(node => node.id === "git-diff-scroll")!.scrollMax > 0);
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
