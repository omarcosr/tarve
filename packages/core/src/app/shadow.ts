import type { NativeCommand, NativeNode } from "../protocol";
import { diffTreeMutations, type CompiledTree } from "../reconciler";
import { NodeSetsCommand } from "./node-sets";

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

/**
 * The nodes of a patch that changed only their text (a list rendered again with new labels:
 * the reconciler's patched texts share every other field with the node before), split off as
 * the packed `setNodes` signals use: no node or style per text, and native sets each text in
 * place. Undefined when none qualifies; `rest` is the patch of the others, if any.
 */
export function splitTextSets(previous: CompiledTree, command: NativeCommand): { sets: NodeSetsCommand; rest: NativeCommand | undefined } | undefined {
  if (command.type !== "patch") return undefined;
  let sets: NodeSetsCommand | undefined;
  const rest: NativeNode[] = [];
  for (const node of command.nodes) {
    if (textOnly(previous.nodes.get(node.id), node)) (sets ??= new NodeSetsCommand()).add(node.id, undefined, node.text);
    else rest.push(node);
  }
  return sets && { sets, rest: rest.length ? { type: "patch", nodes: rest } : undefined };
}

function textOnly(old: NativeNode | undefined, node: NativeNode): boolean {
  if (!old || old.kind !== "text" || node.kind !== "text" || node.runs !== undefined || typeof node.text !== "string") return false;
  const a = old as unknown as Record<string, unknown>, b = node as unknown as Record<string, unknown>;
  let keys = 0;
  for (const key in b) {
    keys++;
    if (key === "text") continue;
    // A patch carries a node without its children (flatNode): a text has none either way.
    if (key === "children") {
      if ((b.children as unknown[]).length !== 0 || (a.children as unknown[] | undefined)?.length) return false;
      continue;
    }
    if (b[key] !== a[key]) return false;
  }
  for (const key in a) keys--;
  return keys === 0;
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
