import type { NativeCommand, NativeNode } from "../protocol";
import { diffTreeMutations, type CompiledTree } from "../reconciler";

/**
 * The tree native is known to hold: the committed compiled tree plus the edits native
 * made since (typed text, a dragged slider). Nodes are shared with the compiled tree;
 * one is copied only when native changed it (`editShadowNode`) or when an
 * uncontrolled field keeps the value native has, so a render costs no copy.
 */
/** Node maps the shadow owns (copied from a compiled tree); others are shared and never written. */
const ownedNodeMaps = new WeakSet<Map<string, NativeNode>>();
/** The compiled node a carried-value copy stands for: while that node is reused (memo), nothing changed. */
const carriedFrom = new WeakMap<NativeNode, NativeNode>();

function ownNodes(shadow: CompiledTree): Map<string, NativeNode> {
  if (!ownedNodeMaps.has(shadow.nodes)) {
    shadow.nodes = new Map(shadow.nodes);
    ownedNodeMaps.add(shadow.nodes);
  }
  return shadow.nodes;
}

/** A native edit (typing, a slider drag) changed a node: the shadow now holds that value. */
export function editShadowNode(shadow: CompiledTree, id: string, changes: Pick<NativeNode, "value"> | Pick<NativeNode, "control">): void {
  const node = shadow.nodes.get(id);
  if (!node) return;
  ownNodes(shadow).set(id, { ...node, ...changes });
}

export function nativeShadow(tree: CompiledTree, previous?: CompiledTree): CompiledTree {
  const shadow: CompiledTree = { document: tree.document, handlers: tree.handlers, nodes: tree.nodes };
  if (!previous) return shadow;
  for (const [id, node] of tree.nodes) {
    // An uncontrolled field (no `value` prop) keeps the text native has.
    if ((node.kind === "input" || node.kind === "textarea") && node.value === undefined) {
      const old = previous.nodes.get(id);
      if (old?.kind === node.kind && old.value !== undefined) {
        const carried = { ...node, value: old.value };
        carriedFrom.set(carried, node);
        ownNodes(shadow).set(id, carried);
      }
    }
  }
  return shadow;
}

/** The smallest native command that turns `previous` into `next`; undefined when nothing changed. */
export function reconciliationCommand(previous: CompiledTree, next: CompiledTree): NativeCommand | undefined {
  const mutations = diffTreeMutations(previous, next, (old, node) => carriedFrom.get(old) === node);
  if (mutations === null) return { type: "update", root: next.document.root };
  if (mutations.length === 0) return undefined;
  if (mutations.every(mutation => mutation.type === "patch")) {
    return { type: "patch", nodes: mutations.map(mutation => mutation.node) };
  }
  return { type: "mutate", mutations };
}
