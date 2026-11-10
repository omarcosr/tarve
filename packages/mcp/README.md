# @tarve/mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for Tarve apps in development. It starts your
app with `tarve dev` (hot reload) and lets an AI agent see and drive the real native window: the node tree,
screenshots, clicks and typing through native hit testing, logs, events, metrics and restarts.

```sh
bun add -d @tarve/mcp
```

MCP client config (Claude Desktop, Claude Code, Cursor, VS Code…):

```json
{ "mcpServers": { "tarve": { "command": "bunx", "args": ["tarve-mcp", "src/app.tsx"] } } }
```

With Node.js: `"command": "npx", "args": ["tarve-mcp", "src/app.tsx", "--runtime", "node"]`. A built app
(`tarve build`, txiki.js executables included) runs as it is: `"args": ["tarve-mcp", "dist/App.exe"]`.

`bun scripts/smoke-mcp.ts [--node | --txiki]` checks it against a real window on each runtime.

| Options | |
| --- | --- |
| `--run` | `tarve run` instead of `tarve dev` (no hot reload) |
| `--runtime bun\|node` | passed to the tarve CLI |
| `--inspect` | also opens the visual inspector window |
| `--cwd <dir>` | the app's working directory |
| `--exec <command…>` | start the app with your own command (`tarve-mcp --exec bun --hot app.tsx`); `--` works too where the runtime keeps it (Bun drops it) |

## Tools

- **Read**: `app_status`, `inspect_tree` (outline `kind#id "text" [x,y wxh]`), `query_nodes`, `screenshot` (PNG), `wait_for`.
- **Drive**: `click`, `hover`, `type_text`, `press_key`, `scroll`, `drag`, `focus`. Target a node by visible text or label, by id, or by a window point (logical px). Each tool waits for the next frame.
- **Develop**: `reload` (restarts the process), `get_metrics` (JS and native phase percentiles, memory, fps), `get_events`, `get_logs` (the app's stdout and stderr).

There is no `eval`: tools only read the app and send it input.

## How it connects

The server makes a private socket (a named pipe on Windows, a Unix socket in a 0700 temporary directory
elsewhere) and starts the app with `TARVE_CONTROL` (that address) and `TARVE_CONTROL_TOKEN` (a random token).
`createApp` sees the variable, turns on debug, connects out and presents the token
(`packages/core/src/devtools/control.ts`). The app listens on nothing, and a normal launch, or one with
`dev: false`, never connects. stdout carries only MCP messages; the app's output is kept for `get_logs`.
