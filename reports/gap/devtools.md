# Inspetor visual (DevTools) — relatório

## Resumo

`tarve dev --inspect` (ou `createApp(view, { dev: { inspector: true } })`, ou `TARVE_INSPECTOR=1`) abre uma
**segunda janela Tarve do mesmo app nativo** (via `app.openWindow`, o mesmo mecanismo de `examples/windows`)
com o inspetor: árvore viva de componentes + nós nativos, props/estilo do nó selecionado, caixa de layout
calculada pelo nativo, modo *picker* que destaca o nó sob o ponteiro na janela do app, contagem de renders
por componente e log de eventos. Tudo em TypeScript; nada em `native/src` nem em `scripts/setup-examples.ts`.

## Como funciona

| Peça | Arquivo | O quê |
| --- | --- | --- |
| Gancho no reconciler | `packages/core/src/reconciler.ts` | `setComponentTrace()` + `ComponentTrace`: quando instalado, cada componente-função é compilado dentro do trace (`visitComponent` extraído, sem mudança de comportamento; sem trace o caminho é o mesmo de antes). |
| Trace de componentes | `packages/core/src/devtools/trace.ts` | `ComponentTracer`: árvore de *frames* (nome, path, props, nós nativos retornados, filhos) e `renders` por chave estável `path|Nome`. Um `memo()` reaproveitado (o reconciler devolve o mesmo array de resultado) **não** conta render e mantém os componentes internos registrados da vez anterior. Componentes desmontados saem da contagem. |
| Serialização/seleção | `packages/core/src/devtools/tree.ts` | `buildInspectorTree` junta nós nativos do `CompiledTree` e frames (estilo React DevTools; fragmentos agrupados uma vez), `indexTree`, `ancestorKeys` (revelar nó), `expandToDepth`, `flattenTree` (linhas visíveis com limite), `stepSelection`, `hitTest` (nó mais interno sob o ponto; respeita ordem de pintura, `portal`, `zIndex`, recorte de `scroll`/`overflow`), `describeValue` (funções, VNodes, ciclos e profundidade resumidos). |
| Controlador | `packages/core/src/devtools/inspector.ts` | `createInspector(app)`: envolve o compile do app, decora a árvore compilada com o overlay, assina `app.onEvent` para o log, abre a janela quando o app fica pronto. |
| UI | `packages/core/src/devtools/view.ts` | Janela escura: toolbar (Pick node / Expand all / Collapse / resumo), árvore à esquerda (×N = renders), detalhes (props, layout, estilo resolvido, campos do nó) e log de eventos à direita. |
| Integração | `packages/core/src/app.ts` | `AppOptions.dev?: boolean \| DevOptions` (`{ inspector?: boolean }`); no `compileView` o compile principal passa por `inspector.compile()` e depois `inspector.decorate(tree)`. Janelas abertas com `openWindow` nunca ganham inspetor próprio. |
| CLI | `packages/core/cli.ts` | `--inspect` em `run`/`dev` define `TARVE_INSPECTOR=1` (vale para Bun e Node). Era `TARVE_INSPECT=1`, que colidia com a automação (`TARVE_INSPECT=<arquivo>` grava a árvore e fecha o app); ver [runtimes-parity.md](runtimes-parity.md). |

### Layout calculado
Usa apenas requisições já existentes no protocolo: `layout` (síncrona, `app.layout([id])` → `LayoutBox`
com border box e conteúdo) para o nó selecionado; se a bridge não responde síncrono, cai para as caixas do
snapshot `inspect` (`NodeSnapshot.x/y/width/height`). O picker usa as caixas do `inspect`, relidas ao entrar
no modo, ao selecionar, após renders do app e a cada ~300 ms de movimento do ponteiro.

### Picker / destaque
Sem mudança nativa: o inspetor injeta como último filho da raiz do app um nó `__tarve-inspector-*`
absoluto (`inset 0`, `zIndex` alto). Fora do picker é uma `view` com `pointerEvents: "none"` contendo só o
retângulo de destaque (borda azul + rótulo `tipo #id L×A`). No picker vira um `pressable` transparente com
`reportPointer` (eventos `pointerMove` com posição) e `onClick` — captura o clique (o app não recebe) e
seleciona o nó sob o ponteiro. Passar o mouse numa linha da árvore também destaca o nó no app. Os nós do
overlay ficam fora da árvore mostrada e do log de eventos.

### Contagem de renders
Conta cada compilação real do componente desde que o inspetor abriu (montagem = 1). Renders disparados pelo
próprio inspetor (mover o destaque, entrar/sair do picker, o clique do picker) são compilados em modo
"quieto" e não contam.

## Testes

- `packages/core/src/devtools/devtools.test.tsx` (11 testes, headless com bridge falsa): árvore
  componentes+nós e fragmentos, contagem com `memo` reaproveitado e renders quietos, remoção de desmontados,
  nomes (`displayName`/anônimo), flatten/limite, revelar ancestrais e navegação, hit test (recorte/ordem/skip),
  `describeValue`, janela do inspetor via `openWindow` com contagens e log, picker (camada de captura, destaque,
  seleção ao clicar, saída do modo), regressão de ids, e `dev: false`/janelas-filhas sem inspetor.
- `scripts/smoke-inspector.ts` (janela real; chamado por `scripts/smoke-devtools.ts` num processo próprio,
  pois só um app nativo por processo): janela do inspetor abre, mostra `<Counter>` com `×N` e `click #bump`;
  picker adiciona a captura, destaque cobre o botão, clique não chega ao app e seleciona `h:bump` com caixa de
  layout. Gera `work/devtools-inspector.png` e `work/devtools-inspector-app.png`.
- Resultados: `bun test packages/core/src` → 0 falhas (incl. app/reconciler/memo/windows);
  `bun scripts/smoke-devtools.ts` → PASS (inclui o inspetor).
  `bun test packages/core` completo: 2 falhas em testes de targets (`public build targets…`, `npm package
  includes every supported native target directory`) vindas do trabalho paralelo de darwin (bg-6), não deste.
  `bun run check`: meus arquivos passam no tsc; no momento da última execução falhava apenas em
  `packages/create-tarve/create-tarve.test.ts` (pacote novo, não rastreado, de outra aba).

## Limitações / próximos passos

- Só componentes-função chamados via JSX (`<Comp/>`/`jsx(Comp)`) aparecem; componentes chamados como função
  (`Column({...})`) viram só nós nativos. `memo(X)` aparece como `memo(X)` envolvendo o que X retornou
  (o reconciler chama a função interna diretamente). Componentes que retornam `null` não aparecem.
- Vários `update()` na mesma tarefa são um render só (é o comportamento real do app). Um render do app que
  coincida no mesmo microtask com um render do inspetor não é contado.
- O hit test usa as caixas do snapshot: ignora `transform`/rotação e raio de borda; nós dentro de listas
  virtuais só existem quando montados.
- Só inspeciona a janela principal; janelas de `openWindow` não têm inspetor (seria preciso um seletor de
  janela). Sem edição de props ao vivo, sem busca na árvore, sem atalhos de teclado (há `stepSelection`
  pronto para isso).
- Árvore limitada a 600 linhas visíveis (colapsar para ver o resto); log guarda 300 eventos (`frame` e
  respostas de requisições são omitidos).
- O inspetor entra no bundle do core (import estático, ~800 linhas); só é instanciado quando pedido.
