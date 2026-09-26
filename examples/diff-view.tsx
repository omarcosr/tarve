import { Button, Column, Diff, Input, Row, Scroll, Text, TitleBar, Window, createTextSearchController, theme } from "tarve";

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
let patchName = "Exemplo: counter.tsx + counter.toml";
let maxLines = 14;
let wordDiff = true;
let status = "Selecione texto no diff para copiar sem números de linha.";
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
  status = `Arquivo carregado: ${name}`;
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
          <Text size={22} weight={700}>Revisão de alterações</Text>
          <Text size={12} color={colors.mutedForeground}>Exemplo inspirado no diff.tsx do GPUix. Abra um patch Git ou unified diff para revisar seus próprios arquivos.</Text>
        </Column>
        <Row gap={8} align="center" style={{ width: "100%" }}>
          <Button id="diff-open-patch" size="sm" onClick={() => { void openPatch(); }}>Abrir .patch / .diff</Button>
          <Button size="sm" variant="outline" onClick={() => setPatchSource(patch, "Exemplo: counter.tsx + counter.toml")}>Exemplo padrão</Button>
          <Text id="diff-file-name" size={12} color={colors.mutedForeground}>{patchName}</Text>
        </Row>
        <Row gap={8} align="center" style={{ width: "100%" }}>
          <Input id="diff-search" type="search" value={query} placeholder="Buscar no patch" onChange={value => { query = value; }} style={{ width: 230 }} />
          <Button size="sm" variant="outline" onClick={() => search.previous()}>Anterior</Button>
          <Button size="sm" variant="outline" onClick={() => search.next()}>Próximo</Button>
          <Text size={12} color={colors.mutedForeground}>{query ? `${found.total ? found.active + 1 : 0}/${found.total}` : "Busca"}</Text>
          <Button size="sm" variant="outline" onClick={() => { wordDiff = !wordDiff; }}>{wordDiff ? "Palavras: ligado" : "Palavras: desligado"}</Button>
        </Row>
        <Row gap={8} align="center" style={{ width: "100%" }}>
          <Button size="sm" variant="outline" onClick={() => { collapsed.clear(); status = "Todos os arquivos expandidos."; }}>Expandir todos</Button>
          <Button size="sm" variant="outline" onClick={() => { maxLines += 20; }}>Mostrar mais linhas</Button>
          <Text size={12} color={colors.mutedForeground}>Clique no cabeçalho para recolher um arquivo.</Text>
        </Row>
        <Scroll id="diff-demo-scroll" flex={1} orientation="vertical" style={{ width: "100%", borderWidth: 1, borderColor: colors.border, radius: 8, background: colors.card }}>
          <Diff
            id="diff-demo"
            source={patchSource}
            wordDiff={wordDiff}
            maxLines={maxLines}
            collapsedPaths={[...collapsed]}
            onToggleFile={path => { collapsed.has(path) ? collapsed.delete(path) : collapsed.add(path); status = `${path}: ${collapsed.has(path) ? "recolhido" : "expandido"}`; }}
            onShowMore={(hidden, path) => { maxLines += Math.max(20, hidden); status = `${path ?? "Patch"}: mais ${hidden} linhas` ; }}
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
