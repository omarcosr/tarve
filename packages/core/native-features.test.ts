import { expect, test } from "bun:test";
import { join } from "node:path";
import { detectNativeFeatures, nativeFeaturesFor, parseNativeFeatures, pickNativeVariant, variantFeatures } from "./native-features";

test("a plain app needs no optional native feature on Windows", () => {
  const source = `import { Button, Text, Window, createApp } from "@tarve/core";\njsx(Window, { children: jsx(Text, {}) });`;
  expect(nativeFeaturesFor(source, "win32").features).toEqual([]);
  expect(nativeFeaturesFor(source, "linux").features).toEqual(["vello-gpu"]);
  expect(nativeFeaturesFor(`${source}\ncreateApp(View, { renderer: "cpu" });`, "linux").features).toEqual([]);
});

test("components, intrinsics and URLs pull their features", () => {
  expect(nativeFeaturesFor(`import { Markdown } from "@tarve/core";`, "win32").features).toEqual(["syntax", "markdown"]);
  expect(nativeFeaturesFor(`import { Code as Source } from "@tarve/core";`, "win32").features).toEqual(["syntax"]);
  expect(nativeFeaturesFor(`jsx("video", { src: "clip.mp4" })`, "win32").features).toEqual(["media"]);
  expect(nativeFeaturesFor(`jsx("img", { src: "https://example.com/a.png" })`, "win32").features).toEqual(["net"]);
  expect(nativeFeaturesFor(`jsx("svg", { xmlns: "http://www.w3.org/2000/svg" })`, "win32").features).toEqual([]);
});

test("explicit feature lists are validated", () => {
  expect(parseNativeFeatures(undefined)).toBe("auto");
  expect(parseNativeFeatures("all")).toBe("all");
  expect(parseNativeFeatures("net, media")).toEqual(["net", "media"]);
  expect(() => parseNativeFeatures("gpu")).toThrow(/Unknown native feature/);
});

test("examples resolve to the features they use", async () => {
  const examples = join(import.meta.dir, "../../examples");
  expect((await detectNativeFeatures(join(examples, "counter/counter.tsx"), "win32")).features).toEqual([]);
  expect((await detectNativeFeatures(join(examples, "rich-content/rich-content.tsx"), "win32")).features).toContain("markdown");
  expect((await detectNativeFeatures(join(examples, "video/video.tsx"), "win32")).features).toContain("media");
});

test("the smallest prebuilt variant covering the app is picked", () => {
  expect(pickNativeVariant([], "win32")?.name).toBe("core");
  expect(pickNativeVariant(["markdown"], "win32")?.name).toBe("rich");
  expect(pickNativeVariant(["net"], "win32")?.name).toBe("media");
  expect(pickNativeVariant(["syntax", "media"], "win32")?.name).toBe("rich-media");
  expect(pickNativeVariant(["vello-gpu"], "win32")).toBeUndefined();
  expect(pickNativeVariant(["vello-gpu"], "linux")?.name).toBe("core");
  expect(variantFeatures({ name: "rich", features: ["syntax", "markdown"] }, "linux")).toEqual(["vello-gpu", "syntax", "markdown"]);
});
