/**
 * Build-time JSX compilation. Each JSX subtree made only of Tarve's own components
 * and intrinsic elements becomes a template (memo.ts `template`): its static parts
 * are compiled once, its dynamic parts ({expressions}) become the template's props,
 * and the reconciler reuses the compiled subtree while they are equal. Elements of
 * the app's own components stay ordinary JSX (they may read module state),
 * splitting a subtree into separate templates around them.
 *
 * Parsing uses TypeScript 7's native compiler through its API (typescript/unstable),
 * loaded only when a build asks for it: `typescript` 7 is an optional peer dependency.
 */
import type * as Ast from "typescript/unstable/ast";
import type * as Is from "typescript/unstable/ast/is";
import type { API, Snapshot } from "typescript/unstable/sync";

type Node = Ast.Node;
type Expression = Ast.Expression;
type SourceFile = Ast.SourceFile;

interface Parser {
  ast: typeof Ast;
  is: typeof Is;
  api: API;
  files: Map<string, string>;
}

const ROOT = "/tarve-jsx";
const FILE = ROOT + "/app.tsx";
const CONFIG = ROOT + "/tsconfig.json";
let parser: Promise<Parser> | undefined;

async function loadParser(): Promise<Parser> {
  let modules: [typeof Ast, typeof Is, typeof import("typescript/unstable/sync")];
  try {
    modules = await Promise.all([import("typescript/unstable/ast"), import("typescript/unstable/ast/is"), import("typescript/unstable/sync")]);
  } catch (error) {
    throw new Error(`compileJsx needs TypeScript 7 (npm install -D typescript@7): ${error instanceof Error ? error.message : String(error)}`);
  }
  const [ast, is, sync] = modules;
  const files = new Map<string, string>([[CONFIG, JSON.stringify({ compilerOptions: { jsx: "preserve", noLib: true, noResolve: true, types: [] }, files: ["app.tsx"] })]]);
  const normalize = (path: string) => path.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "");
  const api = new sync.API({
    cwd: ROOT,
    fs: {
      readFile: (path: string) => files.get(normalize(path)),
      fileExists: (path: string) => files.has(normalize(path)),
      directoryExists: (path: string) => { const p = normalize(path).replace(/\/$/, ""); return p === "" || ROOT.startsWith(p); },
      getAccessibleEntries: (path: string) => normalize(path).replace(/\/$/, "") === ROOT ? { files: ["app.tsx", "tsconfig.json"], directories: [] } : { files: [], directories: [] },
      realpath: (path: string) => path,
    } as never,
  });
  return { ast, is, api, files };
}

/** Stops the TypeScript process a build started; the next compileJsx starts a new one. */
export async function closeJsxCompiler(): Promise<void> {
  const current = parser;
  parser = undefined;
  if (current) (await current).api.close();
}

const CORE = /^(?:@tarve\/core|tarve)(?:\/.*)?$/;
const EVENT = /^on[A-Z]/;

export interface JsxCompileResult {
  code: string;
  templates: number;
}

function constant(node: Expression, ast: typeof Ast, ts: typeof Is): boolean {
  const isConstant = (child: Expression) => constant(child, ast, ts);
  if (ts.isParenthesizedExpression(node)) return isConstant(node.expression);
  if (ts.isNumericLiteral(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return true;
  if (node.kind === ast.SyntaxKind.TrueKeyword || node.kind === ast.SyntaxKind.FalseKeyword || node.kind === ast.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(node) && node.text === "undefined") return true;
  if (ts.isPrefixUnaryExpression(node) && (node.operator === ast.SyntaxKind.MinusToken || node.operator === ast.SyntaxKind.PlusToken)) return ts.isNumericLiteral(node.operand);
  if (ts.isArrayLiteralExpression(node)) return node.elements.every(element => !ts.isSpreadElement(element) && isConstant(element));
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every(property => ts.isPropertyAssignment(property)
      && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name))
      && isConstant(property.initializer));
  }
  return false;
}

type JsxNode = Ast.JsxElement | Ast.JsxSelfClosingElement | Ast.JsxFragment;

export async function compileJsx(source: string): Promise<JsxCompileResult> {
  // Plain JS/TS without JSX: nothing to compile, no TypeScript process.
  if (!/<[A-Za-z>]/.test(source)) return { code: source, templates: 0 };
  const loaded = await (parser ??= loadParser());
  loaded.files.set(FILE, source);
  // Every call parses new text under the same name: drop all cached state first.
  loaded.api.clearSourceFileCache();
  const snapshot: Snapshot = loaded.api.updateSnapshot({ openProject: CONFIG, fileChanges: { invalidateAll: true } } as never);
  try {
    const file = snapshot.getProjects()[0]!.program.getSourceFile(FILE);
    // Positions index this text: a stale parse would splice the wrong ranges.
    if (!file || file.text !== source) throw new Error("compileJsx: TypeScript returned a different parse of the file");
    return compileFile(source, file, loaded.ast, loaded.is);
  } finally {
    snapshot.dispose();
  }
}

function compileFile(source: string, file: SourceFile, ast: typeof Ast, ts: typeof Is): JsxCompileResult {
  const isConstant = (node: Expression): boolean => constant(node, ast, ts);
  const isJsx = (node: Node): node is JsxNode => ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node);
  const core = new Set<string>();
  let lastImport = 0;
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    lastImport = statement.end;
    if (!ts.isStringLiteral(statement.moduleSpecifier) || !CORE.test(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings) && statement.importClause!.phaseModifier !== ast.SyntaxKind.TypeKeyword) {
      for (const element of bindings.elements) if (!element.isTypeOnly) core.add(element.name.text);
    }
  }
  // A local binding with a core name (a parameter called Text) shadows the import: give up on it.
  const shadowed = new Set<string>();
  const scan = (node: Node): void => {
    const name = (node.kind === ast.SyntaxKind.Parameter || ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node))
      ? (node as unknown as { name?: Node }).name : undefined;
    if (name && ts.isIdentifier(name) && core.has(name.text)) shadowed.add(name.text);
    node.forEachChild(scan);
  };
  file.forEachChild(scan);
  for (const name of shadowed) core.delete(name);

  const pure = (node: JsxNode): boolean => {
    if (ts.isJsxFragment(node)) return true;
    const tag = ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName;
    if (ts.isIdentifier(tag)) return /^[a-z]/.test(tag.text) || core.has(tag.text);
    return false;
  };
  const text = (start: number, end: number) => source.slice(start, end);
  const declarations: string[] = [];

  /** Source text of [start, end) with every top-level JSX node inside compiled. */
  function rewrite(start: number, end: number, root: Node): string {
    const roots: JsxNode[] = [];
    const find = (node: Node): void => {
      if (node.end <= start || node.pos >= end) return;
      if (isJsx(node) && node.getStart() >= start && node.end <= end) { roots.push(node); return; }
      node.forEachChild(find);
    };
    find(root);
    let out = "";
    let at = start;
    for (const node of roots) {
      out += text(at, node.getStart()) + compileRoot(node);
      at = node.end;
    }
    return out + text(at, end);
  }

  function compileRoot(node: JsxNode): string {
    if (!pure(node)) return impure(node);
    const holes: string[] = [];
    const events: string[] = [];
    let key: string | undefined;
    const hole = (expression: string, event = false) => {
      const name = "h" + holes.length;
      holes.push(expression);
      if (event) events.push(name);
      return "p." + name;
    };
    let elements = 0;
    /** Body text of a pure element; impure descendants and expressions become holes. */
    function body(element: JsxNode, isRoot: boolean): string {
      if (!pure(element)) return "{" + hole(impure(element)) + "}";
      elements++;
      let out = "";
      let at = element.getStart();
      const end = element.end;
      const attributes = ts.isJsxElement(element) ? element.openingElement.attributes : ts.isJsxSelfClosingElement(element) ? element.attributes : undefined;
      const children = ts.isJsxElement(element) || ts.isJsxFragment(element) ? element.children : undefined;
      const parts: { start: number; end: number; replacement: string }[] = [];
      for (const attribute of attributes?.properties ?? []) {
        if (ts.isJsxSpreadAttribute(attribute)) {
          parts.push({ start: attribute.expression.getStart(), end: attribute.expression.end, replacement: hole(rewrite(attribute.expression.getStart(), attribute.expression.end, attribute.expression)) });
          continue;
        }
        const name = attribute.name.getText();
        const initializer = attribute.initializer;
        if (isRoot && name === "key") {
          key = initializer ? (ts.isJsxExpression(initializer) && initializer.expression ? rewrite(initializer.expression.getStart(), initializer.expression.end, initializer.expression) : initializer.getText()) : "true";
          parts.push({ start: attribute.getStart(), end: attribute.end, replacement: "" });
          continue;
        }
        if (!initializer) continue;
        if (ts.isJsxExpression(initializer) && initializer.expression && !isConstant(initializer.expression)) {
          const expression = initializer.expression;
          parts.push({ start: expression.getStart(), end: expression.end, replacement: hole(rewrite(expression.getStart(), expression.end, expression), EVENT.test(name)) });
        } else if (isJsx(initializer as Node)) {
          const value = initializer as unknown as JsxNode;
          parts.push({ start: value.getStart(), end: value.end, replacement: "{" + hole(compileRoot(value)) + "}" });
        }
      }
      for (const child of children ?? []) {
        if (ts.isJsxExpression(child)) {
          if (!child.expression) continue;
          if (isConstant(child.expression) && !ts.isObjectLiteralExpression(child.expression) && !ts.isArrayLiteralExpression(child.expression)) continue;
          parts.push({ start: child.expression.getStart(), end: child.expression.end, replacement: hole(rewrite(child.expression.getStart(), child.expression.end, child.expression)) });
        } else if (isJsx(child)) {
          parts.push({ start: child.getStart(), end: child.end, replacement: body(child, false) });
        }
      }
      parts.sort((a, b) => a.start - b.start);
      for (const part of parts) {
        out += text(at, part.start) + part.replacement;
        at = part.end;
      }
      return out + text(at, end);
    }
    const template = body(node, true);
    // A lone element with no children gains nothing: keep it plain.
    if (elements < 2) return impure(node);
    const name = "__tarveTemplate" + declarations.length;
    declarations.push(`const ${name} = __tarveCompileTemplate((p: any) => (${template}), ${JSON.stringify(events)});`);
    const props = holes.map((expression, index) => `h${index}={${expression}}`);
    if (key !== undefined) props.unshift(`key={${key}}`);
    return `<${name} ${props.join(" ")} />`;
  }

  /** An element left as written; JSX inside its attributes and children is compiled. */
  function impure(node: JsxNode): string {
    let out = "";
    let at = node.getStart();
    const visit = (child: Node): void => {
      if (isJsx(child) && child !== node) {
        out += text(at, child.getStart()) + compileRoot(child);
        at = child.end;
        return;
      }
      if (ts.isJsxExpression(child) && child.expression) {
        out += text(at, child.expression.getStart()) + rewrite(child.expression.getStart(), child.expression.end, child.expression);
        at = child.expression.end;
        return;
      }
      if (ts.isJsxSpreadAttribute(child)) {
        out += text(at, child.expression.getStart()) + rewrite(child.expression.getStart(), child.expression.end, child.expression);
        at = child.expression.end;
        return;
      }
      child.forEachChild(visit);
    };
    node.forEachChild(visit);
    return out + text(at, node.end);
  }

  const body = rewrite(lastImport, source.length, file);
  if (!declarations.length) return { code: source, templates: 0 };
  const code = text(0, lastImport)
    + `\nimport { template as __tarveCompileTemplate } from "@tarve/core";\n`
    + declarations.join("\n") + "\n"
    + body;
  return { code, templates: declarations.length };
}
