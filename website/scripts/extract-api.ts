// Extracts the public component API of @tarve/core into src/lib/generated/api.json.
// TypeScript 7 ships no JS compiler API, so this uses TypeScript 5 (aliased as "typescript5").
import ts from "typescript5";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

type Prop = { name: string; type: string; optional: boolean; default?: string; doc?: string; from?: string };
type Component = {
  name: string;
  summary?: string;
  source: string;
  line: number;
  generic: boolean;
  propsType?: string;
  props: Prop[];
  common: string[];
  types: string[];
};

const SKIPPED_TYPES = new Set(["Style", "Child", "VNode", "ThemeDefinition", "IntrinsicStyle", "StateStyle", "Control"]);

const repo = resolve(import.meta.dir, "../..");
const entry = resolve(repo, "packages/core/src/index.ts");
const out = resolve(import.meta.dir, "../src/lib/generated/api.json");

const program = ts.createProgram([entry], {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  jsxImportSource: "@tarve/core",
  allowImportingTsExtensions: true,
  skipLibCheck: true,
  noEmit: true,
  strict: true,
  types: [],
  baseUrl: repo,
  paths: {
    "@tarve/core": ["./packages/core/src/index.ts"],
    "@tarve/core/*": ["./packages/core/src/*"],
    "@tarve/protocol": ["./packages/protocol/src/index.ts"],
  },
});
const checker = program.getTypeChecker();
const source = program.getSourceFile(entry);
if (!source) throw new Error("cannot load " + entry);
const moduleSymbol = checker.getSymbolAtLocation(source);
if (!moduleSymbol) throw new Error("no module symbol for " + entry);

function containerName(node: ts.Node): string | undefined {
  const parent = node.parent;
  if (!parent) return undefined;
  if (ts.isInterfaceDeclaration(parent)) return parent.name.text;
  if (ts.isTypeLiteralNode(parent)) {
    let up: ts.Node | undefined = parent.parent;
    while (up && !ts.isTypeAliasDeclaration(up) && !ts.isSourceFile(up)) up = up.parent;
    if (up && ts.isTypeAliasDeclaration(up)) return up.name.text;
  }
  return undefined;
}

const clean = (text: string) => text.replace(/\s+/g, " ").replace(/;\s*}/g, " }").trim();
const isCommon = (node: ts.Node) => node.getSourceFile().fileName.endsWith("jsx-runtime.ts");

function typeText(symbol: ts.Symbol, location: ts.Node): string {
  const decl = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (decl && (ts.isPropertySignature(decl) || ts.isPropertyDeclaration(decl)) && decl.type) return clean(decl.type.getText());
  return clean(checker.typeToString(checker.getTypeOfSymbolAtLocation(symbol, location), undefined, ts.TypeFormatFlags.NoTruncation));
}

function defaults(decl: ts.Declaration): Map<string, string> {
  const result = new Map<string, string>();
  let fn: ts.SignatureDeclaration | undefined;
  if (ts.isFunctionDeclaration(decl)) fn = decl;
  else if (ts.isVariableDeclaration(decl) && decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) fn = decl.initializer;
  const param = fn?.parameters[0];
  if (param && ts.isObjectBindingPattern(param.name)) {
    for (const element of param.name.elements) {
      if (!element.initializer || element.dotDotDotToken) continue;
      const key = (element.propertyName ?? element.name).getText();
      result.set(key, clean(element.initializer.getText()));
    }
  }
  return result;
}

const exportedTypes = new Map<string, string>();
for (const exported of checker.getExportsOfModule(moduleSymbol)) {
  const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
  if (!(symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias))) continue;
  const decl = symbol.declarations?.find((d) => ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d));
  if (!decl || SKIPPED_TYPES.has(exported.getName())) continue;
  const text = decl.getText().replace(/^export\s+/, "").replace(/\r\n/g, "\n");
  if (text.length <= 1600) exportedTypes.set(exported.getName(), text);
}

const components: Component[] = [];
const commonDocs = new Map<string, Prop>();

for (const exported of checker.getExportsOfModule(moduleSymbol)) {
  const name = exported.getName();
  if (!/^[A-Z]/.test(name)) continue;
  const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
  if (!(symbol.flags & (ts.SymbolFlags.Function | ts.SymbolFlags.Variable))) continue;
  const decls = symbol.declarations ?? [];
  const impl = decls.find((d) => ts.isFunctionDeclaration(d) ? !!d.body : ts.isVariableDeclaration(d)) ?? decls[0];
  if (!impl) continue;
  const signatures = checker.getSignaturesOfType(checker.getTypeOfSymbolAtLocation(symbol, impl), ts.SignatureKind.Call);
  if (!signatures.length || !signatures.every((sig) => checker.typeToString(sig.getReturnType()) === "VNode")) continue;

  const own = new Map<string, Prop>();
  const common = new Set<string>();
  const presence = new Map<string, number>();
  const defaultValues = defaults(impl);
  const implParams = ts.isFunctionDeclaration(impl) ? impl.parameters : undefined;
  const propsType = implParams?.[0]?.type ? clean(implParams[0].type.getText()) : undefined;
  const propsTypeName = propsType?.replace(/<.*$/, "");
  for (const sig of signatures) {
    const param = sig.getParameters()[0];
    if (!param) continue;
    const paramType = checker.getTypeOfSymbolAtLocation(param, impl);
    const variants = paramType.isUnion() ? paramType.types : [paramType];
    for (const variant of variants) {
      for (const prop of checker.getPropertiesOfType(variant)) {
        const propName = prop.getName();
        const decl = prop.valueDeclaration ?? prop.declarations?.[0];
        const doc = ts.displayPartsToString(prop.getDocumentationComment(checker)).trim() || undefined;
        const type = typeText(prop, impl);
        if (type === "never" || type === "undefined") continue;
        const from = decl ? containerName(decl) : undefined;
        const entry: Prop = {
          name: propName,
          type,
          optional: !!(prop.flags & ts.SymbolFlags.Optional),
          doc,
          from: from && from !== propsTypeName ? from : undefined,
        };
        if (decl && isCommon(decl)) {
          common.add(propName);
          if (!commonDocs.has(propName)) commonDocs.set(propName, entry);
          continue;
        }
        presence.set(propName, (presence.get(propName) ?? 0) + 1);
        const previous = own.get(propName);
        if (!previous) own.set(propName, { ...entry, default: defaultValues.get(propName) });
        else if (!previous.type.split(" | ").includes(entry.type) && previous.type !== entry.type) previous.type = previous.type + " | " + entry.type;
      }
    }
  }
  const variantCount = signatures.reduce((count, sig) => {
    const param = sig.getParameters()[0];
    const t = param ? checker.getTypeOfSymbolAtLocation(param, impl) : undefined;
    return count + (t?.isUnion() ? t.types.length : 1);
  }, 0);
  for (const [propName, prop] of own) if ((presence.get(propName) ?? 0) < variantCount) prop.optional = true;

  const referenced = new Set<string>();
  for (const prop of own.values()) {
    for (const word of prop.type.match(/[A-Z]\w*/g) ?? []) if (exportedTypes.has(word)) referenced.add(word);
  }
  if (propsTypeName && exportedTypes.has(propsTypeName)) referenced.delete(propsTypeName);
  const file = impl.getSourceFile();
  components.push({
    name,
    summary: ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim() || undefined,
    source: relative(repo, file.fileName).replace(/\\/g, "/"),
    line: file.getLineAndCharacterOfPosition(impl.getStart()).line + 1,
    generic: signatures.some((sig) => !!sig.getTypeParameters()?.length),
    propsType,
    props: [...own.values()].sort((a, b) => Number(a.optional) - Number(b.optional) || a.name.localeCompare(b.name)),
    common: [...common].sort(),
    types: [...referenced].sort(),
  });
}

components.sort((a, b) => a.name.localeCompare(b.name));
const commonProps = [...commonDocs.values()].sort((a, b) => a.name.localeCompare(b.name)).map((prop) => ({ ...prop, optional: true }));
mkdirSync(dirname(out), { recursive: true });
const usedTypes = new Set(components.flatMap((component) => component.types));
for (const name of [...usedTypes]) {
  for (const word of exportedTypes.get(name)?.match(/[A-Z]\w*/g) ?? []) if (exportedTypes.has(word)) usedTypes.add(word);
}
const types = Object.fromEntries([...usedTypes].sort().map((name) => [name, exportedTypes.get(name) ?? ""]));
writeFileSync(out, JSON.stringify({ components, commonProps, types }, null, 2) + "\n");
console.log(`[extract-api] ${components.length} components, ${commonProps.length} common props → ${relative(process.cwd(), out)}`);
