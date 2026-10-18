import { describe, expect, test } from "bun:test";
import { desktopQuote, instanceAddress, quote, requestSingleInstance, urlsOf } from "./instance";

describe("single instance", () => {
  test("links are picked out of the arguments, not paths or drives", () => {
    const args = ["--flag", "C:\\notes.txt", "file:///tmp/a", "myapp://open/1", "https://example.com", "other://x"];
    expect(urlsOf(args, ["myapp"])).toEqual(["myapp://open/1"]);
    expect(urlsOf(args)).toEqual(["myapp://open/1", "https://example.com", "other://x"]);
  });

  test("launch commands are quoted for the Windows command line and desktop entries", () => {
    expect(quote("C:\\Program Files\\app.exe")).toBe('"C:\\Program Files\\app.exe"');
    expect(quote('say "hi"')).toBe('"say \\"hi\\""');
    expect(quote("C:\\dir\\")).toBe('"C:\\dir\\\\"');
    expect(desktopQuote('/opt/my app/$x "y" 100%')).toBe('"/opt/my app/\\$x \\"y\\" 100%%"');
  });

  test("the address is per app and stable", () => {
    expect(instanceAddress("a")).toBe(instanceAddress("a"));
    expect(instanceAddress("a")).not.toBe(instanceAddress("b"));
  });

  test("a second request hands its launch to the first", async () => {
    const id = `tarve-test-${process.pid}-${Math.random()}`;
    const first = await requestSingleInstance({ id, schemes: ["myapp"] });
    expect(first.primary).toBe(true);
    const handed = new Promise(resolve => first.onSecondInstance(resolve));
    const second = await requestSingleInstance({ id, schemes: ["myapp"] });
    expect(second.primary).toBe(false);
    expect(await handed).toMatchObject({ args: second.launch.args, cwd: process.cwd() });
    first.release();
    const after = await requestSingleInstance({ id });
    expect(after.primary).toBe(true);
    after.release();
  });
});
