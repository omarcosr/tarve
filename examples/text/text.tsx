import { createApp } from "@tarve/core";
import { App } from "./text-view";

const app = createApp(App);
await app.closed;
