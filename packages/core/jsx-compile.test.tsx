import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeJsxCompiler, compileJsx } from "./jsx-compile";
import { compileTree } from "./src/reconciler";

const directory = join(import.meta.dir, ".jsx-compile-test");
mkdirSync(directory, { recursive: true });
afterAll(async () => {
  rmSync(directory, { recursive: true, force: true });
  await closeJsxCompiler();
});

// A fresh name per run: Bun caches transpiled modules by path.
let counter = 0;
const run = Date.now().toString(36);
/** The module compiled and plain, for side-by-side compiles. */
async function both(source: string) {
  const id = counter++;
  const compiled = await compileJsx(source);
  writeFileSync(join(directory, `plain-${run}-${id}.tsx`), source);
  writeFileSync(join(directory, `compiled-${run}-${id}.tsx`), compiled.code);
  return { templates: compiled.templates, plain: await import(join(directory, `plain-${run}-${id}.tsx`)), compiled: await import(join(directory, `compiled-${run}-${id}.tsx`)) };
}

// Order-free: a reused subtree registers its nodes parent-first, a compiled one children-first.
const shape = (tree: ReturnType<typeof compileTree>) => [...tree.nodes.values()].map(node => JSON.stringify({ ...node, children: node.children.map(child => child.id) })).sort();

const SOURCE = `
import { Button, Column, Row, Text, Window } from "@tarve/core";
export const state = { items: [1, 2, 3], selected: 0, title: "Hello", clicks: [] as number[] };
function Badge() { return <Text id="badge">{"Selected " + state.selected}</Text>; }
export function App() {
  return <Window title="t">
    <Column gap={4}>
      <Text id="title" style={{ fontSize: 20 }}>{state.title}</Text>
      <Badge />
      {state.items.map(item => <div key={item} style={{ display: "flex", first: { padding: 8 }, last: { padding: 2 }, odd: { gap: 3 } } as never}>
        <Text>Item {item}</Text>
        <Button onClick={() => state.clicks.push(item * 10 + state.selected)}>Pick</Button>
      </div>)}
    </Column>
  </Window>;
}
`;

test("compiled JSX produces the same tree as plain JSX across updates", async () => {
  const { templates, plain, compiled } = await both(SOURCE);
  expect(templates).toBeGreaterThan(0);
  const plainScope = {}, compiledScope = {};
  const steps = [() => {}, () => { plain.state.selected = compiled.state.selected = 2; }, () => { plain.state.items = [3, 1]; compiled.state.items = [3, 1]; },
    () => { plain.state.items = [3, 1, 4, 5]; compiled.state.items = [3, 1, 4, 5]; }, () => { plain.state.title = compiled.state.title = "Bye"; }];
  for (const step of steps) {
    step();
    const a = compileTree(plain.App(), false, "auto", [], plainScope);
    const b = compileTree(compiled.App(), false, "auto", [], compiledScope);
    expect(shape(b)).toEqual(shape(a));
  }
});

test("a reused template calls the handler of the latest render", async () => {
  const { compiled } = await both(SOURCE);
  const scope = {};
  compiled.state.items = [1, 2];
  compileTree(compiled.App(), false, "auto", [], scope);
  compiled.state.selected = 7;
  const tree = compileTree(compiled.App(), false, "auto", [], scope);
  const button = [...tree.nodes.values()].find(node => node.kind === "button" && node.text === "Pick")!;
  tree.handlers.get(button.id)!.onClick!();
  expect(compiled.state.clicks).toEqual([17]);
});

test("app components stay outside templates and keep reading module state", async () => {
  const { compiled } = await both(SOURCE);
  const scope = {};
  compileTree(compiled.App(), false, "auto", [], scope);
  compiled.state.selected = 5;
  const tree = compileTree(compiled.App(), false, "auto", [], scope);
  expect(tree.nodes.get("badge")!.text).toBe("Selected 5");
});

test("TypeScript syntax, comments and non-ASCII text survive compilation", async () => {
  const { templates, plain, compiled } = await both(`
import { Column, Text, Window, type ThemeDefinition } from "@tarve/core";
type Item<T> = { id: number; value: T };
export const state = { items: [{ id: 1, value: "ação ✓" }] as Item<string>[], count: 3 };
const label = <T,>(item: Item<T>): string => String(item.value);
export function App() {
  const theme = undefined as ThemeDefinition | undefined;
  return <Window title="t" theme={theme}>
    {/* comentário */}
    <Column gap={2}>
      <Text id="ç">Olá — {state.count satisfies number} itens</Text>
      {state.items.map((item: Item<string>) => <Text key={item.id}>{label<string>(item)}</Text>)}
      <>
        <Text>Fragmento</Text>
        {state.count > 2 ? <Text>muitos</Text> : null}
      </>
    </Column>
  </Window>;
}
`);
  expect(templates).toBeGreaterThan(0);
  const a = compileTree(plain.App(), false, "auto", [], {});
  const b = compileTree(compiled.App(), false, "auto", [], {});
  expect(shape(b)).toEqual(shape(a));
  expect(b.nodes.get("ç")!.text).toBe("Olá — 3 itens");
});

test("source without JSX is returned unchanged", async () => {
  const source = "export const x: number = 1 < 2 ? 3 : 4;\n";
  expect(await compileJsx(source)).toEqual({ code: source, templates: 0 });
});
