import { describe, expect, test } from "bun:test";
import { resetScopedState, scopedState, withRenderScope } from "./render-scope";

const KEY = Symbol("test.counter");
const counter = () => scopedState(KEY, () => ({ n: 0 }));

describe("scopedState", () => {
  test("keeps one value per render scope", () => {
    const a = {}, b = {};
    withRenderScope(a, () => { counter().n += 1; });
    withRenderScope(a, () => { counter().n += 1; });
    withRenderScope(b, () => { counter().n += 10; });
    expect(withRenderScope(a, () => counter().n)).toBe(2);
    expect(withRenderScope(b, () => counter().n)).toBe(10);
  });

  test("a value captured during render survives outside it", () => {
    const scope = {};
    const box = withRenderScope(scope, () => counter());
    box.n = 7;
    expect(withRenderScope(scope, () => counter().n)).toBe(7);
  });

  test("an explicit scope reads the same store as rendering in it", () => {
    const scope = {};
    withRenderScope(scope, () => { counter().n = 3; });
    expect(scopedState(KEY, () => ({ n: 0 }), scope).n).toBe(3);
  });

  test("resetScopedState forgets one scope only", () => {
    const a = {}, b = {};
    withRenderScope(a, () => { counter().n = 1; });
    withRenderScope(b, () => { counter().n = 2; });
    resetScopedState(a);
    expect(withRenderScope(a, () => counter().n)).toBe(0);
    expect(withRenderScope(b, () => counter().n)).toBe(2);
  });
});
