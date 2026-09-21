import { App } from "../examples/basic";
import { createApp } from "@tarve/core";
import { verifyExecutable } from "./verify-executable";

const app = createApp(App, { debug: true });
const errors: string[] = [];
app.onEvent(event => { if (event.type === "error") errors.push(event.message); });
try {
  await app.ready;
  await verifyExecutable(app, errors);
} finally {
  app.close();
  await app.closed;
}
