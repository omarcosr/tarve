// Every page of the site in one place: the routes, the Markdown copies for
// agents, llms.txt and the sitemap are all generated from this list.

export const SITE = "https://tarve.dev";
export const REPO = "https://github.com/omarcosr/tarve";

export const description =
  "Tarve: native desktop UI for Bun + TSX. No browser, no DOM — Taffy layout, Parley text and Vello/D3D11 rendering.";

export interface GuidePage {
  /** URL path, also the Svelte entry under src/pages. */
  slug: string;
  /** Short name, as in the page's <h1>. */
  name: string;
  description: string;
}

export const guides: GuidePage[] = [
  { slug: "tailwind", name: "Tailwind classes", description: "Tailwind CSS utility classes on native Tarve elements: class, className, tw(), variants and the supported vocabulary." },
  { slug: "updates", name: "Auto-updates", description: "Signed auto-updates for Tarve apps: tarve keygen, tarve release, Authenticode signing and checkForUpdate." },
  { slug: "desktop", name: "Desktop integration", description: "Translucent windows, several windows, system file drops, single instance and URL links, remembered windows and a themed menu bar in Tarve." },
  { slug: "tooling", name: "Project and dev tools", description: "create-tarve templates, tarve dev hot reload, the error overlay, the frame-time graph and the visual inspector." },
  { slug: "router", name: "Navigation", description: "@tarve/router: stack and tab navigation with typed params, transitions and back gestures for Tarve apps." },
  { slug: "testing", name: "Testing", description: "@tarve/test: Testing Library–style tests, queries, events and image snapshots on the WebAssembly runtime." },
  { slug: "plugins", name: "Plugins", description: "Tarve plugins: definePlugin, typed commands, lifecycle hooks and native libraries through FFI." },
  { slug: "shipping", name: "Build and package", description: "tarve build, tarve package (deb, tar.gz, zip, MSIX), Android APK and App Bundle builds, and macOS status." },
  { slug: "runtimes", name: "Runtimes", description: "Bun, Node.js, txiki.js/QuickJS-ng and Go: what each Tarve runtime supports." },
  { slug: "platform", name: "Platform APIs", description: "Deep links, file associations, notifications, permissions, share sheet, location and biometrics in Tarve." },
  { slug: "media", name: "Audio and video", description: "<audio> and <video> in Tarve: native decoders, streaming, events, controls, media keys and background playback." },
  { slug: "system", name: "System integration", description: "Tray icons, global hotkeys, file dialogs, desktop widgets, clipboard paste, app icon and metadata, custom title bars and icons in Tarve." },
  { slug: "motion", name: "Motion", description: "Native transitions in Tarve: interpolated in Rust, retargetable, with motionFrom, AnimatePresence and onTransitionEnd." },
  { slug: "android", name: "Android", description: "Build a Tarve app into an APK or App Bundle: what works on Android, permissions, engines and the differences from the desktop." },
  { slug: "effects", name: "Visual effects", description: "Backdrop blur, filter blur and drop-shadow, mask-image, multiple backgrounds and viewport units in Tarve, on every renderer." },
  { slug: "automation", name: "Automation and errors", description: "TestRenderer on the real renderer, @tarve/headless in WebAssembly, pixel regression helpers and the onError handler in Tarve." },
];

export const homePage = { path: "/", name: "Tarve", title: "Tarve — native interfaces written in TSX", description };
export const showcasePage = {
  path: "/showcase",
  name: "Showcase",
  title: "Showcase — Tarve",
  description: "Apps built with Tarve: Termio, a YouTube Music client, Tarve Studio and more, each screenshot painted by Tarve itself.",
};
export const docsPage = {
  path: "/docs",
  name: "Documentation",
  title: "Documentation — Tarve",
  description: "Tarve documentation: getting started, rendering model and every built-in component.",
};
