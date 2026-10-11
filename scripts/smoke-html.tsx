// Drives examples/html/html-view.tsx in a hidden window: required validation, a
// checkbox, a radio group, a select, a textarea and form submission through real
// native input; every section renders.
import { createTestRenderer } from "@tarve/core";
import { strict as assert } from "node:assert";
import { App, state } from "../examples/html/html-view";

const errors: string[] = [];
const renderer = await createTestRenderer(App, { headless: true, onError: event => errors.push(event.error.message) });
const wait = (ms = 200) => new Promise(resolve => setTimeout(resolve, ms));
// Tall enough that both columns fit without scrolling.
renderer.app.debug({ type: "resize", width: 900, height: 2400 });
await wait(500);
await renderer.getById("submit").click();
await wait();
assert.equal(state.invalid, "email is required");
await renderer.getById("email").fill("ana@example.com");
await renderer.getById("news").click();
await renderer.getByText("Pro", { exact: true }).click();
await renderer.getById("country-trigger").click();
await wait();
await renderer.getById("country-option-pt").click();
await renderer.getById("message").fill("Olá");
await wait();
await renderer.getById("submit").click();
await wait();
const values = JSON.parse(state.submitted);
assert.deepEqual({ email: values.email, news: values.news, plan: values.plan, country: values.country, message: values.message },
  { email: "ana@example.com", news: true, plan: "pro", country: "pt", message: "Olá" });
assert.equal(state.invalid, "");
const snapshot = await renderer.app.inspect();
assert.ok(snapshot.nodes.some(node => node.text === "Ana Maria"), "table cells render");
for (const id of ["people", "spans", "pre", "disk", "upload", "photo", "chart"]) assert.ok(snapshot.nodes.some(node => node.id === id && node.width > 0 && node.height > 0), `${id} renders`);
assert.ok(snapshot.nodes.some(node => node.text === "Team"), "table caption renders");
assert.ok(snapshot.nodes.some(node => node.text?.includes("Native TSX desktop apps")), "description list renders");
await renderer.getById("more-summary").click();
await wait();
await wait();
assert.ok((await renderer.app.inspect()).nodes.some(node => node.text?.includes("laid out like a browser")), "details opens");
assert.deepEqual(errors, []);
renderer.app.close();
console.log("[tarve smoke:html] PASS");
