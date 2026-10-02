import { Column, Window, createApp, darkTheme, lightTheme, type VNode } from "@tarve/core";
import { CanvasBridge } from "./bridge";
import init, { WebTree, registerFont } from "./wasm/tarve_web.js";
import wasmUrl from "./wasm/tarve_web_bg.wasm?url";

let runtime: Promise<WebAssembly.Memory> | undefined;

async function bytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** Loads the WebAssembly build of Tarve's native runtime and its fonts, once per page. */
export function loadRuntime(): Promise<WebAssembly.Memory> {
  runtime ??= (async () => {
    const [wasm, sans, mono] = await Promise.all([
      init({ module_or_path: wasmUrl }),
      bytes("/fonts/InterVariable.ttf"),
      bytes("/fonts/JetBrainsMono.ttf"),
    ]);
    registerFont(sans, "system-ui,ui-sans-serif,sans-serif,serif,ui-serif,cursive,fantasy,emoji");
    registerFont(mono, "monospace,ui-monospace");
    return wasm.memory;
  })();
  return runtime;
}

/**
 * Runs a documentation example in `canvas` with the real Tarve reconciler and native tree, in the
 * page's light or dark theme. Full-window examples keep their own markup; only their theme is swapped.
 */
export async function mountExample(
  canvas: HTMLCanvasElement,
  preview: () => VNode,
  fullWindow: boolean,
  mode: "light" | "dark" = "dark",
): Promise<() => void> {
  const memory = await loadRuntime();
  const theme = mode === "dark" ? darkTheme : lightTheme;
  const view = fullWindow
    ? () => {
        const root = preview();
        return root.type === Window ? { ...root, props: { ...root.props, theme } } : root;
      }
    : () => (
        <Window title="Example" theme={theme}>
          <Column flex={1} align="center" justify="center" padding={40}>
            {preview()}
          </Column>
        </Window>
      );
  const app = createApp(view, { bridge: new CanvasBridge(canvas, WebTree, memory), renderer: "cpu" });
  await app.ready;
  return () => app.close();
}
