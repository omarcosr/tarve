# macOS: lado TypeScript (M1 + M4)

Status: **implementado e testado a partir do Windows; execução, assinatura e notarização ainda não foram validadas em um Mac.**
Base: `reports/gap/apple.md` (M0: `bun scripts/check-apple.ts` compila `native/` para `aarch64/x86_64-apple-darwin`).

## Feito

### Alvos (M1)
- `packages/core/targets.ts`: novos alvos `darwin-arm64` e `darwin-x64` (`platform: "darwin"`, `bunTarget: bun-darwin-*`, `nativeDirectory: native/darwin-arm64|darwin-x64`, `nativeName: libtarve_native.dylib`), além de `isMacTarget()`.
- `PACKAGED_TARGETS = ["windows-x64", "linux-x64"]`: são os runtimes que o pacote npm precisa conter. `scripts/package.ts`, `scripts/release-policy.ts` e o teste da política passaram a usar essa lista, então `bun run package`/`release` não exigem uma `.dylib` que ainda não temos como produzir. `scripts/release.ts` continua só com Windows e Linux.
- `packages/core/src/bridge/runtime.ts` já resolvia o host via `hostBuildTarget()`. Com os novos alvos, ele aceita hosts darwin sem alteração no arquivo. Windows e Linux não mudaram (há teste para isso).
- `scripts/native.ts` (`buildNative`): no macOS verifica `cargo` e `cc`/`clang` (com a dica `xcode-select --install`) e define `MACOSX_DEPLOYMENT_TARGET=11.0`, alinhado ao `LSMinimumSystemVersion`. O `cargo build` gera `libtarve_native.dylib` (crate `cdylib`).
- Importadores revisados: `build.ts`, `cli.ts`, `node-target.ts` (URL do Node para darwin: `node-v<ver>-darwin-<arch>.tar.gz`), `native-features.ts` (o vello-gpu já vale para tudo que não é win32), `native-runtime.ts`, `txiki-build.ts` e `node-build.ts`. Para alvos macOS, `build()` recusa `--runtime node|txiki` com erro claro; os demais importadores só usam `targetConfig`/`hostBuildTarget`.

### Bundle `.app` (M4): `packages/core/macos-bundle.ts`
- `infoPlist()`: CFBundleName, DisplayName, Identifier, Version, ShortVersionString, Executable, PackageType APPL, IconFile, LSMinimumSystemVersion 11.0, NSHighResolutionCapable, NSHumanReadableCopyright e NSSupportsAutomaticGraphicsSwitching. Inclui `encodePlist`/`parsePlist` (XML), `bundleIdentifier` (appId ou `dev.tarve.<nome>`) e `bundleVersion` (1 a 3 inteiros).
- `.icns` em TS puro: `encodeIcns`/`parseIcns` e `icnsFromImage` (PNG ou `.ico` com PNG). Gera `ic07` (128) sempre e `ic08`/`ic09`/`ic10` até o tamanho da imagem de origem, sem ampliar o ícone.
- Layout: `Contents/Info.plist`, `PkgInfo`, `MacOS/<exe>` (0755), `Frameworks/libtarve_native.dylib`, `Resources/AppIcon.icns`. Funções: `writeMacAppBundle`, `readMacAppBundle`, `zipMacApp`/`macAppZipEntries` (no Windows, binários recebem modo 0755; symlinks são recusados).
- `tarve build --target darwin-arm64|darwin-x64` gera `dist/<Nome>.app`. Se `--outfile` não termina em `.app`, o sufixo é acrescentado. Nesses alvos a `.dylib` **não é embutida** no executável. O `nativePath()` gerado resolve `../Frameworks/libtarve_native.dylib` a partir de `process.execPath`, porque o hardened runtime recusa uma biblioteca não assinada extraída para o cache. Num host macOS, o bundle é assinado ad hoc (`TARVE_MACOS_ADHOC_SIGN=0` desliga).
- A compilação cruzada exige `native/darwin-<arch>/libtarve_native.dylib` com o manifesto do runtime, a mesma regra dos outros alvos cruzados.
- `tarve package … --format app-zip` (`package-installer.ts`): aceita um `.app` (ou `app.tsx`, que é compilado antes) e gera `<nome>-<versão>-macos-<arch>.zip`. `executableInfo` reconhece Mach-O e `.app`. `deb`/`tar`/`zip`/`msix` recusam binários macOS. No host macOS o formato padrão é `app-zip`; a partir de outros hosts o alvo usado é `darwin-arm64`.
- `--format dmg`: **adiado**. O `parsePackageFormats` dá um erro explicando que é preciso o `hdiutil` (só existe no macOS) e sugere `app-zip`.

### Assinatura e notarização: `packages/core/macos-sign.ts`
- `tarve release --artifact darwin-arm64=dist/App.app` copia o `.app`, assina quando pedido, compacta em `<stem>-<ver>-darwin-arm64.zip` e põe o hash no `latest.json`.
- Identidade de assinatura: `--sign "<identidade>"` quando só há artefatos darwin (com artefatos Windows, `--sign` continua sendo o comando Authenticode). Também pode vir de `TARVE_MACOS_SIGN_IDENTITY`. Comandos executados: `codesign --force --deep --options runtime --timestamp [--entitlements f] --sign <id>`, seguido de `codesign --verify --deep --strict`.
- Notarização: `--notarize` com `--notary-profile`/`TARVE_NOTARY_PROFILE`, ou `APPLE_ID` + `APPLE_TEAM_ID` + `APPLE_APP_PASSWORD`. Roda `xcrun notarytool submit <zip> --wait` e `xcrun stapler staple <app>`, depois compacta de novo.
- Fora do macOS o processo falha com "needs macOS (codesign/xcrun)…". Assinar um `.zip` ou um Mach-O solto dá erro pedindo o `.app`.

### Atualização: `packages/core/src/updates.ts` + `src/macho.ts`
- `machOKind`/`machOArch`: `0xfeedfacf`/`0xcffaedfe` (64 bits), `0xfeedface`/`0xcefaedfe` (32 bits) e fat `0xcafebabe` (também `0xcafebabf`), lendo o `cputype` (arm64/x86_64). `executableMagics("darwin-*")` aceita Mach-O ou zip; `executableMagic`/`looksExecutable` mantêm o comportamento antigo para Windows e Linux.
- Troca do bundle: `macBundleOf()` e `planMacBundleUpdate()` (bundle, `Contents/MacOS/<exe>`, staging `.<App>.app.update` ao lado do bundle e backup `<App>.app.old`). No macOS, `installUpdate` extrai o zip com `/usr/bin/ditto -x -k`, confirma que o novo `Contents/MacOS/<exe>` é Mach-O, troca os bundles por `rename` (com rollback) e reinicia o app. `downloadUpdate` grava **ao lado** do `.app`, nunca dentro, para não quebrar o selo da assinatura. `canInstallUpdate` verifica permissão de escrita no bundle e na pasta que o contém. `cleanupUpdate` remove `<App>.app.old`.
- Dentro de um bundle, um Mach-O solto é recusado, porque trocar só o executável invalidaria a assinatura.

## Testes (`bun test`, Windows)
- `packages/core/targets.test.ts` (5): alvos, configs, `hostBuildTarget` darwin e `PACKAGED_TARGETS`.
- `packages/core/macos-bundle.test.ts` (11): Info.plist (chaves, escape e parse de volta), plist aninhado, identifier/version, ida e volta do `.icns` e erros, tamanhos e conteúdo das entradas PNG, layout do bundle, gravação e leitura em disco, `app-zip` (modos 0755/0644, conteúdo), recusas de formato, `dmg`, `release` com `.app` (vira zip assinado no manifesto), recusa de assinatura fora do Mac.
- `packages/core/macos-sign.test.ts` (4): argumentos do codesign/notarytool, sequência de comandos com um runner falso e plataforma `darwin`, erro em win32/linux, opções vindas de flags e env.
- `packages/core/src/macho.test.ts` (5): magics nas duas ordens de bytes, cputype, `looksExecutable` darwin/linux/win32, `macBundleOf`, plano de troca do bundle.
- Testes que já existiam continuam passando: `updates`, `package-installer`, `node-target`, `bridge/runtime` e `scripts/release-policy` (67 testes no total, 0 falhas).
- Smoke manual no Windows: `build({ target: "darwin-arm64" })` com uma `.dylib` falsa e um manifesto válido gerou `Smoke.app`. O Bun compilou um Mach-O arm64 real, o Info.plist e o `.icns` saíram corretos, e o `packageApp` gerou `Smoke-macos-arm64.zip`. Os arquivos temporários foram removidos.
- `bun run check`: o `tsc` falha **apenas** em `packages/core/src/devtools/view.ts:156`, arquivo de outra aba (bg-8), sem relação com esta mudança. Nenhum erro nos arquivos tocados aqui.

## Limitações
- O pacote npm ainda não inclui os runtimes macOS (`PACKAGED_TARGETS`), e `package.json` `os`/`cpu` continua `win32`/`linux` + `x64`. Liberar isso depende de um runner macOS rodando `bun run package:native`.
- `--runtime node`/`txiki` para macOS ainda não existe. O SEA do Node no macOS exige `postject --macho-segment-name NODE_SEA` e reassinatura.
- Um `.app` compilado a partir do Windows **não é assinado**. No Apple silicon ele só roda depois de `codesign --sign -` (ou `tarve release --sign`) feito num Mac. O Bun pode ou não aplicar uma assinatura ad hoc na compilação cruzada; isso não foi verificado.
- `.dmg` adiado (precisa de `hdiutil`). O zip gerado em TS não preserva symlinks nem atributos estendidos. Para `.framework` com versões, use `ditto -c -k --keepParent` no Mac.
- `CFBundleURLTypes`/`CFBundleDocumentTypes` (deep links e tipos de arquivo, `associations-config.ts` da bg-7) ainda não entram no Info.plist.
- A troca do bundle na atualização foi escrita, mas não executada: depende do `ditto` e do comportamento do Gatekeeper/quarentena (o arquivo baixado pelo próprio app não recebe `com.apple.quarantine`).

## O que precisa de um runner macOS (`macos-14` arm64 / `macos-13` x64)
1. `bun run build:native` e `bun run package:native` para gerar `native/darwin-*/libtarve_native.dylib` + manifesto.
2. `tarve build app.tsx --target darwin-arm64` → abrir o `.app` (janela, Retina, carregamento da dylib a partir de `Contents/Frameworks`).
3. `tarve release --artifact darwin-arm64=dist/App.app --sign "Developer ID Application: …" --notarize` com credenciais reais, seguido de `spctl --assess -vv` e `stapler validate`.
4. Fluxo de atualização ponta a ponta (`checkForUpdate` → `downloadUpdate` → `installUpdate` trocando o `.app`) em `/Applications` e em `~/Applications`.
5. Opcional: `.dmg` via `hdiutil create -format UDZO`, assinado e notarizado.
