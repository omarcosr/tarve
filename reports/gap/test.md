# @tarve/test — relatório de progresso

## O que foi feito

- Novo pacote de workspace `packages/test` (`@tarve/test` 0.7.0, peer deps `@tarve/core` e
  `@tarve/headless` ^0.7.0, `package.json` no mesmo formato de `packages/headless`).
- API no estilo Testing Library sobre o runtime headless (WebAssembly, sem janela nem GPU):
  `src/index.ts` (render, fireEvent, waitFor, snapshots), `src/queries.ts` (matriz de queries),
  `src/element.ts` (`TestElement`, papéis e nome acessível).
- Alias `@tarve/test` adicionado em `paths` do `tsconfig.json` da raiz (mesmo mecanismo de
  `@tarve/headless`).
- Ganchos novos em `packages/headless` (nenhuma alteração em `packages/core` nem em `native/src`):
  - `src/tree.ts` — `SceneTreeMirror`: espelho da árvore compilada (`compileTree` →
    `SceneDocument.root`), mantido em dia com os comandos `update`, `patch` e `mutate` e com as
    edições que o próprio tree nativo faz (`change` de Input/TextArea, `valueChange` de Slider),
    que o app aplica no shadow sem mandar patch de volta.
  - `HeadlessBridge.scene()`, `HeadlessBridge.sceneVersion` e `HeadlessBridge.emit(event)` (entrega
    um `NativeEvent` ao app pelo mesmo caminho do bridge nativo: `dispatchNativeEvent` →
    `committed.handlers` → `createElementDispatcher`).
  - Exportados em `src/index.ts` (`SceneTreeMirror`, `SceneNode`) e documentados no README.

## API

- `await render(ui | () => ui, options)` → `RenderResult`; views sem `Window` são embrulhadas
  (640×480 por padrão; `theme`, `width`, `height`, `scale`, `clock`, `fonts`…).
- Queries `getBy*`, `getAllBy*`, `queryBy*`, `queryAllBy*`, `findBy*`, `findAllBy*` para
  `Text`, `Role` (`name`, `checked`, `selected`, `expanded`, `disabled`), `Label`, `Placeholder`,
  `DisplayValue` e `TestId` (= id do nó / prop `id`; o core não tem `testId`). Matcher: string
  exata, `{ exact: false }`, RegExp ou função. Erros imprimem a árvore.
- Papéis: `control.role` declarado pelos componentes, ou implícito (`button`, `textbox`,
  `searchbox`, `slider`, `img`, `window`). Nome acessível: `control.label` → `labelledBy`
  (`<label htmlFor>`) → label do `Field` → conteúdo (botão, link, checkbox…) → placeholder.
- `TestElement` vivo e com identidade estável por id: `text`, `textContent`, `value`, `name`,
  `role`, `checked`, `disabled`, `parent`, `children`, `node`, `isConnected`, `closest`,
  `descendants`.
- `fireEvent.click` (ponteiro real com hit testing; `via: "event"` para despacho direto),
  `type` (com `{Enter}`, `{Tab}`… e `clear`), `clear`, `key`, `scroll`, `hover`, `native`.
  Todos aguardam o app re-renderizar (`settle`).
- `rerender(ui?)`, `unmount()`, `cleanup()`, `within(el)`, `debug()`, `box(el)`, `advance(ms)`,
  `snapshot()` (PNG), `pixels()` (RGBA), `waitFor`, `waitForElementToBeRemoved`.
- `toMatchImageSnapshot(view | image, arquivo, { threshold, maxDifferenceRatio, update })` e
  `tarveMatchers` para `expect.extend`.

## Testes

- `packages/test/src/render.test.tsx` — 11 testes: contador (clique via ponteiro e via evento),
  elementos vivos/estáveis, digitação em Input com `Field` (label, placeholder, display value,
  `{Enter}` → `onSubmit`, `clear`), queries de papel (botões, checkbox, switch, searchbox,
  estados, erros de múltiplos/nenhum), botão desabilitado ignora clique, `within`/`getAll`/árvore
  impressa, `findBy`/`waitFor`/`rerender`, teclas (Enter em botão, Tab move foco, ArrowRight em
  Slider) e rolagem, `unmount`, snapshot PNG + comparação com tolerância, matcher via
  `expect.extend`. Snapshots gravados em `packages/test/__snapshots__/` (`counter.png`,
  `matcher.png`) — devem ser commitados (no CI um snapshot ausente falha).
- `bun test packages/test packages/headless`: **20 pass, 0 fail** (11 do novo pacote + 9 do
  headless, que continua passando com os ganchos novos).
- `bun node_modules/typescript/bin/tsc --noEmit -p .` (typecheck da raiz, inclui `packages/`):
  **sem erros**.

## Limitações

- `render` é assíncrono (carrega o wasm) e `rerender` retorna Promise.
- Papéis vêm do metadado `control` do Tarve, não de uma API de acessibilidade do SO; não há
  `heading`, `list` etc. implícitos.
- As queries enxergam toda a árvore compilada, inclusive nós fora da área visível; eventos de
  ponteiro exigem o nó com layout (senão `click` cai para despacho direto do evento).
- `onKeyDown` só recebe as teclas que o tree nativo reporta (menus, selects, tree items).
- Uso em Node documentado (loader TS/JSX como `tsx` + `node:test`), mas **não verificado**:
  `@tarve/core`/`@tarve/headless` publicam fontes TypeScript e o ambiente não tinha `tsx`.
- `bun install` não foi executado; o `bun.lock` ainda não lista o novo workspace (a resolução
  local funciona via `paths` do tsconfig).
- Sem `screen` global nem `userEvent` separado (o `fireEvent` já usa entrada nativa realista).

## Próximos passos

- Rodar `bun install` para registrar o workspace no lockfile e adicionar `test:testing-library`
  (ou incluir `packages/test` em `test:headless`) nos scripts/CI.
- Verificar e cobrir execução em Node com um teste de fumaça.
- `screen` global, `userEvent` com sequência completa de teclas/modificadores, `fireEvent.drag`,
  `paste` e queries `ByTitle`/`ByAltText` quando o core expuser esses metadados.
- Filtro `hidden`/visível por layout (usar `inspect` para excluir nós fora da tela).
- Adicionar `verify:pack` como em `@tarve/headless`.
