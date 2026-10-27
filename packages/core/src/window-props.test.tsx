import { expect, test } from "bun:test";
import { Text, Window } from "./components";
import { compileTree } from "./reconciler";

test("<Window maximized> opens the window maximized", () => {
  expect(compileTree(<Window maximized><Text>a</Text></Window>).document.window?.maximized).toBe(true);
  expect(compileTree(<Window><Text>a</Text></Window>).document.window?.maximized).toBeUndefined();
});
