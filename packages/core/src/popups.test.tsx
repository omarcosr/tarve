import { describe, expect, test } from "bun:test";
import { Button, Icon, Pressable, Text, Window } from "./components";
import { jsx } from "./jsx-runtime";
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

  test("interactive triggers keep their native node and chain existing popup handlers", () => {
    const events: string[] = [];
    const tree = compileTree(
      <Window>
        <Tooltip id="button-tip" open={false}
          trigger={<Button id="button-tip-trigger" onHover={hovered => events.push(`button-hover:${hovered}`)}>Info</Button>}
          content="Helpful" onOpenChange={open => events.push(`tip:${open}`)} />
        <Popover id="pressable-popover" open={false}
          trigger={<Pressable id="pressable-trigger" onClick={() => events.push("pressable-click")}><Text>Open</Text></Pressable>}
          onOpenChange={open => events.push(`popover:${open}`)}><Text>Body</Text></Popover>
        <Popover id="native-popover" open={false}
          trigger={jsx("button", { id: "native-trigger", onClick: () => events.push("native-click"), children: "Native" })}
          onOpenChange={open => events.push(`native-popover:${open}`)}><Text>Body</Text></Popover>
      </Window>,
    );
    expect(tree.nodes.get("button-tip-trigger")?.kind).toBe("button");
    expect(tree.nodes.get("pressable-trigger")?.kind).toBe("pressable");
    expect(tree.nodes.get("native-trigger")?.kind).toBe("button");
    tree.handlers.get("button-tip-trigger")?.onHover?.(true);
    tree.handlers.get("pressable-trigger")?.onClick?.();
    tree.handlers.get("native-trigger")?.onClick?.();
    expect(events).toEqual([
      "button-hover:true", "tip:true",
      "pressable-click", "popover:true",
      "native-click", "native-popover:true",
    ]);
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

  test("DropdownMenu exposes native roving menuitem keyboard semantics and preserves interactive trigger handlers", () => {
    const events: string[] = [];
    const tree = compileTree(
      <Window>
        <DropdownMenu id="keyboard-menu" open
          trigger={<Button id="keyboard-menu-button" onClick={() => events.push("trigger")}>Actions</Button>}
          items={[
            { value: "first", label: "First" },
            { value: "blocked", label: "Blocked", disabled: true },
            { value: "last", label: "Last" },
          ]}
          onOpenChange={open => events.push(`open:${open}`)}
          onSelect={value => events.push(`select:${value}`)} />
      </Window>,
    );
    expect(tree.nodes.get("keyboard-menu")?.control).toEqual({ role: "navigation", orientation: "vertical" });
    expect(tree.nodes.get("keyboard-menu-button")?.control?.role).toBe("button");
    expect(tree.nodes.get("keyboard-menu-button")?.control?.expanded).toBe(true);
    expect(tree.nodes.get("keyboard-menu-button")?.rovingGroup).toBe("keyboard-menu");
    expect(tree.nodes.get("keyboard-menu-button")?.control?.group).toBe("keyboard-menu");
    expect(tree.nodes.get("keyboard-menu-item-first")?.control?.role).toBe("menuitem");
    expect(tree.nodes.get("keyboard-menu-item-first")?.control?.group).toBe("keyboard-menu");
    expect(tree.nodes.get("keyboard-menu-item-first")?.focusable).not.toBe(false);
    expect(tree.nodes.get("keyboard-menu-item-blocked")?.disabled).toBe(true);
    tree.handlers.get("keyboard-menu-item-last")?.onClick?.();
    expect(events).toEqual(["select:last", "open:false"]);

    const closed = compileTree(<Window><DropdownMenu id="closed-menu" open={false} trigger={<Button>Actions</Button>}
      items={[{ value: "one", label: "One" }]} onOpenChange={open => events.push(`closed:${open}`)} /></Window>);
    expect(closed.nodes.get("closed-menu-trigger")?.control?.role).toBe("button");
    expect(closed.nodes.get("closed-menu-trigger")?.control?.expanded).toBe(false);
    closed.handlers.get("closed-menu-trigger")?.onKeyDown?.("ArrowDown");
    expect(events.at(-1)).toBe("closed:true");
  });

  test("composed Button remains an interactive popup trigger with a derived accessible label", () => {
    const tree = compileTree(
      <Window>
        <DropdownMenu id="composed-menu" open={false}
          trigger={<Button id="composed-menu-trigger"><Icon name="plus" /><Text>Create</Text></Button>}
          items={[{ value: "one", label: "One" }]} />
      </Window>,
    );
    const trigger = tree.nodes.get("composed-menu-trigger")!;
    expect(trigger.kind).toBe("pressable");
    expect(trigger.control).toEqual({ role: "button", label: "Create", expanded: false, group: "composed-menu" });
    expect(trigger.rovingGroup).toBe("composed-menu");
    tree.handlers.get("composed-menu-trigger")?.onKeyDown?.("ArrowDown");
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

  test("ContextMenu items participate in a vertical keyboard navigation group", () => {
    const tree = compileTree(<Window><ContextMenu id="context-keys" open trigger={<Pressable><Text>Target</Text></Pressable>}
      items={[{ value: "copy", label: "Copy" }, { value: "disabled", label: "Disabled", disabled: true }, { value: "paste", label: "Paste" }]} /></Window>);
    expect(tree.nodes.get("context-keys")?.control).toEqual({ role: "navigation", orientation: "vertical" });
    expect(tree.nodes.get("context-keys-trigger")?.control?.role).toBe("button");
    expect(tree.nodes.get("context-keys-trigger")?.rovingGroup).toBe("context-keys");
    expect(tree.nodes.get("context-keys-item-copy")?.control?.group).toBe("context-keys");
    expect(tree.nodes.get("context-keys-item-disabled")?.disabled).toBe(true);
    expect(tree.nodes.get("context-keys-item-paste")?.focusable).not.toBe(false);
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
    expect(tree.nodes.get("framework-option-react")?.control?.selected).toBe(true);
    tree.handlers.get("framework-option-react")?.onClick?.();
    expect(selected).toEqual(["react"]);
    expect(openChanges).toEqual([false]);
  });

  test("Combobox uses one roving focus group for trigger, search, and enabled results", () => {
    const openChanges: boolean[] = [];
    const selected: string[] = [];
    const tree = compileTree(<Window><Combobox id="combo-keys" open query="" value="two"
      options={[{ value: "one", label: "One", disabled: true }, { value: "two", label: "Two" }, { value: "three", label: "Three" }]}
      onOpenChange={open => openChanges.push(open)} onValueChange={value => selected.push(value)} /></Window>);
    expect(tree.nodes.get("combo-keys")?.control).toEqual({ role: "navigation", orientation: "vertical" });
    expect(tree.nodes.get("combo-keys-trigger")?.control?.role).toBe("select");
    expect(tree.nodes.get("combo-keys-trigger")?.children.map(node => node.id)).toContain("combo-keys-content");
    expect(tree.nodes.get("combo-keys-trigger")?.rovingGroup).toBe("combo-keys");
    expect(tree.nodes.get("combo-keys-input")?.control).toBeUndefined();
    expect(tree.nodes.get("combo-keys-input")?.rovingGroup).toBe("combo-keys");
    expect(tree.nodes.get("combo-keys-option-one")?.disabled).toBe(true);
    expect(tree.nodes.get("combo-keys-option-two")?.control?.group).toBe("combo-keys");
    expect(tree.nodes.get("combo-keys-option-two")?.focusable).not.toBe(false);
    tree.handlers.get("combo-keys-option-three")?.onClick?.();
    expect(selected).toEqual(["three"]);
    expect(openChanges).toEqual([false]);
    tree.handlers.get("combo-keys")?.onEscape?.();
    expect(openChanges).toEqual([false, false]);
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

  test("Command exposes roving keyboard focus, disabled skipping structure, and Escape", () => {
    const escaped: string[] = [];
    const tree = compileTree(<Window><Command id="command-keys" query="" value="two"
      items={[
        { value: "one", label: "One", disabled: true },
        { value: "two", label: "Two" },
        { value: "three", label: "Three" },
      ]} onEscape={() => escaped.push("escape")} /></Window>);
    expect(tree.nodes.get("command-keys")?.control).toEqual({ role: "navigation", orientation: "vertical" });
    expect(tree.nodes.get("command-keys-input")?.control).toBeUndefined();
    expect(tree.nodes.get("command-keys-input")?.rovingGroup).toBe("command-keys");
    expect(tree.nodes.get("command-keys-item-one")?.disabled).toBe(true);
    expect(tree.nodes.get("command-keys-item-two")?.control?.role).toBe("menuitem");
    expect(tree.nodes.get("command-keys-item-two")?.control?.group).toBe("command-keys");
    expect(tree.nodes.get("command-keys-item-three")?.focusable).not.toBe(false);
    tree.handlers.get("command-keys")?.onEscape?.();
    expect(escaped).toEqual(["escape"]);
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
    expect(openTree.nodes.get("palette")?.modal).toBeUndefined();
    expect(openTree.nodes.get("palette-content")?.modal).toBe(true);
    expect(openTree.nodes.get("palette")?.portal).toBe(true);
    expect(openTree.nodes.get("palette-content")?.control?.label).toBe("Command palette");
    expect(openTree.nodes.get("palette")?.style.zIndex).toBe(1000);
    openTree.handlers.get("palette-command-item-new")?.onClick?.();
    expect(selected).toEqual(["new"]);
    expect(openChanges).toEqual([false]);

    openTree.handlers.get("palette-command")?.onEscape?.();
    expect(openChanges).toEqual([false, false]);

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
