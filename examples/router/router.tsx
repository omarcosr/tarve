// Stack + tab navigation with @tarve/router: typed params, <Link to>, slide transitions,
// Escape / Alt+Left / mouse back on desktops and the hardware back key on Android.
import { createApp } from "@tarve/core";
import { App, tabs } from "./router-view";

// pointerEvents: the mouse's back button reaches the router.
const app = createApp(App, { pointerEvents: true });
tabs.attach(app);
await app.ready;
await app.closed;
