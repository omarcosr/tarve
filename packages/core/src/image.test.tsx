import { afterEach, describe, expect, test } from "bun:test";
import { Image, Window } from "./components";
import { clearImageSourceCache, loadImageSource, serializeImageSource } from "./components/image";
import { compileTree, diffTreeMutations } from "./reconciler";

afterEach(() => clearImageSourceCache());

describe("dynamic image sources", () => {
  test("serializes encoded bytes, data URLs and raw RGBA without a temporary file", () => {
    const bytes = compileTree(
      <Window><Image id="bytes" src={Uint8Array.of(1, 2, 3)} width={10} height={10}/></Window>,
    ).nodes.get("bytes")!;
    expect(bytes.src).toBeUndefined();
    expect(bytes.image?.kind).toBe("encoded");
    expect(bytes.image?.data).toBe("AQID");

    const dataUrl = compileTree(
      <Window><Image id="data-url" src="data:image/png;base64,AQID" width={10} height={10}/></Window>,
    ).nodes.get("data-url")!;
    expect(dataUrl.image?.kind).toBe("encoded");
    expect(dataUrl.image?.data).toBe("AQID");
    expect(dataUrl.image?.kind === "encoded" ? dataUrl.image.mediaType : undefined).toBe("image/png");

    const rgba = compileTree(
      <Window><Image id="rgba" src={{ rgba: Uint8Array.of(255, 0, 0, 255), width: 1, height: 1, cacheKey: "preview" }}/></Window>,
    ).nodes.get("rgba")!;
    expect(rgba.image).toEqual({
      kind: "rgba",
      key: "preview",
      data: "/wAA/w==",
      width: 1,
      height: 1,
    });
  });

  test("rejects malformed RGBA and direct HTTP strings with actionable errors", () => {
    expect(() => compileTree(
      <Window><Image id="bad" src={{ rgba: Uint8Array.of(1, 2, 3), width: 1, height: 1 }}/></Window>,
    )).toThrow("exactly 4 bytes");
    expect(() => compileTree(
      <Window><Image id="remote" src="https://example.test/image.png"/></Window>,
    )).toThrow("loadImageSource");
  });

  test("HTTP loader reuses its bounded cache and forwards AbortSignal", async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    let calls = 0;
    let seenSignal: AbortSignal | null | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      seenSignal = init?.signal;
      return new Response(Uint8Array.of(7, 8, 9), {
        status: 200,
        headers: { "content-type": "image/png", "content-length": "3" },
      });
    }) as typeof fetch;
    try {
      const first = await loadImageSource("https://example.test/image.png", { signal: controller.signal });
      const second = await loadImageSource("https://example.test/image.png");
      expect(calls).toBe(1);
      expect(seenSignal).toBe(controller.signal);
      expect([...first.bytes]).toEqual([7, 8, 9]);
      expect([...second.bytes]).toEqual([7, 8, 9]);
      expect(second.bytes).not.toBe(first.bytes);
      expect(first.mediaType).toBe("image/png");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("HTTP loader enforces response limits before reading a declared oversized body", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(Uint8Array.of(1, 2, 3), {
      status: 200,
      headers: { "content-length": "1024" },
    })) as unknown as typeof fetch;
    try {
      await expect(loadImageSource("https://example.test/large.png", { maxBytes: 16 })).rejects.toThrow("response limit");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("HTTP cache still honors a stricter maxBytes on later reads", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(Uint8Array.of(1, 2, 3, 4), {
        status: 200,
        headers: { "content-length": "4" },
      });
    }) as unknown as typeof fetch;
    try {
      await loadImageSource("https://example.test/cached-limit.png", { maxBytes: 8 });
      await expect(loadImageSource(
        "https://example.test/cached-limit.png",
        { maxBytes: 3 },
      )).rejects.toThrow("3 byte response limit");
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("image source validation", () => {
  test("RGBA sources must have valid dimensions and exact byte length", () => {
    expect(() => serializeImageSource({ width: 0, height: 1, rgba: new Uint8Array(0) })).toThrow("dimensions");
    expect(() => serializeImageSource({ width: 1.5, height: 1, rgba: new Uint8Array(4) })).toThrow("dimensions");
    expect(() => serializeImageSource({ width: 2, height: 2, rgba: new Uint8Array(4) })).toThrow("exactly 16 bytes");
    const ok = serializeImageSource({ width: 1, height: 1, rgba: new Uint8Array([1, 2, 3, 4]), premultiplied: true });
    expect(ok).toMatchObject({ image: { kind: "rgba", width: 1, height: 1, premultiplied: true } });
  });

  test("encoded sources reject empty bytes and keep the media type in the key", () => {
    expect(() => serializeImageSource(new Uint8Array(0))).toThrow("empty");
    const a = serializeImageSource({ bytes: new Uint8Array([1]), mediaType: "image/png" });
    const b = serializeImageSource({ bytes: new Uint8Array([1]), mediaType: "image/webp" });
    expect("image" in a && "image" in b && a.image.key !== b.image.key).toBe(true);
  });

  test("percent-encoded data URLs decode bytes and UTF-8 text", () => {
    const source = serializeImageSource("data:image/svg+xml,%3Csvg%3E\u00e9");
    expect(source).toMatchObject({ image: { kind: "encoded", mediaType: "image/svg+xml" } });
    const data = "image" in source ? Buffer.from(source.image.data, "base64").toString("utf8") : "";
    expect(data).toBe("<svg>\u00e9");
    expect(() => serializeImageSource("data:")).toThrow("Invalid image data URL");
  });

  test("empty paths are rejected", () => {
    expect(() => serializeImageSource("")).toThrow("must not be empty");
  });

  test("loadImageSource validates protocol, cache mode and byte limit", async () => {
    await expect(loadImageSource("file:///tmp/a.png")).rejects.toThrow("only HTTP(S)");
    await expect(loadImageSource("https://example.test/a.png", { cache: "bogus" as never })).rejects.toThrow("cache mode");
    await expect(loadImageSource("https://example.test/a.png", { maxBytes: 0 })).rejects.toThrow("maxBytes");
  });
});

test("changing an image's bytes or cache key patches the node", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const view = (key: string) => <Window title="i"><Image id="img" src={{ bytes: png, cacheKey: key }} width={10} height={10} /></Window>;
  const a = compileTree(view("a"));
  const b = compileTree(view("b"));
  expect(diffTreeMutations(a, b)!.map(m => m.type === "patch" ? m.node.id : m.type)).toEqual(["img"]);
  expect(diffTreeMutations(b, compileTree(view("b")))).toEqual([]);
});
