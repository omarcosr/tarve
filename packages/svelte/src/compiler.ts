import { compile, compileModule, type CompileOptions } from "svelte/compiler";
import { parseCss } from "./css";

export interface CompileTarget {
  /** Rewrites the compiled module's import specifiers (`svelte` to its client build, relative paths to absolute ones…). */
  resolve?: (specifier: string) => string;
}

const IMPORT = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"'\n]+)\2/g;

function rewriteImports(code: string, resolve: CompileTarget["resolve"]): string {
  return resolve ? code.replace(IMPORT, (_, prefix: string, quote: string, specifier: string) => prefix + quote + resolve(specifier) + quote) : code;
}

export interface CompiledSvelte {
  code: string;
  warnings: string[];
}

/**
 * Compiles a `.svelte` component for Tarve: Svelte's client output (createElement
 * templates instead of innerHTML), with its CSS resolved into style rules at build time.
 */
export function compileSvelte(source: string, filename: string, options: CompileOptions = {}, target: CompileTarget = {}): CompiledSvelte {
  const result = compile(source, { filename, generate: "client", css: "external", fragments: "tree", discloseVersion: false, ...options });
  const warnings = result.warnings.map(warning => `${filename}: ${warning.message}`);
  let code = 'import "@tarve/svelte/install";\n' + result.js.code;
  if (result.css?.code) {
    const rules = parseCss(result.css.code, message => warnings.push(`${filename}: ${message}`));
    if (rules.length) code += `\nimport { registerCss as __tarve_registerCss } from "@tarve/svelte/css";\n__tarve_registerCss(${JSON.stringify(rules)});\n`;
  }
  return { code: rewriteImports(code, target.resolve), warnings };
}

/** Compiles a `.svelte.js`/`.svelte.ts` module (runes outside components). TypeScript must be stripped first. */
export function compileSvelteModule(source: string, filename: string, target: CompileTarget = {}): CompiledSvelte {
  const result = compileModule(source, { filename, generate: "client" });
  return { code: rewriteImports('import "@tarve/svelte/install";\n' + result.js.code, target.resolve), warnings: result.warnings.map(warning => `${filename}: ${warning.message}`) };
}
