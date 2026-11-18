// Prints the native documents the TypeScript examples compile to, for the Go parity tests.
// bun go/parity/dump.tsx <counter|fixtures> <scenarios.json>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// examples/ resolves @tarve/core to its built copy in examples/node_modules; a copy of the example
// here resolves it through the root tsconfig to packages/core/src, the compiler's own modules.
const copy = join(import.meta.dirname, ".cache");
mkdirSync(copy, { recursive: true });
import { jsx } from "../../packages/core/src/jsx-runtime";
import { compileTree } from "../../packages/core/src/reconciler";
import { withRenderScope } from "../../packages/core/src/render-scope";

const [which, file] = process.argv.slice(2);
const scenarios: { name: string; state: Record<string, unknown>; events?: { id: string; handler: string; args?: unknown[] }[] }[] = JSON.parse(readFileSync(file!, "utf8"));
const out: unknown[] = [];
if (which === "counter") {
  // counter.tsx starts its app at the bottom; the copy keeps the view and its state.
  const source = readFileSync(join(import.meta.dirname, "../../examples/counter/counter.tsx"), "utf8");
  const viewOnly = source.slice(0, source.indexOf("\napp = createApp(")) + "\nexport function setState(next: { count?: number; status?: string; protectClose?: boolean }) { if (next.count !== undefined) count = next.count; if (next.status !== undefined) status = next.status; if (next.protectClose !== undefined) protectClose = next.protectClose; }\n";
  writeFileSync(join(copy, "counter.tsx"), viewOnly);
  const view = await import("./.cache/counter.tsx");
  for (const scenario of scenarios) {
    view.setState({ count: 0, status: "Ctrl+S is registered as a global app hotkey.", protectClose: true, ...scenario.state });
    const scope = {};
    const render = () => withRenderScope(scope, () => compileTree(jsx(view.Counter, {}), false, "auto", [], scope, true));
    let tree = render();
    for (const event of scenario.events ?? []) {
      (tree.handlers.get(event.id) as Record<string, (...args: unknown[]) => void>)[event.handler]!(...(event.args ?? []));
      tree = render();
    }
    out.push({ name: scenario.name, document: tree.document });
  }
}
if (which === "fixtures") {
  const { fixtures } = await import("./fixtures");
  for (const scenario of scenarios) {
    const scope = {};
    const viewport = scenario.state.viewport as { width: number; height: number } | undefined;
    const tree = withRenderScope(scope, () => compileTree(jsx(fixtures[scenario.name.split(":")[0]!] as never, {}), false, "auto", [], scope, true, viewport));
    out.push({ name: scenario.name, document: tree.document });
  }
}
process.stdout.write(JSON.stringify(out));
