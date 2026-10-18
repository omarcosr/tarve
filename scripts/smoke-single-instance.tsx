// One instance per app, and links that open it: a first launch becomes the primary
// instance and opens a window; a second launch with a link and a file hands them to
// it and exits; the primary is brought to the front. Then a URL scheme is registered
// for the user and a link opened through the shell (Windows) reaches the primary.
import { createApp, registerUrlScheme, requestSingleInstance, Text, unregisterUrlScheme, Window } from "@tarve/core";
import { strict as assert } from "node:assert";
import { setTimeout as sleep } from "node:timers/promises";

const scheme = "tarvesmoke";
if (process.argv[2] === "--instance") {
  const id = process.argv[3]!;
  const instance = await requestSingleInstance({ id, schemes: [scheme] });
  console.log(JSON.stringify({ type: "instance", primary: instance.primary, launch: instance.launch }));
  if (!instance.primary) process.exit(0);
  const app = createApp(() => <Window title={`Single instance ${id}`} width={320} height={160}><Text>primary</Text></Window>);
  instance.onSecondInstance(launch => {
    app.activate();
    console.log(JSON.stringify({ type: "second", launch }));
  });
  await app.ready;
  app.minimize();
  console.log(JSON.stringify({ type: "ready", pid: process.pid }));
  await app.closed;
  process.exit(0);
}

const id = `tarve-smoke-${process.pid}`;
interface Message { type: string; primary?: boolean; launch?: { args: string[]; urls: string[] } }
function launch(args: string[]) {
  const child = Bun.spawn([process.execPath, import.meta.path, "--instance", id, ...args], { stdout: "pipe", stderr: "inherit" });
  const messages: Message[] = [];
  void (async () => {
    let buffer = "";
    for await (const chunk of child.stdout) {
      buffer += new TextDecoder().decode(chunk);
      for (let line; (line = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(line + 1)) {
        const text = buffer.slice(0, line).trim();
        if (text.startsWith("{")) messages.push(JSON.parse(text));
      }
    }
  })();
  return { child, messages };
}
async function until<T>(read: () => T | undefined, what: string, ms = 10_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    const value = read();
    if (value !== undefined) return value;
  }
  throw new Error(`timed out waiting for ${what}`);
}
const foreground = async (pid: number) => (await new Response(Bun.spawn(["powershell.exe", "-NoProfile", "-Command", `Add-Type @"
using System; using System.Runtime.InteropServices;
public static class F { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int p); }
"@
$p=0; [F]::GetWindowThreadProcessId([F]::GetForegroundWindow(), [ref]$p) | Out-Null; $p`], { stdout: "pipe" }).stdout).text()).trim() === String(pid);

const primary = launch(["first"]);
try {
  const first = await until(() => primary.messages.find(message => message.type === "instance"), "the first instance");
  assert.equal(first.primary, true, "the first launch is the primary instance");
  await until(() => primary.messages.find(message => message.type === "ready"), "the primary window");

  const second = launch([`${scheme}://open/42`, "notes.txt"]);
  const secondInstance = await until(() => second.messages.find(message => message.type === "instance"), "the second instance");
  assert.equal(secondInstance.primary, false, "a second launch is not primary");
  assert.equal(await second.child.exited, 0, "the second launch exits");
  const handed = await until(() => primary.messages.find(message => message.type === "second"), "the forwarded launch");
  assert.deepEqual(handed.launch?.args, ["--instance", id, `${scheme}://open/42`, "notes.txt"]);
  assert.deepEqual(handed.launch?.urls, [`${scheme}://open/42`], "the link is picked out of the arguments");
  if (process.platform === "win32") {
    let front = false;
    for (let i = 0; i < 20 && !front; i++) { front = await foreground(primary.child.pid); if (!front) await sleep(100); }
    assert.ok(front, "the minimized primary window is restored and brought to the front");
  }

  if (process.platform === "win32") {
    registerUrlScheme(scheme, { name: "Tarve smoke", command: [process.execPath, import.meta.path, "--instance", id] });
    try {
      Bun.spawn(["rundll32.exe", "url.dll,FileProtocolHandler", `${scheme}://from-the-shell/?x=1`]);
      const linked = await until(() => primary.messages.find(message => message.type === "second" && message.launch?.urls[0]?.includes("from-the-shell")), "the link opened by the shell", 15_000);
      assert.deepEqual(linked.launch?.urls, [`${scheme}://from-the-shell/?x=1`], "a link opened by the system reaches the running app");
    } finally {
      unregisterUrlScheme(scheme);
    }
  }
  console.log("smoke:single-instance passed");
} finally {
  primary.child.kill();
}
process.exit(0);
