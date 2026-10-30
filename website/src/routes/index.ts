import { Hono } from "hono";
import { notFoundHandler, shell } from "hono-svelte";
import tarve from "../../../package.json";
import { buildComponentDoc, commonProps, docsCatalog } from "../lib/docs/build";
import { themeBootScript } from "../lib/theme";

const SITE = "https://tarve.dev";

const head = [
  `<script>${themeBootScript}</script>`,
  '<meta name="theme-color" content="#f2efe6" media="(prefers-color-scheme: light)">',
  '<meta name="theme-color" content="#12110e" media="(prefers-color-scheme: dark)">',
  '<link rel="icon" type="image/svg+xml" href="/favicon.svg">',
  '<link rel="preload" href="/fonts/Archivo.woff2" as="font" type="font/woff2" crossorigin>',
  '<link rel="preload" href="/fonts/IBMPlexSans.woff2" as="font" type="font/woff2" crossorigin>',
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

app.get("/docs/tailwind", (c) => {
  const title = "Tailwind classes — Tarve docs";
  return c.render("docs/tailwind", {
    title,
    data: { version, section: "docs" },
    head: meta("/docs/tailwind", title, "Tailwind CSS utility classes on native Tarve elements: class, className, tw(), variants and the supported vocabulary."),
  });
});

app.get("/docs/updates", (c) => {
  const title = "Auto-updates — Tarve docs";
  return c.render("docs/updates", {
    title,
    data: { version, section: "docs" },
    head: meta("/docs/updates", title, "Signed auto-updates for Tarve apps: tarve keygen, tarve release, Authenticode signing and checkForUpdate."),
  });
});

app.get("/docs/desktop", (c) => {
  const title = "Desktop integration — Tarve docs";
  return c.render("docs/desktop", {
    title,
    data: { version, section: "docs" },
    head: meta("/docs/desktop", title, "Translucent windows, several windows, system file drops, single instance and URL links, remembered windows and a themed menu bar in Tarve."),
  });
});

app.get("/docs/tooling", (c) => {
  const title = "Project and dev tools — Tarve docs";
  return c.render("docs/tooling", {
    title,
    data: { version, section: "docs" },
    head: meta("/docs/tooling", title, "create-tarve templates, tarve dev hot reload, the error overlay, the frame-time graph and the visual inspector."),
  });
});

app.get("/docs/router", (c) => {
  const title = "Navigation — Tarve docs";
  return c.render("docs/router", {
    title,
    data: { version, section: "docs" },
    head: meta("/docs/router", title, "@tarve/router: stack and tab navigation with typed params, transitions and back gestures for Tarve apps."),
  });
});

app.get("/docs/testing", (c) => {
  const title = "Testing — Tarve docs";
  return c.render("docs/testing", {
    title,
    data: { version, section: "docs" },
    head: meta("/docs/testing", title, "@tarve/test: Testing Library–style tests, queries, events and image snapshots on the WebAssembly runtime."),
  });
});

app.get("/docs/plugins", (c) => {
  const title = "Plugins — Tarve docs";
  return c.render("docs/plugins", {
    title,
    data: { version, section: "docs" },
    head: meta("/docs/plugins", title, "Tarve plugins: definePlugin, typed commands, lifecycle hooks and native libraries through FFI."),
  });
});

app.get("/docs/shipping", (c) => {
  const title = "Build and package — Tarve docs";
  return c.render("docs/shipping", {
    title,
    data: { version, section: "docs" },
    head: meta("/docs/shipping", title, "tarve build, tarve package (deb, tar.gz, zip, MSIX), Android APK and App Bundle builds, and macOS status."),
  });
});

app.get("/docs/runtimes", (c) => {
  const title = "Runtimes — Tarve docs";
  return c.render("docs/runtimes", {
    title,
    data: { version, section: "docs" },
    head: meta("/docs/runtimes", title, "Bun, Node.js, txiki.js/QuickJS-ng and Go: what each Tarve runtime supports."),
  });
});

app.get("/docs/platform", (c) => {
  const title = "Platform APIs — Tarve docs";
  return c.render("docs/platform", {
    title,
    data: { version, section: "docs" },
    head: meta("/docs/platform", title, "Deep links, file associations, notifications, permissions, share sheet, location and biometrics in Tarve."),
  });
});

app.get("/docs/media", (c) => {
  const title = "Audio and video — Tarve docs";
  return c.render("docs/media", {
    title,
    data: { version, section: "docs" },
    head: meta("/docs/media", title, "<audio> and <video> in Tarve: native decoders, streaming, events, controls, media keys and background playback."),
  });
});

app.get("/docs/system", (c) => {
  const title = "System integration — Tarve docs";
  return c.render("docs/system", {
    title,
    data: { version, section: "docs" },
    head: meta("/docs/system", title, "Tray icons, global hotkeys, file dialogs, desktop widgets, clipboard paste, app icon and metadata, custom title bars and icons in Tarve."),
  });
});

app.get("/docs/motion", (c) => {
  const title = "Motion — Tarve docs";
  return c.render("docs/motion", {
    title,
    data: { version, section: "docs" },
    head: meta("/docs/motion", title, "Native transitions in Tarve: interpolated in Rust, retargetable, with motionFrom, AnimatePresence and onTransitionEnd."),
  });
});

app.get("/docs/android", (c) => {
  const title = "Android — Tarve docs";
  return c.render("docs/android", {
    title,
    data: { version, section: "docs" },
    head: meta("/docs/android", title, "Build a Tarve app into an APK or App Bundle: what works on Android, permissions, engines and the differences from the desktop."),
  });
});

app.get("/docs/effects", (c) => {
  const title = "Visual effects — Tarve docs";
  return c.render("docs/effects", {
    title,
    data: { version, section: "docs" },
    head: meta("/docs/effects", title, "Backdrop blur, filter blur and drop-shadow, mask-image, multiple backgrounds and viewport units in Tarve, on every renderer."),
  });
});

app.get("/docs/automation", (c) => {
  const title = "Automation and errors — Tarve docs";
  return c.render("docs/automation", {
    title,
    data: { version, section: "docs" },
    head: meta("/docs/automation", title, "TestRenderer on the real renderer, @tarve/headless in WebAssembly, pixel regression helpers and the onError handler in Tarve."),
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
