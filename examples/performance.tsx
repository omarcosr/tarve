import { createApp } from "tarve";
import { App, connectPerformance } from "./performance-view";

const app = createApp(App);
connectPerformance(() => app.update());
await app.ready;
await app.closed;
