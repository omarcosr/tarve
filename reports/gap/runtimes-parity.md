# Paridade entre runtimes das features novas (router, inspetor, deep links, device APIs, plugins)

Status: **✅ todas as features novas e as 16 views genéricas passam igual ao Bun em node, node-c, txiki, txiki-c e bun-c, no Windows x64 e no Linux x64 (WSL2 + WSLg)** — Node 26.10.0, txiki.js 26.6.0, Bun 1.4.3 (Windows) / 1.4.4 (Linux). Pendências da primeira rodada (`spawnSync` no Linux, `unref()` por internals, gzip, `smoke:txiki-apps`) resolvidas na [rodada 2](#rodada-2-linux-sem-internals-gzip-e-fs-do-updater).

## Como é verificado

O harness existente `scripts/smoke-runtime-parity.ts` (sem harness paralelo) ganhou cenários de feature em `scripts/runtime-parity-scenarios.ts`:

- `PROLOGUE` compartilhado por todas as entries: `settle` (primeiros frames), `stage` (árvore de nós + captura PNG por etapa), `click`, `byText`, `parity` (grava o relatório `{ errors, stages, result }` e fecha o app).
- `viewEntry(view)`: a passada genérica de antes (hover, cliques, digitação, Tab, wheel), agora no mesmo formato de etapas.
- `SCENARIOS`: cada cenário dirige uma feature e devolve um `result` que precisa ser **igual ao do Bun**; `result.runtime` (o que legitimamente varia por runtime, ex.: qual FFI abriu a lib) é conferido contra `Scenario.runtime(variant)`. Cenários podem ter `dir` (onde a entry é escrita), `args`, `env` e `prepare`.
- Cada etapa compara árvore de nós (ids, geometria, texto) e pixels com o Bun; relatório velho é apagado antes de cada execução (um crash não pode passar com o JSON da rodada anterior).

Rodar: `bun run smoke:runtime-parity router deep-link device plugin-hello inspector` (sem argumentos: as 16 views + os 5 cenários; `RUNTIME_PARITY_VARIANTS=node,txiki` para restringir).

### Cenários

| Cenário | O que exercita |
| --- | --- |
| `router` | `examples/router` (view separada em `router-view.tsx`; `router.tsx` só cria o app): `<Link>` empilha `/people/1`, botão "Next" empilha `/people/2`, **Escape** volta, "All people" faz `popToRoot`, troca de aba (Settings), `<Link>` dentro da aba, `tabs.back()` por código. 8 etapas com captura. |
| `deep-link` | App lançado com `tarvedemo://hello/world?x=1 note.tarvedemo` + `requestSingleInstance`: o argv chega a `onOpenUrl`/`onOpenFiles` (`initial: true`); depois o app relança a si mesmo (`process.execPath` + script quando é runtime) com outro link e arquivo → a segunda instância encaminha pelo pipe e sai (código 0), a primeira recebe `initial: false` e `onSecondInstance`. No Windows também `registerProtocol`/`registerFileType` de um esquema/tipo descartável, lidos de volta com `reg query` e removidos. |
| `device` | `share`/`authenticate`/`getCurrentPosition` com argumentos inválidos (mesmos erros), depois `share` real, `getCurrentPosition({timeoutMs:3000})`, `watchPosition` (primeira resposta) e `authenticate` (limite de 3 s → `"pending"` se um prompt esperar o usuário). Compara o **formato** (chaves, `supported`, `code`, `success`; coordenadas e texto do SO variam). |
| `plugin-hello` | Entry escrita **dentro** de `examples/plugin-hello` (a descoberta acha o plugin pelo package.json): `hello.client(app).add(40, 2)` = 42, `add(i32 max, 1)` = −2147483648 (wrapping), `info()`; `runtime` confere a FFI (`bun`/`node`/`txiki`) e que nos executáveis a lib veio do registro embutido pelo `tarve build`. `prepare` roda `cargo build --release` da cdylib. |
| `inspector` | `TARVE_INSPECTOR=1`: a janela do inspetor abre, árvore com `<Counter>`, contagem `×2`, nó selecionado (`h:bump`) com layout e "Style (resolved)"; captura das duas janelas. O log de eventos (horário de parede) é esvaziado antes da captura e comparado pela contagem. |

## Matriz feature × runtime (rodada 1, Windows)

Windows x64. "ok" = árvore, pixels e `result` idênticos ao Bun (e `runtime` como esperado). A matriz final, com o Linux, está na [rodada 2](#matriz-final-feature--runtime--so).

| Feature | node | node-c | txiki | txiki-c | bun-c |
| --- | --- | --- | --- | --- | --- |
| Router (push, Escape, pop, popToRoot, abas, back) | ok | ok | ok | ok | ok |
| Deep link: argv → `onOpenUrl`/`onOpenFiles` | ok | ok | ok | ok | ok |
| Deep link: segunda instância encaminhada (`requestSingleInstance`) | ok | ok | ok¹ | ok¹ | ok |
| `registerProtocol` / `registerFileType` (Windows, HKCU) | ok | ok | ok² | ok² | ok |
| Device APIs (share, posição, watch, authenticate) — mesmo formato | ok | ok | ok | ok | ok |
| Plugin nativo via FFI (`hello_add`) | ok (`node:ffi`) | ok | ok (`tjs:ffi`) | ok | ok (`bun:ffi`) |
| Lib do plugin embutida no executável | ok³ | ok³ | ok³ | ok³ | ok |
| Inspetor (`TARVE_INSPECTOR=1`) | ok | ok⁴ | ok⁵ | ok⁴ ⁵ | ok⁴ ⁵ |
| Views genéricas (basic, forms; regressão do refactor) | ok | ok | ok | ok | ok |

1. Corrigido nesta frente: o shim `node:net` do txiki não tinha servidor. 2. Corrigido: o txiki não tinha `spawnSync`. 3. Novo: build Node/txiki embute. 4. Corrigido: templates do `--compile-jsx` apareciam como `<Template>`. 5. Corrigido: nomes de componentes minificados (`<He>`, `<Ee>`).

Resultado observado nesta máquina (igual em todas as variantes): `share` → `{supported:true}`; posição e watch → `{supported:true, position:{…8 campos}}`; `authenticate` → `{supported:false, code:"unsupported"}` (sem dispositivo Windows Hello).

### Genuinamente não suportado / pendente (rodada 1 — superado pela rodada 2)

- **txiki.js no Linux: `child_process.spawnSync`** — implementado só para Windows (CreateProcessW via `tjs:ffi`). No Linux lança erro claro ("not available in the Tarve txiki.js runtime on linux yet … build with --runtime bun or --runtime node"); afeta `registerFileType` (update-mime-database) e o updater sob txiki/Linux. Não é limite do runtime (dá para fazer com `posix_spawnp` via FFI, como o shim de `fs`), mas não pôde ser verificado neste host Windows, então ficou como pendência documentada em vez de código não testado.
- **`server.unref()` no txiki** depende do handle libuv interno do listener (símbolo `getHandle` das classes de socket do txiki; o txiki não expõe `unref` público). Executáveis fixam a versão do txiki com que foram compilados (o build já confere o trailer do `tjs compile`); se uma versão não tiver o handle, `unref()` lança erro claro em vez de manter o processo vivo.
- Linux/macOS/Android não foram executados aqui (matriz acima é Windows). O Go não carrega plugins (sem JS), como já documentado.

## Incompatibilidades encontradas e corrigidas (na raiz)

1. **Inspetor: `TARVE_INSPECT=1` colidia com a automação** (`packages/core/src/app/automation.ts` lê `TARVE_INSPECT=<arquivo>` como "grave a árvore de nós e feche o app"). `tarve dev --inspect` fechava o app e as janelas logo após abrir, em **todos** os runtimes (só não aparecia porque o smoke do inspetor usa `dev: { inspector: true }`). A variável do inspetor passou a ser **`TARVE_INSPECTOR=1`** (`src/app.ts`, `cli.ts`, `devtools/inspector.ts`, `reports/gap/devtools.md`); a da automação (já no CHANGELOG) ficou como estava.
2. **Nomes de função nos builds minificados.** O inspetor mostra `fn.displayName ?? fn.name`; o bundle txiki (esbuild `minify`) e o Bun (`minify: true`) trocavam `Counter` por `He`/`ku`. txiki: `keepNames: true` no esbuild (`txiki-build.ts`, vale também para o bundle QuickJS do Android). Bun: o Bun 1.4.3 **ignora** `minify.keepNames` (verificado: `function Counter` vira `o`), então o build Bun usa `minify: { whitespace, syntax, identifiers: false }` (`build.ts`). O build Node não minifica.
3. **`--compile-jsx` aparecia no inspetor como `<Template>`** — artefato do compilador que não existe no código do app. `devtools/trace.ts`: o frame do template continua sendo rastreado (reuso de memo intacto), mas não é contado nem mostrado; os componentes de dentro sobem para o pai (`withoutTemplates`). Testes do devtools: 11/11.
4. **`requestSingleInstance` não compilava para txiki**: `node:net` `connect`/`createServer` ausentes no shim. `packages/core/txiki/shims/net.ts` reescrito sobre `tjs.connect("pipe")`/`tjs.listen("pipe")` (named pipe no Windows, socket Unix no Linux): `Socket` (cliente ou conexão aceita; `write`, `end`, `setEncoding`, `destroy`, eventos `connect/data/end/error/close`), `Server` (`listen`, `close`, `unref`, evento `connection`), `connect`/`createConnection`/`createServer`. Tipagem de `tjs.listen` em `txiki/tjs.d.ts`. O wake pipe do bridge continua usando o mesmo `Socket`.
5. **`registerProtocol`/`registerFileType` (e o updater) não compilavam para txiki**: `spawnSync` ausente. Novo `packages/core/txiki/shims/child-process-sync.ts` (reexportado por `child-process.ts`): `CreateProcessW` via `tjs:ffi` (mesmo padrão do shim `fs` sobre o C runtime), stdin = `NUL`, stdout/stderr em arquivos temporários herdáveis lidos após a saída (sem deadlock de pipe cheio), `status`, `error.code` `ENOENT`/`ETIMEDOUT`, `encoding`, `cwd`, `env`, `windowsHide`, `timeout`. Os exemplos `deep-link`, `router` e `plugin-hello/demo` agora compilam com `--runtime txiki`.
6. **Libs nativas de plugin só eram embutidas no build Bun** (item 3 do pedido). `plugins-build.ts` ganhou `pluginNativesForBuild(entry, target)` (plano + aviso de plugins sem lib para o alvo, usado pelos três builds) e `pluginNativeModule(embeds, assetsModule)` (o mesmo registro "embedded" do Bun — `import x from "<lib>" with { type: "file" }` + `materializeAsset(x, nome, digest)` — com o próprio import de `materializeAsset`). `node-build.ts` anexa o módulo ao `#tarve/runtime` virtual (a lib vira asset do SEA pelo `fileImportAttributes` existente); `txiki-build.ts` anexa via novo `QuickJsFlavor.runtimeExtra` (o `#tarve/runtime` vira `export * from runtime.ts` + registro; a lib vai no blob do executável). Em todos, a lib é extraída uma vez para `%TEMP%/tarve-assets/<sha256>/` com conferência de digest. `build.ts` perdeu o aviso "does not embed yet". README e `reports/gap/plugins.md` atualizados.

Nada a corrigir em: FFI de plugin (`ffi.ts` já usava `createRequire` + `__tarveTxikiFfi`, que funcionam em ESM no Node SEA e no txiki), layout de `process.argv` (Bun compilado, Node SEA e txiki dão os mesmos `argv.slice(2)` — confirmado pelo cenário `deep-link`), `@tarve/router` (sem API de runtime), device APIs (mesmo protocolo nativo).

## Arquivos

| Arquivo | Mudança |
| --- | --- |
| `scripts/smoke-runtime-parity.ts` | etapas genéricas, cenários, `args`/`env`/`prepare`, `result`/`runtime`, relatório velho apagado, limpeza dos diretórios de entry |
| `scripts/runtime-parity-scenarios.ts` (novo) | `PROLOGUE`, `viewEntry`, `SCENARIOS` (router, deep-link, device, plugin-hello, inspector) |
| `examples/router/router-view.tsx` (novo), `examples/router/router.tsx` | view exportada (`App`, `tabs`); o entry só cria o app |
| `packages/core/plugins-build.ts`, `build.ts`, `node-build.ts`, `txiki-build.ts` | embutir libs de plugin nos 3 runtimes; nomes preservados na minificação |
| `packages/core/txiki/shims/net.ts`, `child-process.ts`, `child-process-sync.ts` (novo), `txiki/tjs.d.ts` | servidor de pipe, `spawnSync` |
| `packages/core/src/app.ts`, `cli.ts`, `src/devtools/inspector.ts`, `src/devtools/trace.ts` | `TARVE_INSPECTOR`; templates do compile-jsx transparentes no inspetor |
| `README.md`, `reports/gap/plugins.md`, `reports/gap/devtools.md`, `reports/gap/README.md` | documentação |

## Verificação

- `bun run smoke:runtime-parity router deep-link device plugin-hello inspector basic forms` (inclui `build:native` + `setup:examples`): **7 × 5 variantes iguais ao Bun**.
- `bun test packages/core`: 539 pass / 0 fail. `bun test packages/router ./examples/plugin-hello`: 31 pass / 0 fail. `bun test packages/core/src/devtools`: 11 pass.
- `bun scripts/smoke-txiki-shims.ts`: PASS.
- `bun run check` (tsc + paleta + intl): limpo.
- `bun run check:lines` falha só por arquivos de outras abas (`native/src/*`, `go/tarve/app.go`, `packages/core/src/app.ts` 1159 linhas, `android-build.ts`…); nenhum arquivo desta frente passa de 600 linhas e `app.ts` não cresceu com estas mudanças.
- Não rodado (rodada 1): a suíte completa das 16 views genéricas × 5 variantes; Linux/macOS. Ambos feitos na rodada 2.

## Rodada 2: Linux, sem internals, gzip e fs do updater

### Matriz final feature × runtime × SO

"ok" = árvore de nós, pixels e `result` idênticos ao Bun (e `runtime` como esperado) no `smoke:runtime-parity`; para as linhas de shim, o check correspondente do `smoke-txiki-shims` (Node/Bun têm a API nativa). Windows 11 x64 e Ubuntu 26.04 x64 (WSL2, WSLg, renderer `cpu` como o harness usa). Node 26.10.0 nos dois; txiki.js 26.6.0 (Windows: winget; Linux: compilado da tag `v26.6.0`, porque o release não publica binário Linux); Bun 1.4.3 (Windows) / 1.4.4 (Linux).

| Feature | node Win | node Linux | node-c Win | node-c Linux | txiki Win | txiki Linux | txiki-c Win | txiki-c Linux | bun-c Win | bun-c Linux |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 16 views genéricas (hover, cliques, digitação, Tab, wheel) | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok |
| Router (push, Escape, pop, popToRoot, abas, back) | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok |
| Deep link: argv → `onOpenUrl`/`onOpenFiles` | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok |
| Deep link: segunda instância encaminhada | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok |
| `registerProtocol`/`registerFileType` (Win: HKCU + `reg.exe`; Linux: `.desktop`, `update-mime-database`, `xdg-mime`) | ok | ok¹ | ok | ok¹ | ok | ok¹ | ok | ok¹ | ok | ok¹ |
| Device APIs — mesmo formato que o Bun | ok | ok² | ok | ok² | ok | ok² | ok | ok² | ok | ok² |
| Plugin nativo via FFI (`hello_add`) + lib embutida | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok |
| Inspetor (`TARVE_INSPECTOR=1`) | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok |
| `child_process.spawnSync` (saída, código, cwd, env, ENOENT, timeout) | nativo | nativo | nativo | nativo | ok | ok³ | ok | ok³ | nativo | nativo |
| `node:net` servidor/cliente de pipe, processo sai após `close()` | nativo | nativo | nativo | nativo | ok | ok⁴ | ok | ok⁴ | nativo | nativo |
| `zlib.gzipSync`/`gunzipSync` (bytes do Node) | nativo | nativo | nativo | nativo | ok⁵ | ok⁵ | ok⁵ | ok⁵ | nativo | nativo |
| `fs` do updater (`accessSync`, `openSync`/`readSync`/`closeSync`, `copyFileSync`, `createWriteStream`, `constants`), `readdirSync` | nativo | nativo | nativo | nativo | ok | ok⁶ | ok | ok⁶ | nativo | nativo |
| `smoke:txiki-apps` (13 apps reais, txiki × Bun) | — | — | — | — | ok | ok⁷ | — | — | — | — |

1. Novo no cenário `deep-link` (Linux): registra esquema e tipo num `XDG_DATA_HOME`/`XDG_CONFIG_HOME` descartável, confere as entradas `.desktop` (`Exec` com aspas), o MIME declarado (`application/x-tarveparity`), o `globs2` gerado pelo `update-mime-database` e o `xdg-mime query default` de cada um; depois remove e confere que sumiu. Todo runtime roda essas ferramentas com `spawnSync` — no txiki, o novo caminho `posix_spawnp`.
2. No WSL não há GeoClue nem portal de compartilhamento: `share`, posição e watch dão `{supported:false}` (`code:"unsupported"`) — igual em Bun e em todas as variantes. No Windows: `share`/posição/watch `supported:true`, `authenticate` `unsupported` (sem Windows Hello).
3. `posix_spawnp` + `waitpid` (glibc) via `tjs:ffi`. 4. Corrigido nesta rodada (ver abaixo). 5. Rust compartilhado (`native/src/zlib.rs`) — também no host Android. 6. `readdirSync`, `/proc` e o próprio `dlopen` da libc estavam quebrados no Linux (abaixo). 7. Linux: `tray`, `widget` e `youtube-music` reportam "no system tray host is running" **no Bun e no txiki igualmente** (WSLg não tem StatusNotifierWatcher); o smoke agora só reprova erros que o Bun não reporta e lista os comuns.

Não executado: macOS (sem host), Linux arm64, node/bun nos itens "nativo" (são as APIs do próprio runtime; os cenários que as usam passaram).

### Genuinamente não suportado (txiki.js), documentado

- **`server.unref()`**: o txiki.js 26.6 não tem API pública para tirar um listener do loop (`tjs.listen` não devolve handle com `unref`). O shim lança `server.unref() is not available in the Tarve txiki.js runtime (txiki.js cannot unref a listener); close() the server instead.` — a Tarve não precisa mais dele (abaixo).
- **Abortar um `fetch` enquanto o TCP ainda conecta** (host que não responde ao SYN): o `tjs.connect` só entrega o socket depois de conectar, então não há o que fechar; o `fetch` rejeita com `AbortError` na hora, mas o processo só sai quando o SO desiste da conexão (~2 min no Linux). Um socket que aparece depois do abort é fechado na hora (`txiki/fetch.ts`). Abort durante a resposta (o caso do smoke) fecha tudo e o processo sai.
- Sem test runner/`node:assert` no txiki (inalterado, ver [runtimes-headless-test.md](runtimes-headless-test.md)).

### Correções desta rodada (na raiz)

1. **`spawnSync` no Linux (txiki)** — `packages/core/txiki/shims/child-process-sync.ts`: `posix_spawnp` com `posix_spawn_file_actions` (stdin `/dev/null`, stdout/stderr em arquivos temporários 0600, `addchdir_np` para `cwd`), `argv`/`envp` montados como `char*[]` com `bufferToPointer` (API pública do `tjs:ffi`), `waitpid` bloqueante (ou `WNOHANG` + `usleep` com `timeout`, depois `SIGTERM` e `ETIMEDOUT` como o Node), `EINTR` repetido, `status`/`signal` decodificados, `ENOENT`/`EACCES` do retorno do `posix_spawnp`. Windows e Linux compartilham `environment`, `spawnFailure` e a leitura/remoção dos arquivos (no Windows, um neto que sobreviveu ao timeout pode segurar o arquivo; a remoção não derruba mais o `spawnSync` — achado pelo novo check de timeout).
2. **`unref()` sem internals** — `instance.ts` não chama mais `server.unref()`: o primeiro `requestSingleInstance` se registra e é liberado quando o app fecha (`app.ts` → `opens.dispose({ appClosed })` → `releaseSingleInstance()`, só para o app raiz, não para janelas de `openWindow`), além de `release()` e `process.exit`. Mesmo comportamento em Bun, Node e txiki; documentado no JSDoc de `requestSingleInstance` e no CHANGELOG. `net.ts` perdeu o acesso ao símbolo `getHandle`.
3. **Socket `node:net` mantinha o processo vivo no Linux** (txiki): quando o par encerrava, o shim emitia `end`/`close` sem fechar a conexão. Agora faz como o Node com `allowHalfOpen: false`: encerra o próprio lado (espera o que foi escrito sair) e fecha o handle; `fail` também fecha. Achado porque o `smoke-txiki-shims` travava no Linux.
4. **`fs` do txiki no Linux estava inteiro quebrado**: `dlopen("c")` não acha a libc (o `uv_dlopen` não resolve nome curto; `libc.so` é script de linker) → `libc.so.6`. `readdirSync` lançava "not available" no Linux → `opendir`/`readdir`/`closedir` com `read.u8` do `tjs:ffi` (`d_type`, e `stat` quando `DT_UNKNOWN`), o que também consertou `rmSync({ recursive })`. `readFileSync` lia só `stat.size` bytes → arquivos de `/proc` vinham vazios (`os.totalmem`/`freemem`/`release`); agora lê até o EOF.
5. **`fs` do updater** (`smoke:txiki-apps` falhava no build: `accessSync`, `closeSync`, `constants`, `copyFileSync`, `createWriteStream`, `openSync`, `readSync` ausentes): implementados em `txiki/shims/fs.ts` sobre a CRT (`_waccess`/`access`, `_fseeki64`/`fseeko`, `open`+`fdopen` no Linux para criar com `mode` respeitando a umask), mais `writeSync` e `WriteStream` (`write`/`end(cb)`/`destroy`, eventos `open`/`finish`/`close`/`error`). `copyFileSync` copia em blocos de 1 MiB, respeita `COPYFILE_EXCL` e copia os bits de permissão (como o libuv).
6. **`gzipSync`/`gunzipSync`** — `native/src/zlib.rs`: `gzip(data, level)` com o cabeçalho do zlib/Node (sem nome/mtime, XFL 2/4/0 pelo nível, byte de SO do zlib: 10 Windows, 3 Linux, 19 Apple), CRC-32 próprio (tabela `const`), `gunzip` com FEXTRA/FNAME/FCOMMENT/FHCRC, membros concatenados, checagem de CRC e ISIZE, erros com as mensagens do zlib (`incorrect header check`, `incorrect data check`, `unexpected end of file`). Exportado como `tarve_zlib_gzip`/`tarve_zlib_gunzip` (`bridge/entry_points.rs`, mesma convenção de retorno) e `host.zlib("gzip"|"gunzip")` no Android (`android/qjs.rs`, que agora rejeita operação desconhecida em vez de cair em inflate). Shims `txiki/shims/zlib.ts` e `android/shims/zlib.ts`. Testes Rust (`cargo test --lib zlib::`, 5/5) comparam com os bytes do Node 26 (`gzipSync("hello")` nos níveis 1, 6, 9 e vazio); o `smoke-txiki-shims` compara de novo dentro do executável.
7. **`fetch` do txiki**: o socket aberto antes de um abort não era rastreado (só depois do `opened`); agora `open()` entrega o `close` assim que o socket existe.
8. **Smokes**: `scripts/txiki-shims-entry.ts` ganhou checks de `spawnSync` (4), `net`, `fs` do updater (4) e `gzip`; `scripts/runtime-parity-scenarios.ts` ganhou o ramo Linux do `deep-link`; `scripts/smoke-txiki-apps.ts` compara erros com os do Bun e deixou de tratar `NaN` sem diferenciar maiúsculas (`/NaN/i` marcava "Conan Gray" nas recomendações ao vivo do youtube-music como texto de erro — reprovou uma rodada no Windows; agora `\bNaN\b` com caixa).

### Arquivos (rodada 2)

| Arquivo | Mudança |
| --- | --- |
| `packages/core/txiki/shims/child-process-sync.ts` | `spawnSync` Linux; partes comuns com o Windows |
| `packages/core/txiki/shims/net.ts` | sem `getHandle`; `unref()` lança; fecha ao fim do par |
| `packages/core/txiki/shims/fs.ts` | `libc.so.6`, `readdirSync` Linux, `readFileSync` até EOF, funções do updater, `WriteStream` |
| `packages/core/txiki/shims/zlib.ts`, `packages/core/android/shims/zlib.ts`, `android/host.ts` | gzip |
| `packages/core/txiki/fetch.ts` | socket rastreado antes de conectar |
| `packages/core/txiki/tjs.d.ts` | `bufferToPointer`, `read`, `errno` do `tjs:ffi` |
| `packages/core/src/instance.ts`, `src/app/open-requests.ts`, `src/app.ts` (1 linha alterada, sem crescer) | instância liberada ao fechar o app |
| `native/src/zlib.rs`, `native/src/bridge/entry_points.rs`, `native/src/android/qjs.rs` | gzip/gunzip + testes |
| `scripts/txiki-shims-entry.ts`, `scripts/runtime-parity-scenarios.ts`, `scripts/smoke-txiki-apps.ts` | checks novos |
| `README.md`, `CHANGELOG.md`, `reports/gap/runtimes-headless-test.md` | documentação |

### Ambiente Linux (reproduzível)

Cópia local no WSL (`~/tarve`, via `rsync` sem `node_modules`, `native/target*`, `work/`, `.git`), para não misturar `node_modules` (esbuild por plataforma) nem o `native/target` do Windows. Pré-requisitos: os pacotes apt de `linuxNativePrerequisiteError` + `cmake autoconf automake libtool texinfo libffi-dev libcurl4-openssl-dev` (build do txiki), `xdg-utils shared-mime-info`; Bun pelo script oficial, Rust pelo rustup, Node 26.10.0 pelo tarball oficial, txiki.js `git clone --recursive --branch v26.6.0` + `make`. Scripts em `work/wsl/` (ignorado pelo git): `sync.sh`, `env.sh`, `parity.sh`, `txiki-apps.sh`.

### Verificação (rodada 2)

| Verificação | Windows | Linux (WSL) |
| --- | --- | --- |
| `bun run smoke:runtime-parity` (16 views + 5 cenários × node, node-c, txiki, txiki-c, bun-c) | 21 × 5 iguais ao Bun⁸ | 21 × 5 iguais ao Bun |
| `bun scripts/smoke-txiki-shims.ts` | PASS (37 checks) | PASS (37 checks) |
| `bun run smoke:txiki-apps` | 13/13 | 13/13 (3 com o erro de bandeja comum ao Bun) |
| `bun test packages/core` | 539 pass / 0 fail | 538 pass / 1 skip / 0 fail |
| `cargo test --lib zlib::` | 5/5 | — |
| `bun run check` | limpo | — |

8. Numa rodada inteira, a referência **Bun** de `intrinsics` caiu uma vez com "Native window is closed" (antes de qualquer variante; nada desta frente toca esse caminho); `intrinsics` e `deep-link` repetidos em seguida: 5/5 ok, e a rodada completa final (com todas as mudanças, inclusive `net`/`fetch`/`readFileSync`) passou inteira: "runtime parity: 21 examples x 5 variants match Bun".
