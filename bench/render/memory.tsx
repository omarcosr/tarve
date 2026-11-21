/**
 * What the JS side keeps for the cross-framework list, stage by stage, on any runtime: the
 * process prints "@mark <stage>" and waits, and bench/render/memory.ts samples its private
 * bytes from outside (txiki.js has no memory API).
 */
import { Button, Column, Row, Scroll, Text, View, Window } from "@tarve/core";
import { compileTree } from "../../packages/core/src/reconciler";
import { nativeShadow } from "../../packages/core/src/app/shadow";
import { documentJson } from "../../packages/core/src/bridge/index";

const rows = 2000;
const view = (tick: number) => (
  <Window title="bench" width={1024} height={760}>
    <Column flex={1} style={{ background: "#ffffff" }}>
      <Row style={{ height: 48, shrink: 0 }}>
        <View style={{ width: 48, height: 48, background: "#ff00ff" }} />
        <Button style={{ width: 120, height: 32 }} onClick={() => {}}>Update</Button>
      </Row>
      <Scroll id="list" flex={1}>
        <Column>
          {Array.from({ length: rows }, (_, i) => (
            <Row key={i} style={{ height: 36, shrink: 0 }} gap={12}>
              <Text style={{ flex: 1 }}>Record {i}: native layout and text {tick}</Text>
              <Button size="sm">Open</Button>
            </Row>
          ))}
        </Column>
      </Scroll>
    </Column>
  </Window>
);
const gc = () => (globalThis as { gc?: () => void; Bun?: { gc(sync: boolean): void } }).Bun?.gc(true) ?? (globalThis as { gc?: () => void }).gc?.();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const mark = async (stage: string) => { gc(); await sleep(500); console.log("@mark " + stage); await sleep(2500); };
const keep: unknown[] = [];
await mark("base");
const vnodes = view(0);
await mark("vnodes");
keep.push(vnodes);
// MEMO=0: no render scope, so no memo store (what the cache itself costs).
const g = globalThis as { process?: { env?: Record<string, string | undefined> }; tjs?: { env?: Record<string, string> } };
const scope = (g.process?.env?.MEMO ?? g.tjs?.env?.MEMO) === "0" ? undefined : {};
const viewport = { width: 1024, height: 760 };
let tree = compileTree(view(0), false, "auto", [], scope, true, viewport);
keep.push(tree);
await mark("compiled");
const shadow = nativeShadow(tree);
keep.push(shadow);
await mark("shadow");
// As the bridge sends the first document (style table).
const json = documentJson(tree.document);
keep.push(json);
await mark("json");
const bytes = new TextEncoder().encode(json);
keep.push(bytes);
await mark("encoded");
keep.length = 2;
await mark("dropped");
// A second render: what an update adds while the first is still committed.
tree = compileTree(view(1), false, "auto", [], scope, true, viewport);
keep.length = 0;
keep.push(tree);
await mark("rerendered");
keep.length = 0;
tree = undefined as never;
await mark("released");
console.log("@done");
await sleep(3000);
