// TypeScript-side cost of one update without a window: compileTree, diff and shadow for a
// 2 000-row list where one text changed. `bun scripts/bench-reconcile.tsx [rows] [memo]`.
// Numbers are per machine; compare runs on the same one.
import { Button, Column, Row, Scroll, Text, Window, Input } from "@tarve/core";
import { compileTree } from "../packages/core/src/reconciler";
import { nativeShadow, reconciliationCommand } from "../packages/core/src/app/shadow";
import { memo } from "../packages/core/src/memo";

const rows = Number(process.argv[2] ?? 2000);
const useMemo = process.argv[3] === "memo";
let revision = 0;
const RowItem = memo(({ index }: { index: number }) => <Row style={{ height: 36, shrink: 0 }} gap={12}>
  <Text style={{ flex: 1 }}>Record {index}: native layout and text</Text>
  <Button size="sm" onClick={() => revision++}>Open</Button>
</Row>);
function App() {
  return <Window title="bench" width={1024} height={760}>
    <Column padding={16} gap={12} flex={1}>
      <Text id="revision">Revision {revision}</Text>
      <Input id="search" />
      <Scroll id="list" flex={1}>
        <Column>
          {Array.from({ length: rows }, (_, index) => useMemo ? <RowItem key={index} index={index} /> : <Row key={index} style={{ height: 36, shrink: 0 }} gap={12}>
            <Text style={{ flex: 1 }}>Record {index}: native layout and text</Text>
            <Button size="sm" onClick={() => revision++}>Open</Button>
          </Row>)}
        </Column>
      </Scroll>
    </Column>
  </Window>;
}
const scope = {};
const t = (f: () => unknown) => { const s = performance.now(); const v = f(); return [performance.now() - s, v] as const; };
const med = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
let committed = compileTree(App(), false, "auto", [], scope);
let observed = nativeShadow(committed);
const compile: number[] = [], shadow: number[] = [], diff: number[] = [], total: number[] = [];
let patchBytes = 0;
for (let i = 0; i < 40; i++) {
  revision++;
  const s = performance.now();
  const [c, next] = t(() => compileTree(App(), false, "auto", [], scope));
  const [d, cmd] = t(() => reconciliationCommand(observed, next as any));
  const [sh, nextObs] = t(() => nativeShadow(next as any, observed));
  total.push(performance.now() - s);
  compile.push(c); diff.push(d); shadow.push(sh); patchBytes = JSON.stringify(cmd).length;
  committed = next as any; observed = nextObs as any;
}
Bun.gc(true);
const heap = process.memoryUsage();
console.log(JSON.stringify({ rows, nodes: committed.nodes.size, memo: useMemo, patchBytes,
  medianMs: { compile: +med(compile).toFixed(2), diff: +med(diff).toFixed(2), shadow: +med(shadow).toFixed(2), total: +med(total).toFixed(2) },
  heapMB: +(heap.heapUsed / 1048576).toFixed(1) }));
