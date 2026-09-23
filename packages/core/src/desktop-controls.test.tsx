import { describe, expect, test } from "bun:test";
import { Window } from "./components";
import { DataGrid, TreeView } from "./desktop-controls";
import { compileTree } from "./reconciler";

describe("desktop controls", () => {
  test("TreeView flattens expanded nodes, validates ids and wires selection/expansion", () => {
    const expanded: string[][] = [];
    const selected: string[] = [];
    const tree = compileTree(<Window><TreeView id="tree" expandedIds={["src"]} selectedId="a" nodes={[
      { id: "src", label: "src", children: [{ id: "a", label: "a.ts" }, { id: "b", label: "b.ts" }] },
      { id: "readme", label: "README" },
    ]} onExpandedChange={ids => expanded.push(ids)} onSelectedChange={id => selected.push(id)} /></Window>);
    expect(tree.nodes.has("tree-node-a")).toBe(true);
    expect(tree.nodes.get("tree-node-a")?.control?.selected).toBe(true);
    expect(tree.nodes.get("tree-node-src")?.control?.expanded).toBe(true);
    expect(tree.nodes.get("tree")?.control?.role).toBe("tree");
    expect(tree.nodes.get("tree-node-a")?.control?.group).toBe("tree");
    tree.handlers.get("tree-node-src-toggle")?.onClick?.();
    expect(expanded).toEqual([[]]);
    tree.handlers.get("tree-node-b")?.onClick?.();
    expect(selected).toEqual(["b"]);
    expect(() => compileTree(<Window><TreeView nodes={[{ id: "x", label: "x" }, { id: "x", label: "x2" }]} /></Window>)).toThrow(TypeError);
  });

  test("DataGrid filters/sorts locally, virtualizes and keeps selection controlled", () => {
    const selections: (string | number)[][] = [];
    const sorts: unknown[] = [];
    const rows = [
      { id: 1, name: "Zulu", score: 2 },
      { id: 2, name: "Alpha", score: 3 },
      { id: 3, name: "Beta", score: 1 },
    ];
    const tree = compileTree(<Window><DataGrid id="grid" rows={rows} rowKey={row => row.id} height={158} rowHeight={40}
      filter="a" sort={{ column: "name", direction: "asc" }} selectionMode="multiple" selectedKeys={[3]}
      onSelectionChange={keys => selections.push(keys)} onSortChange={sort => sorts.push(sort)} columns={[
        { key: "name", header: "Name", sortable: true },
        { key: "score", header: "Score", sortable: true },
      ]} /></Window>);
    expect(tree.nodes.get("grid")?.control?.role).toBe("grid");
    expect(tree.nodes.has("grid-row-2")).toBe(true);
    expect(tree.nodes.has("grid-row-3")).toBe(true);
    expect(tree.nodes.get("grid-row-3")?.control?.role).toBe("option");
    expect(tree.nodes.get("grid-row-3")?.rovingGroup).toBe("grid");
    expect(tree.nodes.get("grid-row-3")?.control?.group).toBe("grid");
    expect(tree.nodes.get("grid-row-3")?.control?.selected).toBe(true);
    expect(tree.nodes.get("grid-sort-name")?.control?.sortDirection).toBe("ascending");
    expect(tree.nodes.get("grid-sort-name")?.style.focus).toMatchObject({ outlineWidth: 0, outlineStyle: "none" });
    tree.handlers.get("grid-row-3")?.onClick?.();
    expect(selections).toEqual([[]]);
    tree.handlers.get("grid-sort-name")?.onClick?.();
    expect(sorts).toEqual([{ column: "name", direction: "desc" }]);
    expect(() => compileTree(<Window><DataGrid rows={rows} rowKey={row => row.id} sort={{ column: "score", direction: "asc" }} columns={[
      { key: "score", header: "Score" },
    ]} /></Window>)).toThrow(RangeError);
    const inert = compileTree(<Window><DataGrid id="inert-grid" rows={rows} rowKey={row => row.id} columns={[
      { key: "name", header: "Name" },
    ]} /></Window>);
    expect(inert.nodes.get("inert-grid-row-1")?.control).toEqual({ role: "row", label: "Row 1", group: "inert-grid" });
    expect(inert.nodes.get("inert-grid-row-1")?.rovingGroup).toBe("inert-grid");
  });
});
