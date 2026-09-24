import { describe, expect, test } from "bun:test";
import { Style } from "./style";

describe("Style helpers", () => {
  test("Style.create preserves typed style maps without runtime rewriting", () => {
    const styles = Style.create({
      button: { height: 36, focus: { outlineWidth: 2 }, focusVisible: { outlineOffset: 3 } },
      label: { foreground: "#ffffff" },
    });
    expect(styles.button.height).toBe(36);
    expect(styles.button.focus?.outlineWidth).toBe(2);
    expect(styles.button.focusVisible?.outlineOffset).toBe(3);
    expect(styles.label.foreground).toBe("#ffffff");
  });

  test("Style.merge deep-merges interactive states instead of replacing them", () => {
    const merged = Style.merge(
      {
        background: "#111111",
        focus: { outlineWidth: 2, outlineColor: "#aaaaaa", outlineStyle: "solid" },
        focusVisible: { outlineWidth: 2, outlineColor: "#bbbbbb" },
        hover: { background: "#222222" },
      },
      {
        focus: { outlineWidth: 0, outlineStyle: "none" },
        focusVisible: { outlineOffset: 4 },
        hover: { borderColor: "#333333" },
      },
    );
    expect(merged.background).toBe("#111111");
    expect(merged.focus).toEqual({
      outlineWidth: 0,
      outlineColor: "#aaaaaa",
      outlineStyle: "none",
    });
    expect(merged.focusVisible).toEqual({
      outlineWidth: 2,
      outlineColor: "#bbbbbb",
      outlineOffset: 4,
    });
    expect(merged.hover).toEqual({ background: "#222222", borderColor: "#333333" });
  });
});
