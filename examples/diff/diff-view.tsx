import { Button, Column, Diff, Input, Row, Scroll, Text, TitleBar, Window, createTextSearchController, theme } from "@tarve/core";

const colors = theme.colors;

// The two counter hunks follow the scenario in GPUix's examples/diff.tsx.
// A second file makes the native file controls visible in this demo.
export const patch = [
  "diff --git a/src/counter.tsx b/src/counter.tsx",
  "--- a/src/counter.tsx",
  "+++ b/src/counter.tsx",
  "@@ -1,7 +1,12 @@",
  " import React from 'react'",
  " import { useState } from 'react'",
  " ",
  "-function Counter({ initial }: { initial: number }) {",
  "-  const [count, setCount] = useState(initial)",
  "+interface CounterProps {",
  "+  initial: number",
  "+  step?: number",
  "+}",
  "+",
  "+function Counter({ initial, step = 1 }: CounterProps) {",
  "+  const [count, setCount] = useState(initial)",
  "   return (",
  "     <div>",
  "@@ -12,5 +16,9 @@",
  "       <span>{count}</span>",
  "-      <button onClick={() => setCount(c => c + 1)}>+</button>",
  "-      <button onClick={() => setCount(c => c - 1)}>-</button>",
  "+      <button onClick={() => setCount(c => c + step)}>",
  "+        Increment by {step}",
  "+      </button>",
  "+      <button onClick={() => setCount(c => c - step)}>",
  "+        Decrement by {step}",
  "+      </button>",
  "     </div>",
  "   )",
  "diff --git a/config/counter.toml b/config/counter.toml",
  "--- a/config/counter.toml",
  "+++ b/config/counter.toml",
  "@@ -1,4 +1,5 @@",
  " [counter]",
  "-step = 1",
  "+step = 2",
  "+label = \"Clicks\"",
  " enabled = true",
  " theme = \"dark\"",
  "",
].join("\n");

let query = "";
let patchSource = patch;
let patchName = "Example: counter.tsx + counter.toml";
let maxLines = 14;
let wordDiff = true;
let status = "Select text in the diff to copy it without line numbers.";
const collapsed = new Set<string>();
const search = createTextSearchController();
let refresh = () => {};
let openPatch = async () => {};
search.subscribe(() => refresh());

export function setPatchSource(source: string, name: string) {
  patchSource = source;
  patchName = name;
  query = "";
  maxLines = 80;
  collapsed.clear();
  status = `Loaded file: ${name}`;
  refresh();
}

export function setPatchError(message: string) {
  status = message;
  refresh();
}

export function connectOpenPatch(open: () => Promise<void>) { openPatch = open; }

export function App() {
  const found = search.getSnapshot({ query });
  return (
    <Window title="Tarve — Diff viewer" width={1000} height={720} minWidth={720} minHeight={500} position="center">
      <TitleBar title="Tarve — Diff viewer" />
      <Column flex={1} gap={12} padding={18} style={{ background: colors.background }}>
        <Column gap={4}>
          <Text size={22} weight={700}>Review changes</Text>
          <Text size={12} color={colors.mutedForeground}>Example inspired by GPUix's diff.tsx. Open a Git patch or unified diff to review your own files.</Text>
        </Column>
        <Row gap={8} align="center" style={{ width: "100%" }}>
          <Button id="diff-open-patch" size="sm" onClick={() => { void openPatch(); }}>Open .patch / .diff</Button>
          <Button size="sm" variant="outline" onClick={() => setPatchSource(patch, "Example: counter.tsx + counter.toml")}>Default example</Button>
          <Text id="diff-file-name" size={12} color={colors.mutedForeground}>{patchName}</Text>
        </Row>
        <Row gap={8} align="center" style={{ width: "100%" }}>
          <Input id="diff-search" type="search" value={query} placeholder="Search the patch" onChange={value => { query = value; }} style={{ width: 230 }} />
          <Button size="sm" variant="outline" onClick={() => search.previous()}>Previous</Button>
          <Button size="sm" variant="outline" onClick={() => search.next()}>Next</Button>
          <Text size={12} color={colors.mutedForeground}>{query ? `${found.total ? found.active + 1 : 0}/${found.total}` : "Search"}</Text>
          <Button size="sm" variant="outline" onClick={() => { wordDiff = !wordDiff; }}>{wordDiff ? "Words: on" : "Words: off"}</Button>
        </Row>
        <Row gap={8} align="center" style={{ width: "100%" }}>
          <Button size="sm" variant="outline" onClick={() => { collapsed.clear(); status = "All files expanded."; }}>Expand all</Button>
          <Button size="sm" variant="outline" onClick={() => { maxLines += 20; }}>Show more lines</Button>
          <Text size={12} color={colors.mutedForeground}>Click a file header to collapse it.</Text>
        </Row>
        <Scroll id="diff-demo-scroll" flex={1} orientation="vertical" style={{ width: "100%", borderWidth: 1, borderColor: colors.border, radius: 8, background: colors.card }}>
          <Diff
            id="diff-demo"
            source={patchSource}
            wordDiff={wordDiff}
            maxLines={maxLines}
            collapsedPaths={[...collapsed]}
            onToggleFile={path => { collapsed.has(path) ? collapsed.delete(path) : collapsed.add(path); status = `${path}: ${collapsed.has(path) ? "collapsed" : "expanded"}`; }}
            onShowMore={(hidden, path) => { maxLines += Math.max(20, hidden); status = `${path ?? "Patch"}: ${hidden} more lines` ; }}
            onLineClick={event => { status = `${event.path ?? "Patch"}  −${event.oldLine ?? ""} +${event.newLine ?? ""}  ${event.text.trim()}`; }}
            {...found.props}
            style={{ width: "100%", padding: 10, fontSize: 14, lineHeight: 1.5 }}
          />
        </Scroll>
        <Text id="diff-status" size={12} color={colors.mutedForeground}>{status}</Text>
      </Column>
    </Window>
  );
}

export function connectRefresh(update: () => void) { refresh = update; }
