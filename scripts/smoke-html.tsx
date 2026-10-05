// Drives examples/html-view.tsx in a hidden window: required validation, a
// checkbox, a radio group and form submission through real native input.
import { createTestRenderer } from "@tarve/core";
import { strict as assert } from "node:assert";
import { App, state } from "../examples/html-view";

const errors: string[] = [];
const renderer = await createTestRenderer(App, { headless: true, onError: event => errors.push(event.error.message) });
const wait = (ms = 200) => new Promise(resolve => setTimeout(resolve, ms));
await wait(400);
await renderer.getById("submit").click();
await wait();
assert.equal(state.invalid, "email is required");
await renderer.getById("email").fill("ana@example.com");
await renderer.getById("news").click();
await renderer.getByText("Pro", { exact: true }).click();
await wait();
await renderer.getById("submit").click();
await wait();
const values = JSON.parse(state.submitted);
assert.deepEqual({ email: values.email, news: values.news, plan: values.plan }, { email: "ana@example.com", news: true, plan: "pro" });
assert.equal(state.invalid, "");
const snapshot = await renderer.app.inspect();
assert.ok(snapshot.nodes.some(node => node.text === "Ana Maria"), "table cells render");
renderer.app.focus("more-summary");
await wait();
await renderer.getById("more-summary").click();
await wait();
assert.ok((await renderer.app.inspect()).nodes.some(node => node.text?.includes("laid out like a browser")), "details opens");
assert.deepEqual(errors, []);
renderer.app.close();
console.log("[tarve smoke:html] PASS");
