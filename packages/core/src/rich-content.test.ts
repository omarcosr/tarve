import { expect, test } from "bun:test";
import { jsx } from "./jsx-runtime";
import { Code, Diff, Markdown, Window } from "./components";
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

test("Diff rejects ambiguous or incomplete input", () => {
  expect(() => Diff({})).toThrow();
  expect(() => Diff({ source: "" })).toThrow();
  expect(() => Diff({ oldText: "old" })).toThrow();
  expect(() => Diff({ source: "patch", oldText: "old", newText: "new" })).toThrow();
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
