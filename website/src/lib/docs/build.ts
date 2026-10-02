import api from "../generated/api.json";
import { catalog, findEntry, orderedNames } from "./catalog";
import type { ComponentDoc, PropDoc } from "./types";

const REPO = "https://github.com/omarcosr/tarve";

const rawExamples = import.meta.glob("./examples/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const examples = new Map(
  Object.entries(rawExamples).map(([path, code]) => [
    path.replace(/^.*\/(\w+)\.tsx$/, "$1"),
    code.replace(/\r\n/g, "\n").replace(/^(\S.*>);$/gm, "$1").trimEnd(),
  ]),
);

export const commonPropNotes: Record<string, string> = {
  children: "Content rendered inside the component.",
  highlight: "Highlights text matches inside the node, as used by find-in-page.",
  id: "Stable native node id. Used for focus, scrolling, tests and accessibility; popups derive their part ids from it.",
  key: "Reconciliation key that keeps list items stable between renders.",
  motionFrom: "Numeric values the node animates from when it mounts.",
  onHighlight: "Reports how many highlight matches were found.",
  onPaste: "Receives pasted text, files or images.",
  onTransitionEnd: "Called when a native transition finishes on a property.",
  rovingGroup: "Joins a roving-focus group so arrow keys move focus between siblings.",
  style: "Layout, colour, border, shadow, gradient, transform and transition styles, plus hover/focus/active/disabled state styles.",
};

export function commonProps(): PropDoc[] {
  return api.commonProps.map((prop) => ({ ...prop, doc: prop.doc || commonPropNotes[prop.name] }));
}

export function docsCatalog() {
  return catalog;
}

export function buildComponentDoc(name: string): ComponentDoc | undefined {
  const component = api.components.find((item) => item.name === name);
  const found = findEntry(name);
  if (!component || !found) return undefined;
  const props = component.props as PropDoc[];
  const own = props.filter((prop) => !prop.from);
  const inheritedFrom = new Map<string, PropDoc[]>();
  for (const prop of props) {
    if (!prop.from) continue;
    inheritedFrom.set(prop.from, [...(inheritedFrom.get(prop.from) ?? []), prop]);
  }
  const index = orderedNames.indexOf(name);
  const link = (target?: string) => {
    if (!target) return undefined;
    const entry = findEntry(target)?.entry;
    return entry ? { name: entry.name, summary: entry.summary } : undefined;
  };
  const types = api.types as Record<string, string>;
  return {
    name,
    category: { id: found.category.id, title: found.category.title },
    summary: found.entry.summary,
    notes: component.summary,
    sourceUrl: `${REPO}/blob/main/${component.source}#L${component.line}`,
    sourceLabel: `${component.source}:${component.line}`,
    generic: component.generic,
    propsType: component.propsType,
    importLine: `import { ${name} } from "@tarve/core";`,
    example: examples.get(name) ?? `import { ${name} } from "@tarve/core";\n\n<${name} />`,
    props: own,
    inherited: [...inheritedFrom].map(([from, list]) => ({ from, props: list })),
    common: component.common,
    types: component.types.filter((type) => types[type]).map((type) => ({ name: type, code: types[type] })),
    prev: link(orderedNames[index - 1]),
    next: link(orderedNames[index + 1]),
  };
}
