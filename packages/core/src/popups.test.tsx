import { describe, expect, test } from "bun:test";
import { Text, Window } from "./components";
import { compileTree } from "./reconciler";
import { Combobox, Command, CommandPalette, ContextMenu, DropdownMenu, Popover, Tooltip } from "./popups";

describe("popup and selection components", () => {
  test("Tooltip is controlled by hover and renders above its trigger", () => {
    const changes: boolean[] = [];
    const tree = compileTree(
      <Window>
        <Tooltip id="tip" open trigger={<Text>Info</Text>} content="Helpful" onOpenChange={value => changes.push(value)} />
      </Window>,
    );
    expect(tree.nodes.get("tip")?.style.zIndex).toBe(1000);
    expect(tree.nodes.get("tip-content")?.style.bottom).toBe("100%");
    tree.handlers.get("tip-trigger")?.onHover?.(false);
    expect(changes).toEqual([false]);
  });

  test("Popover exposes controlled trigger and escape state changes", () => {
    const changes: boolean[] = [];
    const tree = compileTree(
      <Window>
        <Popover id="account" open={false} trigger={<Text>Account</Text>} onOpenChange={value => changes.push(value)}>
          <Text>Profile</Text>
        </Popover>
      </Window>,
    );
    tree.handlers.get("account-trigger")?.onClick?.();
    tree.handlers.get("account-trigger")?.onEscape?.();
    expect(changes).toEqual([true, false]);
    expect(tree.nodes.has("account-content")).toBe(false);
  });

  test("open popovers are native portals and dismiss from outside clicks", () => {
    const changes: boolean[] = [];
    const tree = compileTree(
      <Window>
        <Popover id="portal-popover" open trigger={<Text>Open</Text>} onOpenChange={value => changes.push(value)}>
          <Text>Content</Text>
        </Popover>
      </Window>,
    );
    expect(tree.nodes.get("portal-popover-content")?.portal).toBe(true);
    expect(tree.nodes.get("portal-popover-content")?.dismissOnOutside).toBe(true);
    tree.handlers.get("portal-popover-content")?.onOutsideClick?.();
    expect(changes).toEqual([false]);
  });

  test("DropdownMenu renders checked items and ignores disabled selections", () => {
    const selected: string[] = [];
    const openChanges: boolean[] = [];
    const tree = compileTree(
      <Window>
        <DropdownMenu
          id="menu"
          open
          trigger={<Text>Actions</Text>}
          items={[
            { value: "edit", label: "Edit", checked: true },
            { value: "delete", label: "Delete", disabled: true },
          ]}
          onSelect={value => selected.push(value)}
          onOpenChange={value => openChanges.push(value)}
        />
      </Window>,
    );
    expect(tree.nodes.get("menu-item-edit")?.control?.checked).toBe(true);
    tree.handlers.get("menu-item-delete")?.onClick?.();
    expect(selected).toEqual([]);
    tree.handlers.get("menu-item-edit")?.onClick?.();
    expect(selected).toEqual(["edit"]);
    expect(openChanges).toEqual([false]);
  });

  test("long popup lists use bounded scroll regions", () => {
    const items = Array.from({ length: 20 }, (_, index) => ({ value: `item-${index}`, label: `Item ${index}` }));
    const options = Array.from({ length: 20 }, (_, index) => ({ value: `option-${index}`, label: `Option ${index}` }));
    const commands = Array.from({ length: 20 }, (_, index) => ({ value: `command-${index}`, label: `Command ${index}` }));
    const tree = compileTree(
      <Window>
        <DropdownMenu id="long-menu" open trigger={<Text>Menu</Text>} items={items} />
        <ContextMenu id="long-context" open trigger={<Text>Context</Text>} items={items} />
        <Combobox id="long-combobox" open query="" options={options} />
        <Command id="long-command" query="" items={commands} />
      </Window>,
    );
    expect(tree.nodes.get("long-menu-content")?.portal).toBe(true);
    expect(tree.nodes.get("long-menu-scroll")?.kind).toBe("scroll");
    expect(tree.nodes.get("long-menu-scroll")?.style.height).toBe(240);
    expect(tree.nodes.get("long-context-content")?.portal).toBe(true);
    expect(tree.nodes.get("long-context-scroll")?.style.height).toBe(240);
    expect(tree.nodes.get("long-combobox-content")?.portal).toBe(true);
    expect(tree.nodes.get("long-combobox-results")?.style.height).toBe(240);
    expect(tree.nodes.get("long-command-results")?.kind).toBe("scroll");
    expect(tree.nodes.get("long-command-results")?.style.height).toBe(280);
  });

  test("short popup lists size their scroll regions to content", () => {
    const tree = compileTree(
      <Window>
        <DropdownMenu id="short-menu" open trigger={<Text>Menu</Text>} items={[
          { value: "one", label: "One" },
          { value: "two", label: "Two" },
        ]} />
        <Combobox id="short-combobox" open query="" options={[
          { value: "one", label: "One" },
          { value: "two", label: "Two" },
        ]} />
      </Window>,
    );
    expect(tree.nodes.get("short-menu-scroll")?.style.height).toBe(68);
    expect(tree.nodes.get("short-combobox-results")?.style.height).toBe(68);
  });

  test("ContextMenu opens from the native context-menu handler and returns selected values", () => {
    const openChanges: boolean[] = [];
    const selected: string[] = [];
    const tree = compileTree(
      <Window>
        <ContextMenu
          id="context"
          open
          trigger={<Text>Target</Text>}
          items={[{ value: "copy", label: "Copy" }]}
          onOpenChange={value => openChanges.push(value)}
          onSelect={value => selected.push(value)}
        />
      </Window>,
    );
    tree.handlers.get("context-trigger")?.onContextMenu?.({ x: 12, y: 18 });
    tree.handlers.get("context-item-copy")?.onClick?.();
    expect(openChanges).toEqual([true, false]);
    expect(selected).toEqual(["copy"]);
  });

  test("Combobox filters by label, value and keywords and closes on selection", () => {
    const selected: string[] = [];
    const openChanges: boolean[] = [];
    const tree = compileTree(
      <Window>
        <Combobox
          id="framework"
          open
          query="meta"
          value="react"
          options={[
            { value: "react", label: "React", keywords: ["meta"] },
            { value: "svelte", label: "Svelte" },
          ]}
          onValueChange={value => selected.push(value)}
          onOpenChange={value => openChanges.push(value)}
        />
      </Window>,
    );
    expect(tree.nodes.has("framework-option-react")).toBe(true);
    expect(tree.nodes.has("framework-option-svelte")).toBe(false);
    expect(tree.nodes.get("framework-option-react")?.control?.checked).toBe(true);
    tree.handlers.get("framework-option-react")?.onClick?.();
    expect(selected).toEqual(["react"]);
    expect(openChanges).toEqual([false]);
  });

  test("Command filters grouped actions and emits selection", () => {
    const queries: string[] = [];
    const selected: string[] = [];
    const tree = compileTree(
      <Window>
        <Command
          id="command"
          query="repo"
          items={[
            { value: "open-repo", label: "Open Repository", group: "Project", shortcut: "Ctrl+O" },
            { value: "settings", label: "Settings", group: "App" },
          ]}
          onQueryChange={value => queries.push(value)}
          onSelect={value => selected.push(value)}
        />
      </Window>,
    );
    expect(tree.nodes.has("command-item-open-repo")).toBe(true);
    expect(tree.nodes.has("command-item-settings")).toBe(false);
    expect(tree.nodes.get("command-group-Project")?.text).toBe("Project");
    tree.handlers.get("command-input")?.onChange?.("open");
    tree.handlers.get("command-item-open-repo")?.onClick?.();
    expect(queries).toEqual(["open"]);
    expect(selected).toEqual(["open-repo"]);
  });

  test("CommandPalette is modal, closes on selection, and disappears when closed", () => {
    const openChanges: boolean[] = [];
    const selected: string[] = [];
    const openTree = compileTree(
      <Window>
        <CommandPalette
          id="palette"
          open
          query=""
          items={[{ value: "new", label: "New File" }]}
          onOpenChange={value => openChanges.push(value)}
          onSelect={value => selected.push(value)}
        />
      </Window>,
    );
    expect(openTree.nodes.get("palette")?.modal).toBe(true);
    expect(openTree.nodes.get("palette")?.portal).toBe(true);
    expect(openTree.nodes.get("palette")?.style.zIndex).toBe(1000);
    openTree.handlers.get("palette-command-item-new")?.onClick?.();
    expect(selected).toEqual(["new"]);
    expect(openChanges).toEqual([false]);

    const closedTree = compileTree(
      <Window>
        <CommandPalette id="palette" open={false} query="" items={[]} />
      </Window>,
    );
    expect(closedTree.nodes.has("palette")).toBe(false);
  });

  test("components reject duplicate item values", () => {
    expect(() => compileTree(
      <Window>
        <Combobox id="duplicate" open={false} query="" options={[
          { value: "same", label: "One" },
          { value: "same", label: "Two" },
        ]} />
      </Window>,
    )).toThrow(TypeError);
  });
});
