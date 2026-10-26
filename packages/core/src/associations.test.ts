import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  androidIntentFilters, desktopMimeTypes, fileUrlPath, fileTypeMime, fileTypeProgId, fileTypeRegistryCommands, fileTypeUnregistryCommands,
  msixExtensions, normalizeExtension, normalizeScheme, parseOpenArgs, protocolRegistryCommands, protocolUnregistryCommands, sharedMimeInfo,
} from "./associations";
import { createOpenRequests, type OpenEvent } from "./app/open-requests";

const note = { ext: ".TarveNote", name: "Tarve note" };

describe("deep links and file types", () => {
  test("file URLs become paths without node:url (the Android runtime has none)", () => {
    expect(fileUrlPath("file:///home/a/b%20c.txt", false)).toBe("/home/a/b c.txt");
    expect(fileUrlPath("file://localhost/tmp/x?y#z", false)).toBe("/tmp/x");
    expect(() => fileUrlPath("file://server/x", false)).toThrow(TypeError);
    expect(fileUrlPath("file:///C:/Users/A%20B/n.note", true)).toBe("C:\\Users\\A B\\n.note");
    expect(fileUrlPath("file://server/share/n.note", true)).toBe("\\\\server\\share\\n.note");
    expect(() => fileUrlPath("file:///a%2Fb", false)).toThrow(TypeError);
    expect(fileUrlPath(pathToFileURL(resolve("x y.note")).href)).toBe(resolve("x y.note"));
  });

  test("schemes and extensions are validated and normalized", () => {
    expect(normalizeScheme("MyApp")).toBe("myapp");
    expect(() => normalizeScheme("c")).toThrow(/Invalid URL scheme/);
    expect(() => normalizeScheme("my app")).toThrow();
    expect(normalizeExtension(".MD")).toBe("md");
    expect(normalizeExtension("tar.gz")).toBe("tar.gz");
    expect(() => normalizeExtension("a/b")).toThrow(/Invalid file extension/);
    expect(fileTypeMime(note)).toBe("application/x-tarvenote");
    expect(fileTypeMime({ ext: "md", name: "Markdown", mime: "text/markdown" })).toBe("text/markdown");
  });

  test("launch arguments: links of the app's schemes, files of its types", () => {
    const cwd = resolve("/work");
    const args = ["--flag", "--tarve-script", "steps.json", "myapp://open/1?x=2", "https://example.com", "other://x", "notes.tarvenote", "C:\\docs\\b.TARVENOTE", "readme.md", pathToFileURL(resolve("/tmp/c.tarvenote")).href];
    const opened = parseOpenArgs(args, { protocols: ["MyApp"], fileTypes: [note], cwd });
    expect(opened.urls).toEqual(["myapp://open/1?x=2"]);
    expect(opened.files).toEqual([join(cwd, "notes.tarvenote"), resolve(cwd, "C:\\docs\\b.TARVENOTE"), resolve("/tmp/c.tarvenote")]);
  });

  test("without declared types, files are arguments naming existing files", () => {
    const cwd = resolve("/work");
    const exists = (path: string) => path.endsWith("real.txt");
    const opened = parseOpenArgs(["real.txt", "missing.txt", "--tarve-snapshot", "real.txt", "xy://z"], { cwd, exists });
    expect(opened).toEqual({ urls: ["xy://z"], files: [join(cwd, "real.txt")] });
  });

  test("Windows registration is per user, under HKCU\\Software\\Classes", () => {
    const command = ["C:\\Program Files\\Acme\\Acme.exe"];
    expect(protocolRegistryCommands("MyApp", { name: "Acme", command })).toEqual([
      ["add", "HKCU\\Software\\Classes\\myapp", "/ve", "/d", "URL:Acme", "/f"],
      ["add", "HKCU\\Software\\Classes\\myapp", "/v", "URL Protocol", "/d", "", "/f"],
      ["add", "HKCU\\Software\\Classes\\myapp\\shell\\open\\command", "/ve", "/d", '"C:\\Program Files\\Acme\\Acme.exe" "%1"', "/f"],
    ]);
    expect(protocolRegistryCommands("myapp", { name: "Acme", command, icon: "C:\\a.ico" })[2]).toEqual(["add", "HKCU\\Software\\Classes\\myapp\\DefaultIcon", "/ve", "/d", "C:\\a.ico", "/f"]);
    expect(protocolUnregistryCommands("myapp")).toEqual([["delete", "HKCU\\Software\\Classes\\myapp", "/f"]]);

    const progId = fileTypeProgId("Acme.Notes", note.ext);
    expect(progId).toBe("Acme.Notes.tarvenote");
    expect(fileTypeProgId("x".repeat(80), "md").length).toBeLessThanOrEqual(39);
    expect(fileTypeRegistryCommands({ ...note, icon: "C:\\note.ico" }, { progId, command: ["C:\\bun.exe", "C:\\app.tsx"] })).toEqual([
      ["add", "HKCU\\Software\\Classes\\Acme.Notes.tarvenote", "/ve", "/d", "Tarve note", "/f"],
      ["add", "HKCU\\Software\\Classes\\Acme.Notes.tarvenote\\DefaultIcon", "/ve", "/d", "C:\\note.ico", "/f"],
      ["add", "HKCU\\Software\\Classes\\Acme.Notes.tarvenote\\shell\\open\\command", "/ve", "/d", '"C:\\bun.exe" "C:\\app.tsx" "%1"', "/f"],
      ["add", "HKCU\\Software\\Classes\\.tarvenote\\OpenWithProgids", "/v", "Acme.Notes.tarvenote", "/t", "REG_NONE", "/f"],
      ["add", "HKCU\\Software\\Classes\\.tarvenote", "/ve", "/d", "Acme.Notes.tarvenote", "/f"],
    ]);
    expect(fileTypeRegistryCommands(note, { progId, command: ["a.exe"], setDefault: false }).some(args => args[1] === "HKCU\\Software\\Classes\\.tarvenote" && args[2] === "/ve")).toBe(false);
    expect(fileTypeUnregistryCommands(note, progId)).toEqual([
      ["delete", "HKCU\\Software\\Classes\\Acme.Notes.tarvenote", "/f"],
      ["delete", "HKCU\\Software\\Classes\\.tarvenote\\OpenWithProgids", "/v", "Acme.Notes.tarvenote", "/f"],
    ]);
  });

  test("Linux: desktop MimeType and shared-mime-info for the app's own types", () => {
    expect(desktopMimeTypes(["myapp"], [note, { ext: "md", name: "Markdown", mime: "text/markdown" }])).toBe("x-scheme-handler/myapp;application/x-tarvenote;text/markdown;");
    expect(desktopMimeTypes()).toBeUndefined();
    const xml = sharedMimeInfo([note, { ext: "md", name: "Markdown", mime: "text/markdown" }, { ext: "acme", name: "A & B", mime: "application/vnd.acme" }])!;
    expect(xml).toContain('<mime-type type="application/x-tarvenote">');
    expect(xml).toContain('<glob pattern="*.tarvenote"/>');
    expect(xml).toContain("<comment>A &amp; B</comment>");
    expect(xml).not.toContain("text/markdown");
    expect(sharedMimeInfo([{ ext: "md", name: "Markdown", mime: "text/markdown" }])).toBeUndefined();
  });

  test("MSIX extensions and Android intent filters", () => {
    const msix = msixExtensions(["myapp"], [{ ...note, logo: "Assets\\FileType-tarvenote.png" }]);
    expect(msix).toContain('<uap:Extension Category="windows.protocol">');
    expect(msix).toContain('<uap:Protocol Name="myapp" />');
    expect(msix).toContain('<uap:FileTypeAssociation Name="tarvenote">');
    expect(msix).toContain('<uap:FileType ContentType="application/x-tarvenote">.tarvenote</uap:FileType>');
    expect(msix).toContain("<uap:Logo>Assets\\FileType-tarvenote.png</uap:Logo>");
    expect(msixExtensions()).toBe("");
    const android = androidIntentFilters(["MyApp"]);
    expect(android).toContain('<action android:name="android.intent.action.VIEW"/>');
    expect(android).toContain('<category android:name="android.intent.category.BROWSABLE"/>');
    expect(android).toContain('<data android:scheme="myapp"/>');
  });
});

describe("app.onOpenUrl / onOpenFiles", () => {
  const cwd = resolve("/work");

  test("the initial launch reaches each listener once, after it is added", async () => {
    const errors: unknown[] = [];
    const opens = createOpenRequests({ protocols: ["myapp"], fileTypes: [note], launch: { args: ["myapp://a", "x.tarvenote", "y.txt"], cwd }, report: error => errors.push(error) });
    const urls: [string, OpenEvent][] = [];
    const files: string[][] = [];
    opens.onOpenUrl((url, event) => urls.push([url, event]));
    opens.onOpenFiles(paths => files.push(paths));
    expect(urls).toEqual([]);
    await Promise.resolve();
    expect(urls).toEqual([["myapp://a", { initial: true, args: ["myapp://a", "x.tarvenote", "y.txt"], cwd }]]);
    expect(files).toEqual([[join(cwd, "x.tarvenote")]]);
    opens.onOpenUrl(() => { throw new Error("listener failed"); });
    await Promise.resolve();
    expect(errors).toHaveLength(1);
    opens.dispose();
  });

  test("launches forwarded by requestSingleInstance reach the listeners", async () => {
    const { requestSingleInstance } = await import("./instance");
    const id = `tarve-open-test-${process.pid}-${Math.random()}`;
    const first = await requestSingleInstance({ id });
    expect(first.primary).toBe(true);
    const opens = createOpenRequests({ protocols: ["myapp"], fileTypes: [note], launch: { args: [], cwd }, report: error => { throw error; } });
    const opened = new Promise<[string, OpenEvent]>(resolve => opens.onOpenUrl((url, event) => resolve([url, event])));
    const files = new Promise<string[]>(resolve => opens.onOpenFiles(resolve));
    // A second launch: its arguments come from this process's argv, so hand them over as one would.
    opens.dispatch({ args: ["myapp://second", "z.tarvenote"], cwd }, false);
    const [url, event] = await opened;
    expect(url).toBe("myapp://second");
    expect(event.initial).toBe(false);
    expect(await files).toEqual([join(cwd, "z.tarvenote")]);
    const second = await requestSingleInstance({ id });
    expect(second.primary).toBe(false);
    first.release();
    opens.dispose();
  });

  test("listeners hear launches handed over through the single-instance channel", async () => {
    const instance = await import("./instance");
    const heard = new Promise(resolve => {
      const stop = instance.onForwardedLaunch(launch => { stop(); resolve(launch); });
    });
    const id = `tarve-open-channel-${process.pid}-${Math.random()}`;
    const first = await instance.requestSingleInstance({ id });
    const second = await instance.requestSingleInstance({ id });
    expect(second.primary).toBe(false);
    expect(await heard).toMatchObject({ args: second.launch.args, cwd: process.cwd() });
    first.release();
  });
});
