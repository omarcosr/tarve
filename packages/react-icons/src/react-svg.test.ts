import { expect, test } from "bun:test";
import { memoizeAdapter, type ComponentAdapter } from "./react-svg";

test("memoizeAdapter runs an adapter once per component and primitive props", () => {
  let calls = 0;
  const adapter = memoizeAdapter((({ props }) => { calls++; return { type: "svg", props: { svg: String(props.size) } }; }) as ComponentAdapter);
  const Icon = { $$typeof: Symbol.for("react.forward_ref"), render: () => null };
  const first = adapter({ type: Icon, props: { size: 16, color: "red" } });
  expect(adapter({ type: Icon, props: { size: 16, color: "red" } })).toBe(first!);
  expect(calls).toBe(1);
  adapter({ type: Icon, props: { size: 20, color: "red" } });
  expect(calls).toBe(2);
  // Objects (style, children, handlers) are not keyed: every call adapts again.
  adapter({ type: Icon, props: { size: 16, style: { margin: 2 } } });
  adapter({ type: Icon, props: { size: 16, style: { margin: 2 } } });
  expect(calls).toBe(4);
});
