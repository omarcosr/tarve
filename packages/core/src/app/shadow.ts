import type { NativeCommand, NativeNode } from "../protocol";
import { diffTreeMutations, type CompiledTree } from "../reconciler";

/**
 * The tree native is known to hold. Nodes are copied shallowly: the shadow only
 * ever replaces a node's own `value`/`control` fields (optimistic edits), so
 * styles and other nested values are shared with the compiled tree instead of
 * deep-cloned, which kept a second copy of every style object alive.
 */
/** The compiled node each shadow node copies; a memoized subtree keeps its shadow. */
const shadowSources = new WeakMap<NativeNode, NativeNode>();
/** Set when a native edit mutates a shadow node, so the next shadow copies every node. */
let shadowEdited = false;

/** A native edit (typing, a slider drag) changed `node` in place; the next shadow copies every node. */
export function editShadowNode(node: NativeNode): void {
  shadowSources.delete(node);
  shadowEdited = true;
}

export function nativeShadow(tree: CompiledTree, previous?: CompiledTree): CompiledTree {
  const nodes = new Map<string, NativeNode>();
  // A native edit (typing, a slider drag) changed a shadow node in place: copy everything once.
  const reuse = !shadowEdited;
  shadowEdited = false;
  const keep = (node: NativeNode): void => {
    nodes.set(node.id, node);
    for (const child of node.children) keep(child);
  };
  const copy = (source: NativeNode): NativeNode => {
    const kept = previous?.nodes.get(source.id);
    if (reuse && kept && shadowSources.get(kept) === source) {
      keep(kept);
      return kept;
    }
    const node: NativeNode = { ...source, children: source.children.map(copy) };
    shadowSources.set(node, source);
    const old = previous?.nodes.get(node.id);
    if ((node.kind === "input" || node.kind === "textarea") && node.value === undefined && old?.kind === node.kind) {
      node.value = old.value;
    }
    nodes.set(node.id, node);
    return node;
  };
  const document = { ...tree.document, root: copy(tree.document.root) };
  return { document, handlers: tree.handlers, nodes };
}

/** The smallest native command that turns `previous` into `next`; undefined when nothing changed. */
export function reconciliationCommand(previous: CompiledTree, next: CompiledTree): NativeCommand | undefined {
  const mutations = diffTreeMutations(previous, next, (old, node) => shadowSources.get(old) === node);
  if (mutations === null) return { type: "update", root: next.document.root };
  if (mutations.length === 0) return undefined;
  if (mutations.every(mutation => mutation.type === "patch")) {
    return { type: "patch", nodes: mutations.map(mutation => mutation.node) };
  }
  return { type: "mutate", mutations };
}
