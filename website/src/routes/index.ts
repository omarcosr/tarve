import { Hono } from "hono";
import { notFoundHandler, shell } from "hono-svelte";
import tarve from "../../../package.json";
import type { HonoSvelteEntries } from "../hono-svelte-entries";
import { agentFile, agentFileKey, buildAgentFiles, isPage, markdownPath, type AgentFile } from "../lib/agents";
import { buildComponentDoc, commonProps, docsCatalog } from "../lib/docs/build";
import { SITE, docsPage, guides, homePage, showcasePage } from "../lib/site";
import { themeBootScript } from "../lib/theme";

const head = [
  `<script>${themeBootScript}</script>`,
  '<meta name="theme-color" content="#f2efe6" media="(prefers-color-scheme: light)">',
  '<meta name="theme-color" content="#12110e" media="(prefers-color-scheme: dark)">',
  '<link rel="icon" type="image/svg+xml" href="/favicon.svg">',
  '<link rel="preload" href="/fonts/Archivo.woff2" as="font" type="font/woff2" crossorigin>',
  '<link rel="preload" href="/fonts/IBMPlexSans.woff2" as="font" type="font/woff2" crossorigin>',
].join("");

const version = tarve.version;

function meta(path: string, title: string, text: string) {
  const url = SITE + path;
  return {
    description: text,
    canonical: url,
    og: { type: "website", site_name: "Tarve", url, title, description: text },
    twitter: { card: "summary", title, description: text },
    extra: `<link rel="alternate" type="text/markdown" href="${SITE}${markdownPath(path)}" title="Markdown for agents">`,
  };
}

const app = new Hono();

// www.tarve.dev → tarve.dev, keeping path and query.
app.use("/*", async (c, next) => {
  const url = new URL(c.req.url);
  if (url.hostname === "www.tarve.dev") {
    url.hostname = "tarve.dev";
    return c.redirect(url.toString(), 301);
  }
  await next();
});

// Files for AI agents: `<page>.md` (or the page itself with `Accept: text/markdown`),
// /llms.txt, /llms-full.txt, /sitemap.xml and /robots.txt. A build serves the copies
// rendered by `bun run docs:agents`; the dev server renders them on request.
const generated = Object.values(
  import.meta.glob<Record<string, AgentFile>>("../lib/generated/agents.json", { eager: true, import: "default" }),
)[0];

async function renderHtml(path: string, env?: unknown): Promise<string | undefined> {
  const response = await app.request(path, { headers: { accept: "text/html" } }, env);
  return response.ok ? response.text() : undefined;
}

/** Every agent file, for scripts/build-agents.ts. */
export function renderAgentFiles(): Promise<Record<string, AgentFile>> {
  return buildAgentFiles(version, (path) => renderHtml(path));
}

app.use("/*", async (c, next) => {
  const path = c.req.path;
  const negotiated = isPage(path) && /\btext\/markdown\b/i.test(c.req.header("accept") ?? "");
  const wanted = negotiated ? markdownPath(path) : path;
  const file = import.meta.env.DEV ? await agentFile(wanted, version, (page) => renderHtml(page, c.env)) : generated?.[agentFileKey(wanted)];
  if (file) {
    c.header("content-type", `${file.type}; charset=utf-8`);
    c.header("cache-control", "public, max-age=3600");
    c.header("access-control-allow-origin", "*");
    if (file.canonical) c.header("link", `<${SITE}${file.canonical}>; rel="canonical"`);
    if (negotiated) c.header("vary", "Accept");
    return c.body(file.body);
  }
  await next();
  if (isPage(path) && c.res.headers.get("content-type")?.includes("text/html")) {
    c.res.headers.append("link", `<${SITE}${markdownPath(path)}>; rel="alternate"; type="text/markdown"`);
    c.res.headers.append("vary", "Accept");
  }
});

app.use("/*", shell({ title: "Tarve", lang: "en", head }));

app.get(homePage.path, (c) =>
  c.render("index", { title: homePage.title, data: { version, section: "home" }, head: meta(homePage.path, homePage.title, homePage.description) }),
);

app.get(showcasePage.path, (c) =>
  c.render("showcase", {
    title: showcasePage.title,
    data: { version, section: "showcase" },
    head: meta(showcasePage.path, showcasePage.title, showcasePage.description),
  }),
);

app.get(docsPage.path, (c) =>
  c.render("docs/index", {
    title: docsPage.title,
    data: { version, section: "docs", categories: docsCatalog(), commonProps: commonProps() },
    head: meta(docsPage.path, docsPage.title, docsPage.description),
  }),
);

for (const guide of guides) {
  const path = `/docs/${guide.slug}`;
  const title = `${guide.name} — Tarve docs`;
  app.get(path, (c) =>
    c.render(`docs/${guide.slug}` as HonoSvelteEntries, { title, data: { version, section: "docs" }, head: meta(path, title, guide.description) }),
  );
}

app.get("/docs/components/:name", (c) => {
  const doc = buildComponentDoc(c.req.param("name"));
  if (!doc) return c.notFound();
  const title = `${doc.name} — Tarve docs`;
  return c.render("docs/component", {
    title,
    data: { section: "docs", name: doc.name, doc },
    head: meta(`/docs/components/${doc.name}`, title, `${doc.name}: ${doc.summary}`),
  });
});

app.notFound(notFoundHandler());

export default app;
