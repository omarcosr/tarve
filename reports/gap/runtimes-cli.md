# Paridade de runtimes: CLI `tarve` e ferramentas recentes

Regra: tudo o que funciona no Bun deve funcionar no Node.js 26.10+ (e no txiki onde se aplica), sem hacks.
O CLI roda tanto por `bunx tarve` quanto por `npx tarve`.

## 1. Auditoria de APIs exclusivas do Bun

Procurei `Bun.file/write/spawn/which/gzipSync/CryptoHasher/$/YAML/build/zstd*`, `import.meta.dir`, `bun:*` e `typeof Bun`
nos módulos novos e no bundle publicado (`dist/npm/cli.js`, `package-installer.js`, `node-build.js`).

| Módulo | Resultado |
| --- | --- |
| `packages/core/package-installer.ts` (deb/tar/zip/msix/app-zip) | Já neutro: `node:child_process`, `node:crypto`, `node:fs`, `node:path`. |
| `packages/core/archive-formats.ts` (ar, tar+gzip, zip) | Já neutro: só `node:zlib` (`gzipSync`, `deflateRawSync`). |
| `packages/core/macos-bundle.ts`, `macos-sign.ts`, `src/macho.ts` | Já neutros (`node:fs`, `node:child_process`; Mach-O lido à mão). |
| `packages/core/associations-config.ts` | Já neutro (`node:fs`, `node:path`). |
| `packages/core/plugins-build.ts` | Já neutro (`node:crypto`, `node:fs`). Embutir bibliotecas de plugins nos builds Node/txiki é escopo do bg-13. |
| `tarve dev --inspect` (`cli.ts`) | Só define `TARVE_INSPECT=1` antes de `devNode`/`bun --hot`: idêntico nos dois runtimes. |
| `packages/create-tarve/index.js` | ESM puro com `node:*`; `import.meta.main` só é lido se existir (Bun), senão compara `argv[1]`. |

Usos de `Bun.*` que ainda existem no bundle do CLI estão todos em caminhos que só rodam no Bun, e todos têm guarda:
- `build.ts` (build com runtime Bun, `Bun.build`/`zstdCompressSync`): sob Node o CLI repassa ao `bun` (`forward("bun", …)`) antes de chegar lá. É um limite real: um executável Bun precisa do compilador do Bun.
- `android-build.ts` `compileBunApp`: lança `Android builds with --runtime bun need Bun` sob Node (o runtime Android padrão, QuickJS, funciona sob Node).
- `node-build.ts`, `node-dev.ts`, `txiki-build.ts`: `Bun.which` só atrás de `process.versions.bun`; sob Node usam `process.execPath`/`"tjs"`.

**Conclusão:** nenhuma API exclusiva do Bun estava num caminho alcançável por `npx tarve package|build|run|dev`. Nenhuma alteração de código de produção foi necessária.

txiki: o CLI não roda sob `tjs` (precisa de esbuild e `node:child_process`); o txiki é alvo de executável (`tarve build --runtime txiki`), e `--runtime txiki` em `run/dev` já lança erro claro. Limite real, não gap.

## 2. Testes / smoke sob Node

- O repositório **não tem** um padrão para rodar os testes `bun:test` sob Node (nenhum `node --test`, nenhum shim de runner). Não criei um.
- Para não duplicar lógica, extraí os leitores independentes de arquivos (ar, ustar com checksum, zip com CRC-32) para
  `packages/core/archive-readers.ts` (usa `node:assert`, roda em Bun e Node). `package-installer.test.ts` e
  `macos-bundle.test.ts` agora usam esse módulo.
- Novo smoke `scripts/smoke-node-cli-package.ts` (`bun run smoke:node-cli-package`, ligado em `scripts/verify.ts` após `smoke:exe`
  e no job `windows-x64-package` do CI):
  1. cria um projeto temporário (app `examples/node-smoke`, ícone, metadados `tarve`) e liga o staging local
     (`dist/npm` + `native/`, de `bun run package:local`) como `node_modules/@tarve/core`; com `TARVE_NODE_TARBALL` instala o tarball via npm (padrão do `smoke-node-package.ts`);
  2. `node …/dist/npm/cli.js package app.tsx --format <host>` — build real (Node SEA) + pacote do SO anfitrião (zip no Windows, deb+tar no Linux, app-zip no macOS); confere o executável dentro do arquivo byte a byte e executa o binário (headless, imprime `tarve-node-ready`);
  3. empacota pelo mesmo CLI sob Node os formatos dos outros SOs a partir de executáveis só-cabeçalho (ELF → deb+tar, PE → zip, `.app` Mach-O → app-zip), com as mesmas checagens estruturais dos testes (membros do ar, `control`, `md5sums`, modos 0755, link `/usr/bin`, `.desktop`, CRC, `Info.plist`).
  - Limite real: compilar de verdade um app Linux/macOS a partir do Windows exige o runtime nativo daquele SO (`native/linux-x64` atual, que só é gerado no Linux; não há dylib macOS no pacote). O empacotamento em si não depende disso.

## 3. create-tarve sob Node e Bun

`packages/create-tarve/create-tarve.test.ts` ganhou, para cada template (basic, tailwind, svelte, tray), o teste
"Node.js and Bun write the same project": gera o projeto com `node index.js` e com `bun index.js`, para `--runtime bun` e `--runtime node`,
em diretórios temporários, e exige lista de arquivos e bytes idênticos (e `engines` corretos).

## Resultados (Windows x64, Bun 1.4.3, Node 26.10.0)

- `bun scripts/smoke-node-cli-package.ts` → `Tarve Node CLI package smoke PASS (node v26.10.0: built zip, packaged deb, tar, zip, app-zip)`.
- `bun test packages/create-tarve packages/core/package-installer.test.ts packages/core/macos-bundle.test.ts packages/core/macos-sign.test.ts packages/core/associations-package.test.ts packages/core/src/macho.test.ts` → 56 pass, 0 fail.
- `bun run package:local` → OK. `bun run pack` falha no Windows: `native/linux-x64` está obsoleto (protocolo 59, esperado 60) e só pode ser recompilado no Linux — por isso o smoke usa o staging local por padrão.
- `bun run check` → os únicos erros são em `scripts/smoke-runtime-parity.ts` (arquivo em edição pelo bg-13: `Report.result/stages/errors`, `dirname` não usado); nenhum erro nos arquivos deste trabalho.

## Arquivos alterados

- `packages/core/archive-readers.ts` (novo), `packages/core/package-installer.test.ts`, `packages/core/macos-bundle.test.ts`
- `scripts/smoke-node-cli-package.ts` (novo), `package.json` (`smoke:node-cli-package`), `scripts/verify.ts`, `.github/workflows/ci.yml`
- `packages/create-tarve/create-tarve.test.ts`
