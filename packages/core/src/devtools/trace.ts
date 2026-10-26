import type { NativeNode } from "../protocol";
import type { Component } from "../jsx-runtime";
import { MEMO, type MemoInfo } from "../memo";
import { setComponentTrace, type ComponentTrace } from "../reconciler";

/** One function component of a traced render: what it rendered and the components inside it. */
export interface ComponentFrame {
  /** Stable across renders: the component's tree path and name (`root/children/0|Counter`). */
  key: string;
  name: string;
  path: string;
  props: Record<string, unknown>;
  /** A `memo()` or compiled JSX template component. */
  memo: boolean;
  /** False when a memoized component reused its previous subtree in this render. */
  rendered: boolean;
  /** Ids of the native nodes it returned (several for a fragment, none for `null`). */
  roots: string[];
  children: ComponentFrame[];
}

interface Traced extends ComponentFrame {
  result?: NativeNode[];
  /** A template `--compile-jsx` generated: not in the app's source, so not shown (its components are). */
  template?: boolean;
}

/** The frames as the source wrote them: compiled JSX templates give way to the components inside. */
function withoutTemplates(frames: readonly Traced[]): ComponentFrame[] {
  return frames.flatMap(frame => frame.template
    ? withoutTemplates(frame.children as Traced[])
    : [{ ...frame, children: withoutTemplates(frame.children as Traced[]) }]);
}

/** The name the inspector shows for a component: displayName, the function name, or a fallback. */
export function componentName(type: Component): string {
  const own = (type as { displayName?: unknown }).displayName;
  if (typeof own === "string" && own) return own;
  const info = (type as unknown as Record<symbol, MemoInfo<object> | undefined>)[MEMO];
  if (info?.template) return "Template";
  return type.name || "Anonymous";
}

/**
 * Records the component tree of each render through the reconciler's component trace,
 * and counts how many times each component (by key) rendered. A memoized component
 * that reused its subtree (the reconciler hands back the same result array) does not
 * count, and keeps the components recorded inside it last time.
 */
export class ComponentTracer {
  /** Top-level components of the last completed render. */
  frames: ComponentFrame[] = [];
  /** Renders per component key since the tracer started; unmounted components are dropped. */
  readonly renders = new Map<string, number>();
  private previous = new Map<string, Traced>();
  private current = new Map<string, Traced>();
  private roots: Traced[] = [];
  private stack: Traced[] = [];
  private counting = true;

  private readonly wrap: ComponentTrace = (type, props, path, compile) => {
    const name = componentName(type);
    let key = `${path}|${name}`;
    for (let n = 2; this.current.has(key); n++) key = `${path}|${name}#${n}`;
    const info = (type as unknown as Record<symbol, MemoInfo<object> | undefined>)[MEMO];
    const frame: Traced = {
      key, name, path, props, memo: info !== undefined,
      rendered: true, roots: [], children: [],
      ...info?.template ? { template: true } : {},
    };
    const parent = this.stack[this.stack.length - 1];
    (parent ? parent.children : this.roots).push(frame);
    this.current.set(key, frame);
    this.stack.push(frame);
    let result: NativeNode[];
    try {
      result = compile();
    } finally {
      this.stack.pop();
    }
    const before = this.previous.get(key);
    if (frame.memo && before?.result === result && frame.children.length === 0) {
      frame.rendered = false;
      frame.children = before.children;
      this.keep(before.children);
    }
    frame.result = result;
    frame.roots = result.map(node => node.id);
    if (frame.rendered && this.counting && !frame.template) this.renders.set(key, (this.renders.get(key) ?? 0) + 1);
    return result;
  };

  /** Runs one compile with the trace installed. `count: false` records the tree without counting renders. */
  trace<T>(compile: () => T, count = true): T {
    this.current = new Map();
    this.roots = [];
    this.stack = [];
    this.counting = count;
    const outer = setComponentTrace(this.wrap);
    try {
      const value = compile();
      this.frames = withoutTemplates(this.roots);
      this.previous = this.current;
      for (const key of [...this.renders.keys()]) if (!this.current.has(key)) this.renders.delete(key);
      return value;
    } finally {
      setComponentTrace(outer);
      this.stack = [];
    }
  }

  /** Reused subtrees keep their recorded components (and counts) alive. */
  private keep(frames: ComponentFrame[]): void {
    for (const frame of frames) {
      frame.rendered = false;
      if (!this.current.has(frame.key)) this.current.set(frame.key, frame as Traced);
      this.keep(frame.children);
    }
  }
}
