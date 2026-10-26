// Android smoke for deep links and the device APIs (reports/gap/android-apis.md):
//   bun packages/core/cli.ts build scripts/smoke-android-apis.tsx --target android-x64 --name ApiSmoke --app-id dev.tarve.apismoke --protocol myapp --outfile dist/ApiSmoke.apk
//   adb install -r dist/ApiSmoke.apk && adb shell am start -a android.intent.action.VIEW -d myapp://test
//   adb logcat -s tarve   # "smoke open-url myapp://test initial=true"; a second am start: initial=false
// The buttons call share (text, then a file), getCurrentPosition and authenticate and log their results;
// add `--permission ACCESS_FINE_LOCATION --permission ACCESS_COARSE_LOCATION` for a fix.
import { Button, Column, Text, Window, createApp } from "@tarve/core";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function shareFile() {
  const path = join(tmpdir(), "tarve-smoke.txt");
  writeFileSync(path, "shared by the Tarve smoke\n");
  void app.share({ title: "Tarve file", files: [path] }).then(result => log(`share-file ${JSON.stringify(result)}`));
}

const lines: string[] = [];
const log = (line: string) => {
  console.log(`smoke ${line}`);
  lines.push(line);
  app.update();
};

const app = createApp(() => (
  <Window title="API smoke">
    <Column style={{ padding: 16, gap: 8 }}>
      <Button onClick={() => void app.share({ title: "Tarve", text: "Hello from Tarve", url: "https://tarve.dev" }).then(result => log(`share ${JSON.stringify(result)}`))}>Share</Button>
      <Button onClick={shareFile}>Share file</Button>
      <Button onClick={() => void app.getCurrentPosition({ timeoutMs: 10_000 }).then(result => log(`position ${JSON.stringify(result)}`))}>Location</Button>
      <Button onClick={() => void app.authenticate({ reason: "Tarve smoke" }).then(result => log(`authenticate ${JSON.stringify(result)}`))}>Authenticate</Button>
      {lines.map((line, index) => <Text key={index}>{line}</Text>)}
    </Column>
  </Window>
), { protocols: ["myapp"], fileTypes: [{ ext: "txt", name: "Text", mime: "text/plain" }] });

app.onOpenUrl((url, event) => log(`open-url ${url} initial=${event.initial}`));
app.onOpenFiles((files, event) => log(`open-files ${files.join(",")} initial=${event.initial}`));
