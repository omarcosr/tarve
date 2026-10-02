# Tarve website

Landing page and component documentation for [`@tarve/core`](../README.md), built with
[hono-svelte](https://github.com/omarcosr/hono-svelte). This folder is a standalone Bun app and is not part
of the published npm package.

## Scripts

| Command | What it does |
| --- | --- |
| `bun run dev` | Vite dev server with HMR on http://localhost:5173 |
| `bun run build` | Regenerates the API data, then builds client and server into `dist/` |
| `bun run start` | Serves the production build (`PORT` defaults to 3000) |
| `bun run docs:api` | Extracts props, defaults, JSDoc and types from `packages/core` into `src/lib/generated/api.json` |
| `bun run docs:check` | Fails when a component lacks a catalog entry or example, then type-checks every example |
| `bun run typecheck` | Type-checks the site itself |
| `bun run build:cf` | Builds the Cloudflare Worker (`dist-cf/worker.js`) and its static assets (`dist-cf/public`) |
| `bun run preview:cf` | Builds and runs the Worker locally with `wrangler dev` |
| `bun run deploy` | Builds and deploys to Cloudflare Workers (`wrangler login` once first) |

## Documentation sources

- `src/lib/docs/catalog.ts` — categories, order and one-line summaries.
- `src/lib/docs/examples/<Component>.tsx` — one usage example per component, type-checked against the real sources.
- `src/lib/generated/api.json` — generated; do not edit by hand.

When a component is added to `@tarve/core`, run `bun run docs:api`, add it to the catalog, write its example and run
`bun run docs:check`.

## hono-svelte patch

`patches/hono-svelte@0.5.0.patch` (applied automatically by `bun install`) makes pages that have a `<script>`
render on the server and hydrate on the client. Upstream 0.5.0 only server-renders script-less pages, so every
interactive page would otherwise ship an empty `<body>` until its JavaScript loads. Drop the patch once
hono-svelte supports SSR + hydration for interactive pages.

## Cloudflare Workers

`wrangler.jsonc` deploys the server-rendered app as the `tarve` Worker on https://tarve.dev (custom domain; `www.tarve.dev` answers with a 301 to the apex); files in `dist-cf/public` are served as
Workers static assets before the Worker runs. `public/_headers` marks hashed chunks as immutable. The worker build
resolves Svelte with the `worker` export condition so pages render with Svelte's server runtime.
