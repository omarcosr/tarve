import { createApp } from "@tarve/core";
import { App, step } from "./liquid-view";

const app = createApp(App);
await app.ready;
step();
app.update();
const timer = setInterval(() => { step(); app.update(); }, 1200);
await app.closed;
clearInterval(timer);
