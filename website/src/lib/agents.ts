// The site for AI agents: a Markdown copy of every page at its URL plus `.md`,
// /llms.txt (https://llmstxt.org), /llms-full.txt, /sitemap.xml and /robots.txt.
// `bun run docs:agents` renders all of them at build time (scripts/build-agents.ts);
// the dev server renders them on request so edits show up.

import { buildComponentDoc } from "./docs/build";
import { catalog, orderedNames } from "./docs/catalog";
import type { PropDoc } from "./docs/types";
import { findElement, hasClass, htmlToMarkdown, parseHtml } from "./markdown/html";
import { REPO, SITE, docsPage, guides, homePage, showcasePage } from "./site";

const components = new Set(orderedNames);
const guidePaths = new Set(guides.map((guide) => `/docs/${guide.slug}`));

/** True for every HTML page the site serves. */
export function isPage(path: string): boolean {
  if (path === homePage.path || path === showcasePage.path || path === docsPage.path || guidePaths.has(path)) return true;
  const component = /^\/docs\/components\/([^/]+)$/.exec(path)?.[1];
  return !!component && components.has(component);
}

/** `/docs/testing` → `/docs/testing.md`, `/` → `/index.md`. */
export function markdownPath(path: string): string {
  return path === "/" ? "/index.md" : `${path.replace(/\/$/, "")}.md`;
}

/** The HTML page a `.md` path is the copy of, or undefined. */
export function pageForMarkdown(path: string): string | undefined {
  if (!path.endsWith(".md")) return undefined;
  let page = path.slice(0, -3);
  if (page === "/index") page = "/";
  else if (page.endsWith("/index")) page = page.slice(0, -6);
  return isPage(page) ? page : undefined;
}

/** Absolute URLs, and links to our own pages go to their Markdown copies. */
function agentUrl(url: string): string {
  if (!url.startsWith("/") || url.startsWith("//")) return url;
  const [path = "/", hash] = url.split("#", 2);
  const [pathname = "/", query] = path.split("?", 2);
  if (!query && isPage(pathname)) return SITE + markdownPath(pathname) + (hash ? `#${hash}` : "");
  return SITE + url;
}

function footer(path: string, version: string): string {
  return `---\n\nTarve v${version} · HTML version: ${SITE}${path} · Index for agents: ${SITE}/llms.txt`;
}

/** Markdown for a server-rendered page: its <article class="doc">, else its <main>. */
export function pageMarkdown(html: string, path: string, version: string): string {
  const root = parseHtml(html);
  const content =
    findElement(root, (element) => element.tag === "article" && hasClass(element, "doc")) ??
    findElement(root, (element) => element.tag === "main") ??
    findElement(root, (element) => element.tag === "body") ??
    root;
  return `${htmlToMarkdown(content, { href: agentUrl })}\n\n${footer(path, version)}\n`;
}

const cell = (text: string) => text.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim();
const code = (text: string) => {
  const value = cell(text);
  const ticks = "`".repeat(Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length)) + 1);
  return value ? `${ticks}${value}${ticks}` : "";
};

function propsTable(props: PropDoc[]): string {
  const rows = props.map((prop) =>
    [
      code(prop.name) + (prop.optional ? "" : " (required)"),
      code(prop.type),
      prop.default ? code(prop.default) : "—",
      cell(prop.doc ?? ""),
    ].join(" | "),
  );
  return ["| Prop | Type | Default | Description |", "| --- | --- | --- | --- |", ...rows.map((row) => `| ${row} |`)].join("\n");
}

function fence(source: string, info: string): string {
  const longest = Math.max(2, ...(source.match(/`{3,}/g) ?? []).map((run) => run.length));
  const marks = "`".repeat(longest + 1);
  return `${marks}${info}\n${source.trimEnd()}\n${marks}`;
}

/** Markdown reference for one component, built from the same data as its page. */
export function componentMarkdown(name: string, version: string): string | undefined {
  const doc = buildComponentDoc(name);
  if (!doc) return undefined;
  const out = [`# ${doc.name}`, `> ${doc.summary}`];
  if (doc.notes) out.push(doc.notes);
  const facts = [
    `- Category: [${doc.category.title}](${SITE}/docs.md#${doc.category.id})`,
    `- Import: \`${doc.importLine}\``,
    doc.propsType ? `- Props type: \`${doc.propsType}\`${doc.generic ? " (generic)" : ""}` : doc.generic ? "- Generic component" : "",
    `- Source: [${doc.sourceLabel}](${doc.sourceUrl})`,
  ].filter(Boolean);
  out.push(facts.join("\n"));
  out.push("## Usage", fence(doc.example, `tsx title="${doc.name}.tsx"`));
  out.push("## Props", doc.props.length ? propsTable(doc.props) : `${doc.name} has no props of its own beyond the inherited and common props below.`);
  for (const group of doc.inherited) out.push(`### Inherited from \`${group.from}\``, propsTable(group.props));
  if (doc.common.length) {
    out.push(
      "## Common props",
      `Shared by every component (descriptions: ${SITE}/docs.md#common-props): ${doc.common.map((prop) => `\`${prop}\``).join(", ")}.`,
    );
  }
  if (doc.types.length) {
    out.push("## Types", ...doc.types.map((type) => fence(type.code, `ts title="${type.name}"`)));
  }
  const pager = [
    doc.prev ? `Previous: [${doc.prev.name}](${SITE}/docs/components/${doc.prev.name}.md)` : "",
    doc.next ? `Next: [${doc.next.name}](${SITE}/docs/components/${doc.next.name}.md)` : "",
  ].filter(Boolean);
  if (pager.length) out.push(pager.join(" · "));
  return `${out.join("\n\n")}\n\n${footer(`/docs/components/${doc.name}`, version)}\n`;
}

const md = (path: string) => SITE + markdownPath(path);

export function llmsTxt(version: string): string {
  const out = [
    "# Tarve",
    "> Native desktop UI for Bun and TSX on Windows x64, Linux x64 and Android. No browser, no DOM: a Rust runtime lays out with Taffy, shapes text with Parley and paints with D3D11, Vello or the CPU.",
    [
      `Current version: ${version}. Install with \`bun add @tarve/core\` (Bun 1.4+ or Node.js 26.10+); every component is exported from \`@tarve/core\` and the JSX runtime is \`@tarve/core\`, not React.`,
      "Every page of this site has a Markdown copy at its URL plus `.md` (the home page is `/index.md`), and HTML pages also return Markdown when requested with `Accept: text/markdown`.",
      `All of the documentation in one file: ${SITE}/llms-full.txt`,
    ].join("\n"),
    "## Docs",
    [
      `- [${docsPage.name}](${md(docsPage.path)}): Getting started (install, TypeScript setup, a first window), how rendering works, signals, the component catalog and the props every component shares.`,
      ...guides.map((guide) => `- [${guide.name}](${md(`/docs/${guide.slug}`)}): ${guide.description}`),
    ].join("\n"),
  ];
  for (const category of catalog) {
    out.push(
      `## Components: ${category.title}`,
      `${category.description}\n\n${category.items.map((item) => `- [${item.name}](${md(`/docs/components/${item.name}`)}): ${item.summary}`).join("\n")}`,
    );
  }
  out.push(
    "## Optional",
    [
      `- [Home](${md(homePage.path)}): What Tarve is, its specification, the render pipeline and the features in the box.`,
      `- [${showcasePage.name}](${md(showcasePage.path)}): ${showcasePage.description}`,
      `- [Source code](${REPO}): The repository, with README, CHANGELOG and the packages @tarve/core, @tarve/router, @tarve/test, @tarve/headless and @tarve/mcp.`,
      `- [@tarve/core on npm](https://www.npmjs.com/package/@tarve/core): The published package.`,
    ].join("\n"),
  );
  return `${out.join("\n\n")}\n`;
}

/** Every page in reading order: docs home, guides, components. */
export function docsPaths(): string[] {
  return [docsPage.path, ...guides.map((guide) => `/docs/${guide.slug}`), ...orderedNames.map((name) => `/docs/components/${name}`)];
}

export function allPaths(): string[] {
  return [homePage.path, showcasePage.path, ...docsPaths()];
}

/** All docs pages as one Markdown file; `markdown` renders one page. */
export async function llmsFullTxt(version: string, markdown: (path: string) => Promise<string>): Promise<string> {
  const pages = await Promise.all(docsPaths().map(async (path) => `<!-- Source: ${SITE}${path} -->\n\n${(await markdown(path)).trim()}`));
  const head = `# Tarve documentation (v${version})\n\n> The full documentation of ${SITE} in one file, for AI agents. Index: ${SITE}/llms.txt`;
  return `${[head, ...pages].join("\n\n")}\n`;
}

export function sitemapXml(): string {
  const urls = allPaths().map((path) => `  <url><loc>${SITE}${path}</loc></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

export interface AgentFile {
  type: string;
  body: string;
  /** The HTML page a Markdown copy stands for. */
  canonical?: string;
}

/** Server-renders one HTML page; resolves undefined when it does not render. */
export type RenderHtml = (path: string) => Promise<string | undefined>;

/** Every URL with an agent file, `.md` copies under their main name (`/docs.md`, not `/docs/index.md`). */
export function agentFilePaths(): string[] {
  return ["/llms.txt", "/llms-full.txt", "/sitemap.xml", "/robots.txt", ...allPaths().map(markdownPath)];
}

/** The URL an agent file is stored under: `/docs/index.md` → `/docs.md`. */
export function agentFileKey(path: string): string {
  const page = pageForMarkdown(path);
  return page ? markdownPath(page) : path;
}

function pageRenderer(version: string, render: RenderHtml) {
  const pages = new Map<string, Promise<string>>();
  return (page: string): Promise<string> => {
    let markdown = pages.get(page);
    if (!markdown) {
      markdown = (async () => {
        const component = /^\/docs\/components\/([^/]+)$/.exec(page)?.[1];
        const body = component ? componentMarkdown(component, version) : await render(page).then((html) => html && pageMarkdown(html, page, version));
        if (!body) throw new Error(`${page} did not render`);
        return body;
      })();
      pages.set(page, markdown);
    }
    return markdown;
  };
}

async function renderAgentFile(path: string, version: string, markdown: (page: string) => Promise<string>): Promise<AgentFile | undefined> {
  switch (path) {
    case "/llms.txt":
      return { type: "text/plain", body: llmsTxt(version) };
    case "/llms-full.txt":
      return { type: "text/plain", body: await llmsFullTxt(version, markdown) };
    case "/sitemap.xml":
      return { type: "application/xml", body: sitemapXml() };
    case "/robots.txt":
      return { type: "text/plain", body: robotsTxt() };
  }
  const page = pageForMarkdown(path);
  return page ? { type: "text/markdown", body: await markdown(page), canonical: page } : undefined;
}

/** One agent file, rendered now (the dev server). */
export function agentFile(path: string, version: string, render: RenderHtml): Promise<AgentFile | undefined> {
  return renderAgentFile(agentFileKey(path), version, pageRenderer(version, render));
}

/** Every agent file, each page rendered once; throws when a page does not render. */
export async function buildAgentFiles(version: string, render: RenderHtml): Promise<Record<string, AgentFile>> {
  const markdown = pageRenderer(version, render);
  const files: Record<string, AgentFile> = {};
  for (const path of agentFilePaths()) {
    const file = await renderAgentFile(path, version, markdown);
    if (!file) throw new Error(`no agent file for ${path}`);
    files[path] = file;
  }
  return files;
}

export function robotsTxt(): string {
  return `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n# For AI agents: ${SITE}/llms.txt and ${SITE}/llms-full.txt\n`;
}
