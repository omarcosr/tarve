import type { VNode } from "./jsx-runtime";

export interface ComponentAdapterInput {
  type: unknown;
  props: Readonly<Record<string, unknown>>;
  key?: string | number;
}

/**
 * Converts a foreign component into a Tarve VNode. Returning undefined lets
 * the next adapter (or Tarve's normal component handling) try the node.
 */
export type ComponentAdapter = (component: ComponentAdapterInput) => VNode | undefined;

