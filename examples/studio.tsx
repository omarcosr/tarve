import { createApp } from "tarve";
import { build } from "tarve/build";
import { join } from "node:path";
import { App, connectStudio } from "./studio-view";

const app = createApp(App);
connectStudio({
  refresh: () => app.update(),
  build: () => build({
    entrypoint: join(import.meta.dir, "studio.tsx"),
    outfile: join(import.meta.dir, "dist", process.platform === "win32" ? "Studio.exe" : "Studio"),
    name: "Tarve Studio",
  }),
});
await app.ready;
await app.closed;
