# create-tarve

Scaffold a new [Tarve](https://github.com/omarcosr/tarve) app.

```sh
bun create tarve my-app
npm create tarve@latest my-app
# or: bunx create-tarve my-app / npx create-tarve my-app
```

Missing answers are prompted for (directory, template, runtime). Flags skip the prompts:

```sh
bun create tarve my-app --template tailwind --runtime bun --yes
npm create tarve@latest my-app -- --template svelte --runtime node --yes
```

| Option | |
| --- | --- |
| `-t, --template <name>` | `basic`, `tailwind`, `svelte`, `tray` |
| `-r, --runtime bun\|node` | scripts, `@types/*` and `engines` for Bun 1.4+ or Node.js 26.10+ (default: the runtime running create-tarve) |
| `--title <title>` | display name (default: from the directory name) |
| `-y, --yes` | never prompt; defaults are `basic` and the launching runtime |
| `-f, --force` | write into a non-empty directory (existing files with the same names are overwritten) |

## Templates

- **basic**: a counter with `Window`, `Column`, `Text` and `Button`.
- **tailwind**: the counter styled with Tailwind CSS 4 classes (compiled natively by `@tarve/core`) and a light/dark switch.
- **svelte**: a Svelte 5 counter through `@tarve/svelte` (`app.ts` + `App.svelte`; Bun projects get a `bunfig.toml` preload).
- **tray**: a system tray app with a menu, notifications and hide-on-close.

Every project gets a `package.json` with `@tarve/core` and the scripts `dev` (`tarve dev`), `start` (`tarve run`), `build` (`tarve build`) and `typecheck`, the README's `tsconfig.json`, a `.gitignore` and a `README.md`.

No dependencies: the CLI is one ESM file using `node:readline`, so it runs on Node.js 26.10+ and Bun.
