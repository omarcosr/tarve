// A stand-in for a Tarve app speaking the control protocol (packages/core/src/devtools/control.ts).
import { writeFileSync } from "node:fs";
import { connect } from "node:net";

const inputs = [];
let text = "Count: 0";
const snapshot = () => ({
  frames: 4, layouts: 1, paints: 4, fps: 60, width: 300, height: 200, scale: 1, hovered: null, focused: null,
  nodes: [
    { id: "root", kind: "view", x: 0, y: 0, width: 300, height: 200, scroll: 0, scrollMax: 0, text: "" },
    { id: "count", kind: "text", x: 10, y: 10, width: 80, height: 20, scroll: 0, scrollMax: 0, text },
    { id: "inc", kind: "pressable", x: 10, y: 40, width: 100, height: 30, scroll: 0, scrollMax: 0, text: "", control: { label: "Increment" } },
    { id: "hidden", kind: "text", x: 0, y: 0, width: 0, height: 0, scroll: 0, scrollMax: 0, text: "Increment" },
  ],
});
const tree = { id: "root", kind: "view", children: [{ id: "count", kind: "text", text, children: [] }, { id: "inc", kind: "pressable", children: [] }] };

console.log("fake app started");
console.error("a warning");
const socket = connect(process.env.TARVE_CONTROL);
const send = message => socket.write(JSON.stringify(message) + "\n");
socket.on("connect", () => send({ type: "hello", token: process.env.TARVE_CONTROL_TOKEN, pid: process.pid, runtime: "fake" }));
socket.setEncoding("utf8");
let buffer = "";
socket.on("data", chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const { id, method, params } = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    let result = null;
    if (method === "inspect" || method === "settle") result = snapshot();
    else if (method === "tree") result = tree;
    else if (method === "stats") result = { js: { heapUsedMb: 1 }, native: { phases: null, memory: null } };
    else if (method === "capture") writeFileSync(params.path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    else if (method === "input") {
      inputs.push(params);
      if (params.action === "up") { text = "Count: 1"; send({ type: "event", event: { type: "click", id: "inc" } }); }
      if (params.action === "text") console.log("typed " + params.text + " after " + inputs.length + " inputs");
    } else if (method === "close") { send({ id, result: null }); send({ type: "closed" }); socket.end(); setTimeout(() => process.exit(0), 10); continue; }
    else if (method !== "focus") { send({ id, error: "unknown " + method }); continue; }
    send({ id, result });
  }
});
