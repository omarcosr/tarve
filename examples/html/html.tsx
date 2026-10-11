import { createApp } from "@tarve/core";
import { App } from "./html-view";

const app = createApp(App);
await app.closed;
