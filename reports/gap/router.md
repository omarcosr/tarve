# @tarve/router — relatório de progresso

## O que foi feito

Novo pacote de workspace `packages/router` (`@tarve/router` 0.7.0, `peerDependencies: @tarve/core ^0.7.0`, mesmo formato de `packages/headless/package.json`, `exports: "./src/index.ts"`).

| Arquivo | Conteúdo |
| --- | --- |
| `src/path.ts` | Padrões de caminho: `:param`, `:param?`, `*` (splat final), `PathParams<P>` (tipos via template literal), `matchPath` com backtracking, `buildPath` com encoding, `parseLocation` (query/hash), ranking (estático > param > opcional, splat por último). Sem imports. |
| `src/stack.ts` | `createStackRouter` e `route()` (helper que tipa as props da tela a partir do path). |
| `src/tabs.ts` | `createTabRouter`: uma pilha por aba, histórico de abas, `navigate` que encontra a aba dona do caminho. |
| `src/view.ts` | `<RouterView>`, `<TabRouterView>`, `<TabBar>`, `<Link to>` (alias `RouterLink`), feitos com `View`, `Row`, `Pressable`, `Text`, `AnimatePresence` e `theme` do core. |
| `src/context.ts` | `useRoute()`, `useParams()`, `useRouter()`, `useStack()`. |
| `src/back.ts` | Integração com o botão voltar: `attachBack`, `closeRequestBack`, `requestRender`. Sem imports. |
| `src/types.ts` | `Route`, `Navigator`, `RouteChange`, `RouterTransition`, `resolveTransition`. |
| `scripts/node-smoke.ts` | Empacota um script com esbuild (como faz `tarve run --runtime node`) e roda no `node`. |
| `README.md` | Documentação do pacote. |
| `examples/router/router.tsx` | Exemplo: abas (People/Settings), pilha com transição slide, `useRoute`, `Link`, TitleBar com voltar, Android back. |

Outras edições (fora do pacote): uma entrada `@tarve/router` em `paths` do `tsconfig.json` raiz e do `examples/tsconfig.json`; script `"router"` em `examples/package.json`.

**Nenhuma edição em `packages/core`, `native/src` ou `scripts/setup-examples.ts`.**

## Modelo de re-render (como foi integrado)

O Tarve não tem hooks/estado reativo: o estado é variável comum, e o app renderiza de novo depois de cada handler de evento (`onClick`, hotkey, `onEscape`, `onCloseRequest`…) ou quando se chama `app.update()` (agendado em microtask). O roteador:

- guarda a pilha em variáveis próprias; navegações dentro de handlers renderizam sozinhas;
- fora de handlers (timer, fetch), chama `app.update()` dos apps registrados com `router.attach(app)`; sem `attach`, chama o `update()` do app ativo global (`Symbol.for("tarve.activeApp")`, o mesmo símbolo usado em `packages/core/src/menu-bar.ts`);
- `useRoute()`: o Tarve não tem contexto de componentes, mas o reconciliador expande componentes em profundidade e em ordem. O `RouterView` coloca dois componentes vazios (`ScopeStart`/`ScopeEnd`, que retornam `Fragment` vazio) antes e depois da tela; assim, durante a renderização da subárvore da tela, `useRoute()` lê a rota daquela tela (inclusive de telas saindo em transição). Fora de um `RouterView`, cai no último roteador criado.

## API

```ts
const router = createStackRouter({
  routes: { home: route("/", Home), user: route("/users/:id", User), notFound: route("*", NotFound) },
  initial?: "/" | "home", transition?: "none" | "fade" | "slide" | { push, pop?, transition? },
  backOnCloseRequest?: "android" | "always" | false, onChange?, id?,
});
router.push("user", { id: "42" }, { state?, query? });   // params tipados; obrigatórios só se o path tiver :param
router.replace(...); router.pop(n?); router.popToRoot(); router.back(); router.canGoBack(); router.reset(path?);
router.navigate("/users/42?tab=posts", { replace? });     // Route | undefined
router.route / router.stack / router.lastChange / router.href(name, params) / router.match(path) / router.title()
router.subscribe(fn); router.attach(app, { hotkeys?, mouseBack? }); router.onCloseRequest; router.invalidate();

const tabs = createTabRouter({ tabs: { feed: { title, icon?, routes, initial? }, ... },
  initialTab?, backBehavior?: "initialTab" | "history" | "none", reselectToRoot?, transition? });
tabs.select("feed"); tabs.stack("feed").push(...); tabs.current; tabs.active; tabs.navigate(path, { tab? }); tabs.back();

<RouterView router={router|tabs} backOnEscape? transition? />
<TabRouterView router={tabs} placement="bottom"|"top" />   <TabBar router={tabs} />
<Link to="/users/42" replace? state? router? />
useRoute<Route<"user", { id: string }>>(); useParams(); useRouter(); useStack();
```

## Voltar (back)

Investigado em `packages/core/src`, `packages/protocol/src` e (só leitura) `native/src`:

- **Escape**: o nativo emite `{ type: "escape" }` quando nenhum nó tratou a tecla; o core entrega ao último handler `onEscape` da árvore. O `RouterView` coloca `onEscape` no seu contêiner só enquanto `canGoBack()` — popups/diálogos que vêm depois na árvore continuam tendo prioridade, e na raiz o Escape fica livre.
- **Alt+Left**: `app.registerHotkey("Alt+Left")` (o nativo emite `shortcut` `Alt+ArrowLeft`), feito por `router.attach(app)`.
- **Botão voltar do mouse**: o nativo mapeia `MouseButton::Back` para `button: 3` em eventos `pointer`, que só são enviados com `createApp(view, { pointerEvents: true })`. `attach` escuta `app.onEvent` (`phase: "up"`).
- **Android (tecla voltar)**: `native/src/runtime/android_input.rs` converte `BrowserBack` em pedido de fechamento da janela ("`onCloseRequest` may keep it"). Não existe evento "back" próprio no core/protocolo. Por isso o roteador expõe `router.onCloseRequest`, para `<Window onCloseRequest={router.onCloseRequest}>`: no Android, se puder voltar, faz `pop` e `preventDefault()`; no desktop, por padrão, não interfere no botão fechar.

## Transições

Usam o motor de motion nativo existente (`MotionTransition`/`MotionValues` do protocolo): a tela que entra é envolvida em `AnimatePresence` (`present`, `enter` → `motionFrom`), a que sai é renderizada com `present: false` e os valores de `exit` até o nativo terminar as transições (`motionComplete`). Telas ficam em quadros `position: absolute` com `left/right/top/bottom: 0` e `opacity: 1` numéricos (o necessário para o motion animar `left`/`right`/`opacity`). Predefinições: `"fade"` (opacity) e `"slide"` (left/right ±48 + opacity, espelhado no `pop`), 220 ms `easeOut`; ou valores próprios.

## Testes executados

- `bun test packages/router` → **28 pass, 0 fail** (139 `expect`), 4 arquivos:
  - `path.test.ts` (6): matching, encoding, query, ranking, erros, tipos de `PathParams` (`@ts-expect-error`).
  - `stack.test.ts` (10): push/replace/pop/popToRoot/reset, navigate com query e catch-all, href/match, subscribe/invalidate, Alt+Left e botão do mouse com app falso, `onCloseRequest`, `useRoute` com escopo, tipagem dos params.
  - `tabs.test.ts` (8): pilhas por aba, reselect, navigate entre abas, back (initialTab/history/none), eventos, tipagem.
  - `view.test.tsx` (4, com `@tarve/headless`/WASM): `Link` → tela com params/query via `useRoute`, Escape volta; navegação fora de handler renderiza; transição slide anima (`advanceMotion`) e remove a tela antiga ao fim; `TabRouterView` troca abas mantendo pilhas, Escape volta e retorna à aba inicial.
- `bun run check` (tsc do repo + checks) → **ok**.
- `tsc --noEmit -p examples/tsconfig.json` → **ok** (exemplo tipado).
- `bun packages/router/scripts/node-smoke.ts` → **"router ok on node v26.10.0"** (bundle esbuild + `node`).
- `bun examples/router/router.tsx` abriu sem erros (processo encerrado após 10 s; sem verificação visual).

## Limitações

- `useRoute()` depende da ordem de expansão do reconciliador; componentes renderizados fora dessa passada (subárvores `memo` não re-renderizadas não chamam nada, então não é problema; mas listas virtuais/portais renderizados depois podem ver o roteador padrão). Handlers devem usar o valor lido na renderização.
- Telas fora do topo não ficam montadas: o estado local de cada tela (ex.: rolagem) se perde ao empilhar/voltar; as pilhas das abas são preservadas, mas não as telas montadas.
- Só a última mudança é animada; navegações muito rápidas cortam a saída da anterior. Não há transição entre abas. Não respeita "reduzir movimento" automaticamente.
- Android: a tecla voltar chega como pedido de fechamento; o usuário precisa ligar `onCloseRequest` na `Window`. Não há evento "back" dedicado no core.
- Botão voltar do mouse exige `pointerEvents: true` no `createApp` (que envia todos os eventos de ponteiro ao JS).
- `:param?` só no fim do caminho é inequívoco (há backtracking, mas a especificidade é heurística). Sem rotas aninhadas/layouts, sem guards/redirects assíncronos, sem deep link automático (`registerUrlScheme` + `router.navigate` fica a cargo do app).
- Node.js: o pacote exporta fontes `.ts` com imports sem extensão (como `@tarve/headless`); no Node é usado via bundle (`tarve run --runtime node`), não via type stripping direto.
- Não há script `test:router` no `package.json` raiz (arquivo editado por outro agente); rodar `bun test packages/router`.

## Próximos passos

1. Evento `back` nativo dedicado (Android `BrowserBack`, `XButton1` e `AppCommand` no Windows) no protocolo/core, para não depender de `onCloseRequest`/`pointerEvents`.
2. Contexto de renderização oficial no core (ex.: `scopedState` público por subárvore) para substituir os marcadores de escopo.
3. Manter telas da pilha montadas e ocultas (opção `keepAlive`), preservando rolagem e estado.
4. Rotas aninhadas/layouts, guards (`beforeLeave`), redirects e integração com deep links (`registerUrlScheme`).
5. Transição entre abas e respeito a `prefers-reduced-motion` do ambiente.
6. Adicionar `test:router` e o pacote ao fluxo de publicação (`scripts/pack.ts`/release policy).
