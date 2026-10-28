# Bun e `keepNames`: minificação de identificadores sem perder nomes de componentes

## Problema

O Bun 1.4.3 ignora `keepNames` (tanto em `Bun.build` — opção de topo ou dentro de `minify` — quanto em
`bun build --keep-names`). Para o inspector continuar mostrando `<Counter>`, `packages/core/build.ts`
compilava apps Bun com `minify: { whitespace, syntax, identifiers: false }`, e o bundle JS cresceu.

## (a) O Bun atual honra `keepNames`?

Não. Teste mínimo (`function MyComponent(){}` e `const Arrow = () => 2`, imprimindo `.name`):

| Bun | `Bun.build({ minify: true, keepNames: true })` | `minify: { identifiers: true, keepNames: true }` | `bun build --minify --keep-names` |
|---|---|---|---|
| 1.4.3 (instalado) | `n.name, o.name` (renomeado) | renomeado | renomeado |
| 1.4.4 (última no npm) | — | — | renomeado |

## Medições do bundle JS (bytes, mesmos plugins de framework, `NODE_ENV=production`)

| exemplo | Bun `identifiers:false` (antes) | Bun `identifiers:true` (nomes perdidos) | por arquivo: esbuild `transform` keepNames + Bun | **esbuild bundle keepNames → Bun (escolhido)** |
|---|---|---|---|---|
| basic | 297 760 (gz 89 518) | 223 469 (gz 77 948) | 369 461 | **232 938 (gz 82 749)** −21,8% |
| studio | 1 268 979 (gz 277 656) | 872 268 (gz 240 259) | — | **931 648 (gz 260 940)** −26,6% |
| youtube-music | 375 868 (gz 111 048) | 282 941 (gz 97 415) | — | **294 464 (gz 103 265)** −21,7% |

(studio inclui o JS do `esbuild`, que o Bun empacota como antes.)

## Executável Bun (Windows x64, `tarve build --runtime bun`)

| exemplo | antes | depois | diferença |
|---|---|---|---|
| basic | 101 083 648 | 101 028 352 | −55 296 |
| studio | 103 277 056 | 102 961 664 | −315 392 |
| youtube-music | 102 521 856 | 102 427 648 | −94 208 |

O runtime do Bun domina o executável (~100 MB); o ganho real está no JS que é analisado a cada
inicialização (−22% a −27%).

## Opções avaliadas

- **(a) Atualizar o Bun**: 1.4.4 continua ignorando `keepNames`. Descartada.
- **(b) `displayName` em tempo de compilação**: uma heurística PascalCase cobriria só componentes
  do app (não os do core nem de `node_modules`) e divergiria da semântica `keepNames` de Node/txiki.
  A variante robusta — `esbuild.transform({ keepNames })` por arquivo num plugin do Bun — *aumentou*
  o bundle (basic 369 KB): cada módulo ganha o helper `__name`, e as chamadas `__name(Foo, "Foo")`
  soltas são efeitos colaterais para o Bun, que deixa de eliminar código morto. Descartada.
- **(c) Pré-bundle com esbuild `keepNames`, depois `bun build --compile`**: o esbuild conhece suas
  próprias chamadas `__name` (tree-shaking intacto, um único helper); o Bun minifica o resultado e os
  nomes sobrevivem porque estão em strings. É o mesmo bundler e as mesmas opções (`keepNames`,
  `jsx: automatic`, `jsxImportSource: @tarve/core`) dos executáveis Node.js e txiki.js e dos app packs,
  então os três runtimes têm a mesma regra de nomes. **Escolhida.**

## Implementação

- `packages/core/bun-prebundle.ts` (novo): `prebundleForBun()` empacota a entrada (ou o host de pack)
  com esbuild — `minify`, `keepNames`, `conditions: ["bun"]`, plugins de framework, `--compile-jsx` e
  o mapeamento `tarve`/`@tarve/core` → `src` no checkout do repositório. O que o esbuild não carrega
  fica como import com caminho absoluto para o Bun resolver e embutir exatamente como antes:
  arquivos não-script (imagens, `.txt`, `.wasm`, `.node`, CSS…), qualquer import com `with { type }`,
  `bun`/`bun:*`, `#tarve/runtime` e `esbuild` (cuja API localiza o próprio binário e não pode ser
  empacotada pelo esbuild).
- `packages/core/build.ts`: o `Bun.build` compila esse único módulo com `minify: true` e só o plugin
  `tarve-native-runtime`; o mapeamento `tarve` → `src` e o `--compile-jsx` saíram do plugin do Bun
  (agora no pré-bundle).

## Verificação

- `bun run smoke:runtime-parity inspector basic`: `inspector` e `basic` ok nas 5 variantes
  (node, node-c, txiki, txiki-c, bun-c); `tree: true` confirma `<Counter>` no inspector do Bun.
- `bun run smoke:pack`: ok (bun e node) — o host de pack também passa pelo pré-bundle.
- `bun test packages/core`: 557 pass, 0 fail.
- `bun run check`, `bun run check:lines`: ok.
