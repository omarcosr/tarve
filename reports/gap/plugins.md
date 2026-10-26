# Plugins — API estável para módulos de terceiros (JS e nativos)

Status: **parte TS-first implementada e testada** (Bun + Node 26.10 verificados; build/package Bun embute bibliotecas nativas). `native/src` **não foi tocado**.

## Resumo

- `definePlugin({ name, version, setup(ctx) })` + `createApp(view, { plugins: [...] })`.
- Comandos chamáveis da UI: `app.invoke("ns.cmd", ...args)` ou cliente tipado `plugin.client(app).cmd(...)`.
- Ciclo de vida: `ctx.onReady`, `ctx.onClosed`, `ctx.onOpenUrl`, `ctx.onOpenFiles`.
- Canal tipado com o runtime: `ctx.request(command, { expect, timeoutMs })` (o mesmo `requests.request` que diálogos/permissões usam).
- FFI: `ctx.loadLibrary([pathByTarget], symbols)` → `bun:ffi` / `node:ffi` (Node ≥ 26.10) / `tjs:ffi` (txiki/QuickJS); demais runtimes → `PluginFfiUnsupportedError` com mensagem clara. Tipos de símbolo inferidos da declaração.
- Descoberta via `package.json` `"tarve": { "tarvePluginApi": 1, "plugin": "...", "native": { "<target>": "..." } }` (`discoverPlugins`, `loadPlugins`).
- `tarve build` / `tarve package` (runtimes Bun, Node SEA e txiki — ver [runtimes-parity.md](runtimes-parity.md)) embutem a biblioteca do alvo; `.app` macOS copia para `Contents/Frameworks`.
- Exemplo `examples/plugin-hello` com cdylib Rust (`hello_add`), wrapper TS, demo e testes.

## Arquivos

| Arquivo | O quê |
| --- | --- |
| `packages/core/src/plugins/index.ts` | `definePlugin`, `PluginContext`, `createPluginHost` (setup, registro de comandos, lifecycle, request, loadLibrary/resolveLibrary), `loadPlugins`, `registerEmbeddedPluginNatives`, `PLUGIN_API_VERSION` |
| `packages/core/src/plugins/ffi.ts` | `openPluginLibrary`, `FfiType`/`FfiSymbols`/`FfiFunctions` (tipagem), `detectFfi`, `validateSymbols`, `PluginFfiUnsupportedError` |
| `packages/core/src/plugins/discovery.ts` | `discoverPlugins`, `readPluginManifest`, `findPackageRoot`, `resolvePackageDirectory`, `PLUGIN_API_VERSION = 1` |
| `packages/core/src/plugins/targets.ts` | `PLUGIN_TARGETS`, `hostPluginTarget`, `pluginTargetForBuild` (`windows-x64`→`win32-x64`, `arm64-v8a`→`android-arm64`…), `nativeLibraryFileName` |
| `packages/core/plugins-build.ts` | `planPluginNatives(entry, buildTarget)` e `pluginNativeRuntimeLines(embeds, "embedded"\|"frameworks")` |
| `packages/core/build.ts` | (hunks novos) planeja os nativos dos plugins; anexa o registro ao módulo virtual `#tarve/runtime`; copia dylibs para `Contents/Frameworks` antes do ad-hoc sign; avisos para `--runtime node/txiki` e plugins sem lib para o alvo |
| `packages/core/src/app.ts` | (hunks novos) `AppOptions.plugins`, `AppHandle.invoke`, `AppErrorSource` + `"plugin"`, host criado antes de `bridge.start`; janelas de `openWindow` compartilham o host do app |
| `packages/core/src/index.ts` | exports públicos (API + tipos) |
| `packages/core/src/plugins/plugins.test.tsx` | 18 testes: alvos, descoberta, definePlugin, lifecycle, comandos, request, resolução de bibliotecas, plano de build |
| `packages/core/src/render-handlers.test.tsx` | `PluginFfiUnsupportedError` (classe) adicionada a `NOT_RENDERABLE` |
| `examples/plugin-hello/*` | crate Rust standalone (`[workspace]` próprio), `plugin.ts`, `demo.tsx`, `plugin-hello.test.tsx`, `package.json` com manifesto, `.gitignore` (`native/target/`) |
| `README.md` | seção "Plugins" para autores (entre "Desktop APIs" e "Automation") |

## Design da API

```ts
const hello = definePlugin({
  name: "tarve-plugin-hello",   // = nome npm (chave de descoberta e do registro embutido)
  version: "0.1.0",             // semver do plugin (validado)
  namespace: "hello",           // prefixo dos comandos (padrão: name)
  tarvePluginApi: 1,            // major da API de plugins (padrão 1)
  root: import.meta.dirname,    // base para caminhos relativos e package.json
  setup(ctx) {                  // roda 1x por app, antes de abrir a janela; pode ser async
    const lib = ctx.loadLibrary({ hello_add: { args: ["i32", "i32"], returns: "i32" } });
    return { add: (a: number, b: number) => lib.symbols.hello_add(a, b) }; // vira "hello.add"
  },
});
const app = createApp(View, { plugins: [hello] });
await hello.client(app).add(2, 3); // Promise<number>, tipado a partir do retorno do setup
```

Decisões:

- **Comandos em processo, não JSON.** Os comandos são funções JS chamadas diretamente (`invoke` sempre devolve Promise; aguarda setups assíncronos). Não há serialização: plugins JS e chamadas FFI síncronas ficam baratos. Duplicatas de comando/namespace/plugin falham cedo.
- **Falha de setup não derruba o app**: vai para `onError` com `source: "plugin"`, `event: "<nome>:setup"`; chamadas aos comandos desse plugin rejeitam com "Plugin X failed to set up: …".
- **onReady** só dispara depois de `app.ready` **e** de todos os setups; **onClosed** roda depois de `app.closed`, e então as bibliotecas abertas por `loadLibrary` são fechadas e os comandos removidos.
- **openWindow**: janelas filhas reutilizam o host do app (WeakMap por bridge), então `child.invoke` funciona igual.
- **ctx.request** aceita apenas comandos do protocolo que têm `requestId` (tipo `PluginRequest` = união distributiva sem `requestId`); com `expect` o tipo de retorno é estreitado (`Extract<NativeEvent, {type: E}>`) e o campo `error` vira rejeição.
- **Resolução da biblioteca** (`ctx.resolveLibrary`): 1) registro embutido pelo `tarve build` (`globalThis[Symbol.for("tarve.pluginNatives")]`), 2) caminho explícito (string ou mapa por alvo), 3) `tarve.native` do package.json (via `root` ou descoberta a partir de `TARVE_ENTRY`/`Bun.main`/`argv[1]`/cwd). Caminhos `$bunfs` passam por `nativeAssetPath` (funciona também com `import lib from "./x.dll" with { type: "file" }`). Erros dizem o alvo e o que existe.
- **Alvos** usam a convenção do Node (`win32-x64`, `linux-x64`, `darwin-arm64`, `android-arm64`, + `win32-arm64`, `linux-arm64`, `darwin-x64`, `android-x64`), não os nomes de build do Tarve; `pluginTargetForBuild` faz o mapeamento.
- **Tipos FFI**: `void bool i8 u8 i16 u16 i32 u32 i64 u64 f32 f64 ptr buffer` (`buffer` só como argumento; strings = bytes UTF-8 terminados em NUL). Mapeamento Node verificado contra `require("node:ffi").types` (int32, uint32, double, float, pointer, buffer…).

## Versionamento

- `PLUGIN_API_VERSION = 1` (exportado). É um **major**: adições compatíveis (novos métodos no contexto, novos tipos FFI, novos campos opcionais no manifesto) mantêm `1`; mudança incompatível em `definePlugin`, `PluginContext` ou no manifesto incrementa. O Tarve recusa plugins com `tarvePluginApi` maior que o seu (no `createApp` e na descoberta, com "Update @tarve/core"). Plugins com número menor continuam aceitos enquanto o Tarve mantiver a camada de compatibilidade (política proposta: suportar N e N-1).
- `version` do plugin: semver próprio. Recomendação: `peerDependencies: { "@tarve/core": ">=<versão que trouxe a API>" }`.
- ABI C da biblioteca nativa é contrato do próprio plugin; o exemplo exporta `hello_abi_version()` e o wrapper confere. **Independente** de `ABI_VERSION` (= 6 em `native/src/bridge.rs`) e do `PROTOCOL_VERSION`, que continuam internos ao Tarve.

## Build e package

Implementado (runtime Bun, `packages/core/build.ts` + `plugins-build.ts`):

1. `planPluginNatives(entry, target)` descobre os plugins a partir do package.json mais próximo do entry (o próprio pacote, `dependencies`, `optionalDependencies`), escolhe a lib do alvo, calcula sha256/tamanho; lib declarada mas ausente → erro de build; plugins com libs só para outros alvos → aviso; nomes de arquivo repetidos → erro.
2. O módulo virtual `#tarve/runtime` gerado ganha `import x from "<lib>" with { type: "file" }` + registro `() => materializeAsset(x, "<arquivo>", digest)`: a lib fica dentro do executável e é extraída uma vez para o mesmo cache verificado por hash (`%TEMP%/tarve-assets/<sha256>/`) do runtime Tarve (sem zstd: libs de plugin são pequenas).
3. macOS (`darwin-*`): a lib é copiada para `<App>.app/Contents/Frameworks/` antes do `codesign` ad hoc e registrada como `join(dirname(execPath), "..", "Frameworks", arquivo)`; `tarve package --format app-zip` já leva o diretório inteiro.
4. `tarve package <app.tsx>` chama `build()`, então herda o embutimento; empacotar um executável já pronto não precisa de nada.

Não implementado (documentado; avisos emitidos):

- **`--runtime node` (SEA) e `--runtime txiki`**: `build()` avisa que as libs não são embutidas. Caminho: em `node-build.ts`/`txiki-build.ts`, incluir as libs como assets do SEA / do bundle txiki e gerar o mesmo registro em `#tarve/runtime`.
- **Android (`tarve build --target android-arm64`)**: vai para `buildAndroid`, arquivo com trabalho não commitado de outra aba (bg-9), por isso não editado. Passo exato: em `packages/core/android-build.ts`, ao montar o APK (perto de `entries.push(zipEntry(\`lib/${abi}/libtarveapp.so\`, …))`), chamar `planPluginNatives(entrypoint, abi)` e adicionar `zipEntry(\`lib/${abi}/${embed.fileName}\`, bytes, false)`; no módulo `#tarve/runtime` do Android (`contents: export function nativePath() …`) anexar `pluginNativeRuntimeLines` com um terceiro layout `"soname"` que registra `() => embed.fileName` (o linker do Android acha libs de `lib/<abi>` pelo nome). O `tjs:ffi` do host QuickJS já é usado por `loadLibrary`.
- **Go**: sem JS, não carrega plugins (preferência do usuário: sem paridade).
- Embute **todos** os plugins descobertos com lib para o alvo, mesmo se o código não importar o plugin (sem tree-shaking de nativos).

## Exemplo `examples/plugin-hello`

- `native/` — crate `tarve_plugin_hello` (cdylib, `[workspace]` vazio para não entrar em nenhum workspace), exporta `hello_add(i32,i32)->i32` (wrapping) e `hello_abi_version()->u32`; perfil release `opt-level="s"`, LTO, strip.
- `plugin.ts` — `definePlugin` com `loadLibrary(HELLO_SYMBOLS)` sem caminhos (usa embutido ou `tarve.native`), comandos `add` e `info`.
- `demo.tsx` — janela com botões que chamam `hello.client(app).add(a, b)`.
- `plugin-hello.test.tsx` — manifesto, bun:ffi direto, app com fake bridge + comandos tipados (pula se a lib do host não estiver compilada).

## Verificação

- `cargo build --release` e `cargo test --release` em `examples/plugin-hello/native` (Windows x64): ok, 1 teste.
- `bun test ./examples/plugin-hello`: 3 pass (bun:ffi real chamando `hello_add`).
- Node 26.10.0: `openPluginLibrary` via `node:ffi` → `hello_add(40, 2) = 42`, `hello_abi_version() = 1`.
- `bun test ./packages/core/src/plugins`: 18 pass.
- `bun run check` (tsc + tailwind palette + txiki intl): ok. `tsc -p examples`: sem erros.
- `bun test packages/core`: 532 testes; falhas restantes **pré-existentes e não relacionadas**: `build.test.ts` (2: targets darwin adicionados por outra aba), `node-build.test.ts` e `node-dev.test.ts` ("Protocol version mismatch": a DLL nativa compilada está desatualizada frente ao protocolo TS não commitado de outras abas).
- Ponta a ponta: `tarve build` de uma entry temporária dentro de `examples/plugin-hello` (fake bridge, `TARVE_NATIVE_FEATURES=all`) → executável rodado fora do repo carregou `tarve_plugin_hello.dll` de `%TEMP%\tarve-assets\<sha256>\` e devolveu 42; `tarve package --format zip` → zip extraído e executado com o mesmo resultado. Entry e artefatos temporários removidos.
- Não verificado: macOS (cópia para Frameworks coberta só por teste unitário da geração), Linux, txiki, Android.

## Limitações e próximos passos

1. **Plugins nativos dentro do runtime Rust** (registrar elementos/renderização customizados, receber eventos do loop nativo) exigem uma extensão do C ABI em `native/src/bridge.rs` (ex.: `tarve_register_plugin(vtable)` + bump de `ABI_VERSION`) e um comando de protocolo genérico `{ type: "plugin", plugin, method, payload, requestId }` com evento `pluginResult` (bump de `PROTOCOL_VERSION` em `packages/protocol/src/index.ts` e `native/src/protocol.rs`). Fora do escopo por regra (sem editar `native/src`). Hoje a lib do plugin roda no processo JS via FFI, separada do runtime.
2. Callbacks nativo→JS (ponteiros de função) não são expostos: `bun:ffi` tem `JSCallback`, `node:ffi` tem `function`, mas a semântica de thread difere; proposta para a API 1.x: `ctx.callback(signature, fn)` só na thread JS.
3. Retornos `cstring`/structs não estão no conjunto de tipos (usar `buffer` + comprimento).
4. Android: embutimento no APK pendente (ver acima); Bun no Android com bridge remoto (`TARVE_ANDROID_BRIDGE_FD`) carregaria a lib no processo Bun, não na activity.
5. `loadPlugins()` usa `import()` dinâmico: serve para dev/ferramentas; apps compilados devem importar plugins estaticamente.

## Rascunho da página de documentação (autores de plugins)

1. **Crie o pacote**: `package.json` com `name`, `version`, `peerDependencies["@tarve/core"]` e o campo `tarve` (`tarvePluginApi`, `plugin`, `native`).
2. **Biblioteca nativa (opcional)**: qualquer linguagem com ABI C (`extern "C"`, `#[no_mangle]`, crate `cdylib`). Compile para cada alvo (`cargo build --release --target x86_64-pc-windows-msvc|x86_64-unknown-linux-gnu|aarch64-apple-darwin`, `cargo ndk -t arm64-v8a`), publique os binários no pacote e liste-os em `tarve.native`. Exporte uma função de versão da sua ABI.
3. **Wrapper TS**: `export default definePlugin({ name, version, namespace, root: import.meta.dirname, setup })`. Declare símbolos com `as const` (ou inline) para tipagem; devolva os comandos do `setup`.
4. **Ciclo de vida**: inicialize no `setup`, use `onReady` para trabalho que precisa da janela, libere recursos em `onClosed` (as libs fecham depois).
5. **Uso no app**: `createApp(View, { plugins: [plugin] })`; `plugin.client(app).cmd()` ou `app.invoke("ns.cmd")`. Erros de setup aparecem em `onError` (`source: "plugin"`).
6. **Distribuição**: `tarve build`/`tarve package` (Bun, Node SEA e txiki) embutem a lib do alvo; para Android, por enquanto, envie a lib junto e passe o caminho.
7. **Compatibilidade**: `tarvePluginApi` = major da API; o Tarve recusa plugins mais novos que ele. Teste com `bun test` usando um `NativeBridge` falso (veja `examples/plugin-hello/plugin-hello.test.tsx`).
