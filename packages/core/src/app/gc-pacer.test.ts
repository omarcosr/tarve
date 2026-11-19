import { expect, test } from "bun:test";
import { collectInBackground } from "./gc-pacer";

test("windows hidden together share one collection, then release once", async () => {
  let released = 0;
  collectInBackground(() => { released++; });
  collectInBackground(() => { released++; });
  expect(released).toBe(0);
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(released).toBe(1);
  collectInBackground(() => { released++; });
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(released).toBe(2);
});
