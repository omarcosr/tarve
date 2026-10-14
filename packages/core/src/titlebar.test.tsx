import { describe, expect, test } from "bun:test";
import { TitleBar, Window } from "./components";
import { compileTree } from "./reconciler";

describe("TitleBar", () => {
  test("buttonStyle shapes every window control and keeps their actions", () => {
    const tree = compileTree(<Window><TitleBar id="bar" showMaximize={false} buttonStyle={{ width: 36, height: 36, radius: 18 }} /></Window>);
    const buttons = [...tree.nodes.values()].filter(node => node.windowAction);
    expect(buttons.map(node => node.windowAction)).toEqual(["minimize", "close"]);
    for (const button of buttons) expect([button.style.width, button.style.height, button.style.radius]).toEqual([36, 36, 18]);
    expect(tree.document.window.decorations).toBe(false);
  });
});
