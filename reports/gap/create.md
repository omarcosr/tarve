# create-tarve: relatório de progresso

## O que foi feito

Novo pacote `packages/create-tarve` (npm `create-tarve`, versão 0.7.0, bin `create-tarve`), que entra automaticamente no workspace (`packages/*`).

- `packages/create-tarve/index.js`: o CLI é um único arquivo ESM em JavaScript puro e não tem dependências. Ele não é escrito em TypeScript porque o Node se recusa a remover tipos dentro de `node_modules`. Funciona em Node 26.10+ e em Bun.
  - Prompts simples com `node:readline/promises` (sem inquirer): diretório, template (lista numerada, também aceita o nome) e runtime. Também confirma escrever num diretório não vazio, mas só em TTY.
  - Flags: `--template/-t`, `--runtime/-r bun|node`, `--title`, `--yes/-y`, `--force/-f`, `--help`, `--version`. A forma `--flag=valor` também é aceita.
  - O runtime padrão vem de `npm_config_user_agent` (`bun create` → bun, `npm create` → node).
  - Recusa diretório não vazio sem `--force` (`.git`, `.DS_Store` e `Thumbs.db` são ignorados). Com `--force` não apaga nada, só escreve por cima.
  - Substitui os placeholders `__APP_NAME__` (nome npm normalizado) e `__APP_TITLE__` (título derivado do nome ou de `--title`).
  - Gera `package.json` (dependência `@tarve/core ^0.7.0`; scripts `dev`/`start`/`build` = `tarve dev|run|build <entry> --runtime <rt>` e `typecheck`; campo `tarve.name`; `@types/bun` ou `@types/node`; `engines`), `tsconfig.json` conforme o README (`types: [rt, "@tarve/core/assets"]`), `.gitignore` e `README.md`.
  - No fim imprime os próximos passos (`cd`, `bun install`/`npm install`, `bun run dev`/`npm run dev`).
- Templates em `packages/create-tarve/templates/<id>/{template.json,files/}`:
  - `basic`: contador com componentes.
  - `tailwind`: contador com classes Tailwind 4 e alternância claro/escuro.
  - `svelte`: Svelte 5 via `@tarve/svelte` (`app.ts` + `App.svelte`, `bunfig.toml` com preload no Bun, tipos `@tarve/svelte/elements`).
  - `tray`: bandeja do sistema com menu, notificações, `closeBehavior: "hide"` e ícone em `assets/icon.png`, referenciado por `tarve.icon`.
- `packages/create-tarve/README.md`.
- Testes: `packages/create-tarve/create-tarve.test.ts`.

Não foram alterados `scripts/setup-examples.ts`, `native/src`, `tsconfig.json` da raiz nem `packages/core`.

## Uso

```sh
bun create tarve my-app
npm create tarve@latest my-app
bun create tarve my-app --template tailwind --runtime bun --yes
npm create tarve@latest my-app -- --template svelte --runtime node --yes
```

## Testes

`bun test packages/create-tarve`: **18 pass, 0 fail** (143 expects, cerca de 1,2 s).

- Para cada template (basic, tailwind, svelte, tray):
  - Gera o projeto via CLI num diretório temporário.
  - Confere os arquivos, a ausência de placeholders e o conteúdo de `package.json`/`tsconfig.json`.
  - Roda `tsc --noEmit` com o TypeScript do repositório. O `tsconfig` gerado é reescrito com `paths` para `packages/*/src`, ou seja, contra o workspace local. Verifiquei à parte que um erro de tipo proposital faz o `tsc` falhar.
  - Roda `Bun.build` da entry contra o workspace. O svelte usa `sveltePlugin` de `@tarve/svelte/plugin`.
- Testes do CLI: recusa de diretório não vazio e `--force`; template/runtime/opção inválidos; prompts por readline com stdin em pipe; `--yes` com o user-agent do bun; `--help`/`--version`; execução sob Node real (`node index.js … --runtime node`).
- `tsc --noEmit` da raiz passa (o `include: ["packages"]` também cobre os templates e o teste).

## Limitações

- O typecheck nos testes troca `types` por `["bun"]` com `typeRoots` na raiz, porque `@types/node` não está instalado no repositório. Os templates com `--runtime node` não são checados com `@types/node` de verdade.
- Não há teste end-to-end com `bun install` a partir do registro: `@tarve/core@0.7.0` e `create-tarve` ainda precisam ser publicados. Também não há teste que abra a janela nativa.
- Os prompts são por linha (número ou nome). Não há navegação por setas.
- Não roda `install` automaticamente nem faz `git init`.
- Não há template `multi-window`: o README diz que multi-janela ainda não faz parte do modelo público.
- `@types/node` usa a faixa `>=24`.

## Próximos passos

- Incluir `packages/create-tarve` nos scripts de release/pack (`scripts/package.ts`, `release-policy`, `version-policy`) e no `test` da raiz.
- Opções `--install` e `--git`, e detecção de pnpm/yarn nos próximos passos.
- Template `multi-window` quando a API pública existir, e templates `router`/`test` usando `@tarve/router` e `@tarve/test`.
- Smoke test que publica localmente (`npm pack`) e roda `npm create` / `bun create` contra o tarball.
