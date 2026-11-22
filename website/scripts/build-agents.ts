// Renders the files for AI agents (a Markdown copy of every page, llms.txt, llms-full.txt,
// sitemap.xml and robots.txt) into src/lib/generated/agents.json, which the built server
// serves as is. Pages are server-rendered through Vite, the same way the dev server does.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { createServer } from "vite";
import type { AgentFile } from "../src/lib/agents";

const root = resolve(import.meta.dir, "..");
const out = resolve(root, "src/lib/generated/agents.json");

const server = await createServer({
  root,
  configFile: resolve(root, "vite.config.ts"),
  appType: "custom",
  logLevel: "warn",
  server: { middlewareMode: true, hmr: false, ws: false },
});
try {
  const routes = (await server.ssrLoadModule("/src/routes/index.ts")) as { renderAgentFiles(): Promise<Record<string, AgentFile>> };
  const files = await routes.renderAgentFiles();
  const json = JSON.stringify(files);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, json);
  console.log(`${Object.keys(files).length} agent files, ${(json.length / 1024).toFixed(0)} KB → ${relative(root, out)}`);
} finally {
  await server.close();
}
