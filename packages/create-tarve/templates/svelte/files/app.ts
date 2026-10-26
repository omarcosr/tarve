// `tarve run|dev|build` compile .svelte imports through @tarve/svelte.
import { mount } from "@tarve/svelte";
import App from "./App.svelte";

const { app } = mount(App, { window: { title: "__APP_TITLE__", width: 480, height: 360, titleBar: true } });
await app.closed;
