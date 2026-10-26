# CI de macOS (`.github/workflows/macos.yml`)

Status: **workflow criado e validado sintaticamente (Bun.YAML). Ainda não rodou no GitHub.**
Base: `reports/gap/apple.md` (M0) e `reports/gap/macos-ts.md` (alvos darwin, `.app`, assinatura).

## Gatilhos
`push` (main/master), `pull_request` e `workflow_dispatch`. O estilo segue o `ci.yml`: mesmas versões de actions (`checkout@v7`, `setup-bun@v2` com Bun 1.4.2, `dtolnay/rust-toolchain@stable`, `Swatinem/rust-cache@v2`, `upload-artifact@v7`/`download-artifact@v8`), `concurrency` com `cancel-in-progress` e `timeout-minutes` em todos os jobs.

## Jobs

### 1. `apple-cross-check` (ubuntu-latest), portão rápido de compilação
- Instala Rust stable com os alvos `aarch64-apple-darwin`/`x86_64-apple-darwin` e o Zig 0.17.0 (`mlugg/setup-zig@v2`, a mesma versão usada localmente).
- Executa `bun scripts/check-apple.ts`, que faz `cargo check` dos dois alvos com `zig cc` e dispensa o SDK do Xcode. É o mesmo comando que já funciona num host Windows (`bun run check:apple`). Cache em `native/target-apple`.
- Detecta regressões de compilação no macOS (por exemplo, `cfg` que esquece o darwin) em poucos minutos e sem gastar minutos de runner macOS.

### 2. `macos` (matriz `macos-14` arm64 → `darwin-arm64`; `macos-13` x64 → `darwin-x64`)
Etapas que **bloqueiam** o job:
1. `bun install --frozen-lockfile` e `bun run install:examples`.
2. `cargo clippy --lib --locked`, com avisos permitidos. Existe também uma variante `-D warnings` **informativa** (`continue-on-error`), porque `native/src/tray.rs` ainda tem 2 imports não usados no macOS e esta tarefa não podia editar `native/src`. Depois que eles forem corrigidos, troque o passo principal para `-D warnings`.
3. `cargo test --lib --locked` no darwin.
4. `bun scripts/package.ts --native-only --no-variants`, que chama `buildNative()` de `scripts/native.ts` (checa `cargo`/`cc` e define `MACOSX_DEPLOYMENT_TARGET=11.0`) e gera `native/darwin-<arch>/libtarve_native.dylib` + `runtime.json`. Em seguida, `file`/`lipo`/`otool` conferem a arquitetura e a versão mínima.
5. Testes TS do darwin: `targets`, `macos-bundle`, `macos-sign`, `package-installer`, `node-target`, `native-runtime`, `updates`, `src/macho` e `src/bridge/runtime`.
6. `tarve build examples/basic/basic.tsx --target darwin-<arch> --native-features all --name TarveBasic`, que gera `dist/macos/TarveBasic.app`. Também `tarve package … --format app-zip`. O CLI roda a partir do checkout: `bun packages/core/cli.ts`.
7. Inspeção do bundle: `plutil -lint` no Info.plist, `file` no executável e na dylib, e `codesign --verify` (se não houver assinatura ad hoc, só emite um aviso).
8. Artefatos: `tarve-macos-<arch>-app` (o zip do `.app`) e `tarve-macos-<arch>-native` (dylib + manifesto).

Etapas **informativas** (`continue-on-error: true`, com nomes que começam com `[optional smoke]` ou terminam em `(informational)`):
- `bun test packages/core` completo, porque alguns testes ainda supõem host win32/linux.
- `[optional smoke] launch the .app for 8 s`: executa `Contents/MacOS/<exe>`, espera 8 s, faz um `screencapture` e falha se o processo tiver saído antes. Os runners têm sessão gráfica, mas a GPU é virtual.
- `[optional smoke] bun run smoke`: `scripts/smoke.ts` com janela real, frame Vello, layout e entrada sintética pelo canal de debug (`TARVE_SMOKE_OS_INPUT=0`, como no Linux).
- O artefato `tarve-macos-<arch>-smoke-<run>` guarda os `work/*.png` e `work/*.log`.

### 3. `macos-sign` (macos-14), assinatura e notarização condicionadas aos secrets
- Não roda em `pull_request`, porque forks não recebem secrets. O primeiro passo verifica os secrets e define `sign`/`notarize`. Sem eles, o job termina verde com um `::notice::` e não executa mais nada.
- Com os secrets: importa o `.p12` num keychain temporário (`security create-keychain/import/set-key-partition-list`), baixa o zip arm64 do job `macos`, extrai com `ditto` e roda `tarve release --artifact darwin-arm64=<app> --sign "$TARVE_MACOS_SIGN_IDENTITY" [--notarize]`, que usa `packages/core/macos-sign.ts`. Depois verifica com `codesign --verify --deep --strict`. Se houver notarização, também roda `stapler validate` e `spctl --assess`. Por fim, publica o artefato `tarve-macos-arm64-app-signed` e apaga o keychain.
- Se `TARVE_UPDATE_PRIVATE_KEY` não existir, o job gera uma chave descartável com `tarve keygen`, porque o objetivo é validar a assinatura, não publicar updates.

## Secrets necessários (Settings → Secrets → Actions)
| Secret | Uso | Obrigatório para |
|---|---|---|
| `MACOS_CERTIFICATE_P12` | certificado "Developer ID Application" + chave, `.p12` em base64 (`base64 -i cert.p12`) | assinar |
| `MACOS_CERTIFICATE_PASSWORD` | senha do `.p12` | assinar |
| `MACOS_SIGN_IDENTITY` | p.ex. `Developer ID Application: Nome (TEAMID)` (vira `TARVE_MACOS_SIGN_IDENTITY`) | assinar |
| `APPLE_ID` | Apple ID da conta de desenvolvedor | notarizar |
| `APPLE_TEAM_ID` | Team ID (10 caracteres) | notarizar |
| `APPLE_APP_PASSWORD` | senha específica de app (appleid.apple.com) | notarizar |
| `TARVE_UPDATE_PRIVATE_KEY` | chave de update real (opcional; sem ela usa uma descartável) | `latest.json` publicável |

Sem secrets, os jobs 1 e 2 cobrem tudo, exceto a assinatura Developer ID e a notarização.

## Validação feita
- `Bun.YAML.parse` no `macos.yml`: 3 jobs (`apple-cross-check` com 6 passos, `macos` com 21 e `macos-sign` com 10). Todo passo tem `name` e `run` ou `uses`. Os gatilhos são `push`, `pull_request` e `workflow_dispatch`. O `ci.yml` continua sendo lido sem erro.
- O `actionlint` não está instalado nesta máquina, então as expressões `${{ }}` não foram verificadas por ele.
- Nada foi executado em runner. Os comandos usam os scripts existentes (`check-apple.ts`, `package.ts`/`native.ts` e `cli.ts build/package/release/keygen`), com as flags conferidas no código.

## Riscos e limitações
- **`macos-13`**: o GitHub está aposentando a imagem Intel `macos-13`. Se o job ficar na fila ou falhar por falta de runner, troque para `macos-15-intel` (a última imagem x64) ou remova a entrada x64 da matriz.
- Um build cruzado `--target darwin-arm64` no runner x64 exigiria a dylib arm64. Por isso a matriz usa o alvo nativo de cada runner (`darwin-x64` no Intel).
- `cargo test --lib` pode ter testes que dependem de GPU ou janela. Se algum falhar só por causa do Metal virtual, marque-o com `#[cfg_attr(target_os = "macos", ignore)]` no crate (fora do escopo desta tarefa).
- O `.app` gerado no runner recebe assinatura ad hoc (`TARVE_MACOS_ADHOC_SIGN`). Ele roda no runner, mas o Gatekeeper o bloqueia em outros Macs. Para distribuir, é preciso o job `macos-sign` com notarização.
- O smoke não testa menu, tray, notificações nem vídeo (M3 do `apple.md`), porque essas partes ainda não existem no macOS.
