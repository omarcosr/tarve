import type { NativeBridge } from "@tarve/core";

type SceneDocument = Parameters<NativeBridge["start"]>[0];
type NativeCommand = Parameters<NativeBridge["send"]>[0];
type NativeEvent = Parameters<Parameters<NativeBridge["start"]>[1]>[0];
/** A node of the compiled scene tree, as `compileTree` produced it and the app sent it. */
export type SceneNode = SceneDocument["root"];

/**
 * The scene tree as the app last sent it to the bridge: the start document with every `update`,
 * `patch` and `mutate` command applied. It is what the native tree holds (ids, kinds, text,
 * values, `control` roles and labels, `labelledBy`), without layout.
 */
export class SceneTreeMirror {
  /** Each node without its children; `children` holds their ids. */
  private readonly nodes = new Map<string, SceneNode>();
  private readonly children = new Map<string, string[]>();
  private rootId: string | undefined;
  private built: SceneNode | undefined;
  /** Bumped on every applied change. */
  version = 0;

  reset(root: SceneNode): void {
    this.nodes.clear();
    this.children.clear();
    this.rootId = root.id;
    this.add(root);
    this.changed();
  }

  apply(command: NativeCommand): void {
    switch (command.type) {
      case "update":
        this.reset(command.root);
        return;
      case "patch":
        for (const node of command.nodes) this.patch(node);
        break;
      case "mutate":
        for (const mutation of command.mutations) {
          if (mutation.type === "create") this.add(mutation.node);
          else if (mutation.type === "patch") this.patch(mutation.node);
          else if (mutation.type === "children") this.children.set(mutation.id, [...mutation.children]);
          else {
            this.nodes.delete(mutation.id);
            this.children.delete(mutation.id);
          }
        }
        break;
      default:
        return;
    }
    this.changed();
  }

  /**
   * Edits the native tree made itself and reported: typing changes an input's `value`, a slider's
   * `control.value`. The app folds them into its shadow tree without sending a patch back.
   */
  observe(event: NativeEvent): void {
    if (event.type !== "change" && event.type !== "valueChange") return;
    const node = this.nodes.get(event.id);
    if (!node) return;
    if (event.type === "change" && (node.kind === "input" || node.kind === "textarea")) {
      this.nodes.set(event.id, { ...node, value: event.value });
    } else if (event.type === "valueChange" && node.control) {
      this.nodes.set(event.id, { ...node, control: { ...node.control, value: event.value } });
    } else {
      return;
    }
    this.changed();
  }

  /** The whole tree, nested; `undefined` before the app started. */
  root(): SceneNode | undefined {
    if (this.built || this.rootId === undefined) return this.built;
    const build = (id: string): SceneNode | undefined => {
      const node = this.nodes.get(id);
      if (!node) return undefined;
      const kids: SceneNode[] = [];
      for (const child of this.children.get(id) ?? []) {
        const built = build(child);
        if (built) kids.push(built);
      }
      return { ...node, children: kids };
    };
    return (this.built = build(this.rootId));
  }

  private changed(): void {
    this.built = undefined;
    this.version++;
  }

  private add(node: SceneNode): void {
    this.nodes.set(node.id, { ...node, children: [] });
    this.children.set(node.id, node.children.map((child) => child.id));
    for (const child of node.children) this.add(child);
  }

  /** Patches carry a node's own properties; its children stay. */
  private patch(node: SceneNode): void {
    this.nodes.set(node.id, { ...node, children: [] });
    if (!this.children.has(node.id)) this.children.set(node.id, node.children.map((child) => child.id));
  }
}
