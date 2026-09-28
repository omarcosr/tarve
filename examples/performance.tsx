import { createApp } from "@tarve/core";
import { App, connectPerformance } from "./performance-view";

const app = createApp(App);
connectPerformance(app);
await app.ready;
await app.closed;
