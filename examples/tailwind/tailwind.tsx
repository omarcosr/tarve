import { createApp } from "@tarve/core";
import { App } from "./tailwind-view";

const app = createApp(App, { renderer: "gpu" });
await app.ready;
await app.closed;
