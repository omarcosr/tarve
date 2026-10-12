// <Image src="http://…"> in a hidden window: the native side fetches a URL only
// once the image is painted, lays the image out again with its decoded size,
// and fetches an image further down a scroll view only when it scrolls in.
import { Column, createTestRenderer, Image, Scroll, View, Window } from "@tarve/core";
import { strict as assert } from "node:assert";

const hits = new Map<string, number>();
const svg = (w: number, h: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#e11d48"/></svg>`;
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    if (path === "/missing.svg") return new Response("nope", { status: 404 });
    return new Response(svg(40, 20), { headers: { "content-type": "image/svg+xml", "cache-control": "no-store" } });
  },
});
const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
const errors: string[] = [];
const renderer = await createTestRenderer(() => (
  <Window width={300} height={200}>
    <Scroll id="list" flex={1} style={{ minHeight: 0 }}>
      <Column>
        <Image id="top" src={url("/top.svg")} width={40} />
        <View style={{ height: 1200, shrink: 0 }} />
        <Image id="bottom" src={url("/bottom.svg")} width={40} height={20} />
        <Image id="missing" src={url("/missing.svg")} width={40} height={20} />
      </Column>
    </Scroll>
  </Window>
), { headless: true, onError: event => errors.push(event.error.message) });

async function until(label: string, predicate: () => boolean | Promise<boolean>, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > end) throw new Error(`${label}: timed out; hits ${JSON.stringify([...hits])}; errors ${errors.join(" | ")}`);
    await Bun.sleep(25);
  }
}

try {
  await until("the visible image is fetched", () => hits.get("/top.svg") === 1);
  await until("the decoded size lays it out", async () => (await renderer.getById("top").node()).height === 20);
  await Bun.sleep(200);
  assert.equal(hits.get("/bottom.svg"), undefined, "an image below the fold must not be fetched");
  assert.equal(hits.get("/missing.svg"), undefined);
  for (let i = 0; i < 20 && !hits.get("/bottom.svg"); i++) {
    await renderer.getById("list").wheel(400);
    await Bun.sleep(50);
  }
  await until("scrolling it in fetches it", () => hits.get("/bottom.svg") === 1 && hits.get("/missing.svg") === 1);
  await until("a failed fetch is reported", () => errors.some(message => message.includes("missing.svg")));
  await Bun.sleep(200);
  assert.equal(hits.get("/top.svg"), 1, "a loaded image is not fetched again");
  console.log("remote image smoke passed");
} finally {
  renderer.close();
  server.stop(true);
}
