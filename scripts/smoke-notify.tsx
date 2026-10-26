// app.notify without a tray icon: a toast on Windows, org.freedesktop.Notifications on Linux
// (run under a notification server, e.g. scripts/fake-notification-server.py). Checks the
// system accepted it, and that desktops grant every runtime permission.
import { Text, Window, createApp } from "@tarve/core";
import { strict as assert } from "node:assert";

const errors: string[] = [];
const app = createApp(() => <Window title="Tarve notify smoke"><Text>notify</Text></Window>, {
  headless: true,
  onError: event => errors.push(event.error.message),
});
app.onEvent(event => { if (event.type === "error") errors.push(event.message); });
await app.ready;

app.notify({ title: "Tarve smoke", body: "A notification without a tray icon" });
await Bun.sleep(1500);
assert.deepEqual(errors, [], "the notification was accepted");
assert.deepEqual(await app.checkPermissions(["CAMERA"]), { CAMERA: "granted" });
assert.deepEqual(await app.requestPermissions(["CAMERA", "android.permission.RECORD_AUDIO"]), { CAMERA: "granted", "android.permission.RECORD_AUDIO": "granted" });
app.close();
await app.closed;
console.log("notify smoke ok");
