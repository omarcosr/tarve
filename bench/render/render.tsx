/**
 * JS-side cost of one full update of the cross-framework benchmark's list (bench/frameworks):
 * 2,000 rows whose labels all change. Times the view function (JSX), compileTree, the diff
 * against the previous tree and the native shadow, without a window, on any runtime:
 *
 *   bun bench/render/run.ts            (Bun, Node and txiki; ITER=40)
 *   DUMP=<dir> bun bench/render/render.tsx   (also writes the native layout benchmark's input)
 */
import { Button, Column, Row, Scroll, Text, View, Window } from "@tarve/core";
import { compileTree } from "../../packages/core/src/reconciler";
import { nativeShadow, reconciliationCommand } from "../../packages/core/src/app/shadow";

declare const tjs: unknown;
const g = globalThis as { process?: { env?: Record<string, string | undefined> }; tjs?: { env?: Record<string, string> } };
const env = (name: string) => g.process?.env?.[name] ?? g.tjs?.env?.[name];
const iterations = Number(env("ITER") ?? 40);
const rows = Number(env("ROWS") ?? 2000);
// SHAPE=row|text|button|static isolates the cost of each part of a row (row = the whole row).
const shape = env("SHAPE") ?? "row";
let tick = 0;

function Bench() {
  const marker = tick === 0 ? "#ff00ff" : tick % 2 ? "#00ff00" : "#0000ff";
  return (
    <Window title="bench" width={1024} height={760}>
      <Column flex={1} style={{ background: "#ffffff" }}>
        <Row style={{ height: 48, shrink: 0 }}>
          <View style={{ width: 48, height: 48, background: marker }} />
          <View style={{ width: 16 }} />
          <Column style={{ paddingTop: 8 }}>
            <Button style={{ width: 120, height: 32 }} onClick={() => tick++}>Update</Button>
          </Column>
        </Row>
        <Scroll id="list" flex={1}>
          <Column>
            {Array.from({ length: rows }, (_, i) => (
              shape === "text" ? <Text key={i} style={{ flex: 1 }}>Record {i}: native layout and text {tick}</Text>
              : shape === "button" ? <Button key={i} size="sm">Open {tick}</Button>
              : shape === "static" ? <Row key={i} style={{ height: 36, shrink: 0 }} gap={12}>
                <Text style={{ flex: 1 }}>Record {i}: native layout and text</Text>
                <Button size="sm">Open</Button>
              </Row>
              : <Row key={i} style={{ height: 36, shrink: 0 }} gap={12}>
                <Text style={{ flex: 1 }}>Record {i}: native layout and text {tick}</Text>
                <Button size="sm">Open</Button>
              </Row>
            ))}
          </Column>
        </Scroll>
      </Column>
    </Window>
  );
}

const now = () => performance.now();
const samples: Record<string, number[]> = { view: [], compile: [], diff: [], shadow: [], total: [] };
const viewport = { width: 1024, height: 760 };
// The app passes one render scope per window: memo and auto-memo caches live in it.
const scope = {};
let committed = compileTree(Bench(), false, "auto", [], scope, true, viewport);
let observed = nativeShadow(committed);
for (let i = 0; i < iterations; i++) {
  tick++;
  const t0 = now();
  const vnode = Bench();
  const t1 = now();
  const next = compileTree(vnode, false, "auto", [], scope, true, viewport);
  const t2 = now();
  const command = reconciliationCommand(observed, next);
  const t3 = now();
  observed = nativeShadow(next, observed);
  const t4 = now();
  if (!command && shape !== "static") throw new Error("no command: the update changed nothing");
  committed = next;
  samples.view!.push(t1 - t0); samples.compile!.push(t2 - t1); samples.diff!.push(t3 - t2); samples.shadow!.push(t4 - t3); samples.total!.push(t4 - t0);
}
// DUMP=dir: the first document and the next update's command, for the native layout benchmark
// (native/src/tests/layout_bench.rs).
const dump = env("DUMP");
if (dump) {
  const fs = await import("node:fs");
  tick = 1;
  const first = compileTree(Bench(), false, "auto", [], {}, true, viewport);
  tick = 2;
  const second = compileTree(Bench(), false, "auto", [], {}, true, viewport);
  fs.writeFileSync(dump + "/root.json", JSON.stringify(first.document.root));
  fs.writeFileSync(dump + "/command.json", JSON.stringify(reconciliationCommand(nativeShadow(first), second)));
}
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const out: Record<string, number> = {};
for (const [key, values] of Object.entries(samples)) out[key] = Math.round(median(values.slice(5)) * 100) / 100;
out.nodes = committed.nodes.size;
const prof = (globalThis as { __prof?: Record<string, number> }).__prof;
if (prof) for (const key in prof) out["p:" + key] = Math.round(prof[key]! / (iterations + 1) * 10) / 10;
console.log(JSON.stringify(out));
