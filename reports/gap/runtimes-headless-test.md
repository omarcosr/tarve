# @tarve/headless e @tarve/test em Bun, Node.js e txiki.js

Escopo: `packages/headless` (renderizador WebAssembly) e `packages/test` (API estilo Testing Library).
Regra: o que passa no Bun passa no Node.js 26.10+ e no txiki.js, salvo limite real do runtime,
que lança um erro claro e fica documentado.

## O que era exclusivo do Bun

| Onde | Problema | Efeito fora do Bun |
|---|---|---|
| `headless/src/runtime.ts` | `await import(caminhoAbsoluto)` da cola wasm-bindgen | Node.js: `ERR_UNSUPPORTED_ESM_URL_SCHEME` no Windows (`a:`), com caminho de disco em vez de URL |
| `headless/src/runtime.ts` | Wasm e fontes lidos por `fileURLToPath(new URL(…, import.meta.url))` | Num bundle (Node.js via `tarve run`, executável txiki.js) os arquivos não existem ao lado do bundle; `node:url` nem tem shim no txiki.js (o build falharia) |
| `headless/scripts/build-wasm.ts` | Só a build com `+simd128` | txiki.js (WAMR, sem SIMD): `CompileError: v128 value type requires simd feature` |
| `test/src/render.test.tsx`, `headless/src/headless.test.tsx` | `bun:test`, `import.meta.dir`, `Bun.serve`/`Bun.sleep` | Só rodam no `bun test` (continuam sendo testes do Bun; a paridade vem dos cenários abaixo) |
| `test/README.md` | Sugeria `node --import tsx --test` | Não é o caminho da Tarve para TSX no Node.js; trocado por `tarve run --runtime node` |

O resto já era neutro: `bridge.ts`, `index.ts`, `png.ts`, `tree.ts` e todo `packages/test/src` usam só
`node:fs`, `node:path`, `node:zlib`, `fetch`, `performance`, `queueMicrotask` e `Buffer`. O
`@tarve/test` não depende de `bun:test`: consultas e eventos lançam `Error` comum, `waitFor` usa o
próprio timer, `toMatchImageSnapshot` é função que lança; `tarveMatchers` é só um adaptador para
`expect.extend`.

## Correções

- **Arquivos via `import … with { type: "file" }`** (`runtime.ts`): o mecanismo que a Tarve já
  resolve em todo runtime — o Bun devolve o caminho, o bundle Node.js (`fileImportAttributes`,
  `packages/core/esbuild-file-imports.ts`) copia o arquivo ao lado, o build txiki.js
  (`bundleQuickJs`) embute e extrai. A cola wasm-bindgen é importada por especificador literal,
  então os bundlers a incluem. `src/wasm.d.ts` tipa a saída de build ainda inexistente (o CI roda
  `bun run check` sem `build:wasm`).
- **Duas builds wasm, escolhidas por detecção de recurso** (`build-wasm.ts`, `runtime.ts`): `simd`
  (como antes) e `baseline` (sem SIMD, em `wasm/baseline/`, com `--target-dir` próprio).
  `WebAssembly.validate` de um módulo mínimo com `v128` decide — não há ramo por nome de runtime.
  Medido: a baseline pinta ~2× mais devagar (30 quadros 800×600@2x: 106–113 ms vs 213–224 ms no
  Bun), por isso o SIMD continua padrão onde existe. `HeadlessRuntime.build` informa qual roda.
  Erro de carga vira `could not load the <build> WebAssembly runtime … bun run build:wasm` com `cause`.
- `verify-pack.ts` exige os arquivos da baseline; `engines` de ambos os pacotes inclui
  `"node": ">=26.10.0"`.
- **Cenários compartilhados** (`packages/test/smoke/scenarios.tsx`): pixels em escala, contador +
  clique por hit testing, digitação com rótulo/`{Enter}`/clear, consultas por papel e estado,
  snapshot PNG contra `__snapshots__/counter.png` e falha de um quadro alterado. Asserções são
  `throw` simples (o txiki.js não tem `node:assert` nem runner). Executores finos, sem lógica
  duplicada: `scenarios.test.ts` (`node:test`, roda igual no `bun test` e no `node --test`) e
  `txiki.ts` (laço + relatório JSON). `render.test.tsx` passou a importar o `Counter` dali.
- **Smoke** `scripts/smoke-headless-runtimes.ts`: Node.js via `runNode(…, ["--test"])` (o mesmo
  `tarve run --runtime node`), txiki.js via `buildTxiki` (o mesmo `tarve build --runtime txiki`).
  No txiki.js exige: build `baseline`; todos os cenários passam, exceto os listados em
  `TXIKI_LIMITS`, que devem falhar com exatamente o erro documentado (se passarem, o smoke falha
  pedindo para remover o limite); e o SHA-256 do RGBA do quadro do contador igual ao do
  `counter.png` decodificado no Bun.
- Ligações: `smoke:headless-runtimes` (raiz: `build:native && build:wasm && …`), `test:headless`
  agora inclui `packages/test`, passo em `scripts/verify.ts` após `smoke:txiki-shims`, e o job
  Windows do CI (que roda o verify) ganhou o alvo `wasm32-unknown-unknown` e o `wasm-bindgen-cli`.
  `packages/test/package.json`: scripts `test` e `smoke:runtimes`.
- READMEs: seção *Runtimes* (headless) e *Test runners and runtimes* (test).

## Resultados

| Verificação | Resultado |
|---|---|
| `bun test packages/headless packages/test` | 25 pass, 0 fail |
| Node.js 26.10.0, `node --test` (bundle) | 5/5 cenários, incluindo o snapshot PNG |
| txiki.js 26.6.0, executável | 4/5; o snapshot PNG falha com o erro documentado; quadro RGBA idêntico ao `counter.png` |
| `bun run check` | Passa |
| Baseline sob `bun test` (cópia em `work/`) | 9/9 testes do headless, inclusive o snapshot com tolerância zero: pixels idênticos aos da build SIMD |

## Limites reais

1. **txiki.js: sem WebAssembly SIMD.** O WAMR do txiki.js 26.6 recusa `v128`. Resolvido com a
   build `baseline` (mesmos pixels, pintura ~2× mais lenta). Não é mais limite funcional.
2. **txiki.js: sem zlib síncrono.** Só há `CompressionStream` assíncrono; o shim
   `packages/core/txiki/shims/zlib.ts` lança `zlib.deflateSync is not available in the Tarve
   txiki.js runtime` (e `inflateSync`). Logo `png()`, `snapshot()`, `renderToPng`, `encodePng`,
   `capture`, `matchImageSnapshot`/`toMatchImageSnapshot` e `readPngRgba` não funcionam lá.
   Renderização, entrada, `inspect`, `pixels()`/`renderToRgba` e `compareRgbaImages` funcionam.
   Documentado nos dois READMEs e cobrado pelo smoke.
3. **txiki.js: sem test runner nem `node:assert`.** Testes viram um script que lança na falha
   (como `smoke/txiki.ts`).

## Observações

- Os artefatos em `packages/headless/wasm/` são saída de build (ignorados pelo git). O
  `native/src` da árvore de trabalho hoje **não compila para wasm32** (trabalho em andamento de
  outra aba: `src/glass/cpu.rs` usa `crate::cpu_display`, que é `cfg(not(wasm32))`), então
  `bun run build:wasm` falha agora. A `wasm/baseline/` local foi gerada do `native` do `HEAD`
  (`git archive HEAD native`, compilado em `work/`), com o mesmo comando do `build-wasm.ts`; a
  build `simd` local é a anterior. Por isso o smoke foi rodado direto
  (`bun scripts/smoke-headless-runtimes.ts`), não via `bun run smoke:headless-runtimes`.
- `runNode` e `buildTxiki` exigem a biblioteca nativa (variável `TARVE_NATIVE`, embutida no
  executável) mesmo quando o app só usa o headless; por isso o script do smoke começa com
  `build:native`.
- `package.json`, `scripts/verify.ts` e `ci.yml` pertenciam à aba bg-14, já concluída; as edições
  são de uma linha/bloco em regiões separadas.

## Atualização: zlib síncrono no txiki.js (limite 2 removido)

O limite 2 não era genuíno: o host QuickJS do Android já tinha zlib síncrono via miniz_oxide. Agora
os três caminhos usam a mesma função Rust.

- **Rust compartilhado:** `native/src/zlib.rs` (`deflate(data, level)`, `inflate(data)`) sobre
  miniz_oxide 0.8, que virou dependência de todos os alvos em `native/Cargo.toml` (antes só
  Android; já estava no lock pelo crate `png`). `android/qjs.rs` (`host.zlib`) passou a chamar essas
  funções.
- **C ABI (apps txiki.js no desktop):** `tarve_zlib_deflate(level, in, len, out, cap)` e
  `tarve_zlib_inflate(in, len, out, cap)` em `native/src/bridge/entry_points.rs`, com a convenção
  das outras exportações: retorno = bytes copiados; `< -1` = capacidade necessária (nada escrito);
  `-1` = erro em `tarve_last_error`. `ABI_VERSION` **não** mudou: as exportações são aditivas, o
  `binding.ts` não as declara e a política (`release-policy.ts`, `native-runtime.test.ts`) só
  compara as versões TS/Rust.
- **Shim:** `packages/core/txiki/shims/zlib.ts` abre a biblioteca nativa (`nativePath()`, a mesma
  que o prelude extrai) via `tjs:ffi` na primeira chamada; `deflateSync`/`inflateSync` funcionam e
  produzem os mesmos bytes do Node (checado em `scripts/txiki-shims-entry.ts`, check `zlib`).
  `gzipSync`/`gunzipSync` vieram depois (`zlib::gzip`/`gunzip`, `tarve_zlib_gzip`/`tarve_zlib_gunzip`,
  `host.zlib("gzip"|"gunzip")` no Android) com os mesmos bytes do Node — ver
  [runtimes-parity.md](runtimes-parity.md).
- **@tarve/headless:** o wasm exporta `deflate`/`inflate` (`native/src/web.rs`), expostos em
  `HeadlessRuntime.zlib`. `src/png.ts` usa `headlessRuntime().zlib.deflate` em **todo** runtime:
  um único caminho, sem ramificação por runtime e sem mapeamento especial de `node:zlib` na build
  txiki (essa variante exigiria o `txiki-build.ts` saber se o app usa o headless). O
  `matchImageSnapshot` agora aguarda `loadHeadlessRuntime()` antes de codificar. A leitura do PNG
  guardado continua no `readPngRgba` do core (`node:zlib`), que no txiki.js é servido pelo shim
  acima: todo executável txiki.js embute `tarve_native` (`buildTxiki` sempre embute).
- **Docs/smoke:** limite removido de `packages/headless/README.md` e `packages/test/README.md`;
  `TXIKI_LIMITS` removido de `scripts/smoke-headless-runtimes.ts` (qualquer falha de cenário no
  txiki.js reprova); comentário de `packages/test/smoke/txiki.ts` atualizado.

### Verificação

- `cargo clippy --manifest-path native/Cargo.toml --all-targets -- -D warnings`: ok (só os avisos
  já existentes dos crates vendorizados vello/vello_encoding).
- `cargo test --lib zlib`: 2 testes ok.
- `bun run build:wasm`: ok (simd e baseline exportam `deflate`/`inflate`).
- `bun run smoke:headless-runtimes`: **PASS** — Node.js 5/5 e txiki.js 5/5 (inclui
  “snapshot: PNG bytes, and the frame matches the stored image”), frames idênticos ao `counter.png`.
- `bun run smoke:txiki-shims`: PASS, com o novo check `zlib`.
- `bun test packages`: 651 pass, 0 fail (inclui o novo teste de interoperabilidade do zlib do wasm
  com `node:zlib` em `headless.test.tsx`).
- `bun run check`: ok.
- `bun scripts/build-android.ts --abi arm64-v8a`: ok (`libtarve_native.so`, 19,7 MiB).
- `bun run smoke:txiki-apps`: **falha, sem relação com zlib.** O script apontava para
  `examples/node_modules/@tarve/core/dist/npm/cli.js`, que `setup-examples.ts` não instala mais;
  corrigido para `packages/core/cli.ts` (e a mensagem de falha de build agora mostra a linha de
  erro, não o progresso do cargo). Com isso, todos os exemplos falham no build txiki porque
  `packages/core/src/updates.ts` importa `accessSync`, `closeSync`, `constants`… de `node:fs`, que
  o shim `fs` do txiki.js não tem (o `app.inspect()`/`onEvent` da sonda alcança esse módulo). É uma
  lacuna separada do shim `fs`, a tratar à parte.
