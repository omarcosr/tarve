import { createApp } from "@tarve/core";
import { App, scene, step } from "./liquid-view";

// Liquid Glass needs the D3D11 renderer (Windows). Other renderers show the tints only.
const app = createApp(App);
await app.ready;
step();
app.update();
const timer = setInterval(() => { step(); app.update(); }, 1200);
await app.closed;
clearInterval(timer);
void scene;
