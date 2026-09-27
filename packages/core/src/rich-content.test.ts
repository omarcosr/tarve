import { expect, test } from "bun:test";
import { jsx } from "./jsx-runtime";
import { Code, Diff, Markdown, Window } from "./components";
import { darkTheme, lightTheme } from "./theme";
import { compileTree, diffTrees } from "./reconciler";

test("rich content compiles as native leaves and patches changed sources", () => {
  const view = (source: string) => compileTree(jsx(Window, { children: [
    jsx(Markdown, { id: "doc", source }),
    jsx(Code, { id: "code", code: "const n = 1", language: "js" }),
    jsx(Diff, { id: "diff", oldText: "a\n", newText: "b\n" }),
  ] }));
  const first = view("# Heading");
  expect(first.nodes.size).toBe(4);
  expect(first.nodes.get("doc")).toMatchObject({ kind: "markdown", source: "# Heading", children: [] });
  expect(first.nodes.get("code")).toMatchObject({ kind: "code", text: "const n = 1", language: "js" });
  expect(first.nodes.get("diff")).toMatchObject({ kind: "diff", oldText: "a\n", newText: "b\n" });
  expect(diffTrees(first, view("# Updated"))?.map(node => node.id)).toEqual(["doc"]);
});

test("Code and Diff use a portable monospace default without blocking explicit families", () => {
  const defaults = compileTree(jsx(Window, { children: [
    jsx(Code, { id: "code", code: "const n = 1" }),
    jsx(Diff, { id: "diff", oldText: "a\n", newText: "b\n" }),
  ] }));
  expect(defaults.nodes.get("code")?.style.fontFamily).toBe("monospace");
  expect(defaults.nodes.get("diff")?.style.fontFamily).toBe("monospace");

  const custom = compileTree(jsx(Window, { children: [
    jsx(Code, { id: "code", code: "const n = 1", style: { fontFamily: "Fira Code" } }),
    jsx(Diff, { id: "diff", oldText: "a\n", newText: "b\n", style: { fontFamily: "JetBrains Mono" } }),
  ] }));
  expect(custom.nodes.get("code")?.style.fontFamily).toBe("Fira Code");
  expect(custom.nodes.get("diff")?.style.fontFamily).toBe("JetBrains Mono");
});

test("Diff rejects ambiguous or incomplete input but accepts an empty patch", () => {
  // No source and no text pair: there is nothing to diff.
  expect(() => Diff({})).toThrow();
  // One side of the pair is missing: a diff cannot be computed.
  expect(() => Diff({ oldText: "old" })).toThrow();
  expect(() => Diff({ newText: "new" })).toThrow();
  // Both a patch and a text pair: there is no single correct reading.
  expect(() => Diff({ source: "patch", oldText: "old", newText: "new" })).toThrow();
  // An empty patch is a legitimate state — a file with no changes — and must
  // render as an empty diff rather than throwing during the render pass.
  expect(() => Diff({ source: "" })).not.toThrow();
  const tree = compileTree(jsx(Window, { children: jsx(Diff, { id: "diff", source: "" }) }));
  expect(tree.nodes.get("diff")).toMatchObject({ kind: "diff", source: "" });
});

test("a diff wash resolves to a real colour, not a css variable reference", () => {
  // `theme.colors` hands out `var(--token)` references, so a value that reaches
  // the native side unresolved paints nothing. This is the exact regression that
  // made a removed line render with a saturated action colour.
  const tree = compileTree(jsx(Window, {
    theme: lightTheme,
    children: jsx(Diff, { id: "diff", oldText: "a\n", newText: "b\n" }),
  }));
  const style = tree.nodes.get("diff")!.style;
  for (const key of [
    "diffAddedBackground", "diffRemovedBackground",
    "diffAddedEmphasisBackground", "diffRemovedEmphasisBackground",
    "diffAddedAccent", "diffRemovedAccent", "diffGutterColor",
  ] as const) {
    const value = style[key] as string;
    expect(value.startsWith("var(--")).toBe(false);
    expect(value).toMatch(/^#[0-9a-f]{6,8}$/i);
  }
});

test("rich leaves take their diff and markdown colours from the theme", () => {
  for (const selected of [lightTheme, darkTheme]) {
    const tree = compileTree(jsx(Window, {
      theme: selected,
      children: [
        jsx(Diff, { id: "diff", oldText: "a\n", newText: "b\n" }),
        jsx(Markdown, { id: "doc", source: "`x`" }),
      ],
    }));
    const diffStyle = tree.nodes.get("diff")!.style;
    // The washes must come from the theme, not a hardcoded light palette, or a
    // dark app gets a light-mode diff.
    expect(diffStyle.diffAddedBackground).toBe(selected.colors.diffAddBackground);
    expect(diffStyle.diffRemovedBackground).toBe(selected.colors.diffRemoveBackground);
    expect(diffStyle.diffAddedEmphasisBackground).toBe(selected.colors.diffAddEmphasisBackground);
    expect(diffStyle.diffRemovedEmphasisBackground).toBe(selected.colors.diffRemoveEmphasisBackground);
    expect(diffStyle.diffGutterColor).toBe(selected.colors.mutedForeground);
    // A wash is a background tint, so it must not be the saturated action
    // colour: that red is unreadable behind a line of code.
    expect(diffStyle.diffRemovedBackground).not.toBe(selected.colors.destructive);
    expect(diffStyle.diffAddedBackground).not.toBe(selected.colors.primary);
    const markdownStyle = tree.nodes.get("doc")!.style;
    expect(markdownStyle.markdownCodeColor).toBe(selected.colors.foreground);
    expect(markdownStyle.markdownLinkColor).toBe(selected.colors.primary);
  }
  // The two appearances must actually differ, or one of them is not themed.
  expect(lightTheme.colors.diffAddBackground).not.toBe(darkTheme.colors.diffAddBackground);
  expect(lightTheme.colors.diffRemoveBackground).not.toBe(darkTheme.colors.diffRemoveBackground);
  expect(lightTheme.colors.diffAddEmphasisBackground).not.toBe(darkTheme.colors.diffAddEmphasisBackground);
  expect(lightTheme.colors.diffRemoveEmphasisBackground).not.toBe(darkTheme.colors.diffRemoveEmphasisBackground);
});

test("Markdown exposes clicked link URLs to its callback", () => {
  const links: string[] = [];
  const tree = compileTree(jsx(Window, { children: jsx(Markdown, {
    id: "doc", source: "[Tarve](https://example.com)", onLinkClick: (href: string) => links.push(href),
  }) }));
  tree.handlers.get("doc")?.onMarkdownLink?.("https://example.com");
  expect(links).toEqual(["https://example.com"]);
});

test("highlight reaches native containers and rich leaves without adding nodes", () => {
  const counts: number[] = [];
  const tree = compileTree(jsx(Window, { highlight: { query: "needle", activeIndex: 1 }, onHighlight: (event: { matchCount: number }) => counts.push(event.matchCount), children: [
    jsx(Markdown, { id: "doc", source: "needle" }),
    jsx(Code, { id: "code", code: "needle", highlight: { ranges: [{ start: 0, end: 6 }] } }),
    jsx(Diff, { id: "diff", oldText: "", newText: "needle\n" }),
  ] }));
  expect(tree.nodes.size).toBe(4);
  expect(tree.nodes.get("root")?.highlight).toEqual({ query: "needle", activeIndex: 1 });
  expect(tree.nodes.get("code")?.highlight).toEqual({ ranges: [{ start: 0, end: 6 }] });
  tree.handlers.get("root")?.onHighlight?.({ matchCount: 3 });
  expect(counts).toEqual([3]);
});

test("changing active highlight patches its native owner", () => {
  const view = (activeIndex: number) => compileTree(jsx(Window, {
    highlight: { query: "needle", activeIndex },
    children: jsx(Code, { id: "code", code: "needle needle" }),
  }));
  expect(diffTrees(view(0), view(1))?.map(node => node.id)).toEqual(["root"]);
});
