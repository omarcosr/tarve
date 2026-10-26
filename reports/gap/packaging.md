# Empacotamento: `tarve package` (deb, tar.gz, zip, MSIX)

## O que foi feito

- **`packages/core/archive-formats.ts`** (novo): escritores de arquivos em TypeScript puro, só `node:zlib` (funciona em Bun e Node):
  - `createAr` — formato `ar` System V/GNU, como o `dpkg-deb` escreve (`!<arch>`, cabeçalhos de 60 bytes, padding par).
  - `createTar` / `createTarGz` — POSIX ustar (dono `root:root`, diretórios, symlinks, caminhos longos via campo `prefix`), gzip nível 9.
  - `createZip` — zip com deflate, nomes UTF-8, CRC-32 próprio e permissões Unix nos atributos externos (o executável continua executável ao descompactar no Linux).
  - Datas determinísticas: `SOURCE_DATE_EPOCH` ou a opção `mtime`.
- **`packages/core/package-installer.ts`** (novo, exportado como `@tarve/core/package`): `packageApp(options)` lê o cabeçalho do executável (ELF/PE e arquitetura), resolve metadados com `resolveAppMetadata` (mesmo campo `"tarve"` do `package.json` e flags do `tarve build`) e o ícone com `appIconImages`, e gera:
  - **deb**: `control.tar.gz` (`control`, `md5sums`, `postinst`/`postrm` que atualizam o cache de desktop/ícones) + `data.tar.gz` com `/opt/<app>/<exe>`, symlink `/usr/bin/<app>`, `/usr/share/applications/<id>.desktop` e `/usr/share/icons/hicolor/<N>x<N>/apps/<id>.png`. `StartupWMClass` segue a mesma regra do `writeLinuxDesktopEntry` (appId ou nome do executável).
  - **tar**: `<app>-<versão>-linux-x64.tar.gz` com executável, `.desktop`, ícone e `install.sh` (instalação por usuário em `~/.local`, `--uninstall` remove).
  - **zip**: `<App>-<versão>-windows-x64.zip` portátil.
  - **msix**: pasta com `AppxManifest.xml` (full trust, `runFullTrust`, `Windows.FullTrustApplication`), logos 50/44/150 px (do ícone ou um placeholder) e o `.exe`; se `makeappx` for encontrado (opção, `TARVE_MAKEAPPX`, `PATH` ou Windows SDK mais recente), empacota em `.msix` não assinado; senão devolve a pasta e as instruções.
- **CLI** (`packages/core/cli.ts`): comando `tarve package <dist/App | app.tsx>`; com fonte, faz um `build` por SO alvo (deb/tar → linux-x64, zip/msix → windows-x64, ou `--target`) e empacota cada um logo em seguida. Novas opções: `--format` (lista separada por vírgula), `--categories`; reaproveita `--name --version --icon --publisher --description --copyright --app-id --out --outfile --runtime`.
- **Export público**: `package.json` → `"./package"`; `scripts/package.ts` gera `dist/npm/package-installer.js` (target node). Os tipos saem do `tsconfig.package.json` já existente.
- **README**: subseção "Installers and portable archives" em "Build a standalone executable".

## Uso

```bash
bunx tarve package dist/App --format deb,tar --version 1.2.0 --categories "Utility;Office"
bunx tarve package app.tsx --format zip,msix --version 1.2.0 --publisher "Acme Inc." --out dist/packages
```

```ts
import { packageApp } from "@tarve/core/package";
const artifacts = packageApp({ executable: "dist/App", format: ["deb", "tar"], version: "1.2.0" });
// [{ format: "deb", path: ".../app_1.2.0_amd64.deb", note: "install: sudo apt install ./..." }, ...]
```

Padrão sem `--format`: deb + tar para executável Linux, zip para Windows. deb e msix exigem versão (`--version` ou `version` do package.json com campo `tarve`).

## Testes

- `bun test packages/core/package-installer.test.ts` → **9 pass, 0 fail** (124 expects). Os testes reabrem os arquivos com leitores independentes (ar, ustar com verificação de checksum, zip com CRC e inflate) e conferem: ordem dos membros do deb, `debian-binary`, campos do `control`, `md5sums`, modo 0755, symlink `/usr/bin`, `.desktop`, ícone hicolor; conteúdo do tar.gz e do `install.sh`; zip byte a byte e permissões; manifesto MSIX; erros de formato/SO; caminhos >100 bytes. Também valida com `bsdtar` (libarchive, presente no Windows 10+) quando disponível — rodou aqui e listou deb/tar.gz/zip corretamente.
- `bun test` de `package-metadata.test.ts` e `build.test.ts`: passam (19 testes no total com o acima).
- `tsc --noEmit` (repo): nenhum erro em `packages/core` nem `scripts`; os únicos erros atuais são em `packages/router` (trabalho em andamento de outro agente).
- E2E manual no Windows: `tarve package examples/basic/basic.tsx --format zip,msix --version 1.0.0 --publisher "Tarve Examples"` gerou o zip (48 MB) e o `.msix` (50 MB) via `makeappx` do Windows SDK. O build linux-x64 para o deb falhou neste ambiente porque a runtime nativa linux-x64 local está desatualizada (`bun run package:native` no Linux resolve) — limitação do ambiente, não do empacotador.

## Limitações

- **AppImage** não é gerado: exige o runtime AppImage (binário baixado) e um escritor de squashfs; offline, a alternativa é o `tar.gz` com `install.sh`.
- deb: sem `Depends` (bibliotecas do sistema que a runtime nativa usa não são declaradas), apenas `amd64`/`arm64` detectados pelo ELF; sem `conffiles`/changelog/copyright do Debian (lintian reclamaria).
- zip sem zip64 (limite de 4 GB) e sem symlinks.
- MSIX não é assinado; o `Publisher` vira `CN=<publisher>` e precisa bater exatamente com o certificado. Versões MSIX descartam sufixos de pré-release (`1.2.3-beta` → `1.2.3.0`). Apps instalados via MSIX/deb não se autoatualizam (`canInstallUpdate()` é falso nesses locais).
- `makeappx` só é procurado no Windows; no Linux sai apenas a pasta.

## Próximos passos

- **Assinatura**: `--sign` para MSIX/exe reutilizando `TARVE_SIGN_COMMAND` (signtool/Azure Trusted Signing); assinatura GPG de `.deb`/repositório apt.
- **Notarização / macOS**: `.app` + `.dmg`/`.pkg`, codesign e `notarytool` quando houver alvo macOS.
- **Android AAB**: integrar `tarve package --format aab|apk` ao `buildAndroid` existente (hoje via `tarve build --target android --format aab`), incluindo upload-key.
- AppImage com runtime baixado e cache (como os binários Node/bundletool), RPM, Flatpak manifest, instalador MSI/NSIS ou winget manifest.
- `Depends` calculado (ex.: `libwayland-client0`, `libxkbcommon0`, `libgl1`) e `--depends` explícito.
