import { describe, expect, test } from "bun:test";
import { tw } from "./tailwind";
import { jsx } from "./jsx-runtime";
import { compileTree } from "./reconciler";
import { Window, View } from "./components";
import { darkTheme, lightTheme, theme } from "./theme";

describe("tailwind classes", () => {
  test("layout, spacing and sizing", () => {
    expect(tw("flex flex-col items-center justify-between gap-2 p-4 px-6 mt-1 w-full h-10 min-w-0 max-w-md")).toEqual({
      display: "flex", direction: "column", align: "center", justify: "between", gap: 8,
      padding: { top: 16, right: 24, bottom: 16, left: 24 }, margin: { top: 4 },
      width: "100%", height: 40, minWidth: 0, maxWidth: 448,
    });
    expect(tw("w-1/2 -m-2 size-8 p-px p-[10px] w-[50%] absolute inset-0 -top-1 z-10")).toEqual({
      width: "50%", margin: -8, height: 32, padding: 10, position: "absolute",
      top: -4, right: 0, bottom: 0, left: 0, zIndex: 10,
    });
    expect(tw("grid grid-cols-3 col-span-2 flex-1 grow shrink-0 hidden")).toEqual({
      display: "none", columns: 3, gridColumn: "span 2", flex: 1, grow: 1, shrink: 0,
    });
  });

  test("colours: palette, opacity modifier, theme tokens and arbitrary values", () => {
    expect(tw("bg-zinc-900 text-white border-red-500/50 bg-[#123456]")).toEqual({
      background: "#123456", foreground: "#ffffff", borderColor: "#fb2c3680",
    });
    expect(tw("bg-primary text-muted-foreground border-border")).toEqual({
      background: theme.colors.primary, foreground: theme.colors.mutedForeground, borderColor: theme.colors.border,
    });
    expect(tw("text-[#fff] bg-transparent")).toEqual({ foreground: "#fff", background: "transparent" });
  });

  test("typography", () => {
    expect(tw("text-sm font-semibold italic uppercase truncate leading-tight tracking-wide tabular-nums text-center")).toEqual({
      fontSize: 14, lineHeight: 1.25, fontWeight: 600, fontStyle: "italic", textTransform: "uppercase",
      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", letterSpacing: 0.35,
      fontVariantNumeric: "tabular-nums", textAlign: "center",
    });
    expect(tw("text-[13px] font-mono font-[500] line-clamp-2 underline")).toEqual({
      fontSize: 13, fontFamily: "monospace", fontWeight: 500, lineClamp: 2, overflow: "hidden", textDecoration: "underline",
    });
  });

  test("borders, radius, shadow, opacity, cursor, transforms, transitions", () => {
    expect(tw("border border-t-2 rounded-lg shadow-md opacity-50 cursor-pointer select-none")).toEqual({
      borderWidth: { top: 2, right: 1, bottom: 1, left: 1 }, radius: 8,
      boxShadow: "0 4px 6px -1px #0000001a, 0 2px 4px -2px #0000001a",
      opacity: 0.5, cursor: "pointer", userSelect: "none",
    });
    expect(tw("border-2 border-dashed rounded-full ring-2 ring-blue-500 ring-offset-2")).toEqual({
      borderWidth: 2, borderStyle: "dashed", radius: 9999, outlineWidth: 2, outlineStyle: "solid",
      outlineColor: "#2b7fff", outlineOffset: 2,
    });
    expect(tw("scale-105 -translate-y-1 transition duration-300 ease-out aspect-video")).toEqual({
      transform: { scale: 1.05, y: -4 }, transition: { all: { duration: 300, easing: "easeOut" } }, aspectRatio: 16 / 9,
    });
  });

  test("state variants map to hover/focus/active/disabled; unsupported variants are dropped", () => {
    expect(tw("bg-white hover:bg-zinc-100 focus-visible:ring-2 active:scale-95 disabled:opacity-50 md:p-8 group-hover:p-8 dark:bg-black")).toEqual({
      background: "#ffffff",
      dark: { background: "#000000" },
      hover: { background: "#f4f4f5" },
      focusVisible: { outlineWidth: 2, outlineStyle: "solid" },
      active: { transform: { scale: 0.95 } },
      disabled: { opacity: 0.5 },
    });
  });

  test("gradients compile to a linear gradient object, order-independent", () => {
    expect(tw("from-blue-500 bg-gradient-to-r to-purple-500")).toEqual({
      background: { type: "linear", to: "right", stops: [{ color: "#2b7fff", offset: 0 }, { color: "#ad46ff", offset: 1 }] },
    });
    // Tailwind 4's implicit end stop is transparent.
    expect(tw("bg-linear-to-br from-primary via-white hover:from-black")).toEqual({
      background: { type: "linear", to: "bottom right", stops: [{ color: theme.colors.primary, offset: 0 }, { color: "#ffffff", offset: 0.5 }, { color: "transparent", offset: 1 }] },
      hover: { background: { type: "linear", to: "bottom", stops: [{ color: "#000000", offset: 0 }, { color: "transparent", offset: 1 }] } },
    });
    expect(tw("bg-radial from-white to-black")).toEqual({ background: { type: "radial", stops: [{ color: "#ffffff", offset: 0 }, { color: "#000000", offset: 1 }] } });
    expect(tw("bg-conic-90 from-white via-20% via-black")).toEqual({ background: { type: "conic", from: 90, stops: [{ color: "#ffffff", offset: 0 }, { color: "#000000", offset: 0.2 }, { color: "transparent", offset: 1 }] } });
    expect(tw("mx-auto mt-2")).toEqual({ margin: { left: "auto", right: "auto", top: 8 } });
    expect(tw("shadow-md shadow-red-500/50 backdrop-blur-sm backdrop-saturate-150 animate-spin")).toEqual({
      boxShadow: "0 4px 6px -1px #fb2c3680, 0 2px 4px -2px #fb2c3680", glass: { blur: 8, saturate: 1.5 }, spin: 1000,
    });
    expect(tw("bg-gradient-to-r")).toEqual({});
  });

  test("gap-x/gap-y, justify-around/evenly and dark: variants", () => {
    expect(tw("gap-x-4 gap-y-2 justify-around")).toEqual({ columnGap: 16, rowGap: 8, justify: "around" });
    expect(tw("justify-evenly")).toEqual({ justify: "evenly" });
    expect(tw("bg-white text-black dark:bg-zinc-900 dark:text-white dark:hover:bg-zinc-800 dark:from-black dark:to-white")).toEqual({
      background: "#ffffff", foreground: "#000000",
      dark: {
        background: { type: "linear", to: "bottom", stops: [{ color: "#000000", offset: 0 }, { color: "#ffffff", offset: 1 }] },
        foreground: "#ffffff", hover: { background: "#27272a" },
      },
    });
  });

  test("dark: overrides apply under a dark window theme only and never reach the native tree", () => {
    const scene = (selected: typeof lightTheme) => compileTree(
      <Window theme={selected}>
        <div id="box" className="bg-white hover:bg-zinc-100 dark:bg-zinc-900 dark:hover:bg-zinc-800" style={{ justifyContent: "space-evenly" }} />
      </Window>,
    );
    const light = scene(lightTheme).nodes.get("box")!.style as Record<string, unknown>;
    expect(light).toMatchObject({ background: "#ffffff", hover: { background: "#f4f4f5" }, justify: "evenly" });
    expect("dark" in light).toBe(false);
    const dark = scene(darkTheme).nodes.get("box")!.style as Record<string, unknown>;
    expect(dark).toMatchObject({ background: "#18181b", hover: { background: "#27272a" } });
    expect("dark" in dark).toBe(false);
  });

  test("per-side and per-corner radii, collapsing back to a number when uniform", () => {
    expect(tw("rounded-t-lg")).toEqual({ radius: { topLeft: 8, topRight: 8, bottomRight: 0, bottomLeft: 0 } });
    expect(tw("rounded-lg rounded-b-none")).toEqual({ radius: { topLeft: 8, topRight: 8, bottomRight: 0, bottomLeft: 0 } });
    expect(tw("rounded-tl-xl rounded-br-[3px]")).toEqual({ radius: { topLeft: 12, topRight: 0, bottomRight: 3, bottomLeft: 0 } });
    expect(tw("rounded-t-md rounded-b-md")).toEqual({ radius: 6 });
    expect(tw("rounded-l rounded-r")).toEqual({ radius: 4 });
    expect(tw("rounded-t-lg rounded-full")).toEqual({ radius: 9999 });
    const tree = compileTree(
      <Window theme={lightTheme}>
        <div id="tab" className="rounded-t-lg bg-white" />
        <div id="alias" style={{ borderRadius: { topLeft: 2 } }} />
      </Window>,
    );
    expect(tree.nodes.get("tab")!.style.radius).toEqual({ topLeft: 8, topRight: 8, bottomRight: 0, bottomLeft: 0 });
    expect(tree.nodes.get("alias")!.style.radius).toEqual({ topLeft: 2 });
  });

  test("theme tokens take an opacity modifier, resolved against the active theme", () => {
    expect(tw("bg-primary/50 border-border/0")).toEqual({ background: `${theme.colors.primary}/50`, borderColor: `${theme.colors.border}/0` });
    const scene = (selected: typeof lightTheme) => compileTree(
      <Window theme={selected}><div id="box" class="bg-primary/50 hover:bg-primary/100" /></Window>,
    ).nodes.get("box")!.style;
    expect(scene(lightTheme).background).toBe(`${lightTheme.colors.primary}80`);
    expect(scene(lightTheme).hover?.background).toBe(`${lightTheme.colors.primary}ff`);
    expect(scene(darkTheme).background).toBe(`${darkTheme.colors.primary}80`);
  });

  test("dark: reaches inline spans inside text", () => {
    const run = (selected: typeof lightTheme) => {
      const tree = compileTree(
        <Window theme={selected}><p id="p"><span class="text-zinc-900 dark:text-white">hi</span></p></Window>,
      );
      const node = tree.nodes.get("p") as unknown as { runs?: { style?: { foreground?: string } }[] };
      return JSON.stringify(node);
    };
    expect(run(lightTheme)).toContain("#18181b");
    expect(run(lightTheme)).not.toContain("#ffffff");
    expect(run(darkTheme)).toContain("#ffffff");
  });

  test("font size with line height and arbitrary colours with opacity", () => {
    expect(tw("text-sm/6")).toEqual({ fontSize: 14, lineHeight: 1.714 });
    expect(tw("text-base/tight")).toEqual({ fontSize: 16, lineHeight: 1.25 });
    expect(tw("text-[#fff]/50 bg-[#102030]/25")).toEqual({ foreground: "#ffffff80", background: "#10203040" });
  });

  test("contiguous text children of a box are one anonymous text node, as in CSS", () => {
    const count = 0;
    const tree = compileTree(
      <Window theme={lightTheme}>
        <div id="label" class="flex">Mark {count} as read</div>
        <div id="mixed">Hello <span class="font-bold">world</span> again {2}!</div>
      </Window>,
    );
    const texts = (id: string) => [...tree.nodes.values()].filter(node => node.id.startsWith(`${id}/`) && node.kind === "text").map(node => node.text);
    expect(texts("label")).toEqual(["Mark 0 as read"]);
    expect(texts("mixed")).toEqual(["Hello", "world", "again 2!"]);
  });

  test("composes like clsx and later classes win", () => {
    expect(tw("p-2", false, null, undefined, "p-4")).toEqual({ padding: 16 });
    expect(tw("")).toEqual({});
    expect(tw("unknown-class nonsense")).toEqual({});
  });

  test("className on intrinsics compiles into style at the JSX call site; inline style wins", () => {
    const node = jsx("div", { className: "p-4 bg-red-500 hover:bg-red-600", style: { background: "blue", hover: { opacity: 0.5 } } });
    expect(node.props.className).toBeUndefined();
    expect(node.props.style).toEqual({ padding: 16, background: "blue", hover: { background: "#e7000b", opacity: 0.5 } });
    const aliased = jsx("div", { className: "bg-red-500 flex-col", style: { backgroundColor: "blue" } });
    expect(aliased.props.style).toEqual({ direction: "column", backgroundColor: "blue" });
    const plain = jsx("div", { class: "p-2 bg-white", className: "p-4" });
    expect(plain.props.class).toBeUndefined();
    expect(plain.props.style).toEqual({ padding: 16, background: "#ffffff" });
    expect((<span class="text-sm" />).props.style).toEqual({ fontSize: 14, lineHeight: 1.429 });
  });

  test("className reaches the native tree through div, span and components", () => {
    const tree = compileTree(
      <Window theme={lightTheme}>
        <div id="box" className="flex items-center gap-2 p-3 bg-zinc-100 rounded-md hover:bg-zinc-200">
          <span id="label" className="text-sm font-medium text-zinc-900">hi</span>
          <View id="panel" className="flex-1 bg-primary" />
        </div>
      </Window>,
    );
    const find = (id: string, node: any): any => node.id === id ? node : (node.children ?? []).map((c: any) => find(id, c)).find(Boolean);
    const box = find("box", tree.document.root);
    expect(box.style).toMatchObject({ direction: "row", align: "center", gap: 8, padding: 12, background: "#f4f4f5", radius: 6 });
    expect(box.style.hover).toMatchObject({ background: "#e4e4e7" });
    expect(find("label", tree.document.root).style).toMatchObject({ fontSize: 14, fontWeight: 500, foreground: "#18181b" });
    expect(find("panel", tree.document.root).style).toMatchObject({ flex: 1, background: lightTheme.colors.primary });
  });
});
