import { createApp } from "@tarve/core";
import { lucideReactAdapter } from "@tarve/react-icons";
import { App, bindRefresh } from "./glass-controls-view";

const app = createApp(App, { componentAdapters: [lucideReactAdapter] });
bindRefresh(() => app.update());
await app.closed;
