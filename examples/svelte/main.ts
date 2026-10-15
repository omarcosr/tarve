// `tarve run`/`tarve build` compile .svelte imports through @tarve/svelte.
import { mount } from "@tarve/svelte";
import App from "./App.svelte";

const { app } = mount(App, { window: { title: "Svelte todos", width: 520, height: 560, minWidth: 420, minHeight: 420, titleBar: true } });
await app.closed;
