# Tarve — fechamento de gap vs. frameworks multiplataforma

Relatório mestre. Cada frente tem seu relatório em `reports/gap/<frente>.md`, atualizado pelo agente responsável.

## Ondas

| # | Frente | Pacote/arquivos | Status | Relatório |
|---|--------|-----------------|--------|-----------|
| 1 | Navegação / rotas | `packages/router` (novo) | ✅ 28 testes, Node ok | [router.md](router.md) |
| 2 | Testes para usuários | `packages/test` (novo, sobre `@tarve/headless`) | ✅ 20 testes (test + headless) | [test.md](test.md) |
| 3 | Scaffolding | `packages/create-tarve` (novo): basic, tailwind, svelte, tray | ✅ 18 testes; fluxo publicado via npm não testado | [create.md](create.md) |
| 4 | Empacotamento (.deb, tar.gz, zip, MSIX) | `tarve package`, `packages/core/package-installer.ts` | ✅ testes de estrutura | [packaging.md](packaging.md) |
| 5 | macOS / iOS | `scripts/check-apple.ts` | ✅ M0: `native/` compila para macOS arm64+x64; iOS bloqueado por SDK | [apple.md](apple.md) |

Verificação conjunta: `bun test packages/router packages/test packages/headless packages/core/package-installer.test.ts` → 57 pass / 0 fail; `bun run check` limpo.

## Onda 2 (em andamento)

| # | Frente | Status | Relatório |
|---|--------|--------|-----------|
| 6 | macOS lado TS: alvos `darwin-*`, bundle `.app`, `.icns`, codesign/notarização, Mach-O no updater | ✅ 67 testes; nada executado/assinado em Mac real | [macos-ts.md](macos-ts.md) |
| 7 | Deep links + associação de arquivos (Win registro/MSIX, Linux .desktop, Android) | ✅ 88 testes; Android abre o app mas a URL ainda não chega ao JS (precisa de nativo) | [deeplinks.md](deeplinks.md) |
| 8 | Inspetor visual (devtools): `tarve dev --inspect` | ✅ 11 testes + smoke em janela real | [devtools.md](devtools.md) |

## Onda 3 (em andamento)

Liberação: as 7 abas (Android support, Android support status, Android, Android fluidez, Go-TS, PR avaliação, Code Cleanup) terminaram e liberaram `native/src/android*` e `native/src/runtime*`, com a condição de preservar os hunks não commitados (nada de stash/reset/checkout), rodar `bun run smoke:idle` se mexer no event loop ocioso e `cargo test --release --lib` se mexer em `graphics_startup.rs`.

| # | Frente | Status | Relatório |
|---|--------|--------|-----------|
| 9 | Android nativo: URL do deep link → JS, share sheet, geolocalização, biometria (FCM só plano) | ✅ ponta a ponta no emulador x86_64 (deep link frio/quente, `content://`, share, GPS, biometria); Windows via WinRT compila, não executado; Linux `{supported:false}`; protocolo 59→60 | [android-apis.md](android-apis.md) |
| 10 | CI macOS (GitHub Actions `macos-14`/`macos-13`) + gate `check:apple` | ✅ `.github/workflows/macos.yml` (gate zig no Ubuntu, matriz arm64/x64, assinatura condicionada a secrets); YAML válido, ainda não rodou no GitHub | [macos-ci.md](macos-ci.md) |
| 11 | API de plugins (`definePlugin`, descoberta, FFI, embutir no build) | ✅ Bun + Node (`node:ffi`); build/package embutem libs nativas (Bun, verificado no Windows); exemplo `examples/plugin-hello` | [plugins.md](plugins.md) |

## Verificação final (onda 3)

- `bun test packages`: 641 pass / 0 fail (corrigido `packages/core/build.test.ts`, que ainda assumia só Windows/Linux após a adição dos alvos darwin).
- `bun run check`: limpo.
- `cargo clippy --all-targets -- -D warnings`: limpo.

## Onda 4 — paridade entre runtimes TypeScript (concluída)

Regra: o que passa no Bun deve passar no Node.js 26.10+ e no txiki.js/QuickJS, salvo recurso realmente não suportado (erro claro + documentação). Sem gambiarras.

Auditoria inicial: só `@tarve/router` e `create-tarve` declaram Node em `engines`; `@tarve/headless` e `@tarve/test` declaram só Bun e os testes usam `bun:test`; o embutimento de libs de plugin no build só existe no caminho Bun.

| # | Frente | Status | Relatório |
|---|--------|--------|-----------|
| 12 | `@tarve/headless` + `@tarve/test` em Node e txiki; API independente de test runner | ✅ 5/5 cenários em Node **e** txiki (PNG via `native/src/zlib.rs` compartilhado: export C ABI, wasm e host Android); `build:wasm` corrigido (`glass::cpu` sem gate wasm) | [runtimes-headless-test.md](runtimes-headless-test.md) |
| 13 | Paridade das features novas (router, inspetor, deep links, device APIs, plugins/FFI) em node, node-c, txiki, txiki-c, bun-c | ✅ 5 cenários × 5 variantes iguais ao Bun (`smoke:runtime-parity`); build Node/txiki embute libs de plugin; txiki ganhou servidor de pipe (`net`) e `spawnSync`; `TARVE_INSPECT` do inspetor renomeado para `TARVE_INSPECTOR` (colidia com a automação); nomes de função preservados nos builds minificados | [runtimes-parity.md](runtimes-parity.md) |
| 14 | CLI sob `npx tarve` (package, bundle macOS, plugins-build) + `create-tarve` no Node | ✅ nenhum caminho do `npx tarve` usava API só do Bun; nova smoke Node de `tarve package` (`scripts/smoke-node-cli-package.ts`, no `verify` e CI); `create-tarve` gera projetos idênticos em Node e Bun | [runtimes-cli.md](runtimes-cli.md) |

| 16 | txiki: `spawnSync` no Linux (WSL), `unref()` sem internals, `gzipSync`/`gunzipSync`, `smoke:txiki-apps` (fs em `updates.ts`), paridade completa Win+Linux | ✅ 21 entries × 5 variantes iguais ao Bun no Windows e no Linux (WSL); `smoke-txiki-shims` e `smoke:txiki-apps` passam nos dois; limites reais: `server.unref()` e abort de `fetch` durante o connect TCP no txiki | [runtimes-parity.md](runtimes-parity.md) |

## Verificação final (onda 4)

- `bun run smoke:runtime-parity`: 21 entries × 5 variantes (node, node-c, txiki, txiki-c, bun-c) iguais ao Bun no Windows e no Linux (WSL).
- `bun run smoke:headless-runtimes`: Node e txiki passam todos os cenários, quadros idênticos.
- `bun test packages examples/plugin-hello`: 653/654; a falha (`Node dev remounts the same window…`) passa isolada → instável sob carga, não regressão.
- `bun run check` e `cargo clippy --all-targets -D warnings`: limpos.

## Próximas ondas (não iniciadas)

- Push (FCM/APNs): precisa de projeto Firebase e credenciais; plano em android-apis.md.
- macOS M1–M3 nativo (precisa de runner macOS).

## Regras

- `native/src/android*` e `native/src/runtime*` liberados pelas abas Android; preservar hunks não commitados (sem stash/reset/checkout), rodar `bun run smoke:idle` ao mexer no event loop ocioso.
- Não alterar `scripts/setup-examples.ts`.
- Bun + Node.js suportados em todo pacote novo.
