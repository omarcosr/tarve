import type { NativeNode, TreeMutation } from "../protocol";
import type { CompiledTree } from "../reconciler";

/** Structural equality of plain data (styles, controls, memo props). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => sameValue(value, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => sameValue(left[key], right[key]));
}
function sameFields(a: object, b: object): boolean {
  return sameValue(a, b);
}
function sameStyle(a: NativeNode["style"], b: NativeNode["style"]): boolean {
  return sameValue(a, b);
}

function sameChildren(a: NativeNode, b: NativeNode): boolean {
  return a.children.length === b.children.length
    && a.children.every((child, index) => child.id === b.children[index]?.id);
}

function nodePropertiesChanged(old: NativeNode, node: NativeNode): boolean {
  return old.text !== node.text || old.source !== node.source || old.language !== node.language || old.path !== node.path
    || old.showLineNumbers !== node.showLineNumbers || !sameValue(old.syntaxTheme, node.syntaxTheme)
    || old.wordDiff !== node.wordDiff || !sameValue(old.collapsedPaths, node.collapsedPaths) || old.maxLines !== node.maxLines
    || old.oldText !== node.oldText || old.newText !== node.newText
    || old.src !== node.src || old.fit !== node.fit || !sameValue(old.svg, node.svg)
    // Image bytes: the serialized string is shared per source object, so equal sources compare by identity.
    || old.image?.key !== node.image?.key || old.image?.kind !== node.image?.kind || old.image?.data !== node.image?.data
    || old.value !== node.value || old.placeholder !== node.placeholder || old.inputType !== node.inputType || old.submitOnEnter !== node.submitOnEnter || old.scrollSpeed !== node.scrollSpeed || old.scrollOrientation !== node.scrollOrientation || !sameValue(old.virtualList, node.virtualList) || old.disabled !== node.disabled
    || old.modal !== node.modal || old.rovingGroup !== node.rovingGroup || old.portal !== node.portal || old.dismissOnOutside !== node.dismissOnOutside || !sameValue(old.labelledBy, node.labelledBy) || old.closeIntercept !== node.closeIntercept || old.focusable !== node.focusable
    || old.dragRegion !== node.dragRegion || old.draggable !== node.draggable || old.dropTarget !== node.dropTarget || old.reportSize !== node.reportSize || old.reportPointer !== node.reportPointer || old.windowAction !== node.windowAction || !sameValue(old.motionFrom, node.motionFrom)
    || !sameValue(old.highlight, node.highlight)
    || !sameFields(old.control ?? {}, node.control ?? {})
    || !sameStyle(old.style, node.style);
}

function flatNode(node: NativeNode): NativeNode {
  return { ...node, children: [] };
}

/** null requests a structural replacement; an empty list means no native work is needed. */
export function diffTrees(previous: CompiledTree, next: CompiledTree): NativeNode[] | null {
  if (previous.nodes.size !== next.nodes.size || previous.document.root.id !== next.document.root.id) return null;
  const changed: NativeNode[] = [];
  for (const [id, node] of next.nodes) {
    const old = previous.nodes.get(id);
    if (!old || old.kind !== node.kind || !sameChildren(old, node)) return null;
    if (nodePropertiesChanged(old, node)) changed.push(flatNode(node));
  }
  return changed;
}

/**
 * Computes one atomic retained-tree mutation batch. A null result is reserved for
 * identity-incompatible replacements (root ID or an existing keyed node kind changed).
 */
export function diffTreeMutations(previous: CompiledTree, next: CompiledTree, unchanged?: (old: NativeNode, node: NativeNode) => boolean): TreeMutation[] | null {
  if (previous.document.root.id !== next.document.root.id) return null;

  const creates: TreeMutation[] = [];
  const patches: TreeMutation[] = [];
  const children: TreeMutation[] = [];
  const removes: TreeMutation[] = [];

  for (const [id, node] of next.nodes) {
    const old = previous.nodes.get(id);
    if (!old) {
      creates.push({ type: "create", node: flatNode(node) });
      if (node.children.length > 0) {
        children.push({ type: "children", id, children: node.children.map(child => child.id) });
      }
      continue;
    }
    // The same compiled node (a memoized subtree, or a shadow sharing it): nothing changed.
    if (old === node || unchanged?.(old, node)) continue;
    if (old.kind !== node.kind) return null;
    if (nodePropertiesChanged(old, node)) patches.push({ type: "patch", node: flatNode(node) });
    if (!sameChildren(old, node)) {
      children.push({ type: "children", id, children: node.children.map(child => child.id) });
    }
  }

  for (const id of previous.nodes.keys()) {
    if (!next.nodes.has(id)) removes.push({ type: "remove", id });
  }

  return [...creates, ...patches, ...children, ...removes];
}
