import { render } from "@tarve/core";
import { App } from "./glass-view";

// Liquid Glass needs the D3D11 renderer (Windows). Other renderers show the tint only.
await render(App);
