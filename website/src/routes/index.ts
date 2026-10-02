import { Hono } from "hono";
import { notFoundHandler, shell } from "hono-svelte";
import tarve from "../../../package.json";
import { buildComponentDoc, commonProps, docsCatalog } from "../lib/docs/build";

const SITE = "https://tarve.dev";

const head = [
  '<meta name="theme-color" content="#07070b">',
  '<link rel="icon" type="image/svg+xml" href="/favicon.svg">',
  '<link rel="preconnect" href="https://fonts.googleapis.com">',
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap">',
].join("");

const version = tarve.version;
const description =
  "Tarve: native desktop UI for Bun + TSX. No browser, no DOM — Taffy layout, Parley text and Vello/D3D11 rendering.";

function meta(path: string, title: string, text: string) {
  const url = SITE + path;
  return {
    description: text,
    canonical: url,
    og: { type: "website", site_name: "Tarve", url, title, description: text },
    twitter: { card: "summary", title, description: text },
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

app.use("/*", shell({ title: "Tarve", lang: "en", head }));

app.get("/", (c) => {
  const title = "Tarve — native interfaces written in TSX";
  return c.render("index", { title, data: { version, section: "home" }, head: meta("/", title, description) });
});

app.get("/docs", (c) => {
  const title = "Documentation — Tarve";
  return c.render("docs/index", {
    title,
    data: { version, section: "docs", categories: docsCatalog(), commonProps: commonProps() },
    head: meta("/docs", title, "Tarve documentation: getting started, rendering model and every built-in component."),
  });
});

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
