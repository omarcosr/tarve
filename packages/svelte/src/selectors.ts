/**
 * CSS selectors over the Svelte DOM: `querySelector`/`matches` for Svelte's
 * runtime and actions, and the component `<style>` rules with combinators.
 */

export interface SelectorElement {
  readonly localName: string;
  readonly parentElement: SelectorElement | null;
  readonly previousElementSibling: SelectorElement | null;
  readonly nextElementSibling: SelectorElement | null;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  /** `:checked` (inputs) and selected options. */
  readonly _isChecked: boolean;
  readonly _isDisabled: boolean;
}

type AttributeTest = { name: string; operator?: "=" | "~=" | "|=" | "^=" | "$=" | "*="; value?: string; insensitive?: boolean };
type Pseudo =
  | { kind: "checked" | "disabled" | "enabled" | "first-child" | "last-child" | "only-child" | "empty" | "root" | "required" | "optional" }
  | { kind: "nth-child" | "nth-last-child" | "nth-of-type"; a: number; b: number }
  | { kind: "not" | "is" | "where"; list: Selector[] }
  /** `:has()`: relative selectors, each led by its combinator (descendant by default). */
  | { kind: "has"; list: { combinator: Combinator; selector: Selector }[] }
  /** User-interaction states: false for queries, a style state for CSS rules. */
  | { kind: "state"; state: "hover" | "focus" | "focusVisible" | "active" | "focusWithin" };

export interface Compound {
  tag?: string;
  id?: string;
  classes: string[];
  attributes: AttributeTest[];
  pseudos: Pseudo[];
}

export type Combinator = " " | ">" | "+" | "~";

/** Compounds left to right, with the combinator before each but the first. */
export interface Selector {
  compounds: Compound[];
  combinators: Combinator[];
  specificity: number;
  /** `::before` / `::after` on the last compound: the rule styles generated content. */
  pseudoElement?: "before" | "after";
}

const STATES: Record<string, "hover" | "focus" | "focusVisible" | "active" | "focusWithin"> = {
  hover: "hover", focus: "focus", "focus-visible": "focusVisible", active: "active", "focus-within": "focusWithin",
};
const SIMPLE_PSEUDOS = new Set(["checked", "disabled", "enabled", "first-child", "last-child", "only-child", "empty", "root", "required", "optional"]);
const IGNORED_PSEUDOS = new Set(["visited", "link", "any-link", "target", "scope", "defined"]);

function nth(argument: string): { a: number; b: number } {
  const text = argument.replace(/\s+/g, "").toLowerCase();
  if (text === "odd") return { a: 2, b: 1 };
  if (text === "even") return { a: 2, b: 0 };
  const match = /^([+-]?\d*)n([+-]\d+)?$/.exec(text);
  if (match) {
    const a = match[1] === "" || match[1] === "+" ? 1 : match[1] === "-" ? -1 : Number(match[1]);
    return { a, b: Number(match[2] ?? 0) };
  }
  if (/^[+-]?\d+$/.test(text)) return { a: 0, b: Number(text) };
  throw new SyntaxError(`Unsupported :nth argument "${argument}"`);
}

/** Splits at top-level commas (not inside parentheses or brackets). */
function splitTopLevel(text: string, separator: string): string[] {
  const out: string[] = [];
  let depth = 0, start = 0, quote = "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quote) { if (char === quote) quote = ""; continue; }
    if (char === "\"" || char === "'") quote = char;
    else if (char === "(" || char === "[") depth++;
    else if (char === ")" || char === "]") depth--;
    else if (char === separator && depth === 0) { out.push(text.slice(start, index)); start = index + 1; }
  }
  out.push(text.slice(start));
  return out.map(part => part.trim()).filter(Boolean);
}

const IDENT = /^-?[_a-zA-Z\u00a0-\uffff][-_a-zA-Z0-9\u00a0-\uffff]*|^\*/;

function parseSelector(text: string): Selector {
  const compounds: Compound[] = [];
  const combinators: Combinator[] = [];
  let specificity = 0;
  let rest = text.trim();
  let current: Compound = { classes: [], attributes: [], pseudos: [] };
  let started = false;
  let pseudoElement: Selector["pseudoElement"];
  const finish = () => {
    if (!started) throw new SyntaxError(`Invalid selector "${text}"`);
    compounds.push(current);
    current = { classes: [], attributes: [], pseudos: [] };
    started = false;
  };
  while (rest.length) {
    const combinator = /^\s*([>+~])\s*|^\s+/.exec(rest);
    if (combinator && started) {
      finish();
      combinators.push((combinator[1] ?? " ") as Combinator);
      rest = rest.slice(combinator[0].length);
      continue;
    }
    const char = rest[0]!;
    if (char === "#" || char === ".") {
      const ident = IDENT.exec(rest.slice(1));
      if (!ident) throw new SyntaxError(`Invalid selector "${text}"`);
      if (char === "#") { current.id = ident[0]; specificity += 100; } else { current.classes.push(ident[0]); specificity += 10; }
      rest = rest.slice(1 + ident[0].length);
    } else if (char === "[") {
      const match = /^\[\s*([^\s~|^$*=\]]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+))\s*(i)?\s*)?\]/.exec(rest);
      if (!match) throw new SyntaxError(`Invalid attribute selector in "${text}"`);
      current.attributes.push({ name: match[1]!.toLowerCase(), ...(match[2] ? { operator: match[2] as AttributeTest["operator"], value: match[3] ?? match[4] ?? match[5] ?? "" } : {}), ...(match[6] ? { insensitive: true } : {}) });
      specificity += 10;
      rest = rest.slice(match[0].length);
    } else if (char === ":") {
      const element = rest.startsWith("::");
      const ident = IDENT.exec(rest.slice(element ? 2 : 1));
      if (!ident) throw new SyntaxError(`Invalid pseudo-class in "${text}"`);
      const name = ident[0].toLowerCase();
      rest = rest.slice((element ? 2 : 1) + ident[0].length);
      let argument: string | undefined;
      if (rest[0] === "(") {
        let depth = 0, end = 0;
        for (; end < rest.length; end++) { if (rest[end] === "(") depth++; else if (rest[end] === ")" && --depth === 0) break; }
        argument = rest.slice(1, end);
        rest = rest.slice(end + 1);
      }
      if (element || name === "before" || name === "after") {
        if (name !== "before" && name !== "after") throw new SyntaxError(`Pseudo-element ::${name} is not supported`);
        pseudoElement = name;
        specificity += 1;
        started = true;
        continue;
      }
      if (name === "global" && argument !== undefined) {
        // Svelte strips :global() when it compiles; a query may still carry one.
        rest = argument + rest;
        continue;
      }
      if (SIMPLE_PSEUDOS.has(name)) current.pseudos.push({ kind: name as never });
      else if (name === "nth-child" || name === "nth-last-child" || name === "nth-of-type") current.pseudos.push({ kind: name, ...nth(argument ?? "") });
      else if (name === "has") {
        current.pseudos.push({ kind: "has", list: splitTopLevel(argument ?? "", ",").map(part => {
          const lead = /^([>+~])\s*/.exec(part);
          return { combinator: (lead?.[1] ?? " ") as Combinator, selector: parseSelector(lead ? part.slice(lead[0].length) : part) };
        }) });
      } else if (name === "not" || name === "is" || name === "where") {
        current.pseudos.push({ kind: name, list: parseSelectorList(argument ?? "") });
      } else if (STATES[name]) current.pseudos.push({ kind: "state", state: STATES[name]! });
      else if (!IGNORED_PSEUDOS.has(name)) throw new SyntaxError(`Pseudo-class :${name} is not supported`);
      if (name !== "where") specificity += 10;
    } else {
      const ident = IDENT.exec(rest);
      if (!ident || started) throw new SyntaxError(`Invalid selector "${text}"`);
      if (ident[0] !== "*") { current.tag = ident[0].toLowerCase(); specificity += 1; }
      rest = rest.slice(ident[0].length);
    }
    started = true;
  }
  finish();
  return { compounds, combinators, specificity, ...(pseudoElement ? { pseudoElement } : {}) };
}

const cache = new Map<string, Selector[]>();

/** A comma-separated selector list, parsed once. Throws SyntaxError for unsupported syntax. */
export function parseSelectorList(text: string): Selector[] {
  let list = cache.get(text);
  if (!list) {
    list = splitTopLevel(text, ",").map(parseSelector);
    if (cache.size > 1024) cache.clear();
    cache.set(text, list);
  }
  return list;
}

function attributeMatches(element: SelectorElement, test: AttributeTest): boolean {
  const actual = element.getAttribute(test.name);
  if (actual === null) return false;
  if (!test.operator) return true;
  const value = test.insensitive ? actual.toLowerCase() : actual;
  const expected = test.insensitive ? test.value!.toLowerCase() : test.value!;
  switch (test.operator) {
    case "=": return value === expected;
    case "~=": return value.split(/\s+/).includes(expected);
    case "|=": return value === expected || value.startsWith(expected + "-");
    case "^=": return expected !== "" && value.startsWith(expected);
    case "$=": return expected !== "" && value.endsWith(expected);
    case "*=": return expected !== "" && value.includes(expected);
  }
}

function position(element: SelectorElement, fromEnd: boolean, ofType: boolean): number {
  let index = 1;
  for (let sibling = fromEnd ? element.nextElementSibling : element.previousElementSibling; sibling; sibling = fromEnd ? sibling.nextElementSibling : sibling.previousElementSibling) {
    if (!ofType || sibling.localName === element.localName) index++;
  }
  return index;
}

function nthMatches(index: number, a: number, b: number): boolean {
  if (a === 0) return index === b;
  const n = (index - b) / a;
  return Number.isInteger(n) && n >= 0;
}

/**
 * Whether `element` matches `compound`. `states` lists the interaction states the
 * caller treats as active (CSS rules collect them instead; queries pass none).
 */
function compoundMatches(element: SelectorElement, compound: Compound, states: ReadonlySet<string> | "any"): boolean {
  if (compound.tag && compound.tag !== element.localName.toLowerCase()) return false;
  if (compound.id !== undefined && element.getAttribute("id") !== compound.id) return false;
  if (compound.classes.length) {
    const classes = (element.getAttribute("class") ?? "").split(/\s+/);
    for (const name of compound.classes) if (!classes.includes(name)) return false;
  }
  for (const test of compound.attributes) if (!attributeMatches(element, test)) return false;
  for (const pseudo of compound.pseudos) {
    switch (pseudo.kind) {
      case "checked": if (!element._isChecked) return false; break;
      case "disabled": if (!element._isDisabled) return false; break;
      case "enabled": if (element._isDisabled) return false; break;
      case "required": if (!element.hasAttribute("required")) return false; break;
      case "optional": if (element.hasAttribute("required")) return false; break;
      case "first-child": if (element.previousElementSibling) return false; break;
      case "last-child": if (element.nextElementSibling) return false; break;
      case "only-child": if (element.previousElementSibling || element.nextElementSibling) return false; break;
      case "empty": if ((element as unknown as { firstChild: unknown }).firstChild) return false; break;
      case "root": if (element.parentElement) return false; break;
      case "nth-child": if (!nthMatches(position(element, false, false), pseudo.a, pseudo.b)) return false; break;
      case "nth-last-child": if (!nthMatches(position(element, true, false), pseudo.a, pseudo.b)) return false; break;
      case "nth-of-type": if (!nthMatches(position(element, false, true), pseudo.a, pseudo.b)) return false; break;
      case "not": if (pseudo.list.some(selector => selectorMatches(element, selector, states))) return false; break;
      case "is": case "where": if (!pseudo.list.some(selector => selectorMatches(element, selector, states))) return false; break;
      case "has": if (!pseudo.list.some(relative => hasMatch(element, relative.combinator, relative.selector))) return false; break;
      case "state": if (states !== "any" && !states.has(pseudo.state)) return false; break;
    }
  }
  return true;
}

/** Children of an element, for `:has()` (the DOM element exposes `children`). */
function childrenOf(element: SelectorElement): SelectorElement[] {
  return (element as unknown as { children?: SelectorElement[] }).children ?? [];
}

function hasMatch(element: SelectorElement, combinator: Combinator, selector: Selector): boolean {
  const matches = (candidate: SelectorElement) => selectorMatches(candidate, selector, "any");
  if (combinator === "+") { const next = element.nextElementSibling; return !!next && matches(next); }
  if (combinator === "~") {
    for (let next = element.nextElementSibling; next; next = next.nextElementSibling) if (matches(next)) return true;
    return false;
  }
  if (combinator === ">") return childrenOf(element).some(matches);
  const visit = (node: SelectorElement): boolean => childrenOf(node).some(child => matches(child) || visit(child));
  return visit(element);
}

function matchFrom(element: SelectorElement, selector: Selector, index: number, states: ReadonlySet<string> | "any"): boolean {
  if (!compoundMatches(element, selector.compounds[index]!, index === selector.compounds.length - 1 ? states : "any")) return false;
  if (index === 0) return true;
  const combinator = selector.combinators[index - 1]!;
  if (combinator === ">") {
    const parent = element.parentElement;
    return !!parent && matchFrom(parent, selector, index - 1, "any");
  }
  if (combinator === "+") {
    const previous = element.previousElementSibling;
    return !!previous && matchFrom(previous, selector, index - 1, "any");
  }
  if (combinator === "~") {
    for (let previous = element.previousElementSibling; previous; previous = previous.previousElementSibling) {
      if (matchFrom(previous, selector, index - 1, "any")) return true;
    }
    return false;
  }
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (matchFrom(ancestor, selector, index - 1, "any")) return true;
  }
  return false;
}

const NO_STATES: ReadonlySet<string> = new Set();

/** `element.matches(selector)`: interaction states (`:hover`…) never match a query. */
export function selectorMatches(element: SelectorElement, selector: Selector, states: ReadonlySet<string> | "any" = NO_STATES): boolean {
  return matchFrom(element, selector, selector.compounds.length - 1, states);
}

export function matchesList(element: SelectorElement, text: string): boolean {
  return parseSelectorList(text).some(selector => selectorMatches(element, selector));
}

/** The interaction state a rule's last compound requires (`button:hover` → "hover"), if any. */
export function ruleState(selector: Selector): "hover" | "focus" | "focusVisible" | "active" | "focusWithin" | undefined {
  const last = selector.compounds[selector.compounds.length - 1]!;
  for (const pseudo of last.pseudos) if (pseudo.kind === "state") return pseudo.state;
  return undefined;
}

/** Whether a selector depends on anything but the element's own tag, classes and attributes. */
/** Whether a selector reads an element's descendants or later siblings (`:has()`). */
export function usesHas(selector: Selector): boolean {
  return selector.compounds.some(compound => compound.pseudos.some(pseudo => pseudo.kind === "has"
    || ((pseudo.kind === "not" || pseudo.kind === "is" || pseudo.kind === "where") && pseudo.list.some(usesHas))));
}

export function isContextual(selector: Selector): boolean {
  if (selector.compounds.length > 1) return true;
  return selector.compounds[0]!.pseudos.some(pseudo => pseudo.kind !== "state" && pseudo.kind !== "checked" && pseudo.kind !== "disabled" && pseudo.kind !== "enabled"
    && pseudo.kind !== "required" && pseudo.kind !== "optional");
}
