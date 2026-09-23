import { describe, expect, test } from "bun:test";
import { Text, Window } from "./components";
import { compileTree } from "./reconciler";
import { Carousel, Chart, Drawer, NavigationMenu, Questionnaire, Resizable, Sidebar } from "./advanced-controls";

describe("advanced controls", () => {
  test("Carousel is controlled and validates its index", () => {
    const changes: number[] = [];
    const tree = compileTree(<Window><Carousel id="carousel" index={1} items={[
      { value: "a", content: <Text>A</Text> }, { value: "b", content: <Text>B</Text> }, { value: "c", content: <Text>C</Text> },
    ]} onIndexChange={index => changes.push(index)} /></Window>);
    tree.handlers.get("carousel-previous")?.onClick?.();
    tree.handlers.get("carousel-next")?.onClick?.();
    tree.handlers.get("carousel-indicator-a")?.onClick?.();
    expect(changes).toEqual([0, 2, 0]);
    expect(tree.nodes.get("carousel-indicators")?.control).toEqual({ role: "radiogroup", orientation: "horizontal" });
    expect(tree.nodes.get("carousel-indicator-b")?.control?.group).toBe("carousel-indicators");
    expect(() => compileTree(<Window><Carousel index={1} items={[{ value: "a", content: "A" }]} /></Window>)).toThrow(RangeError);
  });

  test("Chart creates scaled bars", () => {
    const tree = compileTree(<Window><Chart id="chart" data={[{ label: "A", value: 10 }, { label: "B", value: 20 }]} /></Window>);
    expect(tree.nodes.get("chart-plot-0")?.style.flex).toBe(1);
    expect(tree.nodes.get("chart-plot-1")?.style.flex).toBe(1);
    expect(tree.nodes.get("chart-bar-0")?.style.height).toBe("50%");
    expect(tree.nodes.get("chart-bar-1")?.style.height).toBe("100%");
    expect(tree.nodes.get("chart-bar-1")?.control).toEqual({ role: "progress", label: "B", value: 20, min: 0, max: 20 });
    expect(() => compileTree(<Window><Chart data={[]} height={0} /></Window>)).toThrow(RangeError);
    expect(() => compileTree(<Window><Chart data={[]} barWidth={Number.NaN} /></Window>)).toThrow(RangeError);
  });

  test("Drawer delegates controlled modal behavior to Sheet", () => {
    const events: boolean[] = [];
    const tree = compileTree(<Window><Drawer id="drawer" open title="Filters" onOpenChange={open => events.push(open)}><Text>Body</Text></Drawer></Window>);
    expect(tree.nodes.get("drawer")?.modal).toBeUndefined();
    expect(tree.nodes.get("drawer-content")?.modal).toBe(true);
    expect(tree.nodes.get("drawer-content")?.control).toMatchObject({ role: "group", label: "Filters" });
    tree.handlers.get("drawer-close")?.onClick?.();
    expect(events).toEqual([false]);
    expect(() => compileTree(<Window><Drawer open size={0} /></Window>)).toThrow(RangeError);
    const percentage = compileTree(<Window><Drawer id="percent-drawer" open size="50%" closeOnEscape={false} /></Window>);
    expect(percentage.nodes.get("percent-drawer-content")?.style.height).toBe("50%");
    expect(percentage.handlers.get("percent-drawer")?.onEscape).toBeUndefined();
  });

  test("NavigationMenu opens content and selects links", () => {
    const events: string[] = [];
    const tree = compileTree(<Window><NavigationMenu id="nav" openValue="docs" items={[
      { value: "home", label: "Home" },
      { value: "docs", label: "Docs", links: [{ value: "intro", label: "Introduction" }] },
    ]} onValueChange={value => events.push(`value:${value}`)} onOpenValueChange={value => events.push(`open:${value ?? ""}`)} /></Window>);
    expect(tree.nodes.get("nav")?.control).toEqual({ role: "navigation", orientation: "horizontal" });
    expect(tree.nodes.get("nav-trigger-home")?.control?.group).toBe("nav");
    expect(tree.nodes.get("nav-trigger-docs")?.control?.group).toBe("nav");
    expect(tree.nodes.get("nav-content-docs")?.portal).toBe(true);
    tree.handlers.get("nav-trigger-home")?.onClick?.();
    tree.handlers.get("nav-link-intro")?.onClick?.();
    tree.handlers.get("nav-content-docs")?.onEscape?.();
    expect(events).toEqual(["value:home", "open:", "value:intro", "open:", "open:"]);
    expect(() => compileTree(<Window><NavigationMenu items={[
      { value: "home", label: "Home" },
      { value: "docs", label: "Docs", links: [{ value: "home", label: "Duplicate" }] },
    ]} /></Window>)).toThrow(TypeError);
    expect(() => compileTree(<Window><NavigationMenu value="missing" items={[{ value: "home", label: "Home" }]} /></Window>)).toThrow(RangeError);
    expect(() => compileTree(<Window><NavigationMenu openValue="home" items={[{ value: "home", label: "Home" }]} /></Window>)).toThrow(RangeError);
  });

  test("NavigationMenu and Sidebar expose active state through UIA-supported toggle semantics", () => {
    const tree = compileTree(<Window>
      <NavigationMenu id="semantic-nav" value="home" openValue="docs" items={[
        { value: "home", label: "Home" },
        { value: "docs", label: "Docs", links: [{ value: "intro", label: "Introduction" }] },
      ]} />
      <Sidebar id="semantic-side" value="home" items={[
        { value: "home", label: "Home" },
        { value: "settings", label: "Settings" },
      ]} />
    </Window>);
    expect(tree.nodes.get("semantic-nav-trigger-home")?.control).toMatchObject({ role: "menuitem", checked: true });
    expect(tree.nodes.get("semantic-nav-link-intro")?.control).toMatchObject({ role: "menuitem", checked: false });
    expect(tree.nodes.get("semantic-side-item-home")?.control).toMatchObject({ role: "toggle", checked: true });
    expect(tree.nodes.get("semantic-side-item-settings")?.control).toMatchObject({ role: "toggle", checked: false });
  });

  test("Resizable uses a native splitter between panels", () => {
    const sizes: number[] = [];
    const tree = compileTree(<Window><Resizable id="split" size={40} first={<Text>A</Text>} second={<Text>B</Text>}
      onSizeChange={size => sizes.push(size)} /></Window>);
    expect(tree.nodes.get("split")?.children.map(node => node.id)).toEqual(["split-first", "split-handle", "split-second"]);
    expect(tree.nodes.get("split-first")?.style.flex).toBe(40);
    expect(tree.nodes.get("split-handle")?.kind).toBe("splitter");
    expect(tree.nodes.get("split-handle")?.control?.orientation).toBe("horizontal");
    expect(tree.nodes.get("split-handle")?.style.width).toBe(10);
    tree.handlers.get("split-handle")?.onValueChange?.(55);
    expect(sizes).toEqual([55]);
    const vertical = compileTree(<Window><Resizable id="vertical" orientation="vertical" size={35} style={{ height: 300 }}
      first={<Text>A</Text>} second={<Text>B</Text>} /></Window>);
    expect(vertical.nodes.get("vertical")?.children.map(node => node.id)).toEqual(["vertical-first", "vertical-handle", "vertical-second"]);
    expect(vertical.nodes.get("vertical-first")?.style.flex).toBe(35);
    expect(vertical.nodes.get("vertical-handle")?.kind).toBe("splitter");
    expect(vertical.nodes.get("vertical-handle")?.control?.orientation).toBe("vertical");
    expect(vertical.nodes.get("vertical-handle")?.style.height).toBe(10);
    expect(() => compileTree(<Window><Resizable size={40} step={0} first="A" second="B" /></Window>)).toThrow(RangeError);
  });

  test("Sidebar and Questionnaire expose controlled navigation", () => {
    const events: string[] = [];
    const tree = compileTree(<Window>
      <Sidebar id="side" value="home" items={[{ value: "home", label: "Home", icon: "search" }, { value: "settings", label: "Settings" }]}
        onValueChange={value => events.push(`side:${value}`)} onCollapsedChange={value => events.push(`collapsed:${value}`)} />
      <Questionnaire id="quiz" current={0} questions={[{ id: "name", title: "Name", type: "text", required: true }]}
        values={{ name: "Marco" }} onValueChange={(id, value) => events.push(`${id}:${value}`)} onSubmit={() => events.push("submit")} />
    </Window>);
    tree.handlers.get("side-item-settings")?.onClick?.();
    tree.handlers.get("side-toggle")?.onClick?.();
    tree.handlers.get("quiz-input-name")?.onChange?.("John");
    tree.handlers.get("quiz-submit")?.onClick?.();
    expect(events).toEqual(["side:settings", "collapsed:true", "name:John", "submit"]);
    expect(tree.nodes.get("side-items")?.kind).toBe("scroll");
    expect(tree.nodes.get("side-icon-home")?.kind).toBe("icon");
    expect(() => compileTree(<Window><Sidebar width={0} items={[]} /></Window>)).toThrow(RangeError);
  });

  test("Questionnaire validates configuration and controlled answers", () => {
    const required = compileTree(<Window><Questionnaire id="required" current={0}
      questions={[{ id: "name", title: "Name", type: "text", required: true }]}
      values={{ name: "   " }} /></Window>);
    expect(required.nodes.get("required-submit")?.disabled).toBe(true);
    expect(() => compileTree(<Window><Questionnaire current={0}
      questions={[{ id: "runtime", title: "Runtime", type: "single", options: [{ value: "bun", label: "Bun" }] }]}
      values={{ runtime: "node" }} /></Window>)).toThrow(TypeError);
    expect(() => compileTree(<Window><Questionnaire current={0}
      questions={[{ id: "runtime", title: "Runtime", type: "single", options: [
        { value: "bun", label: "Bun" }, { value: "bun", label: "Bun again" },
      ] }]}
      values={{}} /></Window>)).toThrow(TypeError);
    expect(() => compileTree(<Window><Questionnaire current={0}
      questions={[{ id: "name", title: "Name", type: "text" }, { id: "missing", title: "Missing", type: "multiple" }]}
      values={{}} /></Window>)).toThrow(TypeError);
  });
});
