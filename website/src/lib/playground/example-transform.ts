/**
 * Turns a documentation example (imports, module-level state, one top-level JSX expression)
 * into a module that exports the expression as a view, so it can be mounted.
 * Shared by the browser playground (Vite `?playground` imports) and the PNG capture script.
 */
export function toPreviewModule(name: string, source: string): { code: string; fullWindow: boolean } {
  const code = source.replace(/\r\n/g, "\n").trimEnd();
  if (/^function App\(/m.test(code)) {
    const body = code.slice(0, code.search(/^const app = createApp/m));
    return { code: body + "\nexport const preview = App;\nexport const fullWindow = true;\n", fullWindow: true };
  }
  const start = code.search(/^<[A-Za-z>]/m);
  if (start < 0) throw new Error(`${name}: no top-level JSX expression found`);
  const tail = code.slice(start).replace(/;\s*$/, "");
  const fullWindow = tail.startsWith("<Window");
  return {
    code:
      code.slice(0, start) +
      `export const preview = () => (\n${tail}\n);\nexport const fullWindow = ${fullWindow};\n`,
    fullWindow,
  };
}
