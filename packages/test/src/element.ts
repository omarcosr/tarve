import type { SceneNode } from "@tarve/headless";

/** A node role: the `control.role` a component declared, or the implicit role of its kind. */
export type Role = NonNullable<SceneNode["control"]>["role"] | "textbox" | "searchbox" | "img" | "window" | (string & {});

/** What a `TestElement` reads its live node from: one rendered app. */
export interface ElementHost {
  node(id: string): SceneNode | undefined;
  parentId(id: string): string | undefined;
  childIds(id: string): readonly string[];
  element(id: string): TestElement;
}

/** Kinds whose `text` is what a user reads. Inputs show a value instead (`getByDisplayValue`). */
const TEXT_KINDS = new Set(["text", "button", "markdown", "code", "titlebar"]);
/** Roles named from their content when they have no label, as in ARIA. */
const NAME_FROM_CONTENT = new Set(["button", "link", "checkbox", "switch", "radio", "tab", "menuitem", "treeitem", "option", "toggle", "row", "label", "alert", "status"]);
/** Roles a `Field`'s label names. */
export const FORM_ROLES = new Set(["textbox", "searchbox", "slider", "checkbox", "switch", "radio", "radiogroup", "select", "toggle", "togglegroup", "otpSlot"]);

export function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The role of a scene node: its `control.role`, else the implicit role of its kind. */
export function roleOf(node: SceneNode): Role | undefined {
  if (node.control?.role) return node.control.role;
  switch (node.kind) {
    case "button":
      return "button";
    case "input":
      return node.inputType === "search" ? "searchbox" : "textbox";
    case "textarea":
      return "textbox";
    case "slider":
      return "slider";
    case "image":
    case "svg":
      return "img";
    case "window":
      return "window";
    default:
      return undefined;
  }
}

/** The text a node shows itself (not its children's). */
export function ownText(node: SceneNode): string {
  if (TEXT_KINDS.has(node.kind)) return node.text ?? node.source ?? "";
  return "";
}

/**
 * One node of the rendered scene tree. It is live: its properties read the current tree, so
 * after an event or a re-render they show the new text, value or state. Reading a removed
 * element throws (check `isConnected`).
 */
export class TestElement {
  constructor(
    private readonly host: ElementHost,
    /** The node id: the `id` prop when the component set one, else a generated path. */
    readonly id: string,
  ) {}

  /** The node as the app compiled it (`compileTree`), without children. */
  get node(): SceneNode {
    const node = this.host.node(this.id);
    if (!node) throw new Error(`Element #${this.id} is no longer in the tree`);
    return node;
  }

  get isConnected(): boolean {
    return this.host.node(this.id) !== undefined;
  }

  /** Native kind: `text`, `button`, `input`, `view`, `pressable`… */
  get kind(): string {
    return this.node.kind;
  }

  get role(): Role | undefined {
    return roleOf(this.node);
  }

  /** The accessible name, as `getByRole(role, { name })` matches it. */
  get name(): string {
    const node = this.node;
    if (node.control?.label) return normalize(node.control.label);
    if (node.labelledBy?.length) {
      return normalize(node.labelledBy.map((id) => (this.host.node(id) ? this.host.element(id).textContent : "")).join(" "));
    }
    const role = this.role;
    if (role && FORM_ROLES.has(role)) {
      const field = this.closest((element) => element.node.control?.role === "field");
      if (field?.node.control?.label) return normalize(field.node.control.label);
    }
    if (role && NAME_FROM_CONTENT.has(role)) return this.textContent;
    if (node.kind === "input" || node.kind === "textarea") return normalize(node.placeholder ?? "");
    return normalize(ownText(node));
  }

  /** The node's own text: a Text, Button or Markdown source. Empty for containers and inputs. */
  get text(): string {
    return normalize(ownText(this.node));
  }

  /** The text of the node and every descendant, joined with spaces. */
  get textContent(): string {
    const parts: string[] = [];
    const walk = (id: string) => {
      const node = this.host.node(id);
      if (!node) return;
      const text = ownText(node);
      if (text) parts.push(text);
      for (const child of this.host.childIds(id)) walk(child);
    };
    walk(this.id);
    return normalize(parts.join(" "));
  }

  /** The value of an Input or TextArea. */
  get value(): string | undefined {
    return this.node.value;
  }

  get placeholder(): string | undefined {
    return this.node.placeholder;
  }

  get disabled(): boolean {
    return this.node.disabled === true;
  }

  get checked(): boolean | undefined {
    return this.node.control?.checked;
  }

  get selected(): boolean | undefined {
    return this.node.control?.selected;
  }

  get expanded(): boolean | undefined {
    return this.node.control?.expanded;
  }

  get parent(): TestElement | undefined {
    const id = this.host.parentId(this.id);
    return id === undefined ? undefined : this.host.element(id);
  }

  get children(): TestElement[] {
    return this.host.childIds(this.id).map((id) => this.host.element(id));
  }

  /** This element and its ancestors, nearest first, until one matches. */
  closest(predicate: (element: TestElement) => boolean): TestElement | undefined {
    for (let element: TestElement | undefined = this; element; element = element.parent) {
      if (predicate(element)) return element;
    }
    return undefined;
  }

  /** Every descendant in document order. */
  descendants(): TestElement[] {
    const out: TestElement[] = [];
    const walk = (id: string) => {
      for (const child of this.host.childIds(id)) {
        out.push(this.host.element(child));
        walk(child);
      }
    };
    walk(this.id);
    return out;
  }

  toString(): string {
    if (!this.isConnected) return `<removed #${this.id}>`;
    const role = this.role ? ` role=${JSON.stringify(this.role)}` : "";
    const name = this.role && this.name ? ` name=${JSON.stringify(this.name)}` : "";
    const text = this.text ? ` ${JSON.stringify(this.text)}` : "";
    const value = this.value !== undefined ? ` value=${JSON.stringify(this.value)}` : "";
    return `<${this.kind}#${this.id}${role}${name}${value}>${text}`;
  }
}
